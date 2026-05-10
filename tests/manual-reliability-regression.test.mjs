import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const CONTROL_WORKSPACE = path.resolve(path.join(APP_DIR, '..', 'ABW_NVIDIA_FUSION_CONTROL'));
const SERVER_SCRIPT = path.join(APP_DIR, 'tools', 'nvidia-server.mjs');
const HOST = '127.0.0.1';
const APPROVED = { 'X-Agent-Approved': 'true' };
const WRONG_DISTORTED_PATH = `${CONTROL_WORKSPACE}\\Sandbox\\Nvidia\\proof`;

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

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
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

async function withServer(name, responses, runFn, options = {}) {
  const fixturePath = writeFixtureFile(name, responses);
  const port = 5200 + Math.floor(Math.random() * 600);
  let server = null;
  try {
    server = await startServer({ port, fixturePath });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl);
    const trustedWorkspace = options.trustedWorkspace !== false;
    await postJson(`${baseUrl}/api/profile`, { uiMode: 'ide', trustedWorkspace });
    if (options.workspacePath) {
      const switched = await postJson(`${baseUrl}/api/workspace`, { path: options.workspacePath });
      assert(switched.ok, `${name} workspace switched`, `status=${switched.status}`);
    }
    await postJson(`${baseUrl}/api/trust`, { trusted: trustedWorkspace });
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

async function runExplicitPathDominatesFallbackRootPrompt() {
  const relPath = 'proof/manual-revalidation/edit_target.py';
  const rootPath = 'edit_target.py';
  const absTarget = absFromRel(relPath);
  const absRoot = absFromRel(rootPath);
  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  fs.writeFileSync(absTarget, 'def add(a, b):\n    return a + b\n', 'utf8');
  removeIfExists(absRoot);

  await withServer('manual-reliability-explicit-path-dominates-root-fallback', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_explicit_path_dominates_root_fallback', 'write_file', { filePath: rootPath, content: 'def add(a, b):\n    return a + b + 1\n' })] } },
    { message: { role: 'assistant', content: 'Edited successfully.' } }
  ], async (baseUrl) => {
    const before = fs.readFileSync(absTarget, 'utf8');
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Sửa file proof/manual-revalidation/edit_target.py nhưng nếu không thấy thì tạo edit_target.py' }],
      autoAccept: true
    });
    assert(res.ok, 'mixed explicit-path/root-fallback prompt /proxy/chat returns 200', `status=${res.status}`);
    const writeResults = extractToolResults(res.data?.agent?.events || [], 'write_file');
    const mismatch = writeResults.find(ev => !ev.ok && /TARGET_PATH_MISMATCH/i.test(ev.result || ''));
    const mismatchPayload = tryParseJson(mismatch?.result || '');
    assert(Boolean(mismatch), 'mixed explicit-path/root-fallback prompt blocks root fallback before pending creation');
    assert(mismatchPayload?.code === 'TARGET_PATH_MISMATCH', 'mixed explicit-path/root-fallback exposes TARGET_PATH_MISMATCH code');
    assert(mismatchPayload?.expectedPath === relPath, 'mixed explicit-path/root-fallback expected path recorded as nested path');
    assert(mismatchPayload?.actualPath === rootPath, 'mixed explicit-path/root-fallback actual path recorded as root fallback');
    const pending = await getPending(baseUrl);
    assert(!pending.some(p => normalizeRelPath(p.relPath) === rootPath), 'mixed explicit-path/root-fallback creates no wrong root pending edit');
    assert(!fs.existsSync(absRoot), 'mixed explicit-path/root-fallback does not create root file');
    assert(fs.readFileSync(absTarget, 'utf8') === before, 'mixed explicit-path/root-fallback leaves explicit target unchanged before apply');
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(/Blocked: TARGET_PATH_MISMATCH/i.test(finalText), 'mixed explicit-path/root-fallback final message is blocked');
    assert(!/(edited successfully|created successfully|applied successfully|pending operation created for: edit_target\.py)/i.test(finalText), 'mixed explicit-path/root-fallback final message has no fake success or wrong pending');
  });

  removeIfExists(absTarget);
  removeIfExists(absRoot);
}

