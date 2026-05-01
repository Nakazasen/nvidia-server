import http from 'http';
import fs from 'fs';
import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWorkspaceCore } from './agent-core.mjs';
import { createExtensionHost } from './extension-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const NIM_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = process.env.NVIDIA_DEFAULT_MODEL || 'meta/llama-3.1-405b-instruct';
const MAX_TOOL_RESULT_CHARS = 120000;
const MAX_FILE_READ_CHARS = 180000;
const DEFAULT_MAX_ITERATIONS = Number(process.env.NVIDIA_AGENT_MAX_ITERATIONS || 5);
const EXEC_TIMEOUT_MS = 120000;
const HOST = process.env.HOST || process.env.NVIDIA_SERVER_HOST || '127.0.0.1';
const STATE_DIR = path.join(APP_DIR, '.nvidia-agent');
const TRUST_FILE = path.join(STATE_DIR, 'trusted-workspaces.json');
const PROFILE_FILE = path.join(STATE_DIR, 'profile.json');
const READ_ONLY_TOOLS = new Set(['project_indexer', 'semantic_index', 'index_status', 'index_build', 'index_refresh', 'index_search', 'list_dir', 'read_file', 'read_file_paged', 'search_files', 'search', 'load_skill']);
const DESTRUCTIVE_TOOLS = new Set(['write_file', 'apply_patch', 'apply_pending_edit', 'discard_pending_edit', 'execute_command', 'start_command_job', 'cancel_command_job']);

let currentWorkspace = process.cwd();
const nimRequestLog = [];
let lastNimRateLimitHit = null;
const pendingEdits = new Map();
const commandJobs = new Map();
const workspaceCore = createWorkspaceCore({
    workspace: currentWorkspace,
    appDir: APP_DIR,
    stateDir: STATE_DIR,
    execTimeoutMs: EXEC_TIMEOUT_MS,
    maxToolResultChars: MAX_TOOL_RESULT_CHARS,
    maxFileReadChars: MAX_FILE_READ_CHARS
});
const extensionHost = createExtensionHost({
    appDir: APP_DIR,
    workspace: currentWorkspace,
    stateDir: STATE_DIR
});

loadEnvFiles();
fs.mkdirSync(STATE_DIR, { recursive: true });

function loadEnvFiles() {
    const envPaths = [
        path.join(process.cwd(), '.env'),
        path.join(APP_DIR, '.env'),
        path.join(path.dirname(process.execPath), '.env')
    ];

    for (const envPath of envPaths) {
        if (!fs.existsSync(envPath)) continue;
        const env = fs.readFileSync(envPath, 'utf8');
        env.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eq = trimmed.indexOf('=');
            if (eq === -1) return;
            const key = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
            if (key && value && !process.env[key]) process.env[key] = value;
        });
    }
}

function getSkillsDir() {
    return path.join(APP_DIR, 'skills');
}

function sendJSON(res, status, data) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function isAllowedOrigin(origin) {
    if (!origin) return true;
    try {
        const url = new URL(origin);
        return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch {
        return false;
    }
}

function getBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 50 * 1024 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (e) {
                reject(new Error(`Invalid JSON body: ${e.message}`));
            }
        });
        req.on('error', reject);
    });
}

function truncate(value, limit = MAX_TOOL_RESULT_CHARS) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[TRUNCATED ${text.length - limit} chars]`;
}

function redactSecrets(text = '') {
    return String(text)
        .replace(/^(\s*[\w.-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE[_-]?KEY)[\w.-]*\s*=\s*)(.+)$/gim, '$1[REDACTED]')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
        .replace(/\b(?:sk|nvapi|nvidia)[-_][A-Za-z0-9._-]{16,}\b/gi, '[REDACTED_SECRET]');
}

function toolResult(value, limit = MAX_TOOL_RESULT_CHARS) {
    return workspaceCore.toolResult(value, limit);
}

function loadTrustedWorkspaces() {
    try {
        const parsed = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8'));
        return Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    } catch {
        return [];
    }
}

function saveTrustedWorkspaces(workspaces) {
    fs.mkdirSync(path.dirname(TRUST_FILE), { recursive: true });
    fs.writeFileSync(TRUST_FILE, JSON.stringify({ workspaces: [...new Set(workspaces.map(p => path.resolve(p)))] }, null, 2));
}

function isWorkspaceTrusted(workspace = currentWorkspace) {
    return workspaceCore.isWorkspaceTrusted(workspace);
}

function setWorkspaceTrust(workspace = currentWorkspace, trusted = true) {
    return workspaceCore.setWorkspaceTrust(workspace, trusted);
}

function getWorkspaceTrustStatus(workspace = currentWorkspace) {
    return workspaceCore.getWorkspaceTrustStatus(workspace);
}

function sanitizeProfile(input = {}) {
    const uiMode = input.uiMode === 'ide' ? 'ide' : 'enterprise';
    const trustedWorkspace = input.trustedWorkspace === true;
    const fallbackPanels = uiMode === 'ide'
        ? ['chat', 'tools', 'explorer', 'terminal', 'extensions', 'diff']
        : ['chat', 'tools'];
    const allowedPanels = uiMode === 'ide'
        ? new Set(['chat', 'tools', 'explorer', 'terminal', 'extensions', 'diff', 'jobs', 'search', 'composer'])
        : new Set(['chat', 'tools']);
    const requestedPanels = Array.isArray(input.enabledPanels)
        ? [...new Set(input.enabledPanels.filter(item => typeof item === 'string' && allowedPanels.has(item)))]
        : fallbackPanels;
    const enabledPanels = requestedPanels.length > 0 ? requestedPanels : fallbackPanels;
    return { uiMode, trustedWorkspace, enabledPanels };
}

function loadProfile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
        return sanitizeProfile(parsed);
    } catch {
        return sanitizeProfile({ uiMode: 'enterprise', trustedWorkspace: false });
    }
}

function saveProfile(profile) {
    const clean = sanitizeProfile(profile);
    fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(clean, null, 2));
    return clean;
}

function makeUnifiedDiff(relPath, oldText, newText) {
    const oldLines = String(oldText || '').split(/\r?\n/);
    const newLines = String(newText || '').split(/\r?\n/);
    const lines = [`--- a/${relPath}`, `+++ b/${relPath}`];
    const max = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < max; i++) {
        if (oldLines[i] === newLines[i]) {
            if (oldLines[i] !== undefined) lines.push(` ${oldLines[i]}`);
        } else {
            if (oldLines[i] !== undefined) lines.push(`-${oldLines[i]}`);
            if (newLines[i] !== undefined) lines.push(`+${newLines[i]}`);
        }
        if (lines.length > 500) {
            lines.push('[DIFF TRUNCATED]');
            break;
        }
    }
    return lines.join('\n');
}

function createPendingEdit({ filePath, path: inputPath, content, oldContent = null, reason = '' }) {
    if (typeof content !== 'string') throw new Error('content must be a string');
    const resolved = resolveWorkspacePath(filePath || inputPath);
    const relPath = path.relative(currentWorkspace, resolved);
    const previous = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
    const id = `edit_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    if (oldContent !== null && previous !== oldContent) {
        return {
            ok: false,
            conflict: true,
            relPath,
            message: 'The file changed since the proposed oldContent snapshot. Re-read the file before editing.'
        };
    }
    const edit = {
        id,
        filePath: resolved,
        relPath,
        content,
        reason,
        createdAt: new Date().toISOString(),
        before: fs.existsSync(resolved) ? { existed: true, bytes: fs.statSync(resolved).size, hash: fileHash(resolved) } : { existed: false, bytes: 0, hash: null },
        after: { bytes: Buffer.byteLength(content) },
        diff: makeUnifiedDiff(relPath, previous, content)
    };
    pendingEdits.set(id, edit);
    return { ok: true, pendingEdit: edit };
}

