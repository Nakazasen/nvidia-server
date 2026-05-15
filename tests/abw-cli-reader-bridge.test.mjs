import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { ABW_CLI_STATUS, createAbwCliReader } from '../tools/abw-cli-reader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(path.join(__dirname, '..'));
const SERVER_SCRIPT = path.join(APP_DIR, 'tools', 'nvidia-server.mjs');
const MOCK_ABW_SCRIPT = path.join(APP_DIR, 'tests', 'fixtures', 'mock-abw-cli.mjs');
const HOST = '127.0.0.1';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS: ${testName}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL: ${testName}${detail ? ` - ${detail}` : ''}\n`);
    failures.push({ test: testName, detail });
  }
}

function makeRunner(result) {
  return async () => ({ ...result });
}

function makeEnvelope(commandName, status, data, workspace = 'D:/tmp/mock-workspace') {
  return JSON.stringify({
    schema_version: '1',
    command_name: commandName,
    workspace,
    generated_at: '2026-05-15T00:00:00Z',
    status,
    data
  });
}

function startServer({ port, trustAlways = true, mockMode = 'ask-success' }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_SCRIPT], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        HOST,
        NVIDIA_SERVER_HOST: HOST,
        ABW_CLI_LAUNCHER: 'node',
        ABW_CLI_BASE_ARGS: JSON.stringify([MOCK_ABW_SCRIPT]),
        ABW_MOCK_MODE: mockMode,
        ...(trustAlways ? { NVIDIA_WORKSPACE_TRUST: 'always' } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`Server startup timed out on port ${port}`));
    }, 20000);

    const onData = (buf) => {
      if (settled) return;
      if (/server running at/i.test(String(buf || ''))) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      resolve();
    }
  });
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server not ready: ${url}`);
}

async function requestJson(url, { method = 'POST', body = undefined, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: response.ok, status: response.status, json, text };
}

async function getPendingEdits(baseUrl) {
  const response = await requestJson(`${baseUrl}/api/pending_edits`, { method: 'GET' });
  return response.json?.edits || [];
}

console.log('\nABW CLI Reader Bridge Tests\n');

{
  const reader = createAbwCliReader({
    runProcess: makeRunner({
      exitCode: 0,
      stdout: makeEnvelope('version', 'success', { version: '1.1.0', package: 'abw_skill', python: '3.13' }),
      stderr: '',
      durationMs: 12,
      command: ['py', '-m', 'abw.cli', '--json', '--workspace', 'D:/tmp/mock-workspace', 'version']
    })
  });
  const result = await reader.readVersion({ workspace: 'D:/tmp/mock-workspace' });
  assert(result.status === ABW_CLI_STATUS.OK, '1. version JSON parse success', `status=${result.status}`);
  assert(result.data?.version === '1.1.0', '1a. version payload preserved');
}

{
  const reader = createAbwCliReader({
    runProcess: makeRunner({
      exitCode: 0,
      stdout: makeEnvelope('doctor', 'warning', { ok: false, checks: [{ level: 'WARN', message: 'mock doctor' }] }),
      stderr: '',
      durationMs: 8,
      command: ['py', '-m', 'abw.cli', '--json', '--workspace', 'D:/tmp/mock-workspace', 'doctor']
    })
  });
  const result = await reader.readDoctor({ workspace: 'D:/tmp/mock-workspace' });
  assert(result.status === ABW_CLI_STATUS.OK, '2. doctor JSON parse success', `status=${result.status}`);
  assert(Array.isArray(result.data?.checks), '2a. doctor checks preserved');
}

