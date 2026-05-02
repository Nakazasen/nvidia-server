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
const SECURITY_DIR = path.join(STATE_DIR, 'security');
const PERMISSION_AUDIT_LOG = path.join(SECURITY_DIR, 'permission-audit.jsonl');
const TRUST_FILE = path.join(STATE_DIR, 'trusted-workspaces.json');
const PROFILE_FILE = path.join(STATE_DIR, 'profile.json');
const PROVIDERS_FILE = path.join(STATE_DIR, 'providers.json');
const TASKS_DIR = path.join(STATE_DIR, 'tasks');
const READ_ONLY_TOOLS = new Set(['project_indexer', 'semantic_index', 'index_status', 'index_build', 'index_refresh', 'index_search', 'list_dir', 'read_file', 'read_file_paged', 'search_files', 'search', 'load_skill']);
const DESTRUCTIVE_TOOLS = new Set(['write_file', 'apply_patch', 'apply_pending_edit', 'discard_pending_edit', 'execute_command', 'start_command_job', 'cancel_command_job', 'git_stage', 'git_unstage', 'git_discard']);

// --- Sprint 8: Diagnostics Model ---
// In-memory diagnostics store. Not persisted to disk.
let diagnosticsStore = [];
let diagnosticsIdCounter = 0;
let diagnosticsSources = [];
const MAX_MARKER_MESSAGE_CHARS = 4000;
const MAX_MARKERS_PER_UPDATE = 300;
const MAX_DIAGNOSTICS_PER_REFRESH = 2000;

function toSafeInt(value, min = 1, max = 1000000) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const i = Math.trunc(n);
    if (i < min || i > max) return null;
    return i;
}

function stableDiagnosticId({ source, severity, filePath, line, column, message, code }) {
    const key = [source || 'unknown', severity || 'info', filePath || '', line || 0, column || 0, message || '', code || ''].join('|');
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `diag_${(hash >>> 0).toString(16)}`;
}

function createDiagnostic({ source, severity, filePath, line, column, message, code, rawOutput }) {
    diagnosticsIdCounter++;
    const normalizedSeverity = ['error', 'warning', 'info'].includes(severity) ? severity : 'info';
    const normalizedLine = toSafeInt(line);
    const normalizedColumn = toSafeInt(column, 1, 10000);
    const normalizedMessage = String(message || '').trim().slice(0, MAX_MARKER_MESSAGE_CHARS);
    const normalizedFilePath = filePath ? String(filePath).trim() : null;
    const normalizedCode = code ? String(code).slice(0, 128) : null;
    return {
        id: stableDiagnosticId({
            source: source || 'unknown',
            severity: normalizedSeverity,
            filePath: normalizedFilePath,
            line: normalizedLine,
            column: normalizedColumn,
            message: normalizedMessage,
            code: normalizedCode
        }),
        source: source || 'unknown',
        severity: normalizedSeverity,
        filePath: normalizedFilePath,
        line: normalizedLine,
        column: normalizedColumn,
        message: normalizedMessage,
        code: normalizedCode,
        createdAt: new Date().toISOString(),
        rawOutput: rawOutput ? String(rawOutput).slice(0, 2000) : null
    };
}

function dedupeDiagnostics(list) {
    const map = new Map();
    for (const d of list) {
        if (!d || !d.id || !d.message) continue;
        if (!map.has(d.id)) map.set(d.id, d);
    }
    return Array.from(map.values()).slice(0, MAX_DIAGNOSTICS_PER_REFRESH);
}

function getDiagnosticsSummary() {
    let errors = 0, warnings = 0, info = 0;
    for (const d of diagnosticsStore) {
        if (d.severity === 'error') errors++;
        else if (d.severity === 'warning') warnings++;
        else info++;
    }
    return { errors, warnings, info };
}

function clearDiagnostics() {
    diagnosticsStore = [];
    diagnosticsSources = [];
    return { ok: true, cleared: true, diagnostics: [], summary: getDiagnosticsSummary(), sources: [], warnings: [] };
}

function parseDiagnosticsFromNodeCheck(stdout, stderr, filePath) {
    const output = (stderr || '') + '\n' + (stdout || '');
    const results = [];
    // Node --check error pattern: filepath:line
    let foundLine = null;
    let foundCol = null;
    const lineMatch = output.match(/:(\d+)(?::(\d+))?\b/);
    if (lineMatch) {
        foundLine = parseInt(lineMatch[1], 10);
        foundCol = lineMatch[2] ? parseInt(lineMatch[2], 10) : null;
    }
    // Extract the core error message
    const msgMatch = output.match(/SyntaxError:\s*(.+)/i) || output.match(/Error:\s*(.+)/i);
    const message = msgMatch ? msgMatch[1].trim() : output.split('\n').filter(l => l.trim()).slice(-3).join(' ').trim();
    if (message) {
        results.push(createDiagnostic({
            source: 'node --check',
            severity: 'error',
            filePath,
            line: foundLine,
            column: foundCol,
            message,
            code: 'SYNTAX_ERROR',
            rawOutput: output.slice(0, 2000)
        }));
    }
    return results;
}

function parseDiagnosticsFromJobOutput(job) {
    if (!job || !job.stderr) return [];
    const results = [];
    const lines = String(job.stderr).split(/\r?\n/);
    for (const line of lines) {
        // Common error patterns: file:line:col: error: message
        const match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|info|Error|Warning):\s*(.+)/i);
        if (match) {
            results.push(createDiagnostic({
                source: `job:${job.id}`,
                severity: match[4].toLowerCase() === 'error' ? 'error' : match[4].toLowerCase() === 'warning' ? 'warning' : 'info',
                filePath: match[1],
                line: parseInt(match[2], 10),
                column: match[3] ? parseInt(match[3], 10) : null,
                message: match[5].trim(),
                code: null,
                rawOutput: line
            }));
        }
    }
    return results;
}

async function refreshDiagnostics() {
    const start = Date.now();
    diagnosticsStore = [];
    diagnosticsSources = [];
    const warnings = [];

    // Source 1: node --check for .js/.mjs files in workspace
    try {
        const files = getFilesFlat(currentWorkspace);
        let checkableFiles = files.filter(f =>
            (f.name.endsWith('.js') || f.name.endsWith('.mjs') || f.name.endsWith('.cjs')) &&
            !f.relPath.includes('node_modules') &&
            f.size < 500 * 1024
        );
        const diagTmpDir = path.join(currentWorkspace, '.nvidia-agent', 'tmp');
        if (fs.existsSync(diagTmpDir)) {
            for (const name of fs.readdirSync(diagTmpDir)) {
                if (!/\.(mjs|js|cjs)$/i.test(name)) continue;
                const abs = path.join(diagTmpDir, name);
                try {
                    const stat = fs.statSync(abs);
                    if (!stat.isFile() || stat.size >= 500 * 1024) continue;
                    checkableFiles.push({
                        path: abs,
                        relPath: path.relative(currentWorkspace, abs),
                        name,
                        size: stat.size
                    });
                } catch {
                    // ignore unreadable tmp files
                }
            }
        }
        checkableFiles = checkableFiles.sort((a, b) => {
            const aTmp = a.relPath.includes('.nvidia-agent\\tmp') || a.relPath.includes('.nvidia-agent/tmp');
            const bTmp = b.relPath.includes('.nvidia-agent\\tmp') || b.relPath.includes('.nvidia-agent/tmp');
            if (aTmp && !bTmp) return -1;
            if (!aTmp && bTmp) return 1;
            return a.relPath.localeCompare(b.relPath);
        }).slice(0, 200); // Limit for safety while keeping temp smoke files discoverable

        diagnosticsSources.push('node --check');
        let checkedCount = 0;
        for (const file of checkableFiles) {
            try {
                await new Promise((resolve) => {
                    exec(`node --check ${JSON.stringify(file.path)}`, {
                        cwd: currentWorkspace,
                        timeout: 10000,
                        windowsHide: true
                    }, (err, stdout, stderr) => {
                        if (err) {
                            const diags = parseDiagnosticsFromNodeCheck(stdout, stderr, file.relPath);
                            diagnosticsStore.push(...diags);
                        }
                        resolve();
                    });
                });
                checkedCount++;
            } catch {
                // Skip files that fail to check
            }
        }
        if (checkedCount > 0) {
            console.log(`[DIAG] Checked ${checkedCount} JS/MJS files via node --check`);
        }
    } catch (e) {
        warnings.push(`node --check source failed: ${e.message}`);
    }

    // Source 2: Parse recent failed command job outputs
    try {
        const jobs = Array.from(commandJobs.values())
            .filter(j => j.status === 'failed' || (j.status === 'completed' && j.exitCode !== 0))
            .slice(-10);
        if (jobs.length > 0) {
            diagnosticsSources.push('job-output');
            for (const job of jobs) {
                const diags = parseDiagnosticsFromJobOutput(job);
                diagnosticsStore.push(...diags);
            }
        }
    } catch (e) {
        warnings.push(`Job output parsing failed: ${e.message}`);
    }

    diagnosticsStore = dedupeDiagnostics(diagnosticsStore);
    const summary = getDiagnosticsSummary();
    console.log(`[DIAG] Refresh complete: ${diagnosticsStore.length} diagnostics (${summary.errors}E/${summary.warnings}W/${summary.info}I) in ${Date.now() - start}ms`);
    return {
        ok: true,
        diagnostics: diagnosticsStore,
        summary,
        sources: diagnosticsSources,
        warnings
    };
}