function getRateLimitConfig() {
    return {
        enabled: process.env.NVIDIA_RATE_LIMIT_ENABLED !== 'false',
        rpm: Math.max(1, Number(process.env.NVIDIA_RATE_LIMIT_RPM || 40)),
        softRpm: Math.max(1, Number(process.env.NVIDIA_RATE_LIMIT_SOFT_RPM || 30)),
        softDelayMs: Math.max(0, Number(process.env.NVIDIA_RATE_LIMIT_SOFT_DELAY_MS || 1500)),
        burstWindowMs: Math.max(1000, Number(process.env.NVIDIA_RATE_LIMIT_BURST_WINDOW_MS || 10000)),
        burstMax: Math.max(1, Number(process.env.NVIDIA_RATE_LIMIT_BURST_MAX || 10))
    };
}

function cleanupNimRequestLog(now = Date.now()) {
    const cfg = getRateLimitConfig();
    const oldest = now - Math.max(60000, cfg.burstWindowMs);
    while (nimRequestLog.length && nimRequestLog[0].time < oldest) nimRequestLog.shift();
}

function getRateLimitStatus() {
    const now = Date.now();
    const cfg = getRateLimitConfig();
    cleanupNimRequestLog(now);
    const minuteStart = now - 60000;
    const burstStart = now - cfg.burstWindowMs;
    const minuteItems = nimRequestLog.filter(item => item.time >= minuteStart);
    const burstItems = nimRequestLog.filter(item => item.time >= burstStart);
    const minuteRetry = minuteItems.length >= cfg.rpm ? Math.max(0, 60000 - (now - minuteItems[0].time)) : 0;
    const burstRetry = burstItems.length >= cfg.burstMax ? Math.max(0, cfg.burstWindowMs - (now - burstItems[0].time)) : 0;
    const retryAfterMs = Math.max(minuteRetry, burstRetry);

    return {
        enabled: cfg.enabled,
        rpmLimit: cfg.rpm,
        softRpmLimit: cfg.softRpm,
        softDelayMs: cfg.softDelayMs,
        burstLimit: cfg.burstMax,
        burstWindowMs: cfg.burstWindowMs,
        usedLastMinute: minuteItems.length,
        usedBurstWindow: burstItems.length,
        remainingMinute: Math.max(0, cfg.rpm - minuteItems.length),
        remainingBurst: Math.max(0, cfg.burstMax - burstItems.length),
        retryAfterMs,
        nearLimit: cfg.enabled && minuteItems.length >= cfg.softRpm && retryAfterMs === 0,
        limited: cfg.enabled && retryAfterMs > 0,
        lastHit: lastNimRateLimitHit
    };
}

class LocalRateLimitError extends Error {
    constructor(status, label = 'NVIDIA API') {
        const retrySeconds = Math.ceil(status.retryAfterMs / 1000);
        super(`Local NVIDIA rate guard blocked ${label}. ${status.usedLastMinute}/${status.rpmLimit} RPM, ${status.usedBurstWindow}/${status.burstLimit} in ${Math.round(status.burstWindowMs / 1000)}s. Retry after ${retrySeconds}s.`);
        this.name = 'LocalRateLimitError';
        this.statusCode = 429;
        this.retryAfterMs = status.retryAfterMs;
        this.rateLimit = status;
    }
}

