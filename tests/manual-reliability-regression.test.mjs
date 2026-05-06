import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SERVER_SCRIPT = path.join(APP_DIR, 'tools', 'nvidia-server.mjs');
const HOST = '127.0.0.1';
const APPROVED = { 'X-Agent-Approved': 'true' };

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

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function absFromRel(relPath) {
  return path.join(APP_DIR, ...relPath.split('/'));
}

function removeIfExists(targetPath) {
  try {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

function writeFixtureFile(name, responses) {
  const fixturePath = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify({ responses }, null, 2), 'utf8');
  return fixturePath;
}

function startServer({ port, fixturePath }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_SCRIPT], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        HOST,
        NVIDIA_SERVER_HOST: HOST,
        NVIDIA_TEST_CHAT_FIXTURE: fixturePath,
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
      if (/server running at/i.test(String(buf || ''))) {
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

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

async function getPending(baseUrl) {
  const res = await postJson(`${baseUrl}/api/pending_edits`, {}, APPROVED);
  return res.data?.result || res.data || [];
}

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  };
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

async function withServer(name, responses, runFn) {
  const fixturePath = writeFixtureFile(name, responses);
  const port = 5200 + Math.floor(Math.random() * 600);
  let server = null;
  try {
    server = await startServer({ port, fixturePath });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl);
    await postJson(`${baseUrl}/api/profile`, { uiMode: 'ide', trustedWorkspace: true });
    await postJson(`${baseUrl}/api/trust`, { trusted: true });
    await runFn(baseUrl);
  } finally {
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

async function applyPending(baseUrl, edit) {
  return postJson(`${baseUrl}/api/apply_pending_edit`, { id: edit.id }, APPROVED);
}

async function runExplicitCreatePreservesPath() {
  const relPath = 'proof/edit_target.py';
  const rootPath = 'edit_target.py';
  const absTarget = absFromRel(relPath);
  const absRoot = absFromRel(rootPath);
  removeIfExists(absTarget);
  removeIfExists(absRoot);

  await withServer('manual-reliability-create-exact', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_create_exact', 'write_file', { filePath: relPath, content: 'VALUE = 1\n' })] } },
    { message: { role: 'assistant', content: 'Created successfully.' } }
  ], async (baseUrl) => {
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Tao file proof/edit_target.py voi noi dung VALUE = 1' }],
      autoAccept: true
    });
    assert(res.ok, 'create exact /proxy/chat returns 200', `status=${res.status}`);
    const pending = await getPending(baseUrl);
    const edit = pending.find(p => normalizeRelPath(p.relPath) === relPath);
    assert(Boolean(edit?.id), 'create exact pending target is proof/edit_target.py');
    assert(!pending.some(p => normalizeRelPath(p.relPath) === rootPath), 'create exact no root-level pending target');
    assert(!fs.existsSync(absTarget), 'create exact no pre-apply target mutation');
    assert(!fs.existsSync(absRoot), 'create exact root fallback file absent');
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(/Pending operation created/i.test(finalText), 'create exact final message says pending, not applied');
    assert(!/created successfully/i.test(finalText), 'create exact final message removes fake success wording');
    const apply = await applyPending(baseUrl, edit);
    assert(apply.ok, 'create exact apply succeeds', `status=${apply.status}`);
    assert(fs.existsSync(absTarget), 'create exact target exists after apply');
    assert(!fs.existsSync(absRoot), 'create exact root fallback still absent after apply');
  });

  removeIfExists(absTarget);
  removeIfExists(absRoot);
}