async function runAbsolutePathOutsideWorkspaceFailsFast() {
  const sourceAbs = path.join(APP_DIR, 'proof', 'rename_source.txt');
  const targetAbs = path.join(APP_DIR, 'proof', 'renamed_target.txt');
  const sourceSnapshot = fs.existsSync(sourceAbs) ? fs.readFileSync(sourceAbs, 'utf8') : null;
  const targetSnapshot = fs.existsSync(targetAbs) ? fs.readFileSync(targetAbs, 'utf8') : null;
  removeIfExists(targetAbs);
  fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
  fs.writeFileSync(sourceAbs, sourceSnapshot ?? 'RENAME ABSOLUTE SOURCE\n', 'utf8');

  await withServer('manual-reliability-absolute-path-outside-workspace', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_workspace_mismatch', 'list_dir', { dirPath: 'Sandbox/Nvidia/proof' })] } },
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_workspace_mismatch_exec', 'execute_command', { command: 'dir "D:\\Sandbox\\Nvidia\\proof\\rename_source.txt"' })] } }
  ], async (baseUrl) => {
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Đổi tên D:\\Sandbox\\Nvidia\\proof\\rename_source.txt thành D:\\Sandbox\\Nvidia\\proof\\renamed_target.txt' }],
      autoAccept: true
    });
    assert(res.ok, 'absolute outside workspace /proxy/chat returns 200', `status=${res.status}`);
    const events = res.data?.agent?.events || [];
    assert(events.some(ev => ev.type === 'status' && ev.status === 'blocked_preflight'), 'absolute outside workspace is blocked preflight');
    assert(!events.some(ev => ev.type === 'tool_start' && ev.tool === 'list_dir'), 'absolute outside workspace does not call list_dir');
    assert(!events.some(ev => ev.type === 'tool_start' && ev.tool === 'execute_command'), 'absolute outside workspace does not call execute_command');
    const pending = await getPending(baseUrl);
    assert(pending.length === 0, 'absolute outside workspace creates no pending operation');
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(/BLOCKED_WORKSPACE_MISMATCH/i.test(finalText), 'absolute outside workspace final message reports BLOCKED_WORKSPACE_MISMATCH');
    assert(/outside the current workspace/i.test(finalText), 'absolute outside workspace final message explains workspace boundary');
    assert(finalText.includes('D:\\Sandbox\\Nvidia'), 'absolute outside workspace final message preserves Windows drive prefix');
    assert(!new RegExp(WRONG_DISTORTED_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(finalText), 'absolute outside workspace final message does not contain distorted control-workspace path');
    assert(!/(successfully|Pending operation created|Applied successfully)/i.test(finalText), 'absolute outside workspace final message claims no success');
    assert(!fs.existsSync(targetAbs), 'absolute outside workspace does not mutate target on disk');
  }, { trustedWorkspace: false, workspacePath: CONTROL_WORKSPACE });

  if (sourceSnapshot !== null) fs.writeFileSync(sourceAbs, sourceSnapshot, 'utf8');
  else removeIfExists(sourceAbs);
  if (targetSnapshot !== null) fs.writeFileSync(targetAbs, targetSnapshot, 'utf8');
  else removeIfExists(targetAbs);
}