function reserveNimRequest(label = 'NVIDIA API') {
    const status = getRateLimitStatus();
    if (status.enabled && status.limited) {
        lastNimRateLimitHit = { at: new Date().toISOString(), label, retryAfterMs: status.retryAfterMs };
        throw new LocalRateLimitError(status, label);
    }
    nimRequestLog.push({ time: Date.now(), label });
    return getRateLimitStatus();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchNim(pathOrUrl, options = {}, label = 'NVIDIA API') {
    let status = getRateLimitStatus();
    if (status.enabled && status.nearLimit && status.softDelayMs > 0) {
        console.warn(`[RATE] Near NVIDIA API limit: ${status.usedLastMinute}/${status.rpmLimit}. Slowing ${status.softDelayMs}ms before ${label}.`);
        await sleep(status.softDelayMs);
    }
    status = reserveNimRequest(label);
    if (status.enabled && status.nearLimit) {
        console.warn(`[RATE] Warning: NVIDIA API usage ${status.usedLastMinute}/${status.rpmLimit} RPM after ${label}.`);
    }
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${NIM_BASE_URL}${pathOrUrl}`;
    const response = await fetch(url, options);
    if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') || 0);
        lastNimRateLimitHit = {
            at: new Date().toISOString(),
            label,
            upstream: true,
            retryAfterMs: retryAfter ? retryAfter * 1000 : null
        };
    }
    return response;
}

function isPathInside(parentDir, childPath) {
    const parent = path.resolve(parentDir);
    const child = path.resolve(childPath);
    const rel = path.relative(parent, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveWorkspacePath(inputPath = '.') {
    const resolved = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(currentWorkspace, inputPath));
    if (!isPathInside(currentWorkspace, resolved)) {
        throw new Error(`Path is outside workspace: ${inputPath}`);
    }
    return resolved;
}

function isLikelyTextFile(filePath) {
    const textExts = new Set([
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.json', '.md',
        '.txt', '.yml', '.yaml', '.toml', '.env', '.gitignore', '.py', '.ps1', '.sh',
        '.java', '.go', '.rs', '.cpp', '.c', '.h', '.hpp', '.cs', '.xml', '.svg',
        '.sql', '.prisma', '.ini', '.conf', '.bat', '.cmd'
    ]);
    const ext = path.extname(filePath).toLowerCase();
    return textExts.has(ext) || path.basename(filePath).startsWith('.');
}

function shouldSkipDir(name) {
    return new Set(['node_modules', '.git', 'dist', 'build', '.brain', '.next', 'coverage', '.venv', '__pycache__']).has(name);
}

function getFileTree(dir, depth = 0, maxDepth = 5) {
    if (depth > maxDepth) return [];
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        return items
            .filter(item => !shouldSkipDir(item.name))
            .map(item => {
                const fullPath = path.join(dir, item.name);
                return {
                    name: item.name,
                    path: fullPath,
                    relPath: path.relative(currentWorkspace, fullPath),
                    type: item.isDirectory() ? 'dir' : 'file',
                    children: item.isDirectory() ? getFileTree(fullPath, depth + 1, maxDepth) : null
                };
            });
    } catch {
        return [];
    }
}

function getFilesFlat(dir = currentWorkspace, baseDir = '') {
    const fullDirPath = path.isAbsolute(dir) ? dir : path.join(currentWorkspace, dir);
    if (!fs.existsSync(fullDirPath)) return [];

    let results = [];
    for (const item of fs.readdirSync(fullDirPath, { withFileTypes: true })) {
        if (item.isDirectory() && shouldSkipDir(item.name)) continue;
        const fullPath = path.join(fullDirPath, item.name);
        const relPath = path.join(baseDir, item.name);
        if (item.isDirectory()) {
            results = results.concat(getFilesFlat(fullPath, relPath));
        } else {
            results.push({
                name: item.name,
                path: fullPath,
                relPath,
                size: fs.statSync(fullPath).size
            });
        }
    }
    return results;
}

function getSkills() {
    const skillsDir = getSkillsDir();
    if (!fs.existsSync(skillsDir)) return [];
    return fs.readdirSync(skillsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
            const content = fs.readFileSync(path.join(skillsDir, f), 'utf8');
            const descMatch = content.match(/description:\s*(.*)/i);
            const h1Match = content.match(/^#\s*(.*)/m);
            return {
                cmd: `/${f.replace('.md', '')}`,
                name: f.replace('.md', ''),
                file: f,
                desc: (descMatch?.[1] || h1Match?.[1] || f.replace('.md', '')).trim()
            };
        });
}

function getWorkflowCommands() {
    return [...getSkills(), ...extensionHost.listCommands()];
}

function buildSkillIndex() {
    const skills = getWorkflowCommands();
    if (skills.length === 0) return 'No skills are installed.';
    return skills.map(s => `- ${s.name}: ${s.desc}`).join('\n');
}

function findMentionedWorkspaceFiles(text, maxFiles = 8) {
    if (!text) return [];
    const normalizedText = text.replace(/\\/g, '/').toLowerCase();
    const matches = [];
    const seen = new Set();

    for (const file of getFilesFlat(currentWorkspace)) {
        if (!isLikelyTextFile(file.path)) continue;
        const rel = file.relPath.replace(/\\/g, '/');
        const relLower = rel.toLowerCase();
        const nameLower = file.name.toLowerCase();
        const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mentioned = normalizedText.includes(relLower) || new RegExp(`(^|[^\\w.-])${escaped}([^\\w.-]|$)`, 'i').test(text);
        if (!mentioned || seen.has(file.path)) continue;
        matches.push(file);
        seen.add(file.path);
        if (matches.length >= maxFiles) break;
    }

    return matches;
}

function buildWorkspaceContext(files, totalLimit = 220000, perFileLimit = 90000) {
    const blocks = [];
    let used = 0;

    for (const file of files) {
        try {
            const resolved = resolveWorkspacePath(file.path);
            const stat = fs.statSync(resolved);
            if (!stat.isFile() || !isLikelyTextFile(resolved)) continue;

            let content = redactSecrets(fs.readFileSync(resolved, 'utf8'));
            if (content.length > perFileLimit) {
                content = `${content.slice(0, perFileLimit)}\n\n[TRUNCATED: file exceeds ${perFileLimit} chars]\n`;
            }

            const rel = file.relPath || path.relative(currentWorkspace, resolved);
            const block = `--- WORKSPACE FILE: ${rel} ---\n${content}\n`;
            if (used + block.length > totalLimit) break;
            blocks.push(block);
            used += block.length;
        } catch (e) {
            blocks.push(`--- WORKSPACE FILE ERROR: ${file.relPath || file.path} ---\n${e.message}\n`);
        }
    }

    if (blocks.length === 0) return null;
    return `Workspace file context automatically loaded by the local IDE server.
Use this as authoritative local file content; do not ask the user to paste these files again.

${blocks.join('\n')}`;
}

async function buildGitContext() {
    try {
        const ctx = await workspaceCore.gitContextTool({ includeDiff: true, includeLog: true });
        return `--- GIT CONTEXT ---\nBranch/Status:\n${ctx.status.stdout}\n\nDiff Stat:\n${ctx.diffStat.stdout}\n\nRecent Log:\n${ctx.log.stdout}\n\nFull Diff:\n${ctx.diff.stdout}\n`;
    } catch (e) {
        return `--- GIT CONTEXT ERROR ---\n${e.message}\n`;
    }
}

async function buildTerminalContext(jobId = null) {
    try {
        if (jobId) {
            const detail = workspaceCore.commandJobStatusTool({ id: jobId });
            return `--- TERMINAL JOB ${jobId} ---\nStatus: ${detail.status}, Exit: ${detail.exitCode ?? 'N/A'}\nCommand: ${detail.command}\nStdout:\n${truncate(detail.stdout, 20000)}\n${detail.stderr ? `Stderr:\n${truncate(detail.stderr, 10000)}\n` : ''}`;
        }
        const jobs = workspaceCore.commandJobStatusTool({});
        if (jobs.length === 0) return "--- TERMINAL CONTEXT ---\nNo recent or running command jobs.\n";

        const summary = jobs.map(j => `- Job ${j.id}: [${j.status}] ${j.command} (Exit: ${j.exitCode ?? 'N/A'}, Started: ${j.startedAt})`).join('\n');
        const blocks = jobs.slice(-3).map(job => {
            const detail = workspaceCore.commandJobStatusTool({ id: job.id });
            return `[Job ${job.id}] Status: ${job.status}, Exit: ${job.exitCode ?? 'N/A'}\nCommand: ${job.command}\nStdout:\n${truncate(detail.stdout, 5000)}\n${detail.stderr ? `Stderr:\n${truncate(detail.stderr, 2000)}\n` : ''}`;
        });
        return `--- TERMINAL CONTEXT ---\nSummary:\n${summary}\n\nRecent Details:\n${blocks.join('\n---\n')}\n`;
    } catch (e) {
        return `--- TERMINAL CONTEXT ERROR ---\n${e.message}\n`;
    }
}

function buildProblemsContext() {
    // Sprint 2: Placeholder/Mock diagnostics
    return `--- PROBLEMS CONTEXT ---\nNo critical diagnostics detected in the current workspace. (Placeholder)\n`;
}

async function buildFolderContext(folders) {
    const blocks = [];
    for (const folder of folders) {
        try {
            const list = workspaceCore.listDirTool({ dirPath: folder.relPath, maxDepth: 2 });
            const tree = (items) => items.map(it => `${it.type === 'dir' ? '+' : '-'} ${it.relPath}`).join('\n');
            blocks.push(`--- FOLDER CONTEXT: ${folder.relPath} ---\n${tree(list)}\n`);
        } catch (e) {
            blocks.push(`--- FOLDER CONTEXT ERROR: ${folder.relPath} ---\n${e.message}\n`);
        }
    }
    return blocks.join('\n');
}

function searchFiles({ query, path: searchPath = '.', limit = 100 }) {
    if (!query) throw new Error('query is required');
    const root = resolveWorkspacePath(searchPath);
    const results = [];
    const lowerQuery = query.toLowerCase();

    for (const file of getFilesFlat(root)) {
        if (results.length >= limit) break;
        if (!isLikelyTextFile(file.path)) continue;
        try {
            const content = redactSecrets(fs.readFileSync(file.path, 'utf8'));
            const lines = content.split(/\r?\n/);
            lines.forEach((line, index) => {
                if (results.length >= limit) return;
                if (line.toLowerCase().includes(lowerQuery)) {
                    results.push({
                        file: path.relative(currentWorkspace, file.path),
                        path: file.path,
                        line: index + 1,
                        content: redactSecrets(line.trim())
                    });
                }
            });
        } catch {
            // Ignore unreadable files.
        }
    }

    return results;
}

function readFileTool({ filePath, path: inputPath, maxChars = MAX_FILE_READ_CHARS }) {
    const resolved = resolveWorkspacePath(filePath || inputPath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath || inputPath}`);
    if (!isLikelyTextFile(resolved)) throw new Error(`Refusing to read likely-binary file: ${filePath || inputPath}`);
    return {
        path: resolved,
        relPath: path.relative(currentWorkspace, resolved),
        size: stat.size,
        content: truncate(redactSecrets(fs.readFileSync(resolved, 'utf8')), maxChars)
    };
}

