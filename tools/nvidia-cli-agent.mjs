import OpenAI from 'openai';
import readline from 'readline';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { createWorkspaceCore } from './agent-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const WORKSPACE = process.cwd();
const STATE_DIR = path.join(WORKSPACE, '.nvidia-agent');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');

loadEnv();

const DEFAULT_MODEL = process.env.NVIDIA_DEFAULT_MODEL || 'meta/llama-3.1-405b-instruct';
const BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const MAX_ITERATIONS = Number(process.env.NVIDIA_AGENT_MAX_ITERATIONS || 5);
const HISTORY_CHAR_BUDGET = Number(process.env.NVIDIA_AGENT_HISTORY_CHARS || 120000);
const MAX_TOOL_CHARS = 100000;
const SAFE_COMMAND_TIMEOUT_MS = 120000;
const RATE_LIMIT_RPM = Math.max(1, Number(process.env.NVIDIA_RATE_LIMIT_RPM || 40));
const RATE_LIMIT_SOFT_RPM = Math.max(1, Number(process.env.NVIDIA_RATE_LIMIT_SOFT_RPM || 30));
const RATE_LIMIT_SOFT_DELAY_MS = Math.max(0, Number(process.env.NVIDIA_RATE_LIMIT_SOFT_DELAY_MS || 1500));
const RATE_LIMIT_BURST_MAX = Math.max(1, Number(process.env.NVIDIA_RATE_LIMIT_BURST_MAX || 10));
const RATE_LIMIT_BURST_WINDOW_MS = Math.max(1000, Number(process.env.NVIDIA_RATE_LIMIT_BURST_WINDOW_MS || 10000));
const RATE_LIMIT_ENABLED = process.env.NVIDIA_RATE_LIMIT_ENABLED !== 'false';

marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.yellow,
    blockquote: chalk.gray.italic,
    html: chalk.gray,
    heading: chalk.green.bold,
    firstHeading: chalk.green.bold,
    strong: chalk.cyan.bold,
    em: chalk.magenta.italic,
    codespan: chalk.yellow
  })
});

ensureStateDirs();

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: BASE_URL
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const cliArgs = parseArgs();
let currentModel = DEFAULT_MODEL;
if (cliArgs.model) currentModel = cliArgs.model;
let currentSession = cliArgs.session || 'default';
let autoAccept = cliArgs.auto || false;
let forceMode = cliArgs.force || false;
let workingMemory = buildProjectScan();
let messages = loadSession(currentSession);
let skillsIndex = scanSkills();
const nimRequestLog = [];
let lastNimRateLimitHit = null;
const workspaceCore = createWorkspaceCore({
  workspace: WORKSPACE,
  appDir: APP_DIR,
  stateDir: STATE_DIR,
  execTimeoutMs: SAFE_COMMAND_TIMEOUT_MS,
  maxToolResultChars: MAX_TOOL_CHARS,
  maxFileReadChars: 140000
});

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { force: false, auto: false, session: null, model: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') out.force = true;
    else if (args[i] === '--auto') out.auto = true;
    else if (args[i] === '--session') out.session = args[++i];
    else if (args[i] === '--model') out.model = args[++i];
  }
  return out;
}