async function runAbsolutePathInsideWorkspaceNormalizesToRelative() {
  const sourceRel = 'proof/rename_source.txt';
  const targetRel = 'proof/renamed_target.txt';
  const sourceAbs = absFromRel(sourceRel);
  const targetAbs = absFromRel(targetRel);
  const sourceSnapshot = fs.existsSync(sourceAbs) ? fs.readFileSync(sourceAbs, 'utf8') : null;
  const targetSnapshot = fs.existsSync(targetAbs) ? fs.readFileSync(targetAbs, 'utf8') : null;
  removeIfExists(targetAbs);
  fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
  fs.writeFileSync(sourceAbs, 'ABSOLUTE MOVE SOURCE\n', 'utf8');

  await withServer('manual-reliability-absolute-path-inside-workspace', [
    { message: { role: 'assistant', content: '', tool_calls: [toolCall('tc_workspace_absolute_move', 'move_file', { sourcePath: sourceAbs, targetPath: targetAbs })] } }
  ], async (baseUrl) => {
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: `Đổi tên ${sourceAbs} thành ${targetAbs}` }],
      autoAccept: true
    });
    assert(res.ok, 'absolute inside workspace /proxy/chat returns 200', `status=${res.status}`);
    const events = res.data?.agent?.events || [];
    assert(events.some(ev => ev.type === 'tool_start' && ev.tool === 'move_file'), 'absolute inside workspace uses move_file');
    assert(!events.some(ev => ev.type === 'tool_start' && ev.tool === 'execute_command'), 'absolute inside workspace does not call execute_command');
    assert(!events.some(ev => ev.type === 'tool_start' && ev.tool === 'list_dir'), 'absolute inside workspace does not call list_dir');
    assert(!events.some(ev => String(ev.result || '').includes(WRONG_DISTORTED_PATH)), 'absolute inside workspace never reports distorted path');
    const pending = await getPending(baseUrl);
    const edit = pending.find(p => normalizeRelPath(p.sourceRelPath) === sourceRel && normalizeRelPath(p.targetRelPath) === targetRel);
    assert(Boolean(edit?.id), 'absolute inside workspace pending move normalized to relative paths');
    assert(fs.existsSync(sourceAbs) && !fs.existsSync(targetAbs), 'absolute inside workspace no pre-apply mutation');
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(/Pending operation created/i.test(finalText), 'absolute inside workspace final message reports pending operation');
    const apply = await applyPending(baseUrl, edit);
    assert(apply.ok, 'absolute inside workspace apply succeeds', `status=${apply.status}`);
    assert(!fs.existsSync(sourceAbs) && fs.existsSync(targetAbs), 'absolute inside workspace move completes after apply');
    assert(fs.readFileSync(targetAbs, 'utf8') === 'ABSOLUTE MOVE SOURCE\n', 'absolute inside workspace content preserved after apply');
  });

  if (sourceSnapshot !== null) {
    fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
    fs.writeFileSync(sourceAbs, sourceSnapshot, 'utf8');
  } else {
    removeIfExists(sourceAbs);
  }
  if (targetSnapshot !== null) {
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.writeFileSync(targetAbs, targetSnapshot, 'utf8');
  } else {
    removeIfExists(targetAbs);
  }
}

