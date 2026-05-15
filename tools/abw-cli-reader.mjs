import { spawn } from 'child_process';
import path from 'path';

export const ABW_CLI_STATUS = Object.freeze({
  OK: 'ABW_CLI_OK',
  NOT_FOUND: 'ABW_CLI_NOT_FOUND',
  TIMEOUT: 'ABW_CLI_TIMEOUT',
  NONZERO_EXIT: 'ABW_CLI_NONZERO_EXIT',
  INVALID_JSON: 'ABW_CLI_INVALID_JSON',
  SCHEMA_UNSUPPORTED: 'ABW_CLI_SCHEMA_UNSUPPORTED',
  WORKSPACE_REQUIRED: 'ABW_CLI_WORKSPACE_REQUIRED',
  TRUST_REQUIRED: 'ABW_CLI_TRUST_REQUIRED',
  WRONG_WORKSPACE: 'ABW_CLI_WRONG_WORKSPACE',
  NO_MATCH: 'ABW_CLI_NO_MATCH',
  GAP_LOGGED: 'ABW_CLI_GAP_LOGGED',
  AMBIGUOUS: 'ABW_CLI_AMBIGUOUS',
  NO_CONFIDENT_WORKSPACE: 'ABW_CLI_NO_CONFIDENT_WORKSPACE',
  BLOCKED: 'ABW_CLI_BLOCKED'
});

const SUPPORTED_COMMANDS = new Set(['ask', 'doctor', 'version']);
const DEFAULT_TIMEOUT_MS = Number(process.env.ABW_CLI_TIMEOUT_MS || 20000);
const DEFAULT_MAX_OUTPUT_CHARS = Number(process.env.ABW_CLI_MAX_OUTPUT_CHARS || 400000);

function resolveRepoPath(value = process.env.ABW_REPO_PATH) {
  const normalized = String(value || '').trim();
  return normalized ? path.resolve(normalized) : '';
}

function buildPythonPath(repoPath, env = process.env) {
  const repoSrc = path.join(repoPath, 'src');
  const existing = String(env.PYTHONPATH || '').trim();
  return existing ? `${repoSrc}${path.delimiter}${existing}` : repoSrc;
}

function resolveBaseArgs(value = process.env.ABW_CLI_BASE_ARGS) {
  if (!value) return ['-m', 'abw.cli'];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && item.trim())) {
      return parsed.map(item => item.trim());
    }
  } catch {}
  return ['-m', 'abw.cli'];
}

function truncate(value, limit) {
  const text = String(value || '');
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  return text.slice(0, limit);
}

function makeErrorResult(status, details = {}) {
  return {
    ok: false,
    status,
    commandName: details.commandName || null,
    abw: null,
    data: null,
    error: details.error || '',
    stderr: details.stderr || '',
    stdout: details.stdout || '',
    exitCode: details.exitCode ?? null,
    durationMs: details.durationMs ?? 0,
    command: Array.isArray(details.command) ? details.command : [],
    runtime: details.runtime && typeof details.runtime === 'object' ? details.runtime : null
  };
}

function validateEnvelope(payload, commandName) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'ABW payload is not a JSON object.';
  if (String(payload.schema_version || '').trim() !== '1') return `Unsupported schema_version: ${payload.schema_version ?? ''}`;
  if (String(payload.command_name || '').trim() !== commandName) return `Unexpected command_name: ${payload.command_name ?? ''}`;
  if (!String(payload.workspace || '').trim()) return 'Missing workspace.';
  if (!String(payload.generated_at || '').trim()) return 'Missing generated_at.';
  if (!String(payload.status || '').trim()) return 'Missing status.';
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return 'Missing data object.';
  return '';
}

function classifyEnvelope(payload) {
  const status = String(payload?.status || '').trim().toLowerCase();
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  if (status === 'wrong_workspace') return ABW_CLI_STATUS.WRONG_WORKSPACE;
  if (status === 'ambiguous') return ABW_CLI_STATUS.AMBIGUOUS;
  if (status === 'no_confident_workspace') return ABW_CLI_STATUS.NO_CONFIDENT_WORKSPACE;
  if (status === 'knowledge_gap_logged') return ABW_CLI_STATUS.GAP_LOGGED;
  if (status === 'blocked' || status === 'approval_required') return ABW_CLI_STATUS.BLOCKED;
  if (status === 'no_match') {
    return data.gap_logged ? ABW_CLI_STATUS.GAP_LOGGED : ABW_CLI_STATUS.NO_MATCH;
  }
  return ABW_CLI_STATUS.OK;
}

function makeSuccessResult(status, payload, details = {}) {
  return {
    ok: true,
    status,
    commandName: payload.command_name,
    abw: payload,
    data: payload.data,
    error: '',
    stderr: details.stderr || '',
    stdout: details.stdout || '',
    exitCode: details.exitCode ?? 0,
    durationMs: details.durationMs ?? 0,
    command: Array.isArray(details.command) ? details.command : [],
    runtime: details.runtime && typeof details.runtime === 'object' ? details.runtime : null
  };
}

