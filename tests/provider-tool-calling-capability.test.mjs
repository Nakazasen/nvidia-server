import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SERVER_SCRIPT = path.join(APP_DIR, 'tools', 'nvidia-server.mjs');
const HOST = '127.0.0.1';
const STATE_DIR = path.join(APP_DIR, '.nvidia-agent');
const PROVIDERS_FILE = path.join(STATE_DIR, 'providers.json');
const APPROVED_IDE_HEADERS = { 'X-Agent-Approved': 'true' };

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS: ${testName}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL: ${testName}${detail ? ' - ' + detail : ''}\n`);
    failures.push({ test: testName, detail });
  }
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, content: '' };
  return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
}

function restoreFile(filePath, snapshot) {
  if (!snapshot?.exists) {
    try { fs.unlinkSync(filePath); } catch {}
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, snapshot.content, 'utf8');
}

function writeProviderState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    defaultProviderId: 'openai',
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4.1-mini',
        enabled: true
      },
      {
        id: 'nvidia',
        label: 'NVIDIA NIM',
        type: 'nvidia',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        defaultModel: 'meta/llama-3.1-405b-instruct',
        enabled: true
      }
    ]
  }, null, 2), 'utf8');
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server not ready: ${url}`);
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_SCRIPT], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        HOST,
        NVIDIA_SERVER_HOST: HOST,
        NVIDIA_WORKSPACE_TRUST: 'always'
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
      const text = String(buf || '');
      if (/server running at/i.test(text)) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      resolve();
    }
  });
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}

async function postStream(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, contentType: res.headers.get('content-type') || '', text };
}

function extractSseJson(text, eventName) {
  const parts = String(text || '').split('\n\n');
  for (const part of parts) {
    const event = part.split('\n').find(line => line.startsWith('event:'));
    const data = part.split('\n').find(line => line.startsWith('data:'));
    if (!event || !data) continue;
    if (event.slice(6).trim() !== eventName) continue;
    try {
      return JSON.parse(data.slice(5).trim());
    } catch {
      return null;
    }
  }
  return null;
}

console.log('\nProvider Tool-Calling Capability Regression Tests\n');

const providerSnapshot = backupFile(PROVIDERS_FILE);
const blockedAbs = path.join(APP_DIR, 'proof', 'provider_unsupported.py');
let server = null;

try {
  writeProviderState();
  const port = 3920 + Math.floor(Math.random() * 200);
  server = await startServer(port);
  const baseUrl = `http://${HOST}:${port}`;
  await waitForServer(baseUrl);

  const response = await postJson(`${baseUrl}/proxy/chat`, {
    model: 'auto',
    messages: [{ role: 'user', content: 'Create file proof/provider_unsupported.py with Python code that prints "unsupported".' }],
    autoAccept: true
  });
  assert(response.ok, '1. unsupported provider /proxy/chat returns 200', `status=${response.status}`);
  assert(response.data?.status === 'PROVIDER_TOOL_CALLING_UNSUPPORTED', '1a. unsupported provider returns classified status');
  assert(response.data?.providerCapability?.code === 'PROVIDER_TOOL_CALLING_UNSUPPORTED', '1b. providerCapability exposes PROVIDER_TOOL_CALLING_UNSUPPORTED');
  assert(response.data?.providerCapability?.provider === 'openai', '1c. classified failure preserves selected provider');
  assert(Array.isArray(response.data?.providerCapability?.unsupportedFields) && response.data.providerCapability.unsupportedFields.includes('tools'), '1d. unsupported provider blocks tools');
  assert(Array.isArray(response.data?.providerCapability?.unsupportedFields) && response.data.providerCapability.unsupportedFields.includes('tool_choice'), '1e. unsupported provider blocks tool_choice');
  assert(response.data?.providerCapability?.providerCallAttempted === false, '1f. unsupported provider is blocked before provider call');
  assert(response.data?.providerCapability?.mutationApplied === false, '1g. unsupported provider reports no mutation applied');
  const events = response.data?.agent?.events || [];
  assert(events.length === 1 && events[0]?.status === 'blocked_provider_capability', '1h. agent emits blocked_provider_capability event');
  assert(!fs.existsSync(blockedAbs), '1i. unsupported provider did not write disk file');
  const pending = await postJson(`${baseUrl}/api/pending_edits`, {}, APPROVED_IDE_HEADERS);
  const pendingList = pending.data?.result || pending.data || [];
  assert(Array.isArray(pendingList) && pendingList.length === 0, '1j. unsupported provider did not create pending edits');

  const streamResponse = await postStream(`${baseUrl}/proxy/chat`, {
    model: 'auto',
    messages: [{ role: 'user', content: 'Create file proof/provider_unsupported.py with Python code that prints "unsupported".' }],
    autoAccept: true,
    stream: true
  });
  assert(streamResponse.ok, '2. unsupported provider stream path returns 200', `status=${streamResponse.status}`);
  assert(/text\/event-stream/i.test(streamResponse.contentType), '2a. unsupported provider stream path stays SSE');
  const streamFinal = extractSseJson(streamResponse.text, 'final');
  assert(streamFinal?.status === 'PROVIDER_TOOL_CALLING_UNSUPPORTED', '2b. stream path emits classified unsupported status');
  assert(streamFinal?.providerCapability?.providerCallAttempted === false, '2c. stream path blocks before provider call');
  assert(Array.isArray(streamFinal?.providerCapability?.unsupportedFields) && streamFinal.providerCapability.unsupportedFields.includes('stream_with_tools'), '2d. stream path classifies stream_with_tools as unsupported');
} finally {
  await stopServer(server);
  restoreFile(PROVIDERS_FILE, providerSnapshot);
  try { fs.unlinkSync(blockedAbs); } catch {}
}

process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) {
    console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
  }
  process.exitCode = 1;
}
