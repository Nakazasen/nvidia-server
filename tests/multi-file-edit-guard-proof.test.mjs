import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { requestJson, waitForServer } from '../tools/smoke/core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(path.join(__dirname, '..'));
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
    process.stdout.write(`  FAIL: ${testName}${detail ? ` - ${detail}` : ''}\n`);
    failures.push({ test: testName, detail });
  }
}

function writeFixtureFile(name, responses) {
  const fixturePath = path.join(os.tmpdir(), `${name}-${Date.now()}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify({ responses }, null, 2), 'utf8');
  return fixturePath;
}

function stopServer(child) {
  return new Promise((resolve) => {
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
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

function norm(v) {
  return String(v || '').replace(/\\/g, '/');
}

function removeIfExists(targetPath) {
  try {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, data };
}

function extractToolResults(events = [], toolName) {
  return events.filter((ev) => ev.type === 'tool_result' && ev.tool === toolName);
}

async function getPending(baseUrl) {
  const pendingRes = await requestJson(`${baseUrl}/api/pending_edits`, {
    method: 'POST',
    headers: { 'X-Agent-Approved': 'true' },
    body: {}
  });
  return pendingRes.json?.result || [];
}

async function clearPending(baseUrl) {
  const pending = await getPending(baseUrl);
  for (const edit of pending) {
    await postJson(`${baseUrl}/api/discard_pending_edit`, { id: edit.id }, { 'X-Agent-Approved': 'true' });
  }
}

async function applyAllPending(baseUrl) {
  const pending = await getPending(baseUrl);
  for (const edit of pending) {
    const apply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: edit.id }, { 'X-Agent-Approved': 'true' });
    assert(apply.ok, `apply pending ${edit.relPath}`, `status=${apply.status}`);
  }
}

async function scenarioA() {
  const fixturePath = writeFixtureFile('multi-edit-scenario-a', [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'tc_multi_a',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ filePath: 'proof/multi/a.py', content: 'VALUE_A = 10\n' })
          }
        },
        {
          id: 'tc_multi_b',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ filePath: 'proof/multi/b.py', content: 'VALUE_B = 20\n' })
          }
        }
      ]
    }
  }]);

  const dir = path.join(APP_DIR, 'proof', 'multi');
  const a = path.join(dir, 'a.py');
  const b = path.join(dir, 'b.py');
  const untouched = path.join(dir, 'untouched.py');
  const snapshot = {
    a: fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null,
    b: fs.existsSync(b) ? fs.readFileSync(b, 'utf8') : null,
    untouched: fs.existsSync(untouched) ? fs.readFileSync(untouched, 'utf8') : null
  };

  let server = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(a, 'VALUE_A = 1\n', 'utf8');
    fs.writeFileSync(b, 'VALUE_B = 2\n', 'utf8');
    fs.writeFileSync(untouched, 'DO_NOT_CHANGE = True\n', 'utf8');

    const port = 4721;
    server = await startServer({ port, fixturePath, trustAlways: true });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl, 20000);

    await requestJson(`${baseUrl}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: true } });
    await requestJson(`${baseUrl}/api/trust`, { method: 'POST', body: { trusted: true } });

    const prompt = 'S?a hai file proof/multi/a.py va proof/multi/b.py: ??i VALUE_A thanh 10 va VALUE_B thanh 20. Khong s?a file khac.';
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: prompt }],
      autoAccept: true
    });

    assert(res.ok, 'scenario A /proxy/chat returns 200', `status=${res.status}`);
    const pending = await getPending(baseUrl);
    const rels = pending.map(p => norm(p.relPath));
    const uniqueRels = [...new Set(rels)].sort();
    assert(uniqueRels.length === 2, 'scenario A unique pending targets are exactly 2', `unique=${uniqueRels.length} total=${rels.length}`);
    assert(JSON.stringify(uniqueRels) === JSON.stringify(['proof/multi/a.py', 'proof/multi/b.py']), 'scenario A affected file list exact match');

    assert(fs.readFileSync(a, 'utf8') === 'VALUE_A = 1\n', 'scenario A a.py unchanged before apply');
    assert(fs.readFileSync(b, 'utf8') === 'VALUE_B = 2\n', 'scenario A b.py unchanged before apply');
    assert(fs.readFileSync(untouched, 'utf8') === 'DO_NOT_CHANGE = True\n', 'scenario A untouched file unchanged before apply');

    await applyAllPending(baseUrl);

    assert(fs.readFileSync(a, 'utf8') === 'VALUE_A = 10\n', 'scenario A a.py changed after apply');
    assert(fs.readFileSync(b, 'utf8') === 'VALUE_B = 20\n', 'scenario A b.py changed after apply');
    assert(fs.readFileSync(untouched, 'utf8') === 'DO_NOT_CHANGE = True\n', 'scenario A untouched file preserved after apply');
  } finally {
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}

    if (snapshot.a === null) removeIfExists(a); else fs.writeFileSync(a, snapshot.a, 'utf8');
    if (snapshot.b === null) removeIfExists(b); else fs.writeFileSync(b, snapshot.b, 'utf8');
    if (snapshot.untouched === null) removeIfExists(untouched); else fs.writeFileSync(untouched, snapshot.untouched, 'utf8');
  }
}