function readFilePagedTool({ filePath, path: inputPath, startLine = 1, start_line, lineCount = 500, line_count }) {
    const resolved = resolveWorkspacePath(filePath || inputPath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath || inputPath}`);
    if (!isLikelyTextFile(resolved)) throw new Error(`Refusing to read likely-binary file: ${filePath || inputPath}`);
    const lines = redactSecrets(fs.readFileSync(resolved, 'utf8')).split(/\r?\n/);
    const start = Math.max(1, Number(start_line || startLine) || 1);
    const count = Math.max(1, Math.min(Number(line_count || lineCount) || 500, 2000));
    return {
        path: resolved,
        relPath: path.relative(currentWorkspace, resolved),
        startLine: start,
        endLine: Math.min(lines.length, start + count - 1),
        totalLines: lines.length,
        content: lines.slice(start - 1, start - 1 + count).join('\n')
    };
}

function fileHash(filePath) {
    const data = fs.readFileSync(filePath);
    let hash = 0;
    for (const byte of data) hash = ((hash << 5) - hash + byte) >>> 0;
    return hash.toString(16).padStart(8, '0');
}

function writeFileTool({ filePath, path: inputPath, content }) {
    if (typeof content !== 'string') throw new Error('content must be a string');
    const resolved = resolveWorkspacePath(filePath || inputPath);
    const before = fs.existsSync(resolved)
        ? { existed: true, bytes: fs.statSync(resolved).size, hash: fileHash(resolved) }
        : { existed: false, bytes: 0, hash: null };
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);
    return {
        ok: true,
        path: resolved,
        relPath: path.relative(currentWorkspace, resolved),
        bytes: Buffer.byteLength(content),
        before,
        after: { bytes: fs.statSync(resolved).size, hash: fileHash(resolved) }
    };
}

function applyPatchTool({ filePath, path: inputPath, find, replace, replacements, reason = '' }) {
    const resolved = resolveWorkspacePath(filePath || inputPath);
    if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${filePath || inputPath}`);
    if (!isLikelyTextFile(resolved)) throw new Error(`Refusing to patch likely-binary file: ${filePath || inputPath}`);
    let next = fs.readFileSync(resolved, 'utf8');
    const ops = Array.isArray(replacements) ? replacements : [{ find, replace }];
    for (const op of ops) {
        if (typeof op.find !== 'string' || typeof op.replace !== 'string') throw new Error('Each replacement requires find and replace strings');
        if (!next.includes(op.find)) throw new Error(`Patch find text not found in ${filePath || inputPath}: ${op.find.slice(0, 120)}`);
        next = next.replace(op.find, op.replace);
    }
    return createPendingEdit({ filePath: filePath || inputPath, content: next, reason: reason || 'apply_patch' });
}

function applyPendingEditTool({ id }) {
    const edit = pendingEdits.get(id);
    if (!edit) throw new Error(`Pending edit not found: ${id}`);
    fs.mkdirSync(path.dirname(edit.filePath), { recursive: true });
    fs.writeFileSync(edit.filePath, edit.content);
    pendingEdits.delete(id);
    return {
        ok: true,
        id,
        relPath: edit.relPath,
        before: edit.before,
        after: { bytes: fs.statSync(edit.filePath).size, hash: fileHash(edit.filePath) }
    };
}

function listPendingEditsTool() {
    return Array.from(pendingEdits.values()).map(edit => ({
        id: edit.id,
        relPath: edit.relPath,
        reason: edit.reason,
        createdAt: edit.createdAt,
        before: edit.before,
        after: edit.after,
        diff: edit.diff
    }));
}

function listDirTool({ dirPath = '.', path: inputPath = dirPath, maxDepth = 1 }) {
    const resolved = resolveWorkspacePath(inputPath);
    const items = fs.readdirSync(resolved, { withFileTypes: true }).filter(item => !shouldSkipDir(item.name));
    return items.map(item => {
        const fullPath = path.join(resolved, item.name);
        const stat = fs.statSync(fullPath);
        return {
            name: item.name,
            type: item.isDirectory() ? 'dir' : 'file',
            relPath: path.relative(currentWorkspace, fullPath),
            size: item.isDirectory() ? undefined : stat.size,
            children: item.isDirectory() && maxDepth > 1 ? listDirTool({ path: fullPath, maxDepth: maxDepth - 1 }) : undefined
        };
    });
}

function projectIndexerTool({ query = '', maxFiles = 200, includeContent = false }) {
    const files = getFilesFlat(currentWorkspace);
    const packageFiles = files.filter(f => /(^|[\\/])(package\.json|pyproject\.toml|requirements\.txt|vite\.config|electron|main|server|README|readme)/i.test(f.relPath));
    const textFiles = files.filter(f => isLikelyTextFile(f.path));
    const lowerQuery = query.toLowerCase();
    const relevant = lowerQuery
        ? textFiles.filter(f => f.relPath.toLowerCase().includes(lowerQuery) || f.name.toLowerCase().includes(lowerQuery)).slice(0, maxFiles)
        : textFiles.slice(0, maxFiles);

    const summary = {
        workspace: currentWorkspace,
        totalFiles: files.length,
        textFiles: textFiles.length,
        topLevel: listDirTool({ path: '.', maxDepth: 1 }),
        packageFiles: packageFiles.map(f => ({ relPath: f.relPath, size: f.size })),
        relevantFiles: relevant.map(f => ({ relPath: f.relPath, size: f.size }))
    };

    if (includeContent) {
        summary.content = relevant.slice(0, 12).map(f => readFileTool({ filePath: f.relPath, maxChars: 30000 }));
    }

    return summary;
}

function loadSkillTool({ name }) {
    if (!name) throw new Error('name is required');
    const safeName = name.replace(/^\/+/, '').replace(/\.md$/i, '');
    const skillFile = path.resolve(getSkillsDir(), `${safeName}.md`);
    if (!isPathInside(getSkillsDir(), skillFile) || !fs.existsSync(skillFile)) {
        throw new Error(`Skill not found: ${name}`);
    }
    return {
        name: safeName,
        content: fs.readFileSync(skillFile, 'utf8')
    };
}

function executeCommandTool({ command, timeoutMs = EXEC_TIMEOUT_MS }) {
    if (!command || typeof command !== 'string') throw new Error('command is required');
    return new Promise(resolve => {
        exec(command, {
            cwd: currentWorkspace,
            timeout: Math.min(Math.max(Number(timeoutMs) || EXEC_TIMEOUT_MS, 1000), 300000),
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true
        }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                command,
                cwd: currentWorkspace,
                exitCode: err?.code ?? 0,
                signal: err?.signal,
                stdout: truncate(stdout || '', 80000),
                stderr: truncate(stderr || '', 80000),
                error: err ? err.message : null,
                observation: err
                    ? 'Command failed. Analyze stdout/stderr, update your hypothesis, and try the smallest corrective next action.'
                    : 'Command succeeded.'
            });
        });
    });
}