{
  const reader = createAbwCliReader({
    runProcess: makeRunner({
      exitCode: 0,
      stdout: makeEnvelope('ask', 'success', {
        answer: 'AGV communication uses MQTT.',
        retrieval_status: 'exact_match',
        trust_score: 70,
        sources: [{ path: 'wiki/agv.md' }],
        warnings: [],
        gap_logged: false,
        gap_id: null,
        current_state: 'knowledge_answered',
        knowledge_evidence_tier: 'E2_wiki',
        knowledge_source_score: 2,
        source_summary: 'local_wiki',
        logs: [],
        provider: 'local'
      }),
      stderr: '',
      durationMs: 6,
      command: ['py', '-m', 'abw.cli', '--json', '--workspace', 'D:/tmp/mock-workspace', 'ask', 'How does AGV communication work?']
    })
  });
  const result = await reader.ask({ workspace: 'D:/tmp/mock-workspace', question: 'How does AGV communication work?' });
  assert(result.status === ABW_CLI_STATUS.OK, '3. ask known-source JSON success', `status=${result.status}`);
  assert(result.data?.retrieval_status === 'exact_match', '3a. ask retrieval_status preserved');
  assert(result.data?.knowledge_evidence_tier === 'E2_wiki', '3b. ask evidence tier preserved');
}

{
  const reader = createAbwCliReader({
    runProcess: makeRunner({
      exitCode: 0,
      stdout: makeEnvelope('ask', 'no_match', {
        answer: 'No grounded answer found.',
        retrieval_status: 'no_match',
        trust_score: 0,
        sources: [],
        warnings: ['Need to ingest sources first.'],
        gap_logged: true,
        gap_id: 'gap-123',
        current_state: 'knowledge_gap_logged',
        knowledge_evidence_tier: 'E0_unknown',
        knowledge_source_score: 0,
        source_summary: 'no_grounded_sources',
        logs: [],
        provider: 'local'
      }),
      stderr: '',
      durationMs: 7,
      command: ['py', '-m', 'abw.cli', '--json', '--workspace', 'D:/tmp/mock-workspace', 'ask', 'Who is missing?']
    })
  });
  const result = await reader.ask({ workspace: 'D:/tmp/mock-workspace', question: 'Who is missing?' });
  assert(result.status === ABW_CLI_STATUS.GAP_LOGGED, '4. ask no-match gap maps to machine status', `status=${result.status}`);
}

{
  const reader = createAbwCliReader({
    runProcess: makeRunner({
      exitCode: 0,
      stdout: makeEnvelope('ask', 'success', {
        answer: 'Raw note says AGV dispatch uses MQTT.',
        retrieval_status: 'raw_or_draft_only',
        trust_score: 45,
        sources: [{ path: 'raw/agv-raw.md' }],
        warnings: ['Weak evidence: answer is based on raw or draft material, not grounded wiki.'],
        gap_logged: false,
        gap_id: null,
        current_state: 'knowledge_answered',
        knowledge_evidence_tier: 'E1_fallback',
        knowledge_source_score: 2,
        source_summary: 'raw_source',
        logs: [],
        provider: 'local'
      }),
      stderr: '',
      durationMs: 7,
      command: ['py', '-m', 'abw.cli', '--json', '--workspace', 'D:/tmp/mock-workspace', 'ask', 'What does the raw AGV note say?']
    })
  });
  const result = await reader.ask({ workspace: 'D:/tmp/mock-workspace', question: 'What does the raw AGV note say?' });
  assert(result.status === ABW_CLI_STATUS.OK, '4a. ask raw-only success remains machine-readable', `status=${result.status}`);
  assert(result.data?.retrieval_status === 'raw_or_draft_only', '4b. raw-only retrieval_status preserved');
  assert(result.data?.knowledge_evidence_tier === 'E1_fallback', '4c. raw-only evidence tier preserved');
}

{
  const reader = createAbwCliReader({
    runProcess: makeRunner({
      exitCode: 0,
      stdout: 'not-json',
      stderr: '',
      durationMs: 4,
      command: ['py', '-m', 'abw.cli', '--json']
    })
  });
  const result = await reader.readVersion({ workspace: 'D:/tmp/mock-workspace' });
  assert(result.status === ABW_CLI_STATUS.INVALID_JSON, '5. invalid JSON maps to ABW_CLI_INVALID_JSON', `status=${result.status}`);
}