async function runRootMismatchBlocked() {
  const relPath = 'proof/edit_target.py';
  const rootPath = 'edit_target.py';
  const absTarget = absFromRel(relPath);
  const absRoot = absFromRel(rootPath);
  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  fs.writeFileSync(absTarget, 'VALUE = 1\n', 'utf8');
  removeIfExists(absRoot);

  await withServer('manual-reliability-root-mismatch', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_mismatch', 'write_file', { filePath: rootPath, content: 'VALUE = 2\n' })] } },
    { message: { role: 'assistant', content: 'Edited successfully.' } }
  ], async (baseUrl) => {
    const before = fs.readFileSync(absTarget, 'utf8');
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Sua file proof/edit_target.py de VALUE = 2' }],
      autoAccept: true
    });
    assert(res.ok, 'root mismatch /proxy/chat returns 200', `status=${res.status}`);
    const writeResults = extractToolResults(res.data?.agent?.events || [], 'write_file');
    const mismatch = writeResults.find(ev => !ev.ok && /TARGET_PATH_MISMATCH/i.test(ev.result || ''));
    const mismatchPayload = tryParseJson(mismatch?.result || '');
    assert(Boolean(mismatch), 'root mismatch blocked before pending creation');
    assert(mismatchPayload?.code === 'TARGET_PATH_MISMATCH', 'root mismatch exposes TARGET_PATH_MISMATCH code');
    assert(mismatchPayload?.expectedPath === relPath, 'root mismatch expected path recorded');
    assert(mismatchPayload?.actualPath === rootPath, 'root mismatch actual root path recorded');
    const pending = await getPending(baseUrl);
    assert(!pending.some(p => normalizeRelPath(p.relPath) === rootPath), 'root mismatch no wrong root pending edit');
    assert(!fs.existsSync(absRoot), 'root mismatch no root file created');
    assert(fs.readFileSync(absTarget, 'utf8') === before, 'root mismatch target unchanged');
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(/Blocked: TARGET_PATH_MISMATCH/i.test(finalText), 'root mismatch final message is blocked');
    assert(!/(edited successfully|created successfully|applied successfully)/i.test(finalText), 'root mismatch final message has no fake success');
  });

  removeIfExists(absTarget);
  removeIfExists(absRoot);
}

async function runEditDeleteMoveExactPaths() {
  const editRel = 'proof/manual-validation/edit_target.py';
  const deleteRel = 'proof/manual-validation/delete_target.txt';
  const moveSourceRel = 'proof/manual-validation/move_source.txt';
  const moveTargetRel = 'proof/manual-validation/moved/move_target.txt';
  const editAbs = absFromRel(editRel);
  const deleteAbs = absFromRel(deleteRel);
  const moveSourceAbs = absFromRel(moveSourceRel);
  const moveTargetAbs = absFromRel(moveTargetRel);
  removeIfExists(path.join(APP_DIR, 'proof', 'manual-validation'));

  await withServer('manual-reliability-edit-exact', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_edit_exact', 'write_file', { filePath: editRel, content: 'def total(a, b):\n    return a + b + 10\n' })] } }
  ], async (baseUrl) => {
    fs.mkdirSync(path.dirname(editAbs), { recursive: true });
    fs.writeFileSync(editAbs, 'def total(a, b):\n    return a + b\n', 'utf8');
    const before = fs.readFileSync(editAbs, 'utf8');
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Sua file proof/manual-validation/edit_target.py de ham total tra ve a + b + 10' }],
      autoAccept: true
    });
    assert(res.ok, 'edit exact /proxy/chat returns 200', `status=${res.status}`);
    const pending = await getPending(baseUrl);
    const edit = pending.find(p => normalizeRelPath(p.relPath) === editRel);
    assert(Boolean(edit?.id), 'edit exact pending target preserved');
    assert(fs.readFileSync(editAbs, 'utf8') === before, 'edit exact no pre-apply mutation');
    const apply = await applyPending(baseUrl, edit);
    assert(apply.ok, 'edit exact apply succeeds', `status=${apply.status}`);
    assert(fs.readFileSync(editAbs, 'utf8').includes('a + b + 10'), 'edit exact disk changed after apply');
  });

  await withServer('manual-reliability-delete-exact', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_delete_exact', 'delete_file', { filePath: deleteRel })] } }
  ], async (baseUrl) => {
    fs.mkdirSync(path.dirname(deleteAbs), { recursive: true });
    fs.writeFileSync(deleteAbs, 'DELETE ME\n', 'utf8');
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Xoa file proof/manual-validation/delete_target.txt' }],
      autoAccept: true
    });
    assert(res.ok, 'delete exact /proxy/chat returns 200', `status=${res.status}`);
    const pending = await getPending(baseUrl);
    const edit = pending.find(p => normalizeRelPath(p.relPath) === deleteRel && p.operation === 'delete');
    assert(Boolean(edit?.id), 'delete exact pending target preserved');
    assert(fs.existsSync(deleteAbs), 'delete exact no pre-apply mutation');
    const apply = await applyPending(baseUrl, edit);
    assert(apply.ok, 'delete exact apply succeeds', `status=${apply.status}`);
    assert(!fs.existsSync(deleteAbs), 'delete exact disk removed after apply');
  });

  await withServer('manual-reliability-move-exact', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_move_exact', 'move_file', { sourcePath: moveSourceRel, targetPath: moveTargetRel })] } }
  ], async (baseUrl) => {
    fs.mkdirSync(path.dirname(moveSourceAbs), { recursive: true });
    fs.writeFileSync(moveSourceAbs, 'MOVE ME\n', 'utf8');
    removeIfExists(moveTargetAbs);
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Doi ten file proof/manual-validation/move_source.txt thanh proof/manual-validation/moved/move_target.txt' }],
      autoAccept: true
    });
    assert(res.ok, 'move exact /proxy/chat returns 200', `status=${res.status}`);
    const pending = await getPending(baseUrl);
    const edit = pending.find(p => normalizeRelPath(p.sourceRelPath) === moveSourceRel && normalizeRelPath(p.targetRelPath) === moveTargetRel);
    assert(Boolean(edit?.id), 'move exact pending source and target preserved');
    assert(fs.existsSync(moveSourceAbs) && !fs.existsSync(moveTargetAbs), 'move exact no pre-apply mutation');
    const apply = await applyPending(baseUrl, edit);
    assert(apply.ok, 'move exact apply succeeds', `status=${apply.status}`);
    assert(!fs.existsSync(moveSourceAbs) && fs.existsSync(moveTargetAbs), 'move exact disk changed after apply');
    assert(fs.readFileSync(moveTargetAbs, 'utf8') === 'MOVE ME\n', 'move exact content preserved');
  });

  removeIfExists(path.join(APP_DIR, 'proof', 'manual-validation'));
}

