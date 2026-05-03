import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SERVER_SCRIPT = path.join(APP_DIR, 'tools', 'nvidia-server.mjs');
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
    process.stdout.write(`  FAIL: ${testName}${detail ? ' - ' + detail : ''}\n`);
    failures.push({ test: testName, detail });
  }
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

function writeFixtureFile(name, responses) {
  const fixturePath = path.join(os.tmpdir(), `${name}-${Date.now()}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify({ responses }, null, 2), 'utf8');
  return fixturePath;
}

function startServer({ port, fixturePath, trustAlways = true }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      HOST,
      NVIDIA_SERVER_HOST: HOST,
      NVIDIA_TEST_CHAT_FIXTURE: fixturePath
    };
    if (trustAlways) env.NVIDIA_WORKSPACE_TRUST = 'always';
    else delete env.NVIDIA_WORKSPACE_TRUST;

    const child = spawn('node', [SERVER_SCRIPT], {
      cwd: APP_DIR,
      env,
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

function extractToolResults(events = [], toolName) {
  return events.filter(ev => ev.type === 'tool_result' && ev.tool === toolName);
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function runCase({ name, fixtureResponses, autoAccept = true, trustAlways = true, userPrompt, setup, verify }) {
  const port = 3560 + Math.floor(Math.random() * 400);
  const fixturePath = writeFixtureFile(name, fixtureResponses);
  let server = null;
  let cleanup = null;
  try {
    server = await startServer({ port, fixturePath, trustAlways });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl);
    if (setup) cleanup = await setup(baseUrl);
    const response = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: userPrompt }],
      autoAccept
    });
    await verify({ baseUrl, response });
  } finally {
    if (typeof cleanup === 'function') {
      try { await cleanup(); } catch {}
    }
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

console.log('\nReal File Write/Create Flow Proof Tests\n');

const inWorkspacePath = 'proof/add_two_numbers.py';
await runCase({
  name: 'real-write-success',
  autoAccept: true,
  trustAlways: true,
  userPrompt: `Create file ${inWorkspacePath} with Python code that defines add_two_numbers(a, b) and returns a + b.`,
  fixtureResponses: [
    { message: { role: 'assistant', content: 'I will prepare that file now.' } },
    {
      match: { toolChoice: 'required' },
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_write_success',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              filePath: inWorkspacePath,
              content: 'def add_two_numbers(a, b):\n    return a + b\n'
            })
          }
        }]
      }
    },
    { message: { role: 'assistant', content: `Pending edit prepared for ${inWorkspacePath}. Review and apply it.` } }
  ],
  verify: async ({ baseUrl, response }) => {
    assert(response.ok, '1. /proxy/chat returns 200 for in-workspace create path', `status=${response.status}`);
    const events = response.data?.agent?.events || [];
    const toolResults = extractToolResults(events, 'write_file');
    assert(toolResults.some(ev => ev.ok), '1a. write_file completed successfully');
    assert(!events.some(ev => ev.type === 'status' && ev.status === 'retrying_missing_write_file'), '1b. retrying_missing_write_file did not occur for safe valid create intent');
    assert(events.some(ev => ev.type === 'status' && ev.status === 'forcing_write_file'), '1c. forced write_file fallback was used when the model omitted the tool call');
    const successfulToolResult = toolResults.find(ev => ev.ok);
    const parsedToolResult = tryParseJson(successfulToolResult?.result || '');
    const pendingArtifact = parsedToolResult?.pendingEdit || parsedToolResult?.pending_edit || null;
    const normalizedRelPath = String(pendingArtifact?.relPath || '').replace(/\\/g, '/');
    assert(normalizedRelPath === inWorkspacePath, '1d. successful write_file returned the requested pending edit artifact', normalizedRelPath || 'missing relPath');
    assert(pendingArtifact?.content?.includes('def add_two_numbers(a, b):'), '1e. pending edit content contains expected Python function');
    assert(pendingArtifact?.content?.includes('return a + b'), '1f. pending edit content contains expected logic');
    const pending = await postJson(`${baseUrl}/api/pending_edits`, {}, { 'X-Agent-Approved': 'true' });
    assert(pending.ok, '1g. pending_edits endpoint returns 200 after successful create path', `status=${pending.status}`);
  }
});

const outsideLeaf = `outside_real_write_test_${Date.now()}.py`;
const outsidePath = `..\\${outsideLeaf}`;
const outsideAbs = path.resolve(APP_DIR, '..', outsideLeaf);
await runCase({
  name: 'real-write-outside-blocked',
  autoAccept: true,
  trustAlways: true,
  userPrompt: `Create file ${outsidePath} with Python code that prints "outside".`,
  fixtureResponses: [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_write_outside',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              filePath: outsidePath,
              content: 'print("outside")\n'
            })
          }
        }]
      }
    },
    { message: { role: 'assistant', content: 'The requested path is blocked.' } }
  ],
  verify: async ({ baseUrl, response }) => {
    assert(response.ok, '2. /proxy/chat returns 200 for blocked outside-workspace case', `status=${response.status}`);
    const events = response.data?.agent?.events || [];
    const toolResults = extractToolResults(events, 'write_file');
    assert(toolResults.some(ev => !ev.ok && /outside workspace/i.test(ev.result || '')), '2a. outside-workspace write_file attempt is blocked');
    const pending = await postJson(`${baseUrl}/api/pending_edits`, {}, { 'X-Agent-Approved': 'true' });
    const edits = pending.data?.result || pending.data || [];
    assert(!edits.some(edit => edit.relPath && String(edit.relPath).endsWith(outsideLeaf)), '2b. blocked outside-workspace request did not create a pending edit');
    assert(!fs.existsSync(outsideAbs), '2c. blocked outside-workspace request did not create a disk file');
  }
});

await runCase({
  name: 'real-write-no-approval-blocked',
  autoAccept: false,
  trustAlways: true,
  userPrompt: `Create file proof/no_approval.py with Python code that prints "approval required".`,
  fixtureResponses: [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_write_no_approval',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              filePath: 'proof/no_approval.py',
              content: 'print("approval required")\n'
            })
          }
        }]
      }
    },
    { message: { role: 'assistant', content: 'Approval is required before creating that file.' } }
  ],
  verify: async ({ baseUrl, response }) => {
    assert(response.ok, '3. /proxy/chat returns 200 for no-approval case', `status=${response.status}`);
    const events = response.data?.agent?.events || [];
    const toolResults = extractToolResults(events, 'write_file');
    assert(toolResults.some(ev => !ev.ok && /requires user approval or auto-accept/i.test(ev.result || '')), '3a. no-approval path remains blocked');
    const pending = await postJson(`${baseUrl}/api/pending_edits`, {}, { 'X-Agent-Approved': 'true' });
    const edits = pending.data?.result || pending.data || [];
    assert(!edits.some(edit => edit.relPath === 'proof/no_approval.py'), '3b. no-approval path did not create a pending edit');
  }
});

await runCase({
  name: 'real-write-untrusted-blocked',
  autoAccept: true,
  trustAlways: false,
  userPrompt: 'Create file proof/untrusted.py with Python code that prints "trust required".',
  fixtureResponses: [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_write_untrusted',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              filePath: 'proof/untrusted.py',
              content: 'print("trust required")\n'
            })
          }
        }]
      }
    },
    { message: { role: 'assistant', content: 'Trusted workspace is required.' } }
  ],
  setup: async (baseUrl) => {
    const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-untrusted-workspace-'));
    fs.mkdirSync(path.join(tmpWorkspace, 'proof'), { recursive: true });
    const switched = await postJson(`${baseUrl}/api/workspace`, { path: tmpWorkspace });
    assert(switched.ok, '4. switched server to an untrusted temp workspace', `status=${switched.status}`);
    return () => {
      try { fs.rmSync(tmpWorkspace, { recursive: true, force: true }); } catch {}
    };
  },
  verify: async ({ baseUrl, response }) => {
    assert(response.ok, '4a. /proxy/chat returns 200 for untrusted-workspace case', `status=${response.status}`);
    const events = response.data?.agent?.events || [];
    const toolResults = extractToolResults(events, 'write_file');
    assert(toolResults.some(ev => !ev.ok && /trusted workspace/i.test(ev.result || '')), '4b. untrusted workspace path remains blocked');
    const pending = await postJson(`${baseUrl}/api/pending_edits`, {}, { 'X-Agent-Approved': 'true' });
    const edits = pending.data?.result || pending.data || [];
    assert(!edits.some(edit => edit.relPath === 'proof/untrusted.py'), '4c. untrusted workspace did not create a pending edit');
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) {
    console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
  }
  process.exitCode = 1;
}