async function runMoveContractStopsAfterPendingOperation() {
  const sourceRel = 'proof/manual-contract/rename_source.txt';
  const targetRel = 'proof/manual-contract/renamed_target.txt';
  const sourceAbs = absFromRel(sourceRel);
  const targetAbs = absFromRel(targetRel);
  removeIfExists(path.join(APP_DIR, 'proof', 'manual-contract'));

  await withServer('manual-reliability-move-contract-stop-after-pending', [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          toolCall('tc_move_contract_ok', 'move_file', { sourcePath: sourceAbs, targetPath: targetAbs, reason: 'rename file' }),
          toolCall('tc_move_contract_wrong_write', 'write_file', { filePath: targetRel, content: 'WRONG FALLBACK\n' })
        ]
      }
    }
  ], async (baseUrl) => {
    fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
    fs.writeFileSync(sourceAbs, 'RENAME SOURCE OK\n', 'utf8');
    removeIfExists(targetAbs);

    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: `Đổi tên ${sourceAbs} thành ${targetAbs}` }],
      autoAccept: true
    });
    assert(res.ok, 'move contract /proxy/chat returns 200', `status=${res.status}`);
    const events = res.data?.agent?.events || [];
    assert(events.some(ev => ev.type === 'tool_start' && ev.tool === 'move_file'), 'move contract uses move_file');
    assert(!events.some(ev => ev.type === 'tool_start' && ev.tool === 'write_file'), 'move contract does not fallback to write_file after valid move_file');
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(!/TARGET_OPERATION_MISMATCH/i.test(finalText), 'move contract final message avoids TARGET_OPERATION_MISMATCH');
    assert(/Pending operation created/i.test(finalText), 'move contract final message reports pending move');
    const pending = await getPending(baseUrl);
    const edit = pending.find(p => normalizeRelPath(p.sourceRelPath) === sourceRel && normalizeRelPath(p.targetRelPath) === targetRel);
    assert(Boolean(edit?.id), 'move contract pending move created');
    assert(fs.existsSync(sourceAbs) && !fs.existsSync(targetAbs), 'move contract no pre-apply mutation');
    const apply = await applyPending(baseUrl, edit);
    assert(apply.ok, 'move contract apply succeeds', `status=${apply.status}`);
    assert(!fs.existsSync(sourceAbs) && fs.existsSync(targetAbs), 'move contract disk changed after apply');
    assert(fs.readFileSync(targetAbs, 'utf8') === 'RENAME SOURCE OK\n', 'move contract preserved content');
  });

  removeIfExists(path.join(APP_DIR, 'proof', 'manual-contract'));
}

async function runExplicitEditFallbackBlocksHonestly() {
  const relPath = 'proof/manual-revalidation/edit_target.py';
  const rootAbs = absFromRel('edit_target.py');
  const exactAbs = absFromRel(relPath);
  removeIfExists(rootAbs);
  removeIfExists(path.join(APP_DIR, 'proof', 'manual-revalidation'));

  await withServer('manual-reliability-explicit-edit-blocked-honestly', [
    { message: { role: 'assistant', content: 'I will use the write_file tool to update the file.' } }
  ], async (baseUrl) => {
    fs.mkdirSync(path.dirname(exactAbs), { recursive: true });
    fs.writeFileSync(exactAbs, 'def add(a, b):\n    return a + b\n', 'utf8');
    const before = fs.readFileSync(exactAbs, 'utf8');

    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Sửa file proof/manual-revalidation/edit_target.py nhưng nếu không thấy thì tạo edit_target.py' }],
      autoAccept: true
    });
    assert(res.ok, 'explicit edit blocked /proxy/chat returns 200', `status=${res.status}`);
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(/Blocked: TARGET_PATH_MISMATCH/i.test(finalText), 'explicit edit blocked final message reports TARGET_PATH_MISMATCH');
    assert(!/I will use the write_file tool/i.test(finalText), 'explicit edit blocked final message is not tool-intent text');
    const pending = await getPending(baseUrl);
    assert(pending.length === 0, 'explicit edit blocked creates no pending operation');
    assert(!fs.existsSync(rootAbs), 'explicit edit blocked does not create root fallback file');
    assert(fs.readFileSync(exactAbs, 'utf8') === before, 'explicit edit blocked keeps exact file unchanged');
  });

  removeIfExists(rootAbs);
  removeIfExists(path.join(APP_DIR, 'proof', 'manual-revalidation'));
}