async function runTraversalBlockedNoFallback() {
  const outsideLeaf = `manual_reliability_outside_${Date.now()}.py`;
  const outsideRel = `../${outsideLeaf}`;
  const outsideAbs = path.resolve(APP_DIR, '..', outsideLeaf);
  const inferredFallbackAbs = absFromRel('proof/generated_file.py');
  removeIfExists(outsideAbs);
  removeIfExists(inferredFallbackAbs);

  await withServer('manual-reliability-traversal', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_traversal', 'write_file', { filePath: outsideRel, content: 'print("outside")\n' })] } }
  ], async (baseUrl) => {
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: `Create file ${outsideRel} with Python code.` }],
      autoAccept: true
    });
    assert(res.ok, 'traversal /proxy/chat returns 200', `status=${res.status}`);
    const writes = extractToolResults(res.data?.agent?.events || [], 'write_file');
    assert(
      writes.some(ev => !ev.ok && /outside workspace|Path is outside workspace/i.test(ev.result || '')),
      'traversal tool call blocked',
      writes.map(ev => ev.result).join('\n')
    );
    assert(!fs.existsSync(outsideAbs), 'traversal outside file absent');
    assert(!fs.existsSync(inferredFallbackAbs), 'traversal did not use inferred proof/generated_file.py fallback');
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(!/(created successfully|applied successfully)/i.test(finalText), 'traversal final message has no fake success');
  });

  removeIfExists(outsideAbs);
  removeIfExists(inferredFallbackAbs);
}

console.log('\nManual Reliability Regression Tests\n');

await runExplicitCreatePreservesPath();
await runRootMismatchBlocked();
await runEditDeleteMoveExactPaths();
await runTraversalBlockedNoFallback();

process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) {
    console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
  }
  process.exitCode = 1;
}
