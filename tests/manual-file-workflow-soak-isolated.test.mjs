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

function removeIfExists(targetPath) {
  try {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/');
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

async function applyAllPending(baseUrl, tag) {
  let applied = 0;
  while (true) {
    const pending = await getPending(baseUrl);
    if (!pending.length) break;
    const edit = pending[0];
    const apply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: edit.id }, { 'X-Agent-Approved': 'true' });
    const tolerated = apply.status === 403;
    assert(apply.ok || tolerated, `${tag} apply pending ${edit.relPath}`, `status=${apply.status}`);
    if (!apply.ok && tolerated) break;
    if (!apply.ok) break;
    applied++;
  }
  return applied;
}

function extractToolResults(events = [], toolName) {
  return events.filter((ev) => ev.type === 'tool_result' && ev.tool === toolName);
}

function scenarioPath(name) {
  return `proof/soak-isolated/${name}`;
}

function absPath(...parts) {
  return path.join(APP_DIR, ...parts);
}

async function withScenario({ name, responses, trustAlways = true }, runFn) {
  const fixturePath = writeFixtureFile(`soak-${name}`, responses);
  const port = 4900 + Math.floor(Math.random() * 500);
  let server = null;
  const scenarioRoot = absPath('proof', 'soak-isolated', name);
  removeIfExists(scenarioRoot);
  fs.mkdirSync(scenarioRoot, { recursive: true });
  try {
    server = await startServer({ port, fixturePath, trustAlways });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl, 20000);
    await requestJson(`${baseUrl}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: true } });
    await requestJson(`${baseUrl}/api/trust`, { method: 'POST', body: { trusted: true } });
    await clearPending(baseUrl);
    assert((await getPending(baseUrl)).length === 0, `${name} pending reset before scenario`);
    await runFn({ baseUrl, scenarioRoot });
    await clearPending(baseUrl);
    assert((await getPending(baseUrl)).length === 0, `${name} pending reset after scenario`);
  } finally {
    removeIfExists(scenarioRoot);
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

async function scenarioCreateOn() {
  const relFile = `${scenarioPath('create-on')}/create_note.md`;
  await withScenario({
    name: 'create-on',
    responses: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'create_on_call',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              filePath: relFile,
              content: '# Kiem tra may\n\n1. Bat nguon\n2. Kiem tra mang\n3. Chay test nhanh\n'
            })
          }
        }]
      }
    }]
  }, async ({ baseUrl }) => {
    const targetAbs = absPath(...relFile.split('/'));
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Tao file proof/soak-isolated/create-on/create_note.md voi noi dung markdown mo ta 3 buoc kiem tra may.' }],
      autoAccept: true
    });
    assert(res.ok, 'create-on /proxy/chat returns 200', `status=${res.status}`);
    assert(!fs.existsSync(targetAbs), 'create-on no disk mutation before apply');
    const pending = await getPending(baseUrl);
    assert(pending.some((p) => normalizeRelPath(p.relPath) === relFile), 'create-on pending edit visible');
    await applyAllPending(baseUrl, 'create-on');
    assert(fs.existsSync(targetAbs), 'create-on file exists after apply');
    const content = fs.readFileSync(targetAbs, 'utf8');
    assert(content.includes('# Kiem tra may') && content.includes('3.'), 'create-on meaningful markdown content');
  });
}

async function scenarioCreateOff() {
  const relFile = `${scenarioPath('create-off')}/create_approval.txt`;
  const responses = [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'create_off_call_1',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ filePath: relFile, content: 'KIEM TRA APPROVAL\n' }) }
        }]
      }
    },
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'create_off_call_2',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ filePath: relFile, content: 'KIEM TRA APPROVAL\n' }) }
        }]
      }
    }
  ];
  await withScenario({ name: 'create-off', responses }, async ({ baseUrl }) => {
    const targetAbs = absPath(...relFile.split('/'));
    const blocked = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Tao file proof/soak-isolated/create-off/create_approval.txt voi noi dung: KIEM TRA APPROVAL' }],
      autoAccept: false
    });
    assert(blocked.ok, 'create-off /proxy/chat returns 200', `status=${blocked.status}`);
    const events = blocked.data?.agent?.events || [];
    const writes = extractToolResults(events, 'write_file');
    assert(writes.some((w) => !w.ok && /requires user approval or auto-accept/i.test(w.result || '')), 'create-off approval-required state visible');
    assert(events.some((ev) => ev.type === 'status' && ev.status === 'awaiting_user_approval'), 'create-off awaiting_user_approval emitted');
    assert(!events.some((ev) => ev.type === 'assistant_message' && /failed to call write_file/i.test(ev.content || '')), 'create-off no misleading fallback');
    assert(!fs.existsSync(targetAbs), 'create-off no disk mutation before approval/apply');
    assert((await getPending(baseUrl)).length === 0, 'create-off no pending edit before approval');

    const approved = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Tao file proof/soak-isolated/create-off/create_approval.txt voi noi dung: KIEM TRA APPROVAL' }],
      autoAccept: true
    });
    assert(approved.ok, 'create-off approved replay /proxy/chat returns 200', `status=${approved.status}`);
    const pending = await getPending(baseUrl);
    assert(pending.some((p) => normalizeRelPath(p.relPath) === relFile), 'create-off pending edit visible after approval');
    await applyAllPending(baseUrl, 'create-off');
    assert(fs.existsSync(targetAbs), 'create-off file exists after approval + apply');
  });
}

async function scenarioEdit() {
  const relFile = `${scenarioPath('edit')}/edit_target.py`;
  await withScenario({
    name: 'edit',
    responses: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'edit_call',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ filePath: relFile, content: 'def total(a, b):\n    return a + b + 100\n' })
          }
        }]
      }
    }]
  }, async ({ baseUrl }) => {
    const targetAbs = absPath(...relFile.split('/'));
    fs.writeFileSync(targetAbs, 'def total(a, b):\n    return a + b\n', 'utf8');
    const before = fs.readFileSync(targetAbs, 'utf8');
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Sua file proof/soak-isolated/edit/edit_target.py de ham total tra ve a + b + 100' }],
      autoAccept: true
    });
    assert(res.ok, 'edit /proxy/chat returns 200', `status=${res.status}`);
    assert(fs.readFileSync(targetAbs, 'utf8') === before, 'edit file unchanged before apply');
    const pending = await getPending(baseUrl);
    assert(pending.some((p) => normalizeRelPath(p.relPath) === relFile), 'edit pending diff visible');
    await applyAllPending(baseUrl, 'edit');
    assert(fs.readFileSync(targetAbs, 'utf8').includes('a + b + 100'), 'edit file changed after apply');
  });
}

async function scenarioDelete() {
  const relFile = `${scenarioPath('delete')}/delete_target.txt`;
  await withScenario({
    name: 'delete',
    responses: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'delete_call',
          type: 'function',
          function: { name: 'delete_file', arguments: JSON.stringify({ filePath: relFile }) }
        }]
      }
    }]
  }, async ({ baseUrl }) => {
    const targetAbs = absPath(...relFile.split('/'));
    fs.writeFileSync(targetAbs, 'DELETE SOAK\n', 'utf8');
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Xoa file proof/soak-isolated/delete/delete_target.txt' }],
      autoAccept: true
    });
    assert(res.ok, 'delete /proxy/chat returns 200', `status=${res.status}`);
    assert(fs.existsSync(targetAbs), 'delete file exists before apply');
    const pending = await getPending(baseUrl);
    assert(pending.some((p) => normalizeRelPath(p.relPath) === relFile && p.operation === 'delete'), 'delete pending operation visible');
    await applyAllPending(baseUrl, 'delete');
    assert(!fs.existsSync(targetAbs), 'delete file absent after apply');
  });
}

async function scenarioMove() {
  const srcRel = `${scenarioPath('move')}/rename_source.txt`;
  const dstRel = `${scenarioPath('move')}/rename_target.txt`;
  await withScenario({
    name: 'move',
    responses: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'move_call',
          type: 'function',
          function: { name: 'move_file', arguments: JSON.stringify({ sourcePath: srcRel, targetPath: dstRel }) }
        }]
      }
    }]
  }, async ({ baseUrl }) => {
    const srcAbs = absPath(...srcRel.split('/'));
    const dstAbs = absPath(...dstRel.split('/'));
    fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
    fs.writeFileSync(srcAbs, 'MOVE CONTENT\n', 'utf8');
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Doi ten file proof/soak-isolated/move/rename_source.txt thanh proof/soak-isolated/move/rename_target.txt' }],
      autoAccept: true
    });
    assert(res.ok, 'move /proxy/chat returns 200', `status=${res.status}`);
    assert(fs.existsSync(srcAbs) && !fs.existsSync(dstAbs), 'move source/target unchanged before apply');
    const pending = await getPending(baseUrl);
    const p = pending.find((x) => normalizeRelPath(x.targetRelPath) === dstRel);
    assert(Boolean(p) && p.operation === 'move', 'move pending operation visible');
    await applyAllPending(baseUrl, 'move');
    assert(!fs.existsSync(srcAbs) && fs.existsSync(dstAbs), 'move source absent and target exists after apply');
    assert(fs.readFileSync(dstAbs, 'utf8') === 'MOVE CONTENT\n', 'move content preserved');
  });
}

async function scenarioMulti() {
  const root = scenarioPath('multi');
  const aRel = `${root}/a.py`;
  const bRel = `${root}/b.py`;
  const untouchedRel = `${root}/untouched.py`;
  await withScenario({
    name: 'multi',
    responses: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'multi_a', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: aRel, content: 'VALUE_A = 10\n' }) } },
          { id: 'multi_b', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: bRel, content: 'VALUE_B = 20\n' }) } }
        ]
      }
    }]
  }, async ({ baseUrl }) => {
    const aAbs = absPath(...aRel.split('/'));
    const bAbs = absPath(...bRel.split('/'));
    const untouchedAbs = absPath(...untouchedRel.split('/'));
    fs.writeFileSync(aAbs, 'VALUE_A = 1\n', 'utf8');
    fs.writeFileSync(bAbs, 'VALUE_B = 2\n', 'utf8');
    fs.writeFileSync(untouchedAbs, 'DO_NOT_CHANGE = True\n', 'utf8');
    const untouchedBefore = fs.readFileSync(untouchedAbs, 'utf8');

    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Sua hai file proof/soak-isolated/multi/a.py va proof/soak-isolated/multi/b.py. Doi VALUE_A thanh 10 va VALUE_B thanh 20. Khong sua file khac.' }],
      autoAccept: true
    });
    assert(res.ok, 'multi /proxy/chat returns 200', `status=${res.status}`);
    assert(fs.readFileSync(aAbs, 'utf8') === 'VALUE_A = 1\n', 'multi a unchanged before apply');
    assert(fs.readFileSync(bAbs, 'utf8') === 'VALUE_B = 2\n', 'multi b unchanged before apply');
    assert(fs.readFileSync(untouchedAbs, 'utf8') === untouchedBefore, 'multi untouched unchanged before apply');
    const pending = await getPending(baseUrl);
    const uniqueTargets = [...new Set(pending.map((p) => normalizeRelPath(p.relPath)))].sort();
    assert(JSON.stringify(uniqueTargets) === JSON.stringify([aRel, bRel]), 'multi pending targets exactly a.py and b.py');
    await applyAllPending(baseUrl, 'multi');
    assert(fs.readFileSync(aAbs, 'utf8').includes('10'), 'multi a changed after apply');
    assert(fs.readFileSync(bAbs, 'utf8').includes('20'), 'multi b changed after apply');
    assert(fs.readFileSync(untouchedAbs, 'utf8') === untouchedBefore, 'multi untouched preserved');
  });
}

async function scenarioBroad() {
  const root = scenarioPath('broad');
  const aRel = `${root}/a.py`;
  const bRel = `${root}/b.py`;
  const cRel = `${root}/c.py`;
  await withScenario({
    name: 'broad',
    responses: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'broad_a', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: aRel, content: 'VALUE_A = 10\n' }) } },
          { id: 'broad_b', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: bRel, content: 'VALUE_B = 20\n' }) } },
          { id: 'broad_c', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: cRel, content: 'VALUE_C = 30\n' }) } }
        ]
      }
    }]
  }, async ({ baseUrl }) => {
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Sua toan bo file trong project cho toi.' }],
      autoAccept: true
    });
    assert(res.ok, 'broad /proxy/chat returns 200', `status=${res.status}`);
    const writes = extractToolResults(res.data?.agent?.events || [], 'write_file');
    assert(writes.some((w) => !w.ok && /file-count limit exceeded/i.test(w.result || '')), 'broad prompt blocked by file-count limit');
    const pending = await getPending(baseUrl);
    const uniqueTargets = [...new Set(pending.map((p) => normalizeRelPath(p.relPath)))];
    assert(uniqueTargets.length <= 2, 'broad prompt prevents project-wide mutation');
    await clearPending(baseUrl);
  });
}

async function scenarioOutsideTraversal() {
  await withScenario({
    name: 'outside',
    responses: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'outside_call',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ filePath: '..\\outside.txt', content: 'OUTSIDE\n' }) }
        }]
      }
    }]
  }, async ({ baseUrl }) => {
    const outsideAbs = path.resolve(APP_DIR, '..', 'outside.txt');
    removeIfExists(outsideAbs);
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Tao hoac sua file ..\\outside.txt' }],
      autoAccept: true
    });
    assert(res.ok, 'outside /proxy/chat returns 200', `status=${res.status}`);
    const writes = extractToolResults(res.data?.agent?.events || [], 'write_file');
    assert(writes.some((w) => !w.ok && /outside workspace|path traversal/i.test(w.result || '')), 'outside/path traversal blocked with clear reason');
    assert(!fs.existsSync(outsideAbs), 'outside/path traversal no disk mutation');
  });
}

async function scenarioRepeated() {
  const root = scenarioPath('repeated');
  const responses = [
    { message: { role: 'assistant', content: '', tool_calls: [{ id: 'rep1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: `${root}/repeat_1.txt`, content: 'repeat\n' }) } }] } },
    { message: { role: 'assistant', content: '', tool_calls: [{ id: 'rep2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: `${root}/edit_target.py`, content: 'def total(a, b):\n    return a + b + 200\n' }) } }] } },
    { message: { role: 'assistant', content: '', tool_calls: [{ id: 'rep3', type: 'function', function: { name: 'move_file', arguments: JSON.stringify({ sourcePath: `${root}/repeat_1.txt`, targetPath: `${root}/repeat_1_moved.txt` }) } }] } },
    { message: { role: 'assistant', content: '', tool_calls: [{ id: 'rep4', type: 'function', function: { name: 'delete_file', arguments: JSON.stringify({ filePath: `${root}/repeat_1_moved.txt` }) } }] } },
    { message: { role: 'assistant', content: '', tool_calls: [{ id: 'rep5', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: `${root}/a.py`, content: 'VALUE_A = 30\n' }) } }, { id: 'rep6', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filePath: `${root}/b.py`, content: 'VALUE_B = 40\n' }) } }] } }
  ];
  await withScenario({ name: 'repeated', responses }, async ({ baseUrl }) => {
    const editTargetAbs = absPath(...`${root}/edit_target.py`.split('/'));
    fs.writeFileSync(editTargetAbs, 'def total(a, b):\n    return a + b\n', 'utf8');

    const prompts = [
      'create repeated fixture',
      'edit repeated fixture',
      'move repeated fixture',
      'delete repeated fixture',
      'multi repeated fixture'
    ];
    for (const prompt of prompts) {
      const res = await postJson(`${baseUrl}/proxy/chat`, { model: 'auto', messages: [{ role: 'user', content: prompt }], autoAccept: true });
      assert(res.ok, `repeated request ok: ${prompt}`, `status=${res.status}`);
      await applyAllPending(baseUrl, `repeated ${prompt}`);
      await clearPending(baseUrl);
      assert((await getPending(baseUrl)).length === 0, `repeated pending drained: ${prompt}`);
    }
  });
}

async function main() {
  console.log('\nManual File Workflow Soak Isolated Tests\n');
  removeIfExists(absPath('proof', 'soak-isolated'));

  await scenarioCreateOn();
  await scenarioCreateOff();
  await scenarioEdit();
  await scenarioDelete();
  await scenarioMove();
  await scenarioMulti();
  await scenarioBroad();
  await scenarioOutsideTraversal();
  await scenarioRepeated();

  removeIfExists(absPath('proof', 'soak-isolated'));
  assert(!fs.existsSync(absPath('proof', 'soak-isolated')), 'final proof/soak-isolated directory cleaned');

  process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const failure of failures) {
      console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
    }
    process.exitCode = 1;
  }
}

await main();