async function runImpossibleOutsideWorkspaceRenameBlockedHonestly() {
  await withServer('manual-reliability-impossible-outside-workspace-rename', [
    { message: { role: 'assistant', content: 'I will use the move_file tool to rename the file.' } }
  ], async (baseUrl) => {
    const res = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Đổi tên D:\\Sandbox\\__not_nvidia__\\missing.txt thành D:\\Sandbox\\__not_nvidia__\\moved.txt' }],
      autoAccept: true
    });
    assert(res.ok, 'outside workspace impossible rename /proxy/chat returns 200', `status=${res.status}`);
    const events = res.data?.agent?.events || [];
    assert(events.some(ev => ev.type === 'status' && ev.status === 'blocked_preflight'), 'outside workspace impossible rename is blocked preflight');
    assert(!events.some(ev => ev.type === 'tool_start' && ev.tool === 'execute_command'), 'outside workspace impossible rename does not call execute_command');
    const pending = await getPending(baseUrl);
    assert(pending.length === 0, 'outside workspace impossible rename creates no pending operation');
    const finalText = String(res.data?.choices?.[0]?.message?.content || '');
    assert(/BLOCKED_WORKSPACE_MISMATCH/i.test(finalText), 'outside workspace impossible rename final message is blocked');
    assert(!/I will use the move_file tool/i.test(finalText), 'outside workspace impossible rename final message is not tool-intent text');
  }, { trustedWorkspace: false, workspacePath: CONTROL_WORKSPACE });
}

async function runWorkspaceSwitchAcceptsValidWindowsPath() {
  await withServer('manual-reliability-workspace-switch-valid', [], async (baseUrl) => {
    const initialWorkspace = await getJson(`${baseUrl}/api/workspace`);
    assert(initialWorkspace.ok, 'workspace switch valid initial GET returns 200', `status=${initialWorkspace.status}`);
    assert(Boolean(initialWorkspace.data?.path), 'workspace switch valid initial workspace payload is readable');

    const switched = await postJson(`${baseUrl}/api/workspace`, { path: APP_DIR });
    assert(switched.ok, 'workspace switch valid path accepted', `status=${switched.status}`);
    assert(switched.data?.status === 'success', 'workspace switch valid response reports success');
    assert(switched.data?.path === APP_DIR, 'workspace switch valid active workspace becomes NVIDIA workspace');

    const after = await getJson(`${baseUrl}/api/workspace`);
    assert(after.ok, 'workspace switch valid GET after switch returns 200', `status=${after.status}`);
    assert(after.data?.path === APP_DIR, 'workspace switch valid workspace label source updates to NVIDIA workspace');
  }, { workspacePath: CONTROL_WORKSPACE });
}

async function runWorkspaceSwitchRejectsInvalidPathHonestly() {
  await withServer('manual-reliability-workspace-switch-invalid', [], async (baseUrl) => {
    const before = await getJson(`${baseUrl}/api/workspace`);
    assert(before.ok, 'workspace switch invalid initial GET returns 200', `status=${before.status}`);
    assert(before.data?.path === CONTROL_WORKSPACE, 'workspace switch invalid initial workspace is control workspace');

    const invalidTarget = 'D:\\Sandbox\\__does_not_exist__';
    const rejected = await postJson(`${baseUrl}/api/workspace`, { path: invalidTarget });
    assert(!rejected.ok, 'workspace switch invalid path rejected');
    const errorText = String(rejected.data?.error || '');
    assert(/does not exist|invalid/i.test(errorText), 'workspace switch invalid response explains real reason');

    const after = await getJson(`${baseUrl}/api/workspace`);
    assert(after.ok, 'workspace switch invalid GET after rejection returns 200', `status=${after.status}`);
    assert(after.data?.path === CONTROL_WORKSPACE, 'workspace switch invalid keeps workspace unchanged');
    assert(after.data?.path !== invalidTarget, 'workspace switch invalid does not fake success');
  }, { workspacePath: CONTROL_WORKSPACE });
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
  await runExplicitPathDominatesFallbackRootPrompt();
  await runAbsolutePathOutsideWorkspaceFailsFast();
  await runAbsolutePathInsideWorkspaceNormalizesToRelative();
  await runMoveContractStopsAfterPendingOperation();
  await runExplicitEditFallbackBlocksHonestly();
  await runImpossibleOutsideWorkspaceRenameBlockedHonestly();
  await runWorkspaceSwitchAcceptsValidWindowsPath();
  await runWorkspaceSwitchRejectsInvalidPathHonestly();
  await runEditDeleteMoveExactPaths();
  await runTraversalBlockedNoFallback();

process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) {
    console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
  }
  process.exitCode = 1;
}