function startCommandJobTool({ command, timeoutMs = EXEC_TIMEOUT_MS }) {
    if (!command || typeof command !== 'string') throw new Error('command is required');
    const id = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const job = {
        id,
        command,
        cwd: currentWorkspace,
        status: 'running',
        startedAt: new Date().toISOString(),
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        error: null
    };
    const child = exec(command, {
        cwd: currentWorkspace,
        timeout: Math.min(Math.max(Number(timeoutMs) || EXEC_TIMEOUT_MS, 1000), 3600000),
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true
    }, (err, stdout, stderr) => {
        job.stdout += stdout || '';
        job.stderr += stderr || '';
        job.exitCode = err?.code ?? 0;
        job.signal = err?.signal || null;
        job.error = err ? err.message : null;
        job.status = err ? (err.killed ? 'cancelled' : 'failed') : 'completed';
        job.finishedAt = new Date().toISOString();
        job.child = null;
    });
    job.child = child;
    child.stdout?.on('data', chunk => { job.stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { job.stderr += chunk.toString(); });
    commandJobs.set(id, job);
    return { ok: true, id, status: job.status, command, cwd: currentWorkspace };
}

function commandJobStatusTool({ id }) {
    if (id) {
        const job = commandJobs.get(id);
        if (!job) throw new Error(`Command job not found: ${id}`);
        return {
            ...job,
            child: undefined,
            stdout: truncate(job.stdout, 80000),
            stderr: truncate(job.stderr, 80000)
        };
    }
    return Array.from(commandJobs.values()).map(job => ({
        id: job.id,
        command: job.command,
        cwd: job.cwd,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
        signal: job.signal
    }));
}

function cancelCommandJobTool({ id }) {
    const job = commandJobs.get(id);
    if (!job) throw new Error(`Command job not found: ${id}`);
    if (job.status !== 'running' || !job.child) return { ok: true, id, status: job.status, message: 'Job is not running.' };
    job.child.kill();
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    return { ok: true, id, status: job.status };
}

function getAgentTools() {
    return [
        {
            type: 'function',
            function: {
                name: 'project_indexer',
                description: 'Build a compact index of the current workspace before deciding which files to inspect.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Optional topic, file name, or feature to focus the index.' },
                        maxFiles: { type: 'integer', minimum: 1, maximum: 500 },
                        includeContent: { type: 'boolean', description: 'Include short content snippets for the most relevant files.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'list_dir',
                description: 'List files and folders inside the current workspace.',
                parameters: {
                    type: 'object',
                    properties: {
                        dirPath: { type: 'string', description: 'Workspace-relative directory path. Defaults to root.' },
                        maxDepth: { type: 'integer', minimum: 1, maximum: 4 }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'semantic_index',
                description: 'Build/search a lightweight semantic-style workspace index for relevant code chunks.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        limit: { type: 'integer', minimum: 1, maximum: 100 },
                        maxFiles: { type: 'integer', minimum: 1, maximum: 2000 }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'index_status',
                description: 'Get semantic index cache status and metadata.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'index_build',
                description: 'Build semantic index cache for workspace files using lexical offline indexing.',
                parameters: {
                    type: 'object',
                    properties: {
                        maxFiles: { type: 'integer', minimum: 1, maximum: 4000 }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'index_refresh',
                description: 'Refresh semantic index incrementally using file size/mtime signatures.',
                parameters: {
                    type: 'object',
                    properties: {
                        maxFiles: { type: 'integer', minimum: 1, maximum: 4000 }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'index_search',
                description: 'Search semantic index cache and return ranked snippets with file paths and scores.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        limit: { type: 'integer', minimum: 1, maximum: 100 },
                        maxFiles: { type: 'integer', minimum: 1, maximum: 4000 }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'git_context',
                description: 'Read git branch/status/diff/log context for the current workspace.',
                parameters: {
                    type: 'object',
                    properties: {
                        includeDiff: { type: 'boolean' },
                        includeLog: { type: 'boolean' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_file',
                description: 'Read a text file from the current workspace.',
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Workspace-relative file path.' },
                        maxChars: { type: 'integer', minimum: 1000, maximum: 250000 }
                    },
                    required: ['filePath']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_file_paged',
                description: 'Read a line range from a large text file in the current workspace.',
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Workspace-relative file path.' },
                        startLine: { type: 'integer', minimum: 1 },
                        lineCount: { type: 'integer', minimum: 1, maximum: 2000 }
                    },
                    required: ['filePath']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'write_file',
                description: 'Propose a complete text file write inside the current workspace. This creates a pending diff review, not an immediate write.',
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Workspace-relative file path.' },
                        content: { type: 'string', description: 'Complete new file content.' }
                    },
                    required: ['filePath', 'content']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'apply_patch',
                description: 'Propose a precise patch by replacing exact text in a workspace file. This creates a pending diff review.',
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string' },
                        find: { type: 'string' },
                        replace: { type: 'string' },
                        replacements: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { find: { type: 'string' }, replace: { type: 'string' } },
                                required: ['find', 'replace']
                            }
                        },
                        reason: { type: 'string' }
                    },
                    required: ['filePath']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'apply_pending_edit',
                description: 'Apply a pending reviewed edit by id after user approval.',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'discard_pending_edit',
                description: 'Discard a pending edit by id without writing it to disk.',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'search_files',
                description: 'Search text in workspace files and return matching file, line, and content.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        path: { type: 'string', description: 'Optional workspace-relative folder.' },
                        limit: { type: 'integer', minimum: 1, maximum: 500 }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'execute_command',
                description: 'Execute a shell command in the current workspace. Use for tests, lint, git diff, and diagnostics.',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' },
                        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 }
                    },
                    required: ['command']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'start_command_job',
                description: 'Start a long-running shell command as a cancellable background job.',
                parameters: {
                    type: 'object',
                    properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } },
                    required: ['command']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'command_job_status',
                description: 'Get status and output for a command job, or list all jobs.',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string' } }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'cancel_command_job',
                description: 'Cancel a running command job by id.',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'load_skill',
                description: 'Load a skill markdown file from skills/*.md when a matching long-term procedure is useful.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Skill name without .md, for example audit or code.' }
                    },
                    required: ['name']
                }
            }
        }
    ];
}

async function runToolCall(toolCall, options = {}) {
    const name = toolCall.function?.name;
    let args = {};
    try {
        args = JSON.parse(toolCall.function?.arguments || '{}');
    } catch (e) {
        return { ok: false, error: `Invalid tool arguments JSON: ${e.message}` };
    }

    try {
        if (DESTRUCTIVE_TOOLS.has(name) && !isWorkspaceTrusted()) {
            return {
                ok: false,
                denied: true,
                error: `${name} requires a trusted workspace. The tool was not executed.`,
                observation: 'Ask the user to trust this workspace before modifying files or running commands.'
            };
        }
        if (DESTRUCTIVE_TOOLS.has(name) && !options.allowDestructive) {
            return {
                ok: false,
                denied: true,
                error: `${name} requires user approval or Auto-Accept. The tool was not executed.`,
                observation: 'Ask the user to enable Auto-Accept or approve the operation, then retry.'
            };
        }
        if (['project_indexer', 'semantic_index', 'index_status', 'index_build', 'index_refresh', 'index_search', 'git_context', 'list_dir', 'read_file', 'read_file_paged', 'write_file', 'apply_patch', 'apply_pending_edit', 'discard_pending_edit', 'search_files', 'search', 'execute_command', 'start_command_job', 'command_job_status', 'cancel_command_job'].includes(name)) {
            return await workspaceCore.callTool(name, args);
        }
        if (name === 'load_skill') return await loadSkillTool(args);
        return { ok: false, error: `Unknown tool: ${name}` };
    } catch (e) {
        return { ok: false, error: e.message, stack: e.stack };
    }
}

function buildAgentSystemPrompt() {
    return `You are the autonomous agent inside NVIDIA NIM Agent IDE.

Architecture:
- Brain: reason privately, form a concrete hypothesis, choose the next smallest useful action.
- Hands: use JSON tools to inspect, modify, test, and verify workspace state.
- Feet: iterate through Think -> Act -> Observe until the task is complete or blocked.

Rules:
- Do not ask the user to paste files that exist in the workspace. Use project_indexer, search_files, list_dir, and read_file.
- For a new workspace task, call project_indexer first unless the answer is trivial or the relevant files are already loaded in context.
- API budget is constrained. Batch independent tool calls in one assistant turn whenever possible, for example request multiple read_file calls together instead of one file per model round trip.
- Prefer project_indexer and search_files before broad reading. Read only the smallest useful file ranges/content needed for the task.
- Use read_file_paged for large files instead of asking for full file content.
- Treat skills/*.md as long-term procedures. Review the skill index, then call load_skill when a skill matches the task.
- Before editing, inspect the relevant files. Prefer targeted changes over whole-project rewrites.
- Prefer apply_patch for precise edits. Use write_file only when creating a new file or replacing an entire file is clearly appropriate.
- write_file and apply_patch create pending diff reviews. Tell the user the pending edit id and wait for approval before claiming the file changed.
- After an edit is applied with apply_pending_edit, run a verification command when a local command is available.
- If execute_command fails, analyze stderr/stdout, self-correct, and try a smaller fix or diagnostic command.
- Use start_command_job for long-running commands and cancel_command_job if the user asks to stop them.
- write_file and execute_command require user approval unless Auto-Accept is enabled. If a destructive tool is denied, explain exactly what approval is needed.
- Tool observations may redact secrets. Never print full API keys, tokens, passwords, or private keys.
- Keep chain-of-thought private. In final answers, provide concise rationale, changed files, and verification results.
- For file edits, prefer direct tool writes. Only emit [FILE_UPDATE:...] blocks if the frontend explicitly needs a review patch.

Workspace: ${currentWorkspace}
Installed skills:
${buildSkillIndex()}`;
}

function normalizeMessages(messages = []) {
    return messages.map(message => {
        if (message.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: message.tool_call_id,
                content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
            };
        }
        const normalized = {
            role: message.role,
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
        };
        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            normalized.tool_calls = message.tool_calls;
        }
        return normalized;
    }).filter(m => m.role && (m.content !== undefined || m.tool_call_id));
}