async function scenarioB() {
  const fixturePath = writeFixtureFile('multi-edit-scenario-b', [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'tc_multi_b1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ filePath: 'proof/multi/a.py', content: 'VALUE_A = 10\n' })
          }
        },
        {
          id: 'tc_multi_b2',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ filePath: 'proof/multi/b.py', content: 'VALUE_B = 20\n' })
          }
        }
      ]
    }
  }]);

  const dir = path.join(APP_DIR, 'proof', 'multi');
  const a = path.join(dir, 'a.py');
  const b = path.join(dir, 'b.py');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(a, 'VALUE_A = 1\n', 'utf8');
  fs.writeFileSync(b, 'VALUE_B = 2\n', 'utf8');

  let server = null;
  try {
    const port = 4722;
    server = await startServer({ port, fixturePath, trustAlways: true });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl, 20000);

    await requestJson(`${baseUrl}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: true } });
    await requestJson(`${baseUrl}/api/trust`, { method: 'POST', body: { trusted: true } });

    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'S?a hai file proof/multi/a.py va proof/multi/b.py' }],
      autoAccept: false
    });

    assert(res.ok, 'scenario B /proxy/chat returns 200', `status=${res.status}`);
    const events = res.data?.agent?.events || [];
    const writes = extractToolResults(events, 'write_file');
    const blockedCount = writes.filter(w => !w.ok && /requires user approval or auto-accept/i.test(w.result || '')).length;
    assert(blockedCount >= 1, 'scenario B approval-required state is emitted');
    assert(events.some((ev) => ev.type === 'status' && ev.status === 'awaiting_user_approval'), 'scenario B awaiting_user_approval status emitted');
    assert(fs.readFileSync(a, 'utf8') === 'VALUE_A = 1\n', 'scenario B a.py unchanged before approval');
    assert(fs.readFileSync(b, 'utf8') === 'VALUE_B = 2\n', 'scenario B b.py unchanged before approval');
    const pending = await getPending(baseUrl);
    assert(pending.length === 0, 'scenario B approval path creates no pending edits before approval');
  } finally {
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}
    removeIfExists(path.join(APP_DIR, 'proof', 'multi'));
  }
}

async function scenarioC() {
  const outside = `..\\outside_multi_${Date.now()}.txt`;
  const outsideAbs = path.resolve(APP_DIR, '..', `outside_multi_${Date.now()}.txt`);

  const outsideFixturePath = writeFixtureFile('multi-edit-boundary-outside', [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'tc_multi_out',
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ filePath: outside, content: 'x\n' }) }
      }]
    }
  }]);

  const traversalFixturePath = writeFixtureFile('multi-edit-boundary-traversal', [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'tc_multi_traversal',
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ filePath: '../proof/multi/x.py', content: 'x\n' }) }
      }]
    }
  }]);

  const broadFixturePath = writeFixtureFile('multi-edit-boundary-broad', [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc_m1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: 'proof/multi/a.py', content: 'VALUE_A = 10\n' }) } },
        { id: 'tc_m2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: 'proof/multi/b.py', content: 'VALUE_B = 20\n' }) } },
        { id: 'tc_m3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: 'proof/multi/c.py', content: 'VALUE_C = 30\n' }) } }
      ]
    }
  }]);

  const noApprovalFixturePath = writeFixtureFile('multi-edit-boundary-no-approval', [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'tc_multi_no_approval',
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ filePath: 'proof/multi/no_approval.py', content: 'x\n' }) }
      }]
    }
  }]);

  const untrustedFixturePath = writeFixtureFile('multi-edit-boundary-untrusted', [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'tc_multi_untrusted',
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ filePath: 'proof/multi/u.py', content: 'x\n' }) }
      }]
    }
  }]);

  let s1 = null, s2 = null, s3 = null, s4 = null, s5 = null;
  try {
    s1 = await startServer({ port: 4723, fixturePath: outsideFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4723`;
      await waitForServer(baseUrl, 20000);
      const res = await postJson(`${baseUrl}/proxy/chat`, { model: 'auto', messages: [{ role: 'user', content: 'sua file ngoai workspace' }], autoAccept: true });
      const wr = extractToolResults(res.data?.agent?.events || [], 'write_file');
      assert(wr.some(w => !w.ok && /outside workspace/i.test(w.result || '')), 'boundary outside-workspace edit blocked');
      assert(!fs.existsSync(outsideAbs), 'boundary outside-workspace does not mutate disk');
    }

    s2 = await startServer({ port: 4724, fixturePath: traversalFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4724`;
      await waitForServer(baseUrl, 20000);
      const res = await postJson(`${baseUrl}/proxy/chat`, { model: 'auto', messages: [{ role: 'user', content: 'sua traversal' }], autoAccept: true });
      const wr = extractToolResults(res.data?.agent?.events || [], 'write_file');
      assert(wr.some(w => !w.ok && /outside workspace/i.test(w.result || '')), 'boundary path traversal blocked');
    }

    s3 = await startServer({ port: 4725, fixturePath: broadFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4725`;
      await waitForServer(baseUrl, 20000);
      fs.mkdirSync(path.join(APP_DIR, 'proof', 'multi'), { recursive: true });
      fs.writeFileSync(path.join(APP_DIR, 'proof', 'multi', 'a.py'), 'VALUE_A = 1\n', 'utf8');
      fs.writeFileSync(path.join(APP_DIR, 'proof', 'multi', 'b.py'), 'VALUE_B = 2\n', 'utf8');
      const res = await postJson(`${baseUrl}/proxy/chat`, {
        model: 'auto',
        messages: [{ role: 'user', content: 's?a t?t c? file trong project' }],
        autoAccept: true
      });
      assert(res.ok, 'boundary broad prompt /proxy/chat returns 200', `status=${res.status}`);
      const wr = extractToolResults(res.data?.agent?.events || [], 'write_file');
      assert(wr.some(w => !w.ok && /file-count limit exceeded/i.test(w.result || '')), 'boundary broad edit is blocked by file-count limit');
      const pending = await getPending(baseUrl);
      const rels = pending.map(p => norm(p.relPath));
      const uniqueRels = [...new Set(rels)].sort();
      assert(uniqueRels.length === 2, 'boundary file-count limit keeps unique pending targets bounded to 2', `unique=${uniqueRels.length} total=${rels.length}`);
      assert(!uniqueRels.includes('proof/multi/c.py'), 'boundary unintended third file is not pending');
    }

    s4 = await startServer({ port: 4726, fixturePath: noApprovalFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4726`;
      await waitForServer(baseUrl, 20000);
      const res = await postJson(`${baseUrl}/proxy/chat`, { model: 'auto', messages: [{ role: 'user', content: 'multi no approval' }], autoAccept: false });
      const wr = extractToolResults(res.data?.agent?.events || [], 'write_file');
      assert(wr.some(w => !w.ok && /requires user approval or auto-accept/i.test(w.result || '')), 'boundary no-approval multi-file edit blocked/approval-required');
    }

    s5 = await startServer({ port: 4727, fixturePath: untrustedFixturePath, trustAlways: false });
    {
      const baseUrl = `http://${HOST}:4727`;
      await waitForServer(baseUrl, 20000);
      const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-untrusted-multi-'));
      fs.mkdirSync(path.join(tempWorkspace, 'proof', 'multi'), { recursive: true });
      fs.writeFileSync(path.join(tempWorkspace, 'proof', 'multi', 'u.py'), 'VALUE_U = 1\n', 'utf8');
      try {
        await postJson(`${baseUrl}/api/workspace`, { path: tempWorkspace });
        const res = await postJson(`${baseUrl}/proxy/chat`, { model: 'auto', messages: [{ role: 'user', content: 'untrusted multi' }], autoAccept: true });
        const wr = extractToolResults(res.data?.agent?.events || [], 'write_file');
        assert(wr.some(w => !w.ok && /trusted workspace/i.test(w.result || '')), 'boundary untrusted workspace multi-file edit blocked');
      } finally {
        removeIfExists(tempWorkspace);
      }
    }
  } finally {
    await stopServer(s1); await stopServer(s2); await stopServer(s3); await stopServer(s4); await stopServer(s5);
    try { fs.unlinkSync(outsideFixturePath); } catch {}
    try { fs.unlinkSync(traversalFixturePath); } catch {}
    try { fs.unlinkSync(broadFixturePath); } catch {}
    try { fs.unlinkSync(noApprovalFixturePath); } catch {}
    try { fs.unlinkSync(untrustedFixturePath); } catch {}
    removeIfExists(path.join(APP_DIR, 'proof', 'multi'));
  }
}

async function main() {
  console.log('\nMulti-File Edit Guard Proof Tests\n');
  await scenarioA();
  await scenarioB();
  await scenarioC();

  process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const failure of failures) {
      console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
    }
    process.exitCode = 1;
  }
}

await main();