function createSpawnRunner({
  spawnImpl = spawn,
  launcher = process.env.ABW_CLI_LAUNCHER || 'py',
  baseArgs = resolveBaseArgs(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  envOverrides = { ABW_READ_ONLY_QUERY: '1' },
  abwRepoPath = resolveRepoPath()
} = {}) {
  return ({ commandName, workspace, commandArgs = [] }) => new Promise((resolve) => {
    const childArgs = [...baseArgs, '--json', '--workspace', workspace, commandName, ...commandArgs];
    const fullCommand = [launcher, ...childArgs];
    const normalizedRepoPath = resolveRepoPath(abwRepoPath);
    const spawnCwd = normalizedRepoPath || process.cwd();
    const runtimeEnv = {
      ...process.env,
      ...envOverrides
    };
    if (normalizedRepoPath) {
      runtimeEnv.PYTHONPATH = buildPythonPath(normalizedRepoPath, runtimeEnv);
    }
    const runtime = {
      runtimeSource: normalizedRepoPath ? 'repo' : 'default',
      abwRepoPath: normalizedRepoPath || null,
      pythonExecutable: launcher,
      commandArgs: childArgs,
      cwd: spawnCwd
    };
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let exitCode = null;
    let timer = null;

    const finalize = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...result,
        stdout: truncate(stdout, maxOutputChars),
        stderr: truncate(stderr, maxOutputChars),
        exitCode,
        durationMs: Date.now() - startedAt,
        command: fullCommand,
        runtime
      });
    };

    let child = null;
    try {
      child = spawnImpl(launcher, childArgs, {
        cwd: spawnCwd,
        env: runtimeEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      return finalize({ error, stdout, stderr, exitCode: null });
    }

    const enforceOutputCap = () => {
      if (outputExceeded) return;
      if ((stdout.length + stderr.length) <= maxOutputChars) return;
      outputExceeded = true;
      try { child.kill(); } catch {}
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '');
        enforceOutputCap();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
        enforceOutputCap();
      });
    }

    child.once('error', (error) => finalize({ error }));
    child.once('close', (code) => {
      exitCode = Number.isInteger(code) ? code : null;
      finalize({
        timedOut,
        outputExceeded,
        stdout,
        stderr
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, Math.max(1000, timeoutMs));
  });
}

export function createAbwCliReader(options = {}) {
  const runProcess = options.runProcess || createSpawnRunner(options);

  async function invoke(commandName, { workspace = '', question = '' } = {}) {
    const normalizedCommand = String(commandName || '').trim();
    const normalizedWorkspace = String(workspace || '').trim();

    if (!SUPPORTED_COMMANDS.has(normalizedCommand)) {
      return makeErrorResult(ABW_CLI_STATUS.SCHEMA_UNSUPPORTED, {
        commandName: normalizedCommand,
        error: `Unsupported ABW CLI command: ${normalizedCommand}`
      });
    }
    if (!normalizedWorkspace) {
      return makeErrorResult(ABW_CLI_STATUS.WORKSPACE_REQUIRED, {
        commandName: normalizedCommand,
        error: 'workspace is required'
      });
    }

    const commandArgs = [];
    if (normalizedCommand === 'ask') {
      const normalizedQuestion = String(question || '').trim();
      if (!normalizedQuestion) {
        return makeErrorResult(ABW_CLI_STATUS.INVALID_JSON, {
          commandName: normalizedCommand,
          error: 'question is required for ask'
        });
      }
      commandArgs.push(normalizedQuestion);
    }

    const result = await runProcess({ commandName: normalizedCommand, workspace: normalizedWorkspace, commandArgs });
    if (result?.error) {
      const code = String(result.error.code || '').trim().toUpperCase();
      return makeErrorResult(code === 'ENOENT' ? ABW_CLI_STATUS.NOT_FOUND : ABW_CLI_STATUS.NONZERO_EXIT, {
        commandName: normalizedCommand,
        error: String(result.error.message || result.error),
        stderr: result.stderr || '',
        stdout: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        command: result.command,
        runtime: result.runtime
      });
    }
    if (result?.timedOut) {
      return makeErrorResult(ABW_CLI_STATUS.TIMEOUT, {
        commandName: normalizedCommand,
        error: `ABW CLI timed out after ${result.durationMs}ms`,
        stderr: result.stderr || '',
        stdout: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        command: result.command,
        runtime: result.runtime
      });
    }
    if (result?.outputExceeded) {
      return makeErrorResult(ABW_CLI_STATUS.INVALID_JSON, {
        commandName: normalizedCommand,
        error: 'ABW CLI output exceeded capture limit.',
        stderr: result.stderr || '',
        stdout: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        command: result.command,
        runtime: result.runtime
      });
    }
    if (result?.exitCode !== 0) {
      return makeErrorResult(ABW_CLI_STATUS.NONZERO_EXIT, {
        commandName: normalizedCommand,
        error: `ABW CLI exited with code ${result.exitCode}`,
        stderr: result.stderr || '',
        stdout: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        command: result.command,
        runtime: result.runtime
      });
    }

    let payload = null;
    try {
      payload = JSON.parse(String(result.stdout || '').trim());
    } catch (error) {
      return makeErrorResult(ABW_CLI_STATUS.INVALID_JSON, {
        commandName: normalizedCommand,
        error: `ABW CLI returned invalid JSON: ${error.message}`,
        stderr: result.stderr || '',
        stdout: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        command: result.command,
        runtime: result.runtime
      });
    }

    const validationError = validateEnvelope(payload, normalizedCommand);
    if (validationError) {
      return makeErrorResult(ABW_CLI_STATUS.SCHEMA_UNSUPPORTED, {
        commandName: normalizedCommand,
        error: validationError,
        stderr: result.stderr || '',
        stdout: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        command: result.command
      });
    }

    return makeSuccessResult(classifyEnvelope(payload), payload, result);
  }

  return {
    invoke,
    readVersion: (options = {}) => invoke('version', options),
    readDoctor: (options = {}) => invoke('doctor', options),
    ask: (options = {}) => invoke('ask', options)
  };
}