function getLastUserText(messages = []) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    return typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
}

function isFileWriteIntent(text = '') {
    const lower = text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const writeTokens = [
        'create file',
        'write file',
        'save file',
        'make a file',
        'tao file',
        'tao mot file',
        'ghi file',
        'luu file',
        'luu vao',
        'xuat ra file',
        '.md'
    ];
    const asksForMarkdownArtifact = lower.includes('markdown')
        && ['tao', 'create', 'write', 'save', 'luu', 'ghi', 'xuat'].some(token => lower.includes(token));
    return writeTokens.some(token => lower.includes(token)) || asksForMarkdownArtifact;
}

async function prepareMessages(data) {
    const messages = normalizeMessages(data.messages || []);
    const lastUser = [...messages].reverse().find(m => m.role === 'user');

    if (lastUser?.content?.startsWith('/')) {
        const [rawCmd, ...rest] = lastUser.content.split(/\s+/);
        const cmd = rawCmd.slice(1);
        const skillPath = path.join(getSkillsDir(), `${cmd}.md`);
        if (fs.existsSync(skillPath)) {
            messages.unshift({
                role: 'system',
                content: `The user invoked skill /${cmd}. Apply this procedure:\n\n${fs.readFileSync(skillPath, 'utf8')}`
            });
            lastUser.content = rest.join(' ').trim() || `Run the /${cmd} workflow.`;
        }
    }

    // Attached Context (Context Picker)
    if (data.contextFiles?.length) {
        const context = buildWorkspaceContext(data.contextFiles);
        if (context) messages.unshift({ role: 'system', content: context });
    }

    if (data.contextFolders?.length) {
        const context = await buildFolderContext(data.contextFolders);
        if (context) messages.unshift({ role: 'system', content: context });
    }

    if (data.contextGit) {
        const context = await buildGitContext();
        messages.unshift({ role: 'system', content: context });
    }

    if (data.contextTerminal) {
        const context = await buildTerminalContext();
        messages.unshift({ role: 'system', content: context });
    }

    if (data.contextTerminalJobs?.length) {
        for (const jobId of data.contextTerminalJobs) {
            const context = await buildTerminalContext(jobId);
            if (context) messages.unshift({ role: 'system', content: context });
        }
    }

    if (data.contextProblems) {
        const context = buildProblemsContext();
        messages.unshift({ role: 'system', content: context });
    }

    // Auto-context
    const userText = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    const mentionedFiles = findMentionedWorkspaceFiles(userText);
    const autoContext = buildWorkspaceContext(mentionedFiles);
    if (autoContext) {
        console.log(`[CONTEXT] Auto-loaded ${mentionedFiles.length} workspace file(s): ${mentionedFiles.map(f => f.relPath).join(', ')}`);
        messages.unshift({ role: 'system', content: autoContext });
    }

    if (data.selection?.text) {
        const selectionText = truncate(redactSecrets(String(data.selection.text)), 12000);
        messages.unshift({
            role: 'system',
            content: `The user selected code in ${data.selection.file || 'the editor'}:\n\n\`\`\`\n${selectionText}\n\`\`\``
        });
    }

    messages.unshift({ role: 'system', content: buildAgentSystemPrompt() });
    return messages;
}

async function callNimChat(payload, signal) {
    const response = await fetchNim('/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.NVIDIA_API_KEY || ''}`
        },
        body: JSON.stringify(payload),
        signal
    }, 'chat.completions');

    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = { error: text };
    }

    if (!response.ok) {
        throw new Error(`NIM ${response.status}: ${truncate(data, 4000)}`);
    }
    return data;
}

function writeSse(res, event, data) {
    if (res.writableEnded || res.destroyed) return;
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
        console.warn(`[SSE] Failed to write ${event}: ${e.message}`);
    }
}

async function callNimChatStream(payload, onEvent, signal) {
    const response = await fetchNim('/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.NVIDIA_API_KEY || ''}`
        },
        body: JSON.stringify({ ...payload, stream: true }),
        signal
    }, 'chat.completions.stream');

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`NIM ${response.status}: ${truncate(text, 4000)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const message = { role: 'assistant', content: '', tool_calls: [] };
    const toolMap = new Map();

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
            const line = part.split('\n').find(l => l.startsWith('data:'));
            if (!line) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            const chunk = JSON.parse(raw);
            const delta = chunk.choices?.[0]?.delta || {};

            if (delta.content) {
                message.content += delta.content;
                onEvent?.('delta', { content: delta.content });
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const key = tc.index ?? toolMap.size;
                    if (!toolMap.has(key)) {
                        toolMap.set(key, {
                            id: tc.id || `tool_${key}`,
                            type: 'function',
                            function: { name: '', arguments: '' }
                        });
                    }
                    const acc = toolMap.get(key);
                    if (tc.id) acc.id = tc.id;
                    if (tc.function?.name) acc.function.name += tc.function.name;
                    if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                }
            }
        }
    }

    message.tool_calls = Array.from(toolMap.values());
    if (message.tool_calls.length === 0) delete message.tool_calls;
    return { choices: [{ message }] };
}

async function runAutonomousAgent(data, callbacks = {}) {
    const signal = callbacks.signal;
    const allowDestructive = data.autoAccept === true || data.auto_accept === true || data.allowDestructive === true;
    const model = data.model && data.model !== 'auto' ? data.model : DEFAULT_MODEL;
    const maxIterations = Math.max(1, Math.min(Number(data.max_iterations || data.maxIterations) || DEFAULT_MAX_ITERATIONS, 20));
    const tools = getAgentTools();
    const messages = await prepareMessages(data);
    const lastUserText = getLastUserText(messages);
    const requiresFileWrite = isFileWriteIntent(lastUserText);
    if (requiresFileWrite) {
        messages.unshift({
            role: 'system',
            content: 'The current user request appears to require creating, writing, or saving a file. You must call write_file and receive its tool result before saying the file was created or saved. In the final answer, include the exact relPath returned by write_file. If you cannot write the file, say that clearly and do not claim it exists.'
        });
    }
    const events = [];
    let finalMessage = null;
    let successfulWrite = false;
    let writeEnforcementRetried = false;
    const emit = (name, payload) => {
        try {
            callbacks[name]?.(payload);
        } catch (e) {
            events.push({ type: 'callback_error', callback: name, error: e.message });
        }
    };

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (signal?.aborted) {
            finalMessage = { role: 'assistant', content: 'Đã dừng theo yêu cầu của người dùng.' };
            events.push({ type: 'status', iteration, status: 'aborted' });
            break;
        }
        const payload = {
            model,
            messages,
            tools,
            tool_choice: 'auto',
            temperature: data.temperature ?? 0.2,
            max_tokens: data.max_tokens || data.maxTokens || 4096
        };

        emit('status', { iteration, status: 'thinking', model });
        events.push({ type: 'status', iteration, status: 'thinking', model });

        const completion = callbacks.streamFinal
            ? await callNimChatStream(payload, callbacks.event, signal)
            : await callNimChat(payload, signal);

        const message = completion.choices?.[0]?.message;
        if (!message) throw new Error('NIM returned no assistant message');
        messages.push(message);

        const toolCalls = message.tool_calls || [];
        if (toolCalls.length === 0) {
            if (requiresFileWrite && !successfulWrite) {
                if (!writeEnforcementRetried) {
                    writeEnforcementRetried = true;
                    messages.push({
                        role: 'system',
                        content: 'No successful write_file tool call has happened yet. Continue the task by calling write_file now with a concrete workspace-relative filePath and complete content. Do not provide a final answer until write_file succeeds or you explicitly state that you cannot create the file.'
                    });
                    events.push({ type: 'status', iteration, status: 'retrying_missing_write_file' });
                    continue;
                }
                finalMessage = {
                    role: 'assistant',
                    content: 'Tôi chưa tạo được file trong workspace vì không có lệnh write_file nào chạy thành công. Vui lòng thử lại với tên file đích rõ ràng, ví dụ: "Tạo file docs/fix-proposal.md với nội dung markdown ...".'
                };
                break;
            }
            finalMessage = message;
            break;
        }

        emit('status', { iteration, status: 'acting', toolCalls: toolCalls.map(tc => tc.function?.name) });
        events.push({ type: 'status', iteration, status: 'acting', toolCalls: toolCalls.map(tc => tc.function?.name) });

        const toolResults = await Promise.all(toolCalls.map(async toolCall => {
            if (signal?.aborted) return { role: 'tool', tool_call_id: toolCall.id, content: 'Aborted by user.' };
            const toolName = toolCall.function?.name || 'unknown';
            emit('tool_start', { iteration, tool: toolName, arguments: toolCall.function?.arguments || '{}' });
            events.push({ type: 'tool_start', iteration, tool: toolName, arguments: toolCall.function?.arguments || '{}' });

            const result = await runToolCall(toolCall, { allowDestructive });
            if (toolName === 'write_file' && result?.ok !== false) successfulWrite = true;
            const content = toolResult(result);

            emit('tool_result', { iteration, tool: toolName, ok: result?.ok !== false, result: content });
            events.push({ type: 'tool_result', iteration, tool: toolName, ok: result?.ok !== false, result: content });
            return { role: 'tool', tool_call_id: toolCall.id, content };
        }));
        messages.push(...toolResults);
    }

    if (!finalMessage) {
        finalMessage = {
            role: 'assistant',
            content: `Reached max_iterations (${maxIterations}) before a final answer. Current state was preserved in the server-side tool loop.`
        };
    }

    return {
        id: `agent-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: finalMessage, finish_reason: 'stop' }],
        agent: {
            autonomous: true,
            iterations: events.filter(e => e.type === 'status' && e.status === 'thinking').length,
            events
        }
    };
}