function loadEnv() {
  const envPaths = [
    path.join(WORKSPACE, '.env'),
    path.join(APP_DIR, '.env'),
    path.join(path.dirname(process.execPath), '.env')
  ];
  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
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

function ensureStateDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function question(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function sanitizeSessionName(name) {
  return (name || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
}

function sessionPath(name) {
  return path.join(SESSIONS_DIR, `${sanitizeSessionName(name)}.json`);
}

function loadSession(name) {
  const file = sessionPath(name);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

function saveSession(name = currentSession) {
  fs.writeFileSync(sessionPath(name), JSON.stringify({
    name,
    model: currentModel,
    updatedAt: new Date().toISOString(),
    workspace: WORKSPACE,
    messages
  }, null, 2));
}

function listSessions() {
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const full = path.join(SESSIONS_DIR, f);
      let title = f.replace(/\.json$/, '');
      let updatedAt = fs.statSync(full).mtime.toISOString();
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        title = parsed.name || title;
        updatedAt = parsed.updatedAt || updatedAt;
      } catch {
        // Keep filesystem fallback.
      }
      return { title, updatedAt };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function scanSkills() {
  const skillsDir = path.join(APP_DIR, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir)
    .filter(file => file.endsWith('.md'))
    .map(file => {
      const fullPath = path.join(skillsDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const descMatch = content.match(/^description:\s*(.+)$/mi);
      const h1Match = content.match(/^#\s+(.+)$/m);
      return {
        name: file.replace(/\.md$/i, ''),
        file,
        path: fullPath,
        description: (descMatch?.[1] || h1Match?.[1] || file.replace(/\.md$/i, '')).trim(),
        content
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getSkill(name) {
  const clean = name.replace(/^\/+/, '').replace(/\.md$/i, '');
  return skillsIndex.find(skill => skill.name === clean);
}

function printSkills(filter = '') {
  skillsIndex = scanSkills();
  const needle = filter.trim().toLowerCase();
  const skills = needle
    ? skillsIndex.filter(skill => skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))
    : skillsIndex;

  if (skills.length === 0) {
    console.log(chalk.yellow('No matching skills found in skills/*.md'));
    return;
  }

  const rows = skills.slice(0, 80).map(skill => `${chalk.green(`/${skill.name}`).padEnd(28)} ${chalk.gray(skill.description)}`);
  console.log(boxen(rows.join('\n'), {
    title: chalk.cyan.bold('Available Skills'),
    padding: 1,
    borderColor: 'cyan',
    borderStyle: 'round'
  }));
  if (skills.length > 80) console.log(chalk.gray(`Showing 80/${skills.length}. Type /skills <filter> to narrow the list.`));
}

function shouldSkipDir(name) {
  return new Set(['node_modules', '.git', 'dist', 'build', '.brain', '.nvidia-agent', '.next', 'coverage', '.venv', '__pycache__']).has(name);
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return new Set([
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.json', '.md',
    '.txt', '.yml', '.yaml', '.toml', '.env', '.gitignore', '.py', '.ps1', '.sh',
    '.java', '.go', '.rs', '.cpp', '.c', '.h', '.hpp', '.cs', '.xml', '.svg',
    '.sql', '.prisma', '.ini', '.conf', '.bat', '.cmd'
  ]).has(ext) || path.basename(filePath).startsWith('.');
}

function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveWorkspacePath(inputPath = '.') {
  const resolved = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(WORKSPACE, inputPath));
  if (!isPathInside(WORKSPACE, resolved)) throw new Error(`Path outside workspace: ${inputPath}`);
  return resolved;
}

function truncate(text, max = MAX_TOOL_CHARS) {
  const value = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[TRUNCATED ${value.length - max} chars]`;
}

function redactSecrets(text = '') {
  return String(text)
    .replace(/^(\s*[\w.-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE[_-]?KEY)[\w.-]*\s*=\s*)(.+)$/gim, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|nvapi|nvidia)[-_][A-Za-z0-9._-]{16,}\b/gi, '[REDACTED_SECRET]');
}

function toolResult(value, max = MAX_TOOL_CHARS) {
  return truncate(redactSecrets(typeof value === 'string' ? value : JSON.stringify(value, null, 2)), max);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupRateLog(now = Date.now()) {
  const cutoff = now - Math.max(60000, RATE_LIMIT_BURST_WINDOW_MS);
  while (nimRequestLog.length && nimRequestLog[0].time < cutoff) nimRequestLog.shift();
}

function getRateLimitStatus() {
  const now = Date.now();
  cleanupRateLog(now);
  const minuteStart = now - 60000;
  const burstStart = now - RATE_LIMIT_BURST_WINDOW_MS;
  const minuteItems = nimRequestLog.filter(item => item.time >= minuteStart);
  const burstItems = nimRequestLog.filter(item => item.time >= burstStart);
  const oldestMinute = minuteItems[0]?.time || now;
  const oldestBurst = burstItems[0]?.time || now;
  const minuteLimited = RATE_LIMIT_ENABLED && minuteItems.length >= RATE_LIMIT_RPM;
  const burstLimited = RATE_LIMIT_ENABLED && burstItems.length >= RATE_LIMIT_BURST_MAX;
  const retryAfterMs = minuteLimited
    ? Math.max(1000, 60000 - (now - oldestMinute))
    : burstLimited
      ? Math.max(1000, RATE_LIMIT_BURST_WINDOW_MS - (now - oldestBurst))
      : 0;

  return {
    enabled: RATE_LIMIT_ENABLED,
    rpmLimit: RATE_LIMIT_RPM,
    softRpmLimit: RATE_LIMIT_SOFT_RPM,
    softDelayMs: RATE_LIMIT_SOFT_DELAY_MS,
    burstLimit: RATE_LIMIT_BURST_MAX,
    burstWindowMs: RATE_LIMIT_BURST_WINDOW_MS,
    usedLastMinute: minuteItems.length,
    usedBurstWindow: burstItems.length,
    remainingMinute: Math.max(0, RATE_LIMIT_RPM - minuteItems.length),
    remainingBurst: Math.max(0, RATE_LIMIT_BURST_MAX - burstItems.length),
    retryAfterMs,
    nearLimit: RATE_LIMIT_ENABLED && minuteItems.length >= RATE_LIMIT_SOFT_RPM,
    limited: minuteLimited || burstLimited,
    lastHit: lastNimRateLimitHit
  };
}

function quotaStatus() {
  const status = getRateLimitStatus();
  return {
    used: status.usedLastMinute,
    limit: status.rpmLimit,
    soft: status.softRpmLimit,
    remaining: status.remainingMinute,
    nearLimit: status.nearLimit,
    limited: status.limited,
    retryAfterMs: status.retryAfterMs
  };
}

class LocalRateLimitError extends Error {
  constructor(status, label) {
    super(`Local NVIDIA rate guard blocked ${label}: ${status.usedLastMinute}/${status.rpmLimit} RPM. Retry in ${Math.ceil(status.retryAfterMs / 1000)}s.`);
    this.name = 'LocalRateLimitError';
    this.status = 429;
    this.rateLimit = status;
    this.retryAfterMs = status.retryAfterMs;
  }
}

async function reserveNimRequest(label) {
  const status = getRateLimitStatus();
  if (!RATE_LIMIT_ENABLED) {
    nimRequestLog.push({ time: Date.now(), label });
    return;
  }
  if (status.limited) {
    throw new LocalRateLimitError(status, label);
  }
  if (status.nearLimit && RATE_LIMIT_SOFT_DELAY_MS > 0) {
    console.log(chalk.yellow(`\n[quota] Warning: approaching API limit (${status.usedLastMinute}/${status.rpmLimit}). Slowing down ${RATE_LIMIT_SOFT_DELAY_MS}ms.`));
    await sleep(RATE_LIMIT_SOFT_DELAY_MS);
  }
  nimRequestLog.push({ time: Date.now(), label });
}

async function guardedNimCall(label, fn) {
  await reserveNimRequest(label);
  try {
    return await fn();
  } catch (e) {
    if (e?.status === 429 || e?.code === 429 || /rate limit|too many requests/i.test(e?.message || '')) {
      lastNimRateLimitHit = {
        time: new Date().toISOString(),
        label,
        message: e.message
      };
    }
    throw e;
  }
}

function printQuota() {
  const status = getRateLimitStatus();
  const color = status.limited ? chalk.red : status.nearLimit ? chalk.yellow : chalk.gray;
  console.log(color(`[Quota: ${status.usedLastMinute}/${status.rpmLimit} requests used this minute, burst ${status.usedBurstWindow}/${status.burstLimit}]`));
}

function listFiles(root = WORKSPACE, base = '') {
  if (!fs.existsSync(root)) return [];
  let files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && shouldSkipDir(entry.name)) continue;
    const full = path.join(root, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) files = files.concat(listFiles(full, rel));
    else files.push({ path: full, relPath: rel, name: entry.name, size: fs.statSync(full).size });
  }
  return files;
}

function fileTree(root = WORKSPACE, depth = 0, maxDepth = 2) {
  if (depth > maxDepth || !fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => !(entry.isDirectory() && shouldSkipDir(entry.name)))
    .slice(0, 80)
    .map(entry => {
      const full = path.join(root, entry.name);
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        relPath: path.relative(WORKSPACE, full),
        children: entry.isDirectory() ? fileTree(full, depth + 1, maxDepth) : undefined
      };
    });
}

function readIfExists(relPath, maxChars = 30000) {
  const full = path.join(WORKSPACE, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile() || !isTextFile(full)) return null;
  return truncate(redactSecrets(fs.readFileSync(full, 'utf8')), maxChars);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildProjectScan() {
  const packageJson = readIfExists('package.json', 40000);
  const readme = readIfExists('README.md', 40000) || readIfExists('readme.md', 40000);
  const rootFiles = fileTree(WORKSPACE, 0, 2);
  const files = listFiles().filter(f => isTextFile(f.path));
  const likelyEntryPoints = files
    .filter(f => /(server|cli|agent|main|index|electron|vite|package|README)/i.test(f.relPath))
    .slice(0, 40)
    .map(f => ({ relPath: f.relPath, size: f.size }));

  return truncate({
    workspace: WORKSPACE,
    scannedAt: new Date().toISOString(),
    packageJson: packageJson ? safeJsonParse(packageJson) || packageJson : null,
    readme,
    rootFiles,
    likelyEntryPoints
  }, 90000);
}

function systemPrompt() {
  return `You are NVIDIA NIM CLI Agent Pro, an autonomous terminal coding agent.

Operating loop:
- Think privately.
- Act with tools.
- Observe tool results.
- Self-correct after failures without asking the user unless safety approval is required.

Workspace rules:
- Current workspace: ${WORKSPACE}
- Use project_indexer, search_files, list_dir, and read_file before modifying code.
- For a new workspace task, call project_indexer first unless the answer is trivial or the relevant files are already loaded in context.
- NVIDIA API budget is constrained. Batch independent tool calls in a single assistant turn whenever possible, especially multiple read_file calls.
- Prefer search_files/project_indexer before reading many files. Keep tool observations compact and request only what is needed.
- Use read_file_paged for large files instead of asking for full file content.
- Prefer apply_patch for precise edits. write_file and apply_patch create pending diff reviews; use apply_pending_edit only after approval.
- Use execute_command for short tests/lint/diagnostics and start_command_job for long-running commands.
- If execute_command fails, inspect stderr/stdout and try a focused fix or diagnostic in the next iteration.
- Tool observations may redact secrets. Never print full API keys, tokens, passwords, or private keys.
- Keep final answers concise: changed files, commands run, result, and residual risk.
- Do not reveal hidden chain-of-thought. Summarize reasoning briefly.
- Skills are long-term procedures from skills/*.md. If a skill instruction is injected, follow it as the primary procedure for that turn.
- Available skills at startup: ${skillsIndex.map(skill => `/${skill.name}: ${skill.description}`).join('; ') || 'none'}

Working memory from startup project scan:
${workingMemory}`;
}

function compactMessages(history, extraSystem = []) {
  const system = [{ role: 'system', content: systemPrompt() }];
  system.push(...extraSystem);
  const clean = history.filter(m => m.role !== 'system');
  let used = system.reduce((n, m) => n + (m.content?.length || 0), 0);
  const kept = [];

  for (let i = clean.length - 1; i >= 0; i--) {
    const msg = clean[i];
    const len = JSON.stringify(msg).length;
    if (used + len > HISTORY_CHAR_BUDGET) break;
    kept.unshift(msg);
    used += len;
  }

  if (kept.length < clean.length) {
    system.push({
      role: 'system',
      content: `Older conversation was compacted. Preserved the latest ${kept.length} messages within ${HISTORY_CHAR_BUDGET} chars.`
    });
  }
  return [...system, ...kept];
}

function safeCommand(command) {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();
  const dangerous = /\b(rm|del|erase|rmdir|rd|format|shutdown|reboot|npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install|git\s+push|git\s+reset|git\s+clean|move|mv|copy|cp)\b|>|>>|\|\s*sh\b|\|\s*bash\b/;
  if (dangerous.test(lower)) return false;
  return /^(ls|dir|pwd|cat|type|head|tail|rg|grep|findstr|git\s+(status|diff|log|show|branch)|npm\s+(test|run\s+\w+)|node\s+--check|python\s+--version|node\s+--version)\b/i.test(trimmed);
}

async function requireApproval(kind, description, safe = false) {
  if (forceMode) return true;
  if (autoAccept && safe) return true;
  const answer = await question(chalk.yellow(`\n[approval] ${kind}: ${description}\nAllow? (y/N): `));
  return answer.trim().toLowerCase() === 'y';
}

function warnForcedDanger(kind, description) {
  if (!forceMode) return;
  console.log(chalk.red.bold(`\n[force] Dangerous ${kind} auto-approved: ${description}`));
}

async function execCommand(command, timeoutMs = SAFE_COMMAND_TIMEOUT_MS) {
  return new Promise(resolve => {
    exec(command, {
      cwd: WORKSPACE,
      timeout: Math.min(Math.max(Number(timeoutMs) || SAFE_COMMAND_TIMEOUT_MS, 1000), 300000),
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        command,
        exitCode: error?.code ?? 0,
        stdout: truncate(stdout || '', 80000),
        stderr: truncate(stderr || '', 80000),
        error: error ? error.message : null,
        observation: error
          ? 'Command failed. Interpret stdout/stderr and try a focused fix or diagnostic next.'
          : 'Command succeeded.'
      });
    });
  });
}

function fallbackGrep(query, searchPath = '.', limit = 100) {
  const root = resolveWorkspacePath(searchPath);
  const lower = query.toLowerCase();
  const results = [];
  for (const file of listFiles(root)) {
    if (results.length >= limit) break;
    if (!isTextFile(file.path)) continue;
    try {
      fs.readFileSync(file.path, 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (results.length >= limit) return;
        if (line.toLowerCase().includes(lower)) {
          results.push({
            file: path.relative(WORKSPACE, file.path),
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

async function grepSearch(args) {
  const query = args.query || args.pattern;
  if (!query) throw new Error('query is required');
  const searchPath = args.path || '.';
  const limit = Number(args.limit || 100);
  const include = args.include_pattern || args.includePattern || '';
  const gitPathspec = include || searchPath;
  const gitGrepCommand = `git grep -n ${JSON.stringify(query)} -- ${JSON.stringify(gitPathspec)}`;
  const grepCommand = include
    ? `grep -RIn --include=${JSON.stringify(include)} ${JSON.stringify(query)} ${JSON.stringify(searchPath)}`
    : `grep -RIn ${JSON.stringify(query)} ${JSON.stringify(searchPath)}`;
  const rgCommand = include
    ? `rg --line-number --no-heading --color never -g ${JSON.stringify(include)} ${JSON.stringify(query)} ${JSON.stringify(searchPath)}`
    : `rg --line-number --no-heading --color never ${JSON.stringify(query)} ${JSON.stringify(searchPath)}`;

  for (const command of [gitGrepCommand, rgCommand, grepCommand]) {
    const result = await execCommand(command, 30000);
    if (!result.ok || !result.stdout.trim()) continue;
    return result.stdout.split(/\r?\n/).slice(0, limit).map(line => {
      const [file, lineNo, ...rest] = line.split(':');
      return { file, line: Number(lineNo), content: redactSecrets(rest.join(':').trim()) };
    });
  }
  return fallbackGrep(query, searchPath, limit);
}

async function projectIndexer() {
  workingMemory = buildProjectScan();
  return { ok: true, memory: workingMemory };
}

const toolLogic = {
  update_plan: async args => {
    const rows = (args.steps || []).map((step, index) => `${chalk.cyan('[ ]')} ${chalk.bold(index + 1 + '.')} ${step}`);
    console.log(boxen(rows.join('\n') || 'No steps provided.', {
      title: chalk.cyan.bold('Action Plan'),
      padding: 1,
      borderColor: 'cyan',
      borderStyle: 'round'
    }));
    return { ok: true, message: 'Plan updated visually.' };
  },
  project_indexer: projectIndexer,
  project_scan: projectIndexer,
  list_dir: async args => workspaceCore.listDirTool(args),
  read_file: async args => workspaceCore.readFileTool(args),
  read_file_paged: async args => workspaceCore.readFilePagedTool(args),
  write_file: async args => {
    const target = args.filePath || args.path;
    warnForcedDanger('write_file', target);
    const approved = await requireApproval('write_file pending edit', target, false);
    if (!approved) return { ok: false, denied: true, message: 'User denied file write proposal.' };
    return workspaceCore.createPendingEdit(args);
  },
  apply_patch: async args => {
    const target = args.filePath || args.path;
    warnForcedDanger('apply_patch', target);
    const approved = await requireApproval('apply_patch pending edit', target, false);
    if (!approved) return { ok: false, denied: true, message: 'User denied patch proposal.' };
    return workspaceCore.applyPatchTool(args);
  },
  apply_pending_edit: async args => {
    const approved = await requireApproval('apply_pending_edit', args.id, false);
    if (!approved) return { ok: false, denied: true, message: 'User denied applying pending edit.' };
    return workspaceCore.applyPendingEditTool(args);
  },
  discard_pending_edit: async args => {
    const approved = await requireApproval('discard_pending_edit', args.id, false);
    if (!approved) return { ok: false, denied: true, message: 'User denied discarding pending edit.' };
    return workspaceCore.discardPendingEditTool(args);
  },
  pending_edits: async args => workspaceCore.listPendingEditsTool(args),
  semantic_index: async args => workspaceCore.semanticIndexTool(args),
  git_context: async args => workspaceCore.gitContextTool(args),
  execute_command: async args => {
    const safe = safeCommand(args.command);
    if (!safe) warnForcedDanger('execute_command', args.command);
    const approved = await requireApproval('execute_command', args.command, safe);
    if (!approved) return { ok: false, denied: true, message: 'User denied command execution.' };
    return workspaceCore.executeCommandTool(args);
  },
  start_command_job: async args => {
    const safe = safeCommand(args.command);
    if (!safe) warnForcedDanger('start_command_job', args.command);
    const approved = await requireApproval('start_command_job', args.command, safe);
    if (!approved) return { ok: false, denied: true, message: 'User denied command job start.' };
    return workspaceCore.startCommandJobTool(args);
  },
  command_job_status: async args => workspaceCore.commandJobStatusTool(args),
  cancel_command_job: async args => {
    const approved = await requireApproval('cancel_command_job', args.id, false);
    if (!approved) return { ok: false, denied: true, message: 'User denied command job cancellation.' };
    return workspaceCore.cancelCommandJobTool(args);
  },
  search_files: async args => workspaceCore.searchFiles(args),
  grep_search: async args => workspaceCore.searchFiles(args)
};

const toolsDef = [
  { type: 'function', function: { name: 'update_plan', description: 'Show or update the current task plan.', parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } } },
  { type: 'function', function: { name: 'project_indexer', description: 'Index the workspace and return package metadata, README, structure, and likely entry points. Use first for new workspace tasks.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_files', description: 'Search code patterns across the workspace using git grep/rg/grep with JS fallback.', parameters: { type: 'object', properties: { query: { type: 'string' }, include_pattern: { type: 'string', description: 'Optional glob/pathspec such as *.mjs or tools/*.mjs' }, path: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'semantic_index', description: 'Find relevant workspace chunks using lightweight semantic indexing.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, maxFiles: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'git_context', description: 'Read git branch/status/diff/log context.', parameters: { type: 'object', properties: { includeDiff: { type: 'boolean' }, includeLog: { type: 'boolean' } } } } },
  { type: 'function', function: { name: 'project_scan', description: 'Refresh and return workspace memory: package metadata, README, structure, likely entry points.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_dir', description: 'List files/folders in the workspace.', parameters: { type: 'object', properties: { dirPath: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file from the workspace.', parameters: { type: 'object', properties: { filePath: { type: 'string' }, maxChars: { type: 'integer' } }, required: ['filePath'] } } },
  { type: 'function', function: { name: 'read_file_paged', description: 'Read a slice of a large text file.', parameters: { type: 'object', properties: { filePath: { type: 'string' }, start_line: { type: 'integer' }, line_count: { type: 'integer' } }, required: ['filePath'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create a pending diff review for a complete text file write.', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['filePath', 'content'] } } },
  { type: 'function', function: { name: 'apply_patch', description: 'Create a pending diff review by replacing exact text in a file.', parameters: { type: 'object', properties: { filePath: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, reason: { type: 'string' } }, required: ['filePath', 'find', 'replace'] } } },
  { type: 'function', function: { name: 'apply_pending_edit', description: 'Apply a pending edit by id after approval.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'discard_pending_edit', description: 'Discard a pending edit by id without writing it.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'execute_command', description: 'Run a shell command in the workspace.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'start_command_job', description: 'Start a cancellable long-running command job.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'command_job_status', description: 'Get status for a command job.', parameters: { type: 'object', properties: { id: { type: 'string' } } } } },
  { type: 'function', function: { name: 'cancel_command_job', description: 'Cancel a running command job.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'grep_search', description: 'Search code patterns across the workspace using git grep/rg/grep with JS fallback.', parameters: { type: 'object', properties: { query: { type: 'string' }, include_pattern: { type: 'string', description: 'Optional glob/pathspec such as *.mjs or tools/*.mjs' }, path: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } } }
];

async function fetchModels() {
  const spinner = ora(chalk.yellow('Loading NVIDIA NIM models...')).start();
  try {
    const response = await guardedNimCall('models.list', () => openai.models.list());
    spinner.succeed(chalk.green(`Loaded ${response.data.length} models`));
    return response.data.sort((a, b) => a.id.localeCompare(b.id)).map(m => m.id);
  } catch (e) {
    spinner.warn(chalk.yellow(`Model list unavailable: ${e.message}`));
    return [DEFAULT_MODEL, 'deepseek-ai/deepseek-v3', 'meta/llama-3.1-405b-instruct'];
  }
}

async function streamCompletion(requestMessages, onFirstOutput = null) {
  const stream = await guardedNimCall('chat.completions.stream', () => openai.chat.completions.create({
    model: currentModel,
    messages: requestMessages,
    tools: toolsDef,
    tool_choice: 'auto',
    temperature: 0.2,
    max_tokens: 4096,
    stream: true
  }));

  const message = { role: 'assistant', content: '', tool_calls: [] };
  const toolMap = new Map();
  let startedOutput = false;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta || {};
    if (delta.content) {
      if (!startedOutput) {
        startedOutput = true;
        onFirstOutput?.();
        process.stdout.write(chalk.green.bold('\nAgent: '));
      }
      message.content += delta.content;
      process.stdout.write(chalk.green(delta.content));
    }

    if (delta.tool_calls) {
      if (!startedOutput) {
        startedOutput = true;
        onFirstOutput?.();
      }
      for (const tc of delta.tool_calls) {
        const key = tc.index ?? toolMap.size;
        if (!toolMap.has(key)) {
          toolMap.set(key, {
            id: tc.id || `tool_${key}`,
            type: 'function',
            function: { name: '', arguments: '' }
          });
        }
        const current = toolMap.get(key);
        if (tc.id) current.id = tc.id;
        if (tc.function?.name) current.function.name += tc.function.name;
        if (tc.function?.arguments) current.function.arguments += tc.function.arguments;
      }
    }
  }

  message.tool_calls = Array.from(toolMap.values());
  if (message.tool_calls.length === 0) delete message.tool_calls;
  return message;
}

function extractSkillTurn(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { userText: input, extraSystem: [] };
  const [slash, ...rest] = trimmed.split(/\s+/);
  const skill = getSkill(slash);
  if (!skill) return { userText: input, extraSystem: [] };
  const userText = rest.join(' ').trim() || `Run the ${slash} workflow.`;
  console.log(chalk.magenta(`[skill] Injecting /${skill.name}: ${skill.description}`));
  return {
    userText,
    extraSystem: [{
      role: 'system',
      content: `The user invoked skill /${skill.name}. Treat the following skill file as the primary procedure for this turn.\n\n--- skills/${skill.file} ---\n${skill.content}`
    }]
  };
}

async function runToolCall(tc, iteration) {
  const name = tc.function.name;
  let args = {};
  try {
    args = JSON.parse(tc.function.arguments || '{}');
  } catch (e) {
    return {
      name,
      result: { ok: false, error: `Invalid JSON tool arguments: ${e.message}`, raw: tc.function.arguments }
    };
  }

  const spinner = ora(chalk.yellow(`Tool ${name} (${iteration}/${MAX_ITERATIONS})...`)).start();
  try {
    const fn = toolLogic[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    const result = await fn(args);
    if (result?.ok === false) spinner.warn(chalk.yellow(`Tool ${name} returned an observation`));
    else spinner.succeed(chalk.yellow(`Tool ${name} completed`));
    return { name, result };
  } catch (e) {
    spinner.fail(chalk.red(`Tool ${name} failed`));
    return {
      name,
      result: {
        ok: false,
        error: e.message,
        observation: 'Tool failed. Interpret the error and try a focused correction or diagnostic next.'
      }
    };
  }
}

function isParallelSafeToolCall(tc) {
  const name = tc.function?.name;
  return new Set(['update_plan', 'project_indexer', 'project_scan', 'list_dir', 'read_file', 'read_file_paged', 'search_files', 'semantic_index', 'git_context', 'grep_search', 'pending_edits', 'command_job_status']).has(name);
}

async function runAgentTurn(input) {
  const { userText, extraSystem } = extractSkillTurn(input);
  messages.push({ role: 'user', content: userText });

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const spinner = ora(chalk.yellow(`AI thinking (${iteration}/${MAX_ITERATIONS})...`)).start();
    let msg;
    try {
      msg = await streamCompletion(compactMessages(messages, extraSystem), () => spinner.stop());
      spinner.stop();
      if (msg.content) process.stdout.write('\n');
    } catch (e) {
      if (e instanceof LocalRateLimitError) {
        spinner.fail(chalk.red(`Rate limit guard paused the agent: retry in ${Math.ceil(e.retryAfterMs / 1000)}s.`));
        printQuota();
        return;
      }
      spinner.fail(chalk.red(`Model stream failed: ${e.message}`));
      throw e;
    }

    messages.push(msg);
    saveSession();

    if (!msg.tool_calls?.length) {
      renderFinal(msg.content || 'Task completed.');
      saveSession();
      printQuota();
      return;
    }

    const runOne = async tc => {
      const { name, result } = await runToolCall(tc, iteration);
      if (name === 'execute_command' && result?.ok === false) {
        console.log(chalk.yellow('Command failed; error was added as observation for self-correction.'));
      }
      return {
        role: 'tool',
        tool_call_id: tc.id,
        name,
        content: toolResult(result)
      };
    };

    const toolResults = msg.tool_calls.every(isParallelSafeToolCall)
      ? await Promise.all(msg.tool_calls.map(runOne))
      : [];

    if (toolResults.length === 0) {
      for (const tc of msg.tool_calls) toolResults.push(await runOne(tc));
    }

    messages.push(...toolResults);
    saveSession();
  }

  console.log(chalk.red(`Stopped after max iterations (${MAX_ITERATIONS})`));
  printQuota();
}

function renderFinal(content) {
  const rendered = marked(content);
  console.log(boxen(rendered, {
    title: chalk.green.bold('Agent'),
    titleAlignment: 'left',
    padding: 1,
    margin: 1,
    borderColor: 'green',
    borderStyle: 'round'
  }));
}

function printBanner(models = []) {
  console.log(boxen(
    `${chalk.green.bold('NVIDIA NIM CLI Agent Pro')}\n${chalk.white('Autonomous terminal agent with sessions, tools, project memory')}\n\n` +
    `${chalk.gray('Workspace:')} ${WORKSPACE}\n` +
    `${chalk.gray('Session:')} ${currentSession}\n` +
    `${chalk.gray('Model:')} ${currentModel}\n` +
    `${chalk.gray('Modes:')} auto=${autoAccept} force=${forceMode}\n` +
    `${chalk.gray('Models loaded:')} ${models.length}`,
    { padding: 1, borderColor: 'cyan', borderStyle: 'double' }
  ));
}

function printHelp() {
  console.log(chalk.cyan.bold('\nCommands'));
  console.log('  /help                 Show this cheat sheet');
  console.log('  /clear                Clear current session history');
  console.log('  /save                 Save current session');
  console.log('  /sessions             List saved sessions');
  console.log('  /session <name>       Switch or create session');
  console.log('  /new <name>           Create empty session and switch to it');
  console.log('  /model <id>           Switch model');
  console.log('  /models               Print available model IDs');
  console.log('  /skills [filter]      List available skills from skills/*.md');
  console.log('  /<skill> <task>       Inject a skill, e.g. /abw-ask explain this repo');
  console.log('  /scan                 Refresh project working memory');
  console.log('  /cheat                Show this cheat sheet');
  console.log('  /memory               Print current project scan summary');
  console.log('  /quota                Show NVIDIA API requests used this minute');
  console.log('  /trust-status         Show workspace trust status');
  console.log('  /trust                Trust this workspace for edits and commands');
  console.log('  /untrust              Remove workspace trust');
  console.log('  /auto                 Toggle auto-accept for safe-listed commands');
  console.log('  /force                Toggle force mode for all approvals');
  console.log('  /exit                 Quit');
}

async function handleCommand(input, models) {
  const [cmd, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  if (cmd === '/') {
    printSkills();
  } else if (cmd === '/help') printHelp();
  else if (cmd === '/quota') {
    printQuota();
  }
  else if (cmd === '/trust-status') {
    const status = workspaceCore.getWorkspaceTrustStatus();
    console.log(chalk.cyan(JSON.stringify(status, null, 2)));
  }
  else if (cmd === '/trust') {
    const approved = await requireApproval('trust workspace', WORKSPACE, false);
    if (!approved) {
      console.log(chalk.yellow('Workspace trust unchanged.'));
    } else {
      console.log(chalk.green(JSON.stringify(workspaceCore.setWorkspaceTrust(WORKSPACE, true), null, 2)));
    }
  }
  else if (cmd === '/untrust') {
    console.log(chalk.yellow(JSON.stringify(workspaceCore.setWorkspaceTrust(WORKSPACE, false), null, 2)));
  }
  else if (cmd === '/clear') {
    messages = [];
    saveSession();
    console.log(chalk.green('Session cleared.'));
  } else if (cmd === '/save') {
    saveSession();
    console.log(chalk.green(`Saved session ${currentSession}.`));
  } else if (cmd === '/sessions') {
    listSessions().forEach((s, i) => console.log(`${chalk.yellow(`[${i + 1}]`)} ${s.title} ${chalk.gray(s.updatedAt)}`));
  } else if (cmd === '/session') {
    currentSession = sanitizeSessionName(arg || 'default');
    messages = loadSession(currentSession);
    console.log(chalk.green(`Switched to session ${currentSession}.`));
  } else if (cmd === '/new') {
    currentSession = sanitizeSessionName(arg || `session-${Date.now()}`);
    messages = [];
    saveSession();
    console.log(chalk.green(`Created session ${currentSession}.`));
  } else if (cmd === '/model') {
    currentModel = arg || currentModel;
    console.log(chalk.green(`Model set to ${currentModel}.`));
  } else if (cmd === '/models') {
    models.forEach((m, i) => console.log(`${chalk.yellow(`[${i + 1}]`)} ${m}`));
  } else if (cmd === '/skills') {
    printSkills(arg);
  } else if (cmd === '/scan') {
    const spinner = ora('Scanning project...').start();
    workingMemory = buildProjectScan();
    spinner.succeed('Project scan refreshed.');
  } else if (cmd === '/cheat') {
    printHelp();
  } else if (cmd === '/memory') {
    console.log(boxen(truncate(workingMemory, 12000), { padding: 1, borderColor: 'gray' }));
  } else if (cmd === '/auto') {
    autoAccept = !autoAccept;
    console.log(chalk.green(`auto=${autoAccept}`));
  } else if (cmd === '/force') {
    forceMode = !forceMode;
    console.log(chalk.red(`force=${forceMode}`));
  } else if (cmd === '/exit') {
    saveSession();
    rl.close();
    process.exit(0);
  } else {
    const skill = getSkill(cmd);
    if (skill) return false;
    console.log(chalk.red(`Unknown command or skill: ${cmd}`));
  }
  return true;
}

async function main() {
  const models = await fetchModels();
  if (!cliArgs.model && models.includes(DEFAULT_MODEL)) currentModel = DEFAULT_MODEL;
  printBanner(models);
  printHelp();

  while (true) {
    const input = await question(chalk.blue.bold('\nYou: '));
    if (!input.trim()) continue;
    try {
      if (input.trim().startsWith('/')) {
        const handled = await handleCommand(input, models);
        if (!handled) await runAgentTurn(input);
      } else {
        await runAgentTurn(input);
      }
    } catch (e) {
      if (e instanceof LocalRateLimitError) {
        console.error(chalk.red(`Rate limit guard: ${e.message}`));
        printQuota();
      } else {
        console.error(chalk.red(`Error: ${e.message}`));
      }
    }
  }
}

process.on('SIGINT', () => {
  saveSession();
  console.log(chalk.yellow('\nSession saved. Bye.'));
  process.exit(0);
});

main().catch(error => {
  console.error(chalk.red(error.stack || error.message));
  process.exit(1);
});