{
  const reader = createAbwCliReader({
    runProcess: async () => ({ error: Object.assign(new Error('spawn py ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '', durationMs: 1, command: ['py'] })
  });
  const result = await reader.readVersion({ workspace: 'D:/tmp/mock-workspace' });
  assert(result.status === ABW_CLI_STATUS.NOT_FOUND, '6. missing command maps to ABW_CLI_NOT_FOUND', `status=${result.status}`);
}

{
  const reader = createAbwCliReader({
    runProcess: makeRunner({
      timedOut: true,
      stdout: '',
      stderr: '',
      durationMs: 25000,
      command: ['py', '-m', 'abw.cli']
    })
  });
  const result = await reader.readDoctor({ workspace: 'D:/tmp/mock-workspace' });
  assert(result.status === ABW_CLI_STATUS.TIMEOUT, '7. timeout maps to ABW_CLI_TIMEOUT', `status=${result.status}`);
}

{
  const reader = createAbwCliReader({
    runProcess: makeRunner({
      exitCode: 7,
      stdout: '',
      stderr: 'mock nonzero',
      durationMs: 5,
      command: ['py', '-m', 'abw.cli']
    })
  });
  const result = await reader.readDoctor({ workspace: 'D:/tmp/mock-workspace' });
  assert(result.status === ABW_CLI_STATUS.NONZERO_EXIT, '8. nonzero exit maps to ABW_CLI_NONZERO_EXIT', `status=${result.status}`);
}

{
  const reader = createAbwCliReader({
    runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, command: [] })
  });
  const result = await reader.ask({ workspace: '', question: 'Where is AGV?' });
  assert(result.status === ABW_CLI_STATUS.WORKSPACE_REQUIRED, '9. workspace path is required', `status=${result.status}`);
}

{
  const port = 4861;
  const baseUrl = `http://${HOST}:${port}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-abw-reader-workspace-'));
  const markerPath = path.join(workspace, 'proof', 'marker.txt');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, 'before\n', 'utf8');
  const beforeMarker = fs.readFileSync(markerPath, 'utf8');
  let server = null;
  try {
    server = await startServer({ port, trustAlways: true, mockMode: 'ask-success' });
    await waitForServer(`${baseUrl}/api/health`);
    const switched = await requestJson(`${baseUrl}/api/workspace`, { body: { path: workspace } });
    assert(switched.ok, '10. workspace switch for ABW reader endpoint succeeds', `status=${switched.status}`);
    const ask = await requestJson(`${baseUrl}/proxy/abw/ask`, {
      body: {
        workspace,
        question: 'How does AGV communication work?'
      }
    });
    assert(ask.ok, '10a. /proxy/abw/ask returns 200', `status=${ask.status}`);
    assert(ask.json?.status === ABW_CLI_STATUS.OK, '10b. endpoint returns ABW_CLI_OK', `status=${ask.json?.status}`);
    assert(ask.json?.retrievalStatus === 'exact_match', '10c. endpoint exposes retrievalStatus');
    assert(ask.json?.evidenceTier === 'E2_wiki', '10d. endpoint exposes evidenceTier');
    assert(ask.json?.readOnly === true, '10e. endpoint exposes readOnly=true');
    assert(Array.isArray(ask.json?.sources) && ask.json.sources.length === 1, '10f. endpoint exposes sources');
    const pendingEdits = await getPendingEdits(baseUrl);
    assert(Array.isArray(pendingEdits) && pendingEdits.length === 0, '10g. bridge does not create pending edit');
    const afterMarker = fs.readFileSync(markerPath, 'utf8');
    assert(afterMarker === beforeMarker, '10h. bridge does not mutate disk');
  } finally {
    await stopServer(server);
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

{
  const port = 4863;
  const baseUrl = `http://${HOST}:${port}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-abw-reader-raw-'));
  let server = null;
  try {
    server = await startServer({ port, trustAlways: true, mockMode: 'ask-raw-only' });
    await waitForServer(`${baseUrl}/api/health`);
    const switched = await requestJson(`${baseUrl}/api/workspace`, { body: { path: workspace } });
    assert(switched.ok, '12. workspace switch for raw-only bridge test succeeds', `status=${switched.status}`);
    const ask = await requestJson(`${baseUrl}/proxy/abw/ask`, {
      body: {
        workspace,
        question: 'What does the raw AGV note say?'
      }
    });
    assert(ask.ok, '12a. raw-only /proxy/abw/ask returns 200', `status=${ask.status}`);
    assert(ask.json?.status === ABW_CLI_STATUS.OK, '12b. raw-only endpoint stays ABW_CLI_OK', `status=${ask.json?.status}`);
    assert(ask.json?.retrievalStatus === 'raw_or_draft_only', '12c. raw-only retrievalStatus exposed');
    assert(ask.json?.evidenceTier === 'E1_fallback', '12d. raw-only evidenceTier exposed');
    assert(Array.isArray(ask.json?.warnings) && ask.json.warnings.some(w => /raw or draft material/i.test(w)), '12e. raw-only warnings preserved');
    assert(ask.json?.readOnly === true, '12f. raw-only endpoint stays readOnly');
  } finally {
    await stopServer(server);
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

{
  const port = 4864;
  const baseUrl = `http://${HOST}:${port}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-abw-reader-nomatch-'));
  const markerPath = path.join(workspace, 'proof', 'marker.txt');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, 'before\n', 'utf8');
  let server = null;
  try {
    server = await startServer({ port, trustAlways: true, mockMode: 'ask-no-match-read-only' });
    await waitForServer(`${baseUrl}/api/health`);
    const switched = await requestJson(`${baseUrl}/api/workspace`, { body: { path: workspace } });
    assert(switched.ok, '13. workspace switch for no-match bridge test succeeds', `status=${switched.status}`);
    const ask = await requestJson(`${baseUrl}/proxy/abw/ask`, {
      body: {
        workspace,
        question: 'Who is Chu Van?'
      }
    });
    assert(ask.ok, '13a. no-match /proxy/abw/ask returns 200', `status=${ask.status}`);
    assert(ask.json?.status === ABW_CLI_STATUS.NO_MATCH, '13b. no-match endpoint returns ABW_CLI_NO_MATCH', `status=${ask.json?.status}`);
    assert(ask.json?.retrievalStatus === 'no_match', '13c. no-match retrievalStatus exposed');
    assert(Array.isArray(ask.json?.sources) && ask.json.sources.length === 0, '13d. no-match keeps empty sources');
    assert(ask.json?.gapLogSuppressed === true && ask.json?.wouldLogGap === true, '13e. no-match suppression flags preserved');
    assert(ask.json?.runtimeWriteSuppressed === true, '13f. no-match runtime write suppression preserved');
    assert(ask.json?.readOnly === true, '13g. no-match endpoint stays readOnly');
    const afterMarker = fs.readFileSync(markerPath, 'utf8');
    assert(afterMarker === 'before\n', '13h. no-match endpoint does not mutate disk');
  } finally {
    await stopServer(server);
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

{
  const port = 4862;
  const baseUrl = `http://${HOST}:${port}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-abw-reader-untrusted-'));
  let server = null;
  try {
    server = await startServer({ port, trustAlways: false, mockMode: 'version-ok' });
    await waitForServer(`${baseUrl}/api/health`);
    const switched = await requestJson(`${baseUrl}/api/workspace`, { body: { path: workspace } });
    assert(switched.ok, '11. workspace switch for untrusted bridge test succeeds', `status=${switched.status}`);
    const version = await requestJson(`${baseUrl}/proxy/abw/version`, { body: { workspace } });
    assert(version.status === 403, '11a. untrusted workspace is blocked', `status=${version.status}`);
    assert(version.json?.status === ABW_CLI_STATUS.TRUST_REQUIRED, '11b. trust failure is classified', `status=${version.json?.status}`);
  } finally {
    await stopServer(server);
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
}

console.log('\n---');
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(({ test, detail }) => console.log(`  - ${test}: ${detail}`));
  process.exit(1);
}

console.log('\nAll tests passed.');