async function handleProxyChat(req, res) {
    const data = await getBody(req);
    console.log(`[POST] /proxy/chat - Model: ${data.model || DEFAULT_MODEL}`);
    const abortController = new AbortController();
    req.on('close', () => {
        if (!res.writableEnded) abortController.abort();
    });
    res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
    });

    if (data.stream === true || data.autonomous_stream === true) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
        });
        const result = await runAutonomousAgent(data, {
            streamFinal: true,
            event: (event, payload) => writeSse(res, event, payload),
            status: payload => writeSse(res, 'status', payload),
            tool_start: payload => writeSse(res, 'tool_start', payload),
            tool_result: payload => writeSse(res, 'tool_result', payload),
            signal: abortController.signal
        });
        writeSse(res, 'final', result);
        writeSse(res, 'done', {});
        res.end();
        return;
    }

    const result = await runAutonomousAgent(data, { signal: abortController.signal });
    sendJSON(res, 200, result);
}

async function probeModels(models, concurrency = 12, timeoutMs = 15000) {
    const results = {};
    const limit = Math.max(1, Math.min(Number(concurrency) || 12, 24));
    const timeout = Math.max(3000, Math.min(Number(timeoutMs) || 15000, 30000));

    async function probeOne(modelId) {
        const start = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetchNim('/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.NVIDIA_API_KEY || ''}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1,
                    temperature: 0,
                    stream: true
                }),
                signal: controller.signal
            }, `probe:${modelId}`);

            if (!response.ok) {
                results[modelId] = {
                    latency: Date.now() - start,
                    status: response.status === 404 || response.status === 410 ? 'removed' : 'error',
                    code: response.status
                };
                return;
            }

            if (response.body?.getReader) {
                const reader = response.body.getReader();
                await reader.read();
                await reader.cancel().catch(() => {});
            }

            results[modelId] = { latency: Date.now() - start, status: 'ok', code: response.status };
        } catch (e) {
            const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
            results[modelId] = {
                latency: Date.now() - start,
                status: isTimeout ? 'timeout' : 'error',
                code: isTimeout ? 408 : 0
            };
        } finally {
            clearTimeout(timer);
        }
    }

    let cursor = 0;
    async function worker() {
        while (cursor < models.length) {
            const modelId = models[cursor++];
            await probeOne(modelId);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, models.length) }, worker));
    return results;
}