let currentWorkspace = process.cwd();
const nimRequestLog = [];
let lastNimRateLimitHit = null;
const pendingEdits = new Map();
const commandJobs = new Map();

// --- Task Timeline & Persistence (Sprint 12) ---
const taskStore = new Map();
const TASK_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled', 'paused', 'needs_user']);
const STEP_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'skipped', 'blocked']);
const MAX_TASK_TITLE_CHARS = 200;
const MAX_TASK_TEXT_CHARS = 1200;
const MAX_TASK_STEPS = 200;
const MAX_TASK_WARNINGS = 50;
const MAX_TASK_ERRORS = 50;
const MAX_TASK_RECOVERY_HINTS = 50;

function sanitizeTaskText(value, limit = MAX_TASK_TEXT_CHARS) {
    return redactSecrets(String(value ?? '').trim()).slice(0, limit);
}

function sanitizeArrayText(values, maxItems, limit = MAX_TASK_TEXT_CHARS) {
    if (!Array.isArray(values)) return [];
    return values.slice(0, maxItems).map(v => sanitizeTaskText(v, limit)).filter(Boolean);
}

function sanitizeTaskStep(input = {}) {
    const status = STEP_STATUSES.has(input.status) ? input.status : 'pending';
    const startedAt = input.startedAt || (status === 'running' ? new Date().toISOString() : null);
    const endedAt = ['completed', 'failed', 'skipped', 'blocked'].includes(status) ? (input.endedAt || new Date().toISOString()) : null;
    return {
        stepId: sanitizeTaskText(input.stepId || `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, 120),
        label: sanitizeTaskText(input.label || 'Step'),
        status,
        startedAt,
        endedAt,
        toolName: sanitizeTaskText(input.toolName || '', 120),
        inputSummary: sanitizeTaskText(input.inputSummary || '', 500),
        outputSummary: sanitizeTaskText(input.outputSummary || '', 500),
        evidenceRefs: sanitizeArrayText(input.evidenceRefs, 20, 200),
        errorSummary: sanitizeTaskText(input.errorSummary || '', 500),
        nextActionHint: sanitizeTaskText(input.nextActionHint || '', 300)
    };
}

function toTaskView(task) {
    return {
        id: task.id,
        taskId: task.id,
        title: task.title,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        currentStepId: task.currentStepId || null,
        steps: Array.isArray(task.steps) ? task.steps.slice(-MAX_TASK_STEPS) : [],
        warnings: Array.isArray(task.warnings) ? task.warnings.slice(-MAX_TASK_WARNINGS) : [],
        errors: Array.isArray(task.errors) ? task.errors.slice(-MAX_TASK_ERRORS) : [],
        recoveryHints: Array.isArray(task.recoveryHints) ? task.recoveryHints.slice(-MAX_TASK_RECOVERY_HINTS) : [],
        resumeAvailable: task.resumeAvailable === true
    };
}

function normalizeTask(task = {}) {
    const id = sanitizeTaskText(task.id || task.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, 120);
    const status = TASK_STATUSES.has(task.status) ? task.status : 'needs_user';
    const nowIso = new Date().toISOString();
    return {
        id,
        title: sanitizeTaskText(task.title || 'Task', MAX_TASK_TITLE_CHARS),
        status,
        createdAt: task.createdAt || nowIso,
        updatedAt: task.updatedAt || nowIso,
        currentStepId: sanitizeTaskText(task.currentStepId || '', 120) || null,
        steps: Array.isArray(task.steps) ? task.steps.map(sanitizeTaskStep).slice(-MAX_TASK_STEPS) : [],
        warnings: sanitizeArrayText(task.warnings, MAX_TASK_WARNINGS, 400),
        errors: sanitizeArrayText(task.errors, MAX_TASK_ERRORS, 400),
        recoveryHints: sanitizeArrayText(task.recoveryHints, MAX_TASK_RECOVERY_HINTS, 400),
        resumeAvailable: task.resumeAvailable === true
    };
}

function loadTasks() {
    if (!fs.existsSync(TASKS_DIR)) return;
    const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
            const task = normalizeTask(parsed);
            taskStore.set(task.id, task);
        } catch (e) {
            console.error(`[TASKS] Failed to load ${file}: ${e.message}`);
        }
    }
}

function saveTask(task) {
    const normalized = normalizeTask(task);
    taskStore.set(normalized.id, normalized);
    const safeTask = { ...normalized };
    if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.writeFileSync(path.join(TASKS_DIR, `${normalized.id}.json`), JSON.stringify(safeTask, null, 2));
}

function createTask(title = 'New Task', model = 'auto') {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task = {
        id,
        title: sanitizeTaskText(title || 'Task', MAX_TASK_TITLE_CHARS),
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentStepId: null,
        steps: [],
        warnings: [],
        errors: [],
        recoveryHints: [],
        resumeAvailable: true
    };
    saveTask(task);
    return normalizeTask(taskStore.get(id));
}

function recordTaskEvent(taskId, event) {
    const task = taskStore.get(taskId);
    if (!task) return;

    const nowIso = new Date().toISOString();
    task.updatedAt = nowIso;
    if (event.status && TASK_STATUSES.has(event.status)) task.status = event.status;

    if (event.type === 'tool_start' || event.type === 'tool_result' || event.type === 'step') {
        const step = sanitizeTaskStep({
            stepId: event.stepId || `${event.iteration || 'iter'}-${event.tool || event.label || 'step'}`,
            label: event.label || event.tool || event.type || 'step',
            status: event.stepStatus || (event.ok === false ? 'failed' : (event.type === 'tool_start' ? 'running' : 'completed')),
            startedAt: event.startedAt || nowIso,
            endedAt: event.endedAt || (event.type === 'tool_result' ? nowIso : null),
            toolName: event.tool || '',
            inputSummary: event.arguments || event.inputSummary || '',
            outputSummary: event.result || event.outputSummary || event.content || '',
            evidenceRefs: event.evidenceRefs || [],
            errorSummary: event.ok === false ? (event.errorSummary || event.result || 'Step failed') : (event.errorSummary || ''),
            nextActionHint: event.nextActionHint || ''
        });
        task.currentStepId = step.stepId;
        task.steps.push(step);
        if (task.steps.length > MAX_TASK_STEPS) task.steps = task.steps.slice(-MAX_TASK_STEPS);
    }

    if (event.warning) {
        task.warnings.push(sanitizeTaskText(event.warning, 400));
        if (task.warnings.length > MAX_TASK_WARNINGS) task.warnings = task.warnings.slice(-MAX_TASK_WARNINGS);
    }
    if (event.error || event.errorSummary) {
        task.errors.push(sanitizeTaskText(event.error || event.errorSummary, 400));
        if (task.errors.length > MAX_TASK_ERRORS) task.errors = task.errors.slice(-MAX_TASK_ERRORS);
    }
    if (event.recoveryHint) {
        task.recoveryHints.push(sanitizeTaskText(event.recoveryHint, 400));
        if (task.recoveryHints.length > MAX_TASK_RECOVERY_HINTS) task.recoveryHints = task.recoveryHints.slice(-MAX_TASK_RECOVERY_HINTS);
    }
    if (typeof event.resumeAvailable === 'boolean') task.resumeAvailable = event.resumeAvailable;
    if (['cancelled', 'completed'].includes(task.status)) task.resumeAvailable = false;
    if (['paused', 'failed', 'needs_user'].includes(task.status) && task.resumeAvailable !== false) task.resumeAvailable = true;

    saveTask(task);
}

loadTasks();

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
if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });

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

const KNOWN_PROVIDER_DEFAULTS = {
    nvidia: { label: 'NVIDIA NIM', type: 'nvidia', baseUrl: process.env.NVIDIA_BASE_URL || NIM_BASE_URL, defaultModel: process.env.NVIDIA_DEFAULT_MODEL || DEFAULT_MODEL },
    openai: { label: 'OpenAI', type: 'openai', baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', defaultModel: process.env.OPENAI_DEFAULT_MODEL || 'gpt-4.1-mini' },
    anthropic: { label: 'Anthropic', type: 'anthropic', baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1', defaultModel: process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-3-5-sonnet-latest' },
    gemini: { label: 'Google Gemini', type: 'gemini', baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta', defaultModel: process.env.GEMINI_DEFAULT_MODEL || 'gemini-1.5-pro' },
    deepseek: { label: 'DeepSeek', type: 'deepseek', baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1', defaultModel: process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-chat' },
    openrouter: { label: 'OpenRouter', type: 'openrouter', baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1', defaultModel: process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini' },
    local: { label: 'Local Endpoint', type: 'local', baseUrl: process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1', defaultModel: process.env.LOCAL_LLM_MODEL || '' }
};

const PROVIDER_ENV_KEYS = {
    nvidia: { apiKey: 'NVIDIA_API_KEY', baseUrl: 'NVIDIA_BASE_URL', defaultModel: 'NVIDIA_DEFAULT_MODEL' },
    openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL', defaultModel: 'OPENAI_DEFAULT_MODEL' },
    anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL', defaultModel: 'ANTHROPIC_DEFAULT_MODEL' },
    gemini: { apiKey: 'GEMINI_API_KEY', baseUrl: 'GEMINI_BASE_URL', defaultModel: 'GEMINI_DEFAULT_MODEL' },
    deepseek: { apiKey: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL', defaultModel: 'DEEPSEEK_DEFAULT_MODEL' },
    openrouter: { apiKey: 'OPENROUTER_API_KEY', baseUrl: 'OPENROUTER_BASE_URL', defaultModel: 'OPENROUTER_DEFAULT_MODEL' },
    local: { apiKey: 'LOCAL_LLM_API_KEY', baseUrl: 'LOCAL_LLM_BASE_URL', defaultModel: 'LOCAL_LLM_MODEL' }
};

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const MAX_PROVIDER_LABEL = 80;
const MAX_PROVIDER_TYPE = 40;
const MAX_PROVIDER_BASE_URL = 300;
const MAX_PROVIDER_MODEL = 120;
const MAX_PROVIDER_MESSAGE = 300;
const MAX_PROVIDER_RECORDS = 40;
const MAX_INLINE_SELECTION_CHARS = 12000;
const MAX_INLINE_INSTRUCTION_CHARS = 800;

function nowIso() {
    return new Date().toISOString();
}

function maskApiKey(raw = '') {
    const token = String(raw || '').trim();
    if (!token) return '';
    if (token.length <= 6) return '***';
    return `${token.slice(0, 3)}...${token.slice(-4)}`;
}

function normalizeProviderId(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (!PROVIDER_ID_RE.test(clean)) throw new Error('Invalid provider id. Use lowercase letters, numbers, underscore, hyphen.');
    return clean;
}

function readStringField(value, maxLen, fieldName) {
    const text = String(value ?? '').trim();
    if (text.length > maxLen) {
        throw new Error(`${fieldName} is too long. Max ${maxLen} characters.`);
    }
    return text;
}

function normalizeProviderRecord(input = {}, previous = null) {
    const id = normalizeProviderId(input.id || previous?.id);
    const defaults = KNOWN_PROVIDER_DEFAULTS[id] || {};
    const label = readStringField(input.label ?? previous?.label ?? defaults.label ?? id, MAX_PROVIDER_LABEL, 'label');
    const type = readStringField(input.type ?? previous?.type ?? defaults.type ?? id, MAX_PROVIDER_TYPE, 'type').toLowerCase();
    const baseUrl = readStringField(input.baseUrl ?? previous?.baseUrl ?? defaults.baseUrl ?? '', MAX_PROVIDER_BASE_URL, 'baseUrl');
    const defaultModel = readStringField(input.defaultModel ?? previous?.defaultModel ?? defaults.defaultModel ?? '', MAX_PROVIDER_MODEL, 'defaultModel');
    const enabled = input.enabled === undefined ? (previous?.enabled !== false) : input.enabled === true;
    const lastTestStatus = String(input.lastTestStatus ?? previous?.lastTestStatus ?? 'untested').trim().toLowerCase();
    const lastTestAt = input.lastTestAt ? String(input.lastTestAt) : (previous?.lastTestAt || null);
    const lastTestMessage = readStringField(input.lastTestMessage ?? previous?.lastTestMessage ?? '', MAX_PROVIDER_MESSAGE, 'lastTestMessage');
    const keyRaw = input.apiKey !== undefined ? String(input.apiKey || '').trim() : (previous?.apiKey || '');
    if (keyRaw.length > 400) throw new Error('apiKey is too long. Max 400 characters.');
    const apiKey = keyRaw ? keyRaw : '';
    return {
        id,
        label: label || id,
        type: type || id,
        baseUrl,
        defaultModel,
        enabled,
        lastTestStatus: ['ok', 'failed', 'untested'].includes(lastTestStatus) ? lastTestStatus : 'untested',
        lastTestAt,
        lastTestMessage,
        apiKey
    };
}

function buildDefaultProviderState() {
    const nvidia = normalizeProviderRecord({
        id: 'nvidia',
        label: KNOWN_PROVIDER_DEFAULTS.nvidia.label,
        type: 'nvidia',
        baseUrl: KNOWN_PROVIDER_DEFAULTS.nvidia.baseUrl,
        defaultModel: KNOWN_PROVIDER_DEFAULTS.nvidia.defaultModel,
        enabled: true
    });
    return {
        version: 1,
        updatedAt: nowIso(),
        defaultProviderId: 'nvidia',
        providers: [nvidia]
    };
}

function loadProviderState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
        const list = Array.isArray(parsed.providers) ? parsed.providers.slice(0, MAX_PROVIDER_RECORDS).map(item => normalizeProviderRecord(item)) : [];
        const dedup = new Map(list.map(item => [item.id, item]));
        if (!dedup.has('nvidia')) dedup.set('nvidia', normalizeProviderRecord({ id: 'nvidia', enabled: true }));
        const providers = Array.from(dedup.values());
        const defaultProviderId = providers.some(p => p.id === parsed.defaultProviderId) ? parsed.defaultProviderId : 'nvidia';
        return {
            version: 1,
            updatedAt: parsed.updatedAt || nowIso(),
            defaultProviderId,
            providers
        };
    } catch {
        return buildDefaultProviderState();
    }
}

function saveProviderState(state) {
    const next = {
        version: 1,
        updatedAt: nowIso(),
        defaultProviderId: state.defaultProviderId,
        providers: state.providers.slice(0, MAX_PROVIDER_RECORDS).map(item => normalizeProviderRecord(item))
    };
    if (!next.providers.some(p => p.id === next.defaultProviderId)) next.defaultProviderId = 'nvidia';
    fs.mkdirSync(path.dirname(PROVIDERS_FILE), { recursive: true });
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(next, null, 2));
    return next;
}

function getProviderEnvValue(providerId, field) {
    const envMap = PROVIDER_ENV_KEYS[providerId] || {};
    const envKey = envMap[field];
    return envKey ? (process.env[envKey] || '') : '';
}

function providerToClientRecord(provider) {
    const envApiKey = getProviderEnvValue(provider.id, 'apiKey');
    const hasStoredApiKey = !!provider.apiKey;
    const hasEnvApiKey = !!envApiKey;
    const effectiveBaseUrl = provider.baseUrl || getProviderEnvValue(provider.id, 'baseUrl') || '';
    const effectiveModel = provider.defaultModel || getProviderEnvValue(provider.id, 'defaultModel') || '';
    return {
        id: provider.id,
        label: provider.label,
        type: provider.type,
        baseUrl: effectiveBaseUrl,
        defaultModel: effectiveModel,
        enabled: provider.enabled !== false,
        apiKeyRef: hasStoredApiKey ? 'stored' : (hasEnvApiKey ? 'env' : null),
        hasApiKey: hasStoredApiKey || hasEnvApiKey,
        apiKeyPreview: hasStoredApiKey ? maskApiKey(provider.apiKey) : (hasEnvApiKey ? `${provider.id}-env` : ''),
        lastTestStatus: provider.lastTestStatus || 'untested',
        lastTestAt: provider.lastTestAt || null,
        warning: provider.lastTestStatus === 'failed' ? (provider.lastTestMessage || 'Last test failed') : '',
        message: provider.lastTestMessage || ''
    };
}

function getSettingsPayload() {
    const state = loadProviderState();
    const settings = {
        defaultProviderId: state.defaultProviderId,
        providerPrecedence: 'runtime-settings-then-env-fallback',
        sprint: '10',
        secretStorage: 'local plaintext under .nvidia-agent/providers.json'
    };
    return {
        ok: true,
        settings,
        providers: state.providers.map(providerToClientRecord),
        warnings: ['Provider/API key storage is local plaintext runtime state; encryption is not implemented in Sprint 10.']
    };
}

function ensureIdeMutationAllowed(req) {
    enforcePermission(req, 'file.write');
}

function toPermissionStatusCode(reason = '') {
    const lowered = String(reason || '').toLowerCase();
    if (lowered.includes('unknown action type')) return 400;
    if (lowered.includes('requires x-agent-approved') || lowered.includes('requires ide mode') || lowered.includes('trusted workspace') || lowered.includes('reserved')) return 403;
    if (lowered.includes('confirm') || lowered.includes('outside workspace') || lowered.includes('invalid')) return 400;
    return 403;
}

function summarizePermissionTarget(targetSummary = '') {
    const summary = String(targetSummary || '').replace(/\s+/g, ' ').trim();
    return redactSecrets(summary).slice(0, 200);
}

function appendPermissionAudit(entry = {}) {
    try {
        fs.mkdirSync(SECURITY_DIR, { recursive: true });
        const safeEntry = {
            timestamp: nowIso(),
            actionType: String(entry.actionType || ''),
            decision: entry.decision === 'allow' ? 'allow' : 'deny',
            reason: redactSecrets(String(entry.reason || '')).slice(0, 300),
            uiMode: entry.uiMode === 'ide' ? 'ide' : 'enterprise',
            trustedWorkspace: entry.trustedWorkspace === true,
            hasApprovalHeader: entry.hasApprovalHeader === true,
            riskLevel: String(entry.riskLevel || 'unknown'),
            targetSummary: summarizePermissionTarget(entry.targetSummary),
            requestId: entry.requestId ? String(entry.requestId).slice(0, 100) : null
        };
        fs.appendFileSync(PERMISSION_AUDIT_LOG, `${JSON.stringify(safeEntry)}\n`, 'utf8');
    } catch {
        // Non-fatal: do not break the request path if audit logging fails.
    }
}

function readPermissionAuditTail(limit = 50) {
    try {
        if (!fs.existsSync(PERMISSION_AUDIT_LOG)) return [];
        const lines = fs.readFileSync(PERMISSION_AUDIT_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
        const slice = lines.slice(Math.max(0, lines.length - Math.max(1, Math.min(Number(limit) || 50, 200))));
        return slice.map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
    } catch {
        return [];
    }
}

function checkPermission(req, actionType, options = {}) {
    const profile = loadProfile();
    const hasApproval = req?.headers?.['x-agent-approved'] === 'true';
    const isTrusted = isWorkspaceTrusted();
    const targetSummary = summarizePermissionTarget(options.targetSummary);
    const reservedActions = new Set(['abw.bridge.reserved', 'git.commit', 'git.push']);
    const result = workspaceCore.checkPermission({
        actionType,
        uiMode: profile.uiMode,
        hasApproval,
        isTrusted,
        isReservedAction: reservedActions.has(actionType)
    });
    const requiresConfirmation = options.requiresConfirmation === true;
    const hasConfirmation = options.hasConfirmation === true;
    if (result.allow && requiresConfirmation && !hasConfirmation) {
        result.allow = false;
        result.reason = `Action ${actionType} requires explicit confirmation.`;
    }
    appendPermissionAudit({
        actionType,
        decision: result.allow ? 'allow' : 'deny',
        reason: result.reason,
        uiMode: profile.uiMode,
        trustedWorkspace: isTrusted,
        hasApprovalHeader: hasApproval,
        riskLevel: result.riskLevel || 'unknown',
        targetSummary,
        requestId: req?.headers?.['x-request-id'] || null
    });
    return { ...result, uiMode: profile.uiMode, trustedWorkspace: isTrusted, hasApprovalHeader: hasApproval };
}

function enforcePermission(req, actionType, options = {}) {
    const result = checkPermission(req, actionType, options);
    if (!result.allow) {
        const err = new Error(result.reason || `Permission denied for ${actionType}`);
        err.statusCode = toPermissionStatusCode(result.reason);
        err.permission = result;
        throw err;
    }
    return result;
}

function actionTypeForTool(toolName = '') {
    const map = {
        write_file: 'file.write',
        apply_patch: 'file.apply_edit',
        apply_pending_edit: 'file.apply_edit',
        discard_pending_edit: 'file.apply_edit',
        execute_command: 'terminal.run',
        start_command_job: 'terminal.run',
        cancel_command_job: 'job.cancel',
        git_stage: 'git.stage',
        git_unstage: 'git.unstage',
        git_discard: 'git.discard'
    };
    return map[String(toolName || '').trim()] || null;
}

function resolveProviderForChat(requestedModel = '') {
    const state = loadProviderState();
    const preferred = state.providers.find(p => p.id === state.defaultProviderId && p.enabled !== false) || state.providers.find(p => p.id === 'nvidia');
    const nvidia = state.providers.find(p => p.id === 'nvidia') || normalizeProviderRecord({ id: 'nvidia', enabled: true });
    const warnings = [];
    let active = preferred || nvidia;
    if (active.id !== 'nvidia') {
        warnings.push(`Provider ${active.id} is not implemented for /proxy/chat yet. Falling back to nvidia.`);
        active = nvidia;
    }
    const apiKey = active.apiKey || getProviderEnvValue('nvidia', 'apiKey') || process.env.NVIDIA_API_KEY || '';
    const baseUrl = active.baseUrl || getProviderEnvValue('nvidia', 'baseUrl') || NIM_BASE_URL;
    const defaultModel = active.defaultModel || getProviderEnvValue('nvidia', 'defaultModel') || DEFAULT_MODEL;
    const model = requestedModel && requestedModel !== 'auto' ? requestedModel : defaultModel;
    return { provider: active, apiKey, baseUrl, model, warnings };
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
    const baseUrl = options.baseUrl || NIM_BASE_URL;
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
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
    // Sprint 8: Real diagnostics context from in-memory store
    if (diagnosticsStore.length === 0) {
        return `--- PROBLEMS CONTEXT ---\nNo diagnostics detected in the current workspace.\n`;
    }
    const summary = getDiagnosticsSummary();
    const lines = diagnosticsStore.slice(0, 30).map(d =>
        `[${d.severity.toUpperCase()}] ${d.filePath || '(no file)'}${d.line ? ':' + d.line : ''}${d.column ? ':' + d.column : ''} - ${d.message}${d.source ? ' (source: ' + d.source + ')' : ''}`
    );
    return `--- PROBLEMS CONTEXT ---\nSummary: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.info} info\n${lines.join('\n')}\n${diagnosticsStore.length > 30 ? `[${diagnosticsStore.length - 30} more diagnostics truncated]\n` : ''}`;
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
                name: 'git_status',
                description: 'Get detailed git status: branch, staged/untracked/changed files with status labels.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'git_diff',
                description: 'Get git diff output. Returns full working tree diff or diff for a specific file.',
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Optional: workspace-relative file path for file-specific diff.' },
                        cached: { type: 'boolean', description: 'Optional: show staged diff instead of working tree diff.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'git_file_diff',
                description: 'Get git diff for a single file. Requires filePath.',
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Workspace-relative file path.' },
                        cached: { type: 'boolean' }
                    },
                    required: ['filePath']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'git_log',
                description: 'Get recent git commit log.',
                parameters: {
                    type: 'object',
                    properties: {
                        count: { type: 'integer', minimum: 1, maximum: 100 },
                        branch: { type: 'string' },
                        filePath: { type: 'string' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'git_stage',
                description: 'Stage files for commit. Requires trusted workspace.',
                parameters: {
                    type: 'object',
                    properties: {
                        files: { type: 'array', items: { type: 'string' }, description: 'File paths to stage.' },
                        all: { type: 'boolean', description: 'Stage all changes.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'git_unstage',
                description: 'Unstage files from the index. Requires trusted workspace.',
                parameters: {
                    type: 'object',
                    properties: {
                        files: { type: 'array', items: { type: 'string' }, description: 'File paths to unstage.' },
                        all: { type: 'boolean', description: 'Unstage all changes.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'git_discard',
                description: 'Discard working-tree changes for files. DESTRUCTIVE - requires confirm:true.',
                parameters: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string' },
                        files: { type: 'array', items: { type: 'string' } },
                        confirm: { type: 'boolean', description: 'Must be set to true to confirm the destructive operation.' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'git_commit_draft',
                description: 'Generate a commit message draft based on the current git diff and status.',
                parameters: {
                    type: 'object',
                    properties: {
                        style: { type: 'string', enum: ['conventional', 'simple'] }
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
        if (['project_indexer', 'semantic_index', 'index_status', 'index_build', 'index_refresh', 'index_search', 'git_context', 'git_status', 'git_diff', 'git_file_diff', 'git_log', 'git_stage', 'git_unstage', 'git_discard', 'git_commit_draft', 'list_dir', 'read_file', 'read_file_paged', 'write_file', 'apply_patch', 'apply_pending_edit', 'discard_pending_edit', 'search_files', 'search', 'execute_command', 'start_command_job', 'command_job_status', 'cancel_command_job'].includes(name)) {
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

async function callNimChat(payload, signal, providerConfig = {}) {
    const apiKey = providerConfig.apiKey || process.env.NVIDIA_API_KEY || '';
    const baseUrl = providerConfig.baseUrl || NIM_BASE_URL;
    const response = await fetchNim('/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal,
        baseUrl
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

async function callNimChatStream(payload, onEvent, signal, providerConfig = {}) {
    const apiKey = providerConfig.apiKey || process.env.NVIDIA_API_KEY || '';
    const baseUrl = providerConfig.baseUrl || NIM_BASE_URL;
    const response = await fetchNim('/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...payload, stream: true }),
        signal,
        baseUrl
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
    const providerResolved = resolveProviderForChat(data.model);
    const model = data.model && data.model !== 'auto' ? data.model : providerResolved.model;
    const maxIterations = Math.max(1, Math.min(Number(data.max_iterations || data.maxIterations) || DEFAULT_MAX_ITERATIONS, 20));
    const tools = getAgentTools();
    const messages = await prepareMessages(data);
    if (providerResolved.warnings?.length) {
        messages.unshift({
            role: 'system',
            content: `Provider warning: ${providerResolved.warnings.join(' ')}`
        });
    }
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
    let terminalStatus = 'running';
    const emit = (name, payload) => {
        try {
            callbacks[name]?.(payload);
            if (data.taskId) {
                if (name === 'status') {
                    recordTaskEvent(data.taskId, { type: 'status', ...payload });
                } else if (name === 'tool_start') {
                    recordTaskEvent(data.taskId, { type: 'tool_start', ...payload });
                } else if (name === 'tool_result') {
                    recordTaskEvent(data.taskId, { type: 'tool_result', ...payload });
                }
            }
        } catch (e) {
            events.push({ type: 'callback_error', callback: name, error: e.message });
        }
    };

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (signal?.aborted) {
            finalMessage = { role: 'assistant', content: 'Đã dừng theo yêu cầu của người dùng.' };
            events.push({ type: 'status', iteration, status: 'aborted' });
            terminalStatus = 'paused';
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
            ? await callNimChatStream(payload, callbacks.event, signal, providerResolved)
            : await callNimChat(payload, signal, providerResolved);

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
            const ok = result?.ok !== false;

            emit('tool_result', { iteration, tool: toolName, ok, result: content });
            events.push({ type: 'tool_result', iteration, tool: toolName, ok, result: content });
            if (!ok) terminalStatus = 'failed';
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

    const result = {
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

    if (data.taskId) {
        if (terminalStatus === 'running') terminalStatus = 'completed';
        recordTaskEvent(data.taskId, {
            type: terminalStatus === 'completed' ? 'completed' : 'status',
            status: terminalStatus,
            content: typeof finalMessage.content === 'string' ? finalMessage.content.slice(0, 1000) : 'Task finished',
            resumeAvailable: ['paused', 'failed', 'needs_user'].includes(terminalStatus),
            recoveryHint: terminalStatus === 'paused' ? 'Resume can continue from saved context; review pending edits and diagnostics first.' : undefined
        });
    }

    return result;
}

async function handleProxyChat(req, res) {
    const data = await getBody(req);
    const providerResolved = resolveProviderForChat(data.model);
    console.log(`[POST] /proxy/chat - Provider: ${providerResolved.provider.id} Model: ${providerResolved.model}`);
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
    const providerResolved = resolveProviderForChat('auto');
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
                    'Authorization': `Bearer ${providerResolved.apiKey || ''}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1,
                    temperature: 0,
                    stream: true
                }),
                signal: controller.signal,
                baseUrl: providerResolved.baseUrl
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
    if (['list_dir', 'read_file', 'read_file_paged', 'write_file', 'apply_patch', 'apply_pending_edit', 'discard_pending_edit', 'pending_edits', 'search', 'search_files', 'semantic_index', 'index_status', 'index_build', 'index_refresh', 'index_search', 'git_context', 'git_status', 'git_diff', 'git_file_diff', 'git_log', 'git_stage', 'git_unstage', 'git_discard', 'git_commit_draft', 'execute_command', 'start_command_job', 'command_job_status', 'cancel_command_job', 'project_indexer'].includes(toolName)) {
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
                const providerResolved = resolveProviderForChat('auto');
                const response = await fetchNim('/models', {
                    headers: { 'Authorization': `Bearer ${providerResolved.apiKey || ''}` },
                    baseUrl: providerResolved.baseUrl
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
            if (req.url === '/api/settings') return sendJSON(res, 200, getSettingsPayload());
            if (req.url === '/api/providers') {
                const payload = getSettingsPayload();
                return sendJSON(res, 200, { ok: true, providers: payload.providers, warnings: payload.warnings });
            }
            if (req.url === '/api/permissions') {
                const profile = loadProfile();
                return sendJSON(res, 200, {
                    ok: true,
                    uiMode: profile.uiMode,
                    trustedWorkspace: isWorkspaceTrusted(),
                    warning: 'This is a basic permission model, not full sandboxing.',
                    permissions: workspaceCore.getAllPermissions()
                });
            }
            if (requestUrl.pathname === '/api/security/summary') {
                const profile = loadProfile();
                const entries = readPermissionAuditTail(200);
                const denied = entries.filter(e => e.decision === 'deny').length;
                const allowed = entries.filter(e => e.decision === 'allow').length;
                return sendJSON(res, 200, {
                    ok: true,
                    uiMode: profile.uiMode,
                    trustedWorkspace: isWorkspaceTrusted(),
                    warning: 'This is a basic permission model, not full sandboxing.',
                    totals: { entries: entries.length, allowed, denied },
                    recent: entries.slice(-20)
                });
            }
            if (requestUrl.pathname === '/api/security/audit_log') {
                const limit = Number(requestUrl.searchParams.get('limit') || 50);
                return sendJSON(res, 200, { ok: true, entries: readPermissionAuditTail(limit) });
            }
            if (req.url === '/api/pending_edits') return sendJSON(res, 200, { edits: workspaceCore.listPendingEditsTool() });
            if (req.url === '/api/command_jobs') return sendJSON(res, 200, { jobs: workspaceCore.commandJobStatusTool({}) });
            if (req.url === '/api/tools') return sendJSON(res, 200, { tools: getAgentTools() });
            if (req.url === '/api/rate_limit') return sendJSON(res, 200, getRateLimitStatus());

            // Sprint 12: Tasks API
            if (req.url === '/api/tasks') {
                const tasks = Array.from(taskStore.values())
                    .map(toTaskView)
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                return sendJSON(res, 200, { ok: true, tasks });
            }

            // Sprint 8: Diagnostics API (read-only, safe for enterprise mode)
            if (req.url === '/api/diagnostics') {
                return sendJSON(res, 200, {
                    ok: true,
                    diagnostics: diagnosticsStore,
                    result: diagnosticsStore,
                    summary: getDiagnosticsSummary(),
                    sources: diagnosticsSources,
                    warnings: []
                });
            }

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

            // Sprint 13: Git / SCM Panel API (read-only)
            if (req.url === '/api/git/status') {
              try {
                const status = await workspaceCore.callTool('git_status', {});
                return sendJSON(res, 200, status);
              } catch (e) {
                return sendJSON(res, 500, { ok: false, isRepo: false, error: redactSecrets(e.message) });
              }
            }

            if (requestUrl.pathname === '/api/git/diff') {
              try {
                const file = requestUrl.searchParams.get('file') || '';
                const cached = requestUrl.searchParams.get('cached') === 'true';
                const diff = await workspaceCore.callTool('git_diff', { filePath: file || undefined, cached });
                return sendJSON(res, 200, diff);
              } catch (e) {
                return sendJSON(res, 500, { ok: false, error: redactSecrets(e.message) });
              }
            }

            if (requestUrl.pathname === '/api/git/log') {
              try {
                const count = Number(requestUrl.searchParams.get('count') || 10);
                const branch = requestUrl.searchParams.get('branch') || '';
                const file = requestUrl.searchParams.get('file') || '';
                const log = await workspaceCore.callTool('git_log', {
                  count: Math.max(1, Math.min(count, 100)),
                  branch: branch || undefined,
                  filePath: file || undefined
                });
                return sendJSON(res, 200, log);
              } catch (e) {
                return sendJSON(res, 500, { ok: false, error: redactSecrets(e.message) });
              }
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

        if (req.url === '/api/permissions/check') {
            const body = await getBody(req);
            const actionType = String(body.actionType || '').trim();
            if (!actionType) return sendJSON(res, 400, { ok: false, error: 'actionType is required' });
            const result = checkPermission(req, actionType, {
                requiresConfirmation: body.confirmationRequired === true,
                hasConfirmation: body.confirm === true,
                targetSummary: body.targetSummary || ''
            });
            if (!workspaceCore.getPermission(actionType)) {
                return sendJSON(res, 400, { ok: false, error: result.reason, permission: result });
            }
            const status = result.allow ? 200 : toPermissionStatusCode(result.reason);
            return sendJSON(res, status, {
                ok: result.allow,
                actionType,
                permission: result,
                warning: 'This is a basic permission model, not full sandboxing.'
            });
        }

        if (req.url === '/api/settings') {
            try {
                enforcePermission(req, 'provider.mutate', { targetSummary: 'settings.defaultProvider/defaultModel' });
                const body = await getBody(req);
                const state = loadProviderState();
                const requestedDefaultProviderId = body?.settings?.defaultProviderId || body?.defaultProviderId || state.defaultProviderId;
                const requestedDefaultModel = String(body?.settings?.defaultModel || '').trim().slice(0, MAX_PROVIDER_MODEL);
                if (!PROVIDER_ID_RE.test(String(requestedDefaultProviderId || ''))) {
                    return sendJSON(res, 400, { ok: false, error: 'Invalid defaultProviderId.' });
                }
                if (!state.providers.some(p => p.id === requestedDefaultProviderId)) {
                    return sendJSON(res, 400, { ok: false, error: `Unknown default provider: ${requestedDefaultProviderId}` });
                }
                state.defaultProviderId = requestedDefaultProviderId;
                if (requestedDefaultModel) {
                    state.providers = state.providers.map(p => p.id === requestedDefaultProviderId ? { ...p, defaultModel: requestedDefaultModel } : p);
                }
                saveProviderState(state);
                return sendJSON(res, 200, getSettingsPayload());
            } catch (e) {
                const status = e && Number.isInteger(e.statusCode) ? e.statusCode : 403;
                return sendJSON(res, status, { ok: false, error: redactSecrets(e.message) });
            }
        }

        if (req.url === '/api/providers') {
            try {
                enforcePermission(req, 'provider.mutate', { targetSummary: 'providers.upsert' });
                const body = await getBody(req);
                const inputProvider = body.provider && typeof body.provider === 'object' ? body.provider : body;
                const state = loadProviderState();
                const existing = state.providers.find(p => p.id === String(inputProvider.id || '').toLowerCase()) || null;
                const provider = normalizeProviderRecord(inputProvider, existing);
                state.providers = state.providers.filter(p => p.id !== provider.id);
                state.providers.push(provider);
                if (state.providers.length > MAX_PROVIDER_RECORDS) {
                    return sendJSON(res, 413, { ok: false, error: `Too many providers. Max ${MAX_PROVIDER_RECORDS}.` });
                }
                if (!state.defaultProviderId) state.defaultProviderId = 'nvidia';
                saveProviderState(state);
                return sendJSON(res, 200, { ok: true, provider: providerToClientRecord(provider), providers: state.providers.map(providerToClientRecord), warnings: [] });
            } catch (e) {
                const status = e && Number.isInteger(e.statusCode) ? e.statusCode : 400;
                return sendJSON(res, status, { ok: false, error: redactSecrets(e.message) });
            }
        }

        if (req.url === '/api/providers/default') {
            try {
                enforcePermission(req, 'provider.mutate', { targetSummary: 'providers.default' });
                const body = await getBody(req);
                const providerId = normalizeProviderId(body.id || body.providerId);
                const state = loadProviderState();
                if (!state.providers.some(p => p.id === providerId)) {
                    return sendJSON(res, 404, { ok: false, error: `Provider not found: ${providerId}` });
                }
                state.defaultProviderId = providerId;
                saveProviderState(state);
                return sendJSON(res, 200, { ok: true, settings: { defaultProviderId: providerId }, providers: state.providers.map(providerToClientRecord), warnings: [] });
            } catch (e) {
                const status = e && Number.isInteger(e.statusCode) ? e.statusCode : 400;
                return sendJSON(res, status, { ok: false, error: redactSecrets(e.message) });
            }
        }

        if (req.url === '/api/providers/clear_key') {
            try {
                enforcePermission(req, 'provider.mutate', { targetSummary: 'providers.clear_key' });
                const body = await getBody(req);
                const providerId = normalizeProviderId(body.id || body.providerId);
                const state = loadProviderState();
                let found = false;
                state.providers = state.providers.map(p => {
                    if (p.id !== providerId) return p;
                    found = true;
                    return { ...p, apiKey: '', lastTestStatus: 'untested', lastTestAt: nowIso(), lastTestMessage: 'API key cleared' };
                });
                if (!found) return sendJSON(res, 404, { ok: false, error: `Provider not found: ${providerId}` });
                saveProviderState(state);
                return sendJSON(res, 200, { ok: true, provider: providerToClientRecord(state.providers.find(p => p.id === providerId)), warnings: [] });
            } catch (e) {
                const status = e && Number.isInteger(e.statusCode) ? e.statusCode : 400;
                return sendJSON(res, status, { ok: false, error: redactSecrets(e.message) });
            }
        }

        if (req.url === '/api/providers/test') {
            try {
                enforcePermission(req, 'provider.mutate', { targetSummary: 'providers.test' });
                const body = await getBody(req);
                const providerId = normalizeProviderId(body.id || body.providerId);
                const state = loadProviderState();
                const provider = state.providers.find(p => p.id === providerId);
                if (!provider) return sendJSON(res, 404, { ok: false, error: `Provider not found: ${providerId}` });
                const keyCandidate = body.apiKey !== undefined ? String(body.apiKey || '').trim() : (provider.apiKey || getProviderEnvValue(providerId, 'apiKey') || '');
                let status = 'untested';
                let message = 'Connection test is not implemented for this provider in Sprint 10.';
                if (providerId === 'nvidia') {
                    if (!keyCandidate) {
                        status = 'failed';
                        message = 'Missing API key for NVIDIA provider.';
                    } else {
                        const timeoutMs = Math.max(2000, Math.min(Number(body.timeoutMs) || 8000, 20000));
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), timeoutMs);
                        try {
                            const response = await fetchNim('/models', {
                                method: 'GET',
                                headers: { 'Authorization': `Bearer ${keyCandidate}` },
                                baseUrl: provider.baseUrl || getProviderEnvValue('nvidia', 'baseUrl') || NIM_BASE_URL,
                                signal: controller.signal
                            }, 'provider.test.nvidia');
                            status = response.ok ? 'ok' : 'failed';
                            message = response.ok ? 'NVIDIA connection test passed.' : `NVIDIA connection test failed: HTTP ${response.status}`;
                        } catch (e) {
                            status = 'failed';
                            message = `NVIDIA connection test failed: ${redactSecrets(e.message).slice(0, MAX_PROVIDER_MESSAGE)}`;
                        } finally {
                            clearTimeout(timer);
                        }
                    }
                }
                state.providers = state.providers.map(p => p.id === providerId ? {
                    ...p,
                    apiKey: body.saveKey === true && body.apiKey !== undefined ? String(body.apiKey || '').trim().slice(0, 400) : p.apiKey,
                    lastTestStatus: status,
                    lastTestAt: nowIso(),
                    lastTestMessage: message
                } : p);
                saveProviderState(state);
                const updated = state.providers.find(p => p.id === providerId);
                return sendJSON(res, 200, {
                    ok: status === 'ok',
                    status,
                    provider: providerToClientRecord(updated),
                    warnings: status === 'untested' ? ['Provider test is not implemented for this provider in Sprint 10.'] : [],
                    reason: status === 'untested' ? 'not implemented' : undefined
                });
            } catch (e) {
                const status = e && Number.isInteger(e.statusCode) ? e.statusCode : 400;
                return sendJSON(res, status, { ok: false, status: 'failed', error: redactSecrets(e.message), warnings: [] });
            }
        }

        if (req.url === '/api/apply_pending_edit') {
            const body = await getBody(req);
            enforcePermission(req, 'file.apply_edit', { targetSummary: `apply_pending_edit:${String(body.id || '').slice(0, 60)}` });
            return sendJSON(res, 200, { result: workspaceCore.applyPendingEditTool(body) });
        }

        if (req.url === '/api/write_file') {
            const body = await getBody(req);
            enforcePermission(req, 'file.write', { targetSummary: `write_file:${String(body.path || '').slice(0, 120)}` });
            const result = await routeApiTool('write_file', { filePath: body.path, content: body.content, reason: 'Manual UI Save' });
            return sendJSON(res, 200, { ok: true, result });
        }

        if (req.url === '/api/discard_pending_edit') {
            const body = await getBody(req);
            enforcePermission(req, 'file.apply_edit', { targetSummary: `discard_pending_edit:${String(body.id || '').slice(0, 60)}` });
            return sendJSON(res, 200, { result: workspaceCore.discardPendingEditTool(body) });
        }

        if (req.url === '/api/inline_edit') {
            try {
                enforcePermission(req, 'inline_edit.generate', { targetSummary: 'inline_edit.generate' });
                const body = await getBody(req);
                const { filePath, instruction, selectedCode, startLine, endLine } = body;
                if (!filePath || !instruction || !selectedCode) {
                    return sendJSON(res, 400, { ok: false, error: 'filePath, instruction, and selectedCode are required.' });
                }
                const resolvedPath = resolveWorkspacePath(String(filePath));
                const relPath = path.relative(currentWorkspace, resolvedPath);
                const normalizedInstruction = String(instruction || '').trim();
                const normalizedSelectedCode = String(selectedCode || '');
                if (!normalizedInstruction) {
                    return sendJSON(res, 400, { ok: false, error: 'instruction must not be empty.' });
                }
                if (!normalizedSelectedCode.trim()) {
                    return sendJSON(res, 400, { ok: false, error: 'selectedCode must not be empty.' });
                }
                if (normalizedInstruction.length > MAX_INLINE_INSTRUCTION_CHARS) {
                    return sendJSON(res, 400, { ok: false, error: `instruction is too long. Max ${MAX_INLINE_INSTRUCTION_CHARS} characters.` });
                }
                if (normalizedSelectedCode.length > MAX_INLINE_SELECTION_CHARS) {
                    return sendJSON(res, 400, { ok: false, error: `selectedCode is too long. Max ${MAX_INLINE_SELECTION_CHARS} characters.` });
                }
                const start = Number(startLine);
                const end = Number(endLine);
                if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 2000) {
                    return sendJSON(res, 400, { ok: false, error: 'Invalid startLine/endLine range.' });
                }

                const providerResolved = resolveProviderForChat('auto');
                const prompt = `You are an expert coder. The user has selected the following code in ${relPath}:
\`\`\`
${normalizedSelectedCode}
\`\`\`
Instruction: ${normalizedInstruction}

Rewrite the selected code to fulfill the instruction. Output ONLY the rewritten code without any markdown blocks (like \`\`\`javascript) or explanations. If you cannot edit it, return the original code exactly.`;

                const completion = await callNimChat({
                    model: providerResolved.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1,
                    max_tokens: 4096
                }, null, providerResolved);

                let newCode = completion.choices[0].message.content.trim();
                newCode = newCode.replace(/^```[\w]*\n/i, '').replace(/\n```$/i, '');
                if (!newCode) {
                    return sendJSON(res, 400, { ok: false, status: 'failed', error: 'Inline edit model response was empty.' });
                }

                const result = await routeApiTool('apply_patch', {
                    filePath: relPath,
                    find: normalizedSelectedCode,
                    replace: newCode,
                    reason: 'Inline Edit: ' + normalizedInstruction.slice(0, 50)
                });

                return sendJSON(res, 200, { ok: true, pendingEdit: result.pendingEdit || result });
            } catch (e) {
                if (e && Number.isInteger(e.statusCode)) {
                    return sendJSON(res, e.statusCode, { ok: false, status: 'failed', error: redactSecrets(e.message) });
                }
                const safeMessage = redactSecrets(e.message);
                const lowered = String(safeMessage || '').toLowerCase();
                const statusCode = lowered.includes('x-agent-approved') || lowered.includes('ide-mode only')
                    ? 403
                    : lowered.includes('outside workspace') || lowered.includes('invalid')
                        ? 400
                        : 500;
                return sendJSON(res, statusCode, { ok: false, status: 'failed', error: safeMessage });
            }
        }

        if (req.url === '/api/install_extension') {
            const body = await getBody(req);
            enforcePermission(req, 'extension.install', { targetSummary: `install_extension:${String(body.path || '').slice(0, 120)}` });
            const installed = extensionHost.installFromFolder(body.path);
            return sendJSON(res, 200, { status: 'success', extension: installed });
        }

        if (req.url === '/api/extensions/install_folder') {
            const body = await getBody(req);
            enforcePermission(req, 'extension.install', { targetSummary: `extensions.install_folder:${String(body.path || '').slice(0, 120)}` });
            return sendJSON(res, 200, { status: 'success', extension: extensionHost.installFromFolder(body.path) });
        }

        if (req.url === '/api/extensions/install_vsix') {
            const body = await getBody(req);
            enforcePermission(req, 'extension.install', { targetSummary: `extensions.install_vsix:${String(body.path || '').slice(0, 120)}` });
            return sendJSON(res, 200, { status: 'success', extension: extensionHost.installFromVsix(body.path) });
        }

        if (req.url === '/api/extensions/install_openvsx') {
            const body = await getBody(req);
            enforcePermission(req, 'extension.install', { targetSummary: `extensions.install_openvsx:${String(body.id || body.name || '').slice(0, 120)}` });
            return sendJSON(res, 200, { status: 'success', extension: await extensionHost.installFromOpenVsx(body) });
        }

        if (req.url === '/api/extensions/enable') {
            const body = await getBody(req);
            enforcePermission(req, 'extension.mutate', { targetSummary: `extensions.enable:${String(body.id || '').slice(0, 120)}` });
            return sendJSON(res, 200, { status: 'success', extension: extensionHost.setEnabled(body.id, body.enabled === true) });
        }

        if (req.url === '/api/extensions/uninstall') {
            const body = await getBody(req);
            enforcePermission(req, 'extension.mutate', { targetSummary: `extensions.uninstall:${String(body.id || '').slice(0, 120)}` });
            return sendJSON(res, 200, { status: 'success', result: extensionHost.uninstall(body.id) });
        }

        if (req.url === '/api/extensions/activate') {
            const body = await getBody(req);
            enforcePermission(req, 'extension.mutate', { targetSummary: `extensions.activate:${String(body.id || body.event || '').slice(0, 120)}` });
            const result = body.event
                ? await extensionHost.activateByEvent(body.event)
                : await extensionHost.activateExtension(body.id, body.activationEvent || 'manual');
            return sendJSON(res, 200, { status: 'success', result, registeredCommands: extensionHost.listRegisteredCommands() });
        }

        if (req.url === '/api/extensions/run_command') {
            const body = await getBody(req);
            enforcePermission(req, 'extension.mutate', { targetSummary: `extensions.run_command:${String(body.command || '').slice(0, 120)}` });
            const result = await extensionHost.executeCommand(body.command, body.args || []);
            return sendJSON(res, 200, { status: 'success', result });
        }

        if (req.url === '/api/agent_providers/run') {
            const body = await getBody(req);
            enforcePermission(req, 'terminal.run', { targetSummary: `agent_provider.run:${String(body.id || '').slice(0, 60)}` });
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

        // Sprint 8: Diagnostics refresh (runs safe read-only checks; IDE mode only)
        if (req.url === '/api/diagnostics/refresh') {
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'diagnostics refresh requires explicit UI approval.' });
            enforcePermission(req, 'file.read', { targetSummary: 'diagnostics.refresh' });
            return sendJSON(res, 200, await refreshDiagnostics());
        }

        // Sprint 8: Diagnostics clear (safe, just clears in-memory store)
        if (req.url === '/api/diagnostics/clear') {
            return sendJSON(res, 200, clearDiagnostics());
        }

        // Sprint 8: Update from local IDE (Monaco LSP markers)
        if (req.url === '/api/diagnostics/update') {
            const body = await getBody(req);
            const { filePath, markers } = body;
            if (!filePath) return sendJSON(res, 400, { error: 'filePath is required' });
            if (typeof filePath !== 'string' || filePath.length > 2000) return sendJSON(res, 400, { error: 'filePath must be a safe string' });
            if (markers !== undefined && !Array.isArray(markers)) return sendJSON(res, 400, { error: 'markers must be an array' });
            if (Array.isArray(markers) && markers.length > MAX_MARKERS_PER_UPDATE) {
                return sendJSON(res, 413, { error: `Too many markers. Max ${MAX_MARKERS_PER_UPDATE}` });
            }
            
            // Remove old monaco diagnostics for this file
            diagnosticsStore = diagnosticsStore.filter(d => !(d.source === 'monaco' && d.filePath === filePath));
            
            if (markers && Array.isArray(markers)) {
                for (const m of markers) {
                    if (!m || typeof m !== 'object') continue;
                    diagnosticsStore.push(createDiagnostic({
                        source: 'monaco',
                        severity: m.severity === 8 ? 'error' : m.severity === 4 ? 'warning' : 'info',
                        filePath: filePath,
                        line: toSafeInt(m.startLineNumber),
                        column: toSafeInt(m.startColumn, 1, 10000),
                        message: m.message,
                        code: m.code || 'LSP'
                    }));
                }
            }
            diagnosticsStore = dedupeDiagnostics(diagnosticsStore);
            if (!diagnosticsSources.includes('monaco')) diagnosticsSources.push('monaco');
            return sendJSON(res, 200, { ok: true, summary: getDiagnosticsSummary() });
        }

        if (req.url === '/api/index/build') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'index build requires explicit UI approval.' });
            enforcePermission(req, 'file.read', { targetSummary: 'index.build' });
            return sendJSON(res, 200, await workspaceCore.buildIndexCache({ maxFiles: body.maxFiles || 1200, full: true }));
        }

        if (req.url === '/api/index/refresh') {
            const body = await getBody(req);
            if (req.headers['x-agent-approved'] !== 'true') return sendJSON(res, 403, { error: 'index refresh requires explicit UI approval.' });
            enforcePermission(req, 'file.read', { targetSummary: 'index.refresh' });
            return sendJSON(res, 200, await workspaceCore.refreshIndexCache({ maxFiles: body.maxFiles || 1200 }));
        }

        if (req.url === '/api/tasks/start') {
            enforcePermission(req, 'task.mutate', { targetSummary: 'tasks.start' });
            const body = await getBody(req);
            if (JSON.stringify(body).length > 20_000) return sendJSON(res, 413, { error: 'Task start payload too large' });
            const title = sanitizeTaskText(body.title || 'Task', MAX_TASK_TITLE_CHARS);
            if (!title) return sendJSON(res, 400, { error: 'title is required' });
            const task = createTask(title, body.model);
            return sendJSON(res, 200, { ok: true, task: toTaskView(task) });
        }

        if (req.url === '/api/tasks/event') {
            enforcePermission(req, 'task.mutate', { targetSummary: 'tasks.event' });
            const body = await getBody(req);
            if (JSON.stringify(body).length > 30_000) return sendJSON(res, 413, { error: 'Task event payload too large' });
            const taskId = String(body.id || body.taskId || '');
            if (!taskId || !taskStore.has(taskId)) return sendJSON(res, 404, { error: 'Task not found' });
            const status = body.status ? String(body.status) : undefined;
            const stepStatus = body.stepStatus ? String(body.stepStatus) : undefined;
            if (status && !TASK_STATUSES.has(status)) return sendJSON(res, 400, { error: 'Invalid task status' });
            if (stepStatus && !STEP_STATUSES.has(stepStatus)) return sendJSON(res, 400, { error: 'Invalid step status' });
            recordTaskEvent(taskId, body);
            return sendJSON(res, 200, { ok: true, task: toTaskView(taskStore.get(taskId)) });
        }

        if (req.url === '/api/tasks/pause') {
            enforcePermission(req, 'task.mutate', { targetSummary: 'tasks.pause' });
            const body = await getBody(req);
            const taskId = String(body.id || body.taskId || '');
            const task = taskStore.get(taskId);
            if (!task) return sendJSON(res, 404, { error: 'Task not found' });
            if (task.status !== 'running') return sendJSON(res, 409, { error: 'Only running tasks can be paused' });
            recordTaskEvent(task.id, { type: 'paused', status: 'paused', content: 'Task paused by user', resumeAvailable: true });
            return sendJSON(res, 200, { ok: true, task: toTaskView(taskStore.get(task.id)) });
        }

        if (req.url === '/api/tasks/cancel') {
            enforcePermission(req, 'task.mutate', { targetSummary: 'tasks.cancel' });
            const body = await getBody(req);
            const taskId = String(body.id || body.taskId || '');
            const task = taskStore.get(taskId);
            if (!task) return sendJSON(res, 404, { error: 'Task not found' });
            recordTaskEvent(task.id, { type: 'cancelled', status: 'cancelled', content: 'Task cancelled by user', resumeAvailable: false });
            return sendJSON(res, 200, { ok: true, task: toTaskView(taskStore.get(task.id)) });
        }

        if (req.url === '/api/tasks/resume') {
            enforcePermission(req, 'task.mutate', { targetSummary: 'tasks.resume' });
            const body = await getBody(req);
            const taskId = String(body.id || body.taskId || '');
            const task = taskStore.get(taskId);
            if (!task) return sendJSON(res, 404, { error: 'Task not found' });
            if (!['paused', 'failed', 'needs_user'].includes(task.status) && task.resumeAvailable !== true) {
                return sendJSON(res, 409, { error: 'Task is not resumable' });
            }
            recordTaskEvent(task.id, {
                type: 'resume',
                label: 'Task resumed',
                status: 'running',
                warning: 'Resume is manual context recovery marker; destructive tools still require normal approval.',
                recoveryHint: 'Review pending edits, running jobs, diagnostics, and dirty tabs before continuing.',
                resumeAvailable: true
            });
            return sendJSON(res, 200, { ok: true, task: toTaskView(taskStore.get(task.id)) });
        }

        if (req.url === '/api/tasks/clear_completed') {
            enforcePermission(req, 'task.mutate', { targetSummary: 'tasks.clear_completed' });
            const toDelete = [];
            for (const [id, task] of taskStore.entries()) {
                if (['completed', 'cancelled', 'failed'].includes(task.status)) {
                    toDelete.push(id);
                    const filePath = path.join(TASKS_DIR, `${id}.json`);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                }
            }
            toDelete.forEach(id => taskStore.delete(id));
            return sendJSON(res, 200, { ok: true, deleted: toDelete.length });
        }

        // Sprint 13: Git / SCM Panel - Mutation endpoints
        if (req.url === '/api/git/stage') {
          try {
            enforcePermission(req, 'git.stage', { targetSummary: 'git.stage' });
            const body = await getBody(req);
            const files = Array.isArray(body.files) ? body.files.map(f => String(f).trim()).filter(Boolean) : [];
            const all = body.all === true;
            if (!all && files.length === 0) return sendJSON(res, 400, { ok: false, error: 'files array or all=true is required' });
            const result = await workspaceCore.callTool('git_stage', { files: files.length > 0 ? files : undefined, all });
            return sendJSON(res, 200, result);
          } catch (e) {
            if (e && Number.isInteger(e.statusCode)) {
              return sendJSON(res, e.statusCode, { ok: false, error: redactSecrets(e.message) });
            }
            const lowered = String(e.message || '').toLowerCase();
            const statusCode = lowered.includes('x-agent-approved') || lowered.includes('ide-mode only') ? 403
              : lowered.includes('trusted') ? 403 : 400;
            return sendJSON(res, statusCode, { ok: false, error: redactSecrets(e.message) });
          }
        }

        if (req.url === '/api/git/unstage') {
          try {
            enforcePermission(req, 'git.unstage', { targetSummary: 'git.unstage' });
            const body = await getBody(req);
            const files = Array.isArray(body.files) ? body.files.map(f => String(f).trim()).filter(Boolean) : [];
            const all = body.all === true;
            if (!all && files.length === 0) return sendJSON(res, 400, { ok: false, error: 'files array or all=true is required' });
            const result = await workspaceCore.callTool('git_unstage', { files: files.length > 0 ? files : undefined, all });
            return sendJSON(res, 200, result);
          } catch (e) {
            if (e && Number.isInteger(e.statusCode)) {
              return sendJSON(res, e.statusCode, { ok: false, error: redactSecrets(e.message) });
            }
            const lowered = String(e.message || '').toLowerCase();
            const statusCode = lowered.includes('x-agent-approved') || lowered.includes('ide-mode only') ? 403
              : lowered.includes('trusted') ? 403 : 400;
            return sendJSON(res, statusCode, { ok: false, error: redactSecrets(e.message) });
          }
        }

        if (req.url === '/api/git/discard') {
          try {
            const body = await getBody(req);
            enforcePermission(req, 'git.discard', {
                targetSummary: 'git.discard',
                requiresConfirmation: true,
                hasConfirmation: body.confirm === true
            });
            const filePath = body.filePath ? String(body.filePath).trim() : '';
            const files = Array.isArray(body.files) ? body.files.map(f => String(f).trim()).filter(Boolean) : [];
            const confirm = body.confirm === true;
            if (!confirm) return sendJSON(res, 400, { ok: false, error: 'confirm:true is required for discard (destructive operation)' });
            const result = await workspaceCore.callTool('git_discard', { filePath: filePath || undefined, files: files.length > 0 ? files : undefined, confirm });
            return sendJSON(res, 200, result);
          } catch (e) {
            if (e && Number.isInteger(e.statusCode)) {
              return sendJSON(res, e.statusCode, { ok: false, error: redactSecrets(e.message) });
            }
            const lowered = String(e.message || '').toLowerCase();
            const statusCode = lowered.includes('x-agent-approved') || lowered.includes('ide-mode only') ? 403
              : lowered.includes('trusted') ? 403 : 400;
            return sendJSON(res, statusCode, { ok: false, error: redactSecrets(e.message) });
          }
        }

        if (req.url === '/api/git/commit_draft') {
          try {
            enforcePermission(req, 'git.commit_draft', { targetSummary: 'git.commit_draft' });
            const body = await getBody(req);
            const style = ['conventional', 'simple'].includes(body.style) ? body.style : 'conventional';
            const draft = await workspaceCore.callTool('git_commit_draft', { style });
            return sendJSON(res, 200, draft);
          } catch (e) {
            return sendJSON(res, 500, { ok: false, error: redactSecrets(e.message) });
          }
        }

        if (req.url.startsWith('/api/')) {
            const toolName = req.url.split('/')[2];
            const args = await getBody(req);
            const mappedAction = actionTypeForTool(toolName);
            if (mappedAction) {
                const confirm = args && typeof args === 'object' && args.confirm === true;
                enforcePermission(req, mappedAction, {
                    targetSummary: `tool:${toolName}`,
                    requiresConfirmation: mappedAction === 'git.discard',
                    hasConfirmation: confirm
                });
            }
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
        if (e && Number.isInteger(e.statusCode) && e.statusCode >= 400 && e.statusCode < 600) {
            return sendJSON(res, e.statusCode, {
                ok: false,
                error: redactSecrets(e.message || 'Permission denied'),
                permission: e.permission || null
            });
        }
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
        if (/X-Agent-Approved=true|IDE-mode only/i.test(String(e.message || ''))) {
            return sendJSON(res, 403, { error: redactSecrets(e.message) });
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