async function routeApiTool(toolName, args) {
    if (['list_dir', 'read_file', 'read_file_paged', 'write_file', 'apply_patch', 'apply_pending_edit', 'discard_pending_edit', 'pending_edits', 'search', 'search_files', 'semantic_index', 'index_status', 'index_build', 'index_refresh', 'index_search', 'git_context', 'execute_command', 'start_command_job', 'command_job_status', 'cancel_command_job', 'project_indexer'].includes(toolName)) {
        const result = await workspaceCore.callTool(toolName, args);
        return toolName === 'read_file' ? result.content : result;
    }
    if (toolName === 'load_skill') return loadSkillTool(args);
    throw new Error(`Unknown API tool: ${toolName}`);
}

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Forbidden origin' }));
        return;
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Approved');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (req.method === 'GET') {
            if (req.url === '/' || req.url === '/index.html') {
                const htmlPath = path.join(APP_DIR, 'nvidia_playground.html');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(fs.readFileSync(htmlPath));
                return;
            }

            if (req.url === '/api/models') {
                const response = await fetchNim('/models', {
                    headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY || ''}` }
                }, 'models.list');
                const data = await response.json();
                return sendJSON(res, response.ok ? 200 : response.status, data);
            }

            if (req.url === '/api/workflows') return sendJSON(res, 200, { commands: getWorkflowCommands() });
            if (req.url === '/api/extensions') return sendJSON(res, 200, {
                extensions: extensionHost.listExtensions(),
                commands: extensionHost.listCommands(),
                registeredCommands: extensionHost.listRegisteredCommands(),
                providers: extensionHost.getAgentProviders()
            });
            if (requestUrl.pathname === '/api/extensions/search') {
                const query = requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '';
                const results = await extensionHost.searchOpenVsx(query, requestUrl.searchParams.get('size') || 20);
                return sendJSON(res, 200, { results });
            }
            if (req.url === '/api/agent_providers') return sendJSON(res, 200, { providers: extensionHost.getAgentProviders() });
            if (req.url === '/api/files') return sendJSON(res, 200, { tree: workspaceCore.getFileTree(currentWorkspace) });
            if (req.url === '/api/files_flat') return sendJSON(res, 200, { files: workspaceCore.getFilesFlat(currentWorkspace) });
            if (req.url === '/api/workspace') return sendJSON(res, 200, { path: currentWorkspace });
            if (req.url === '/api/trust') return sendJSON(res, 200, getWorkspaceTrustStatus());
            if (req.url === '/api/profile') return sendJSON(res, 200, loadProfile());
            if (req.url === '/api/pending_edits') return sendJSON(res, 200, { edits: workspaceCore.listPendingEditsTool() });
            if (req.url === '/api/command_jobs') return sendJSON(res, 200, { jobs: workspaceCore.commandJobStatusTool({}) });
            if (req.url === '/api/tools') return sendJSON(res, 200, { tools: getAgentTools() });
            if (req.url === '/api/rate_limit') return sendJSON(res, 200, getRateLimitStatus());
            if (req.url === '/api/index/status') return sendJSON(res, 200, await workspaceCore.indexStatusTool());
            if (requestUrl.pathname === '/api/index/search') {
                const query = requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '';
                const limit = Number(requestUrl.searchParams.get('limit') || 20);
                return sendJSON(res, 200, await workspaceCore.searchIndexCache({ query, limit }));
            }

            if (req.url === '/api/select_folder') {
                const psCommand = "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowNewFolderButton = $true; if($f.ShowDialog() -eq 'OK'){$f.SelectedPath}";
                exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCommand}"`, { windowsHide: true }, (error, stdout) => {
                    if (error) return sendJSON(res, 500, { error: error.message });
                    sendJSON(res, 200, { path: stdout.trim() });
                });
                return;
            }

            if (requestUrl.pathname === '/api/select_file') {
                const kind = (requestUrl.searchParams.get('kind') || '').toLowerCase();
                const filter = kind === 'vsix'
                    ? 'VSIX files (*.vsix)|*.vsix|All files (*.*)|*.*'
                    : 'All files (*.*)|*.*';
                const psCommand = `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = ${JSON.stringify(filter)}; $f.Multiselect = $false; if($f.ShowDialog() -eq 'OK'){$f.FileName}`;
                exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCommand}"`, { windowsHide: true }, (error, stdout) => {
                    if (error) return sendJSON(res, 500, { error: error.message });
                    sendJSON(res, 200, { path: stdout.trim() });
                });
                return;
            }

            res.writeHead(404);
            res.end();
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
        }

        if (req.url === '/proxy/chat') return await handleProxyChat(req, res);

        if (req.url === '/api/probe_models') {
            const body = await getBody(req);
            const models = body.models || [];
            console.log(`[PROBE] Checking ${models.length} model(s)`);
            const results = await probeModels(models, body.concurrency, body.timeoutMs);
            return sendJSON(res, 200, { results });
        }

        if (req.url === '/api/workspace') {
            const body = await getBody(req);
            if (!body.path || !fs.existsSync(body.path)) return sendJSON(res, 400, { error: 'Invalid workspace path' });
            currentWorkspace = path.resolve(body.path);
            workspaceCore.setWorkspace(currentWorkspace);
            extensionHost.setWorkspace(currentWorkspace);
            console.log(`[WORKSPACE] Switched to: ${currentWorkspace}`);
            return sendJSON(res, 200, { status: 'success', path: currentWorkspace, trust: getWorkspaceTrustStatus() });
        }

        if (req.url === '/api/trust') {
            const body = await getBody(req);
            return sendJSON(res, 200, setWorkspaceTrust(currentWorkspace, body.trusted === true));
        }

        if (req.url === '/api/profile') {
            const body = await getBody(req);
            if (body.uiMode !== 'enterprise' && body.uiMode !== 'ide') {
                return sendJSON(res, 400, { error: 'Invalid uiMode. Use enterprise or ide.' });
            }
            return sendJSON(res, 200, saveProfile(body));
        }

        if (req.url === '/api/apply_pending_edit') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'apply_pending_edit requires explicit UI approval.' });
            return sendJSON(res, 200, { result: workspaceCore.applyPendingEditTool(body) });
        }

        if (req.url === '/api/discard_pending_edit') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'discard_pending_edit requires explicit UI approval.' });
            return sendJSON(res, 200, { result: workspaceCore.discardPendingEditTool(body) });
        }

        if (req.url === '/api/install_extension') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'install_extension requires explicit UI approval.' });
            const installed = extensionHost.installFromFolder(body.path);
            return sendJSON(res, 200, { status: 'success', extension: installed });
        }

        if (req.url === '/api/extensions/install_folder') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'extensions/install_folder requires explicit UI approval.' });
            return sendJSON(res, 200, { status: 'success', extension: extensionHost.installFromFolder(body.path) });
        }

        if (req.url === '/api/extensions/install_vsix') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'extensions/install_vsix requires explicit UI approval.' });
            return sendJSON(res, 200, { status: 'success', extension: extensionHost.installFromVsix(body.path) });
        }

        if (req.url === '/api/extensions/install_openvsx') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'extensions/install_openvsx requires explicit UI approval.' });
            return sendJSON(res, 200, { status: 'success', extension: await extensionHost.installFromOpenVsx(body) });
        }

        if (req.url === '/api/extensions/enable') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'extensions/enable requires explicit UI approval.' });
            return sendJSON(res, 200, { status: 'success', extension: extensionHost.setEnabled(body.id, body.enabled === true) });
        }

        if (req.url === '/api/extensions/uninstall') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'extensions/uninstall requires explicit UI approval.' });
            return sendJSON(res, 200, { status: 'success', result: extensionHost.uninstall(body.id) });
        }

        if (req.url === '/api/extensions/activate') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'extensions/activate requires explicit UI approval.' });
            const result = body.event
                ? await extensionHost.activateByEvent(body.event)
                : await extensionHost.activateExtension(body.id, body.activationEvent || 'manual');
            return sendJSON(res, 200, { status: 'success', result, registeredCommands: extensionHost.listRegisteredCommands() });
        }

        if (req.url === '/api/extensions/run_command') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'extensions/run_command requires explicit UI approval.' });
            const result = await extensionHost.executeCommand(body.command, body.args || []);
            return sendJSON(res, 200, { status: 'success', result });
        }

        if (req.url === '/api/agent_providers/run') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'agent provider run requires explicit UI approval.' });
            const provider = extensionHost.getAgentProviders().find(item => item.id === body.id);
            if (!provider) return sendJSON(res, 404, { error: `Agent provider not found: ${body.id}` });
            if (provider.installed === false) return sendJSON(res, 400, { error: `${provider.name || provider.id} is not installed or not on PATH.` });
            const prompt = String(body.prompt || '');
            const quotedPrompt = JSON.stringify(prompt);
            const command = provider.runTemplate
                ? String(provider.runTemplate).replaceAll('{prompt}', quotedPrompt)
                : `${provider.command} ${quotedPrompt}`;
            return sendJSON(res, 200, { status: 'success', job: await workspaceCore.startCommandJobTool({ command, timeoutMs: body.timeoutMs || 3600000 }) });
        }

        if (req.url === '/api/index/build') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'index build requires explicit UI approval.' });
            return sendJSON(res, 200, await workspaceCore.buildIndexCache({ maxFiles: body.maxFiles || 1200, full: true }));
        }

        if (req.url === '/api/index/refresh') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'index refresh requires explicit UI approval.' });
            return sendJSON(res, 200, await workspaceCore.refreshIndexCache({ maxFiles: body.maxFiles || 1200 }));
        }

        if (req.url.startsWith('/api/')) {
            const toolName = req.url.split('/')[2];
            const args = await getBody(req);
            if (DESTRUCTIVE_TOOLS.has(toolName) && !isWorkspaceTrusted()) {
                return sendJSON(res, 403, { error: `${toolName} requires trusted workspace.` });
            }
            if (DESTRUCTIVE_TOOLS.has(toolName) && req.headers['x-agent-approved'] !== 'true') {
                return sendJSON(res, 403, { error: `${toolName} requires explicit UI approval.` });
            }
            console.log(`[TOOL] ${toolName} ${JSON.stringify(args)}`);
            const result = await routeApiTool(toolName, args);
            return sendJSON(res, 200, { result });
        }

        res.writeHead(404);
        res.end();
    } catch (e) {
        console.error(`[ERR] ${req.method} ${req.url}`, e);
        if (e.name === 'AbortError') {
            if (req.url === '/proxy/chat' && !res.headersSent && !res.writableEnded) {
                return sendJSON(res, 499, { error: 'Request aborted by user.' });
            }
            if (!res.writableEnded) res.end();
            return;
        }
        if (e instanceof LocalRateLimitError) {
            if (req.url === '/proxy/chat' && res.headersSent) {
                writeSse(res, 'error', { error: e.message, rateLimit: e.rateLimit, retryAfterMs: e.retryAfterMs });
                writeSse(res, 'done', {});
                res.end();
                return;
            }
            return sendJSON(res, 429, { error: e.message, rateLimit: e.rateLimit, retryAfterMs: e.retryAfterMs });
        }
        if (req.url === '/proxy/chat' && !res.headersSent) {
            return sendJSON(res, 500, { error: e.message });
        }
        if (!res.writableEnded) sendJSON(res, 500, { error: e.message });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`NVIDIA NIM Agent IDE server running at http://${HOST}:${PORT}`);
    console.log(`Workspace: ${currentWorkspace}`);
});
