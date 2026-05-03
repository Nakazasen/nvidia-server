import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SERVER_SCRIPT = path.join(APP_DIR, 'tools', 'nvidia-server.mjs');
const HOST = '127.0.0.1';
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

function uniqueName(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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

function startServer({ port, trustAlways = true }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      HOST,
      NVIDIA_SERVER_HOST: HOST
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
      if (/server running at/i.test(String(buf || ''))) {
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
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

async function runServerCase({ name, trustAlways = true, verify }) {
  const port = 3960 + Math.floor(Math.random() * 400);
  let server = null;
  try {
    server = await startServer({ port, trustAlways });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl);
    const profile = await postJson(`${baseUrl}/api/profile`, { uiMode: 'ide', trustedWorkspace: true });
    assert(profile.ok, `${name}: IDE profile enabled`, `status=${profile.status}`);
    await verify(baseUrl);
  } finally {
    await stopServer(server);
  }
}

function removeIfExists(targetPath) {
  try {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true, recursive: true });
  } catch {}
}

console.log('\nApply Pending Edit To Disk Proof Tests\n');

const happyRelPath = `proof/apply_to_disk_${uniqueName('happy')}.py`;
const happyAbsPath = path.join(APP_DIR, ...happyRelPath.split('/'));
const happyContent = 'def multiply_by_two(value):\n    return value * 2\n';
await runServerCase({
  name: 'apply-happy-path',
  trustAlways: true,
  verify: async (baseUrl) => {
    removeIfExists(happyAbsPath);
    const write = await postJson(`${baseUrl}/api/write_file`, {
      path: happyRelPath,
      content: happyContent
    }, APPROVED_IDE_HEADERS);
    assert(write.ok, '1. write_file creates pending edit before apply', `status=${write.status}`);

    const pendingEdit = write.data?.result?.pendingEdit || null;
    assert(pendingEdit?.id, '1a. pending edit id returned');
    assert(!fs.existsSync(happyAbsPath), '1b. write_file does not write disk file before apply');

    const apply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: pendingEdit?.id }, APPROVED_IDE_HEADERS);
    assert(apply.ok, '1c. apply_pending_edit returns 200 for approved trusted apply', `status=${apply.status}`);
    assert(fs.existsSync(happyAbsPath), '1d. file exists on disk after apply');
    const diskContent = fs.existsSync(happyAbsPath) ? fs.readFileSync(happyAbsPath, 'utf8') : '';
    assert(diskContent.includes('def multiply_by_two(value):'), '1e. disk content contains expected function');
    assert(diskContent.includes('return value * 2'), '1f. disk content contains expected logic');

    const pending = await postJson(`${baseUrl}/api/pending_edits`, {}, APPROVED_IDE_HEADERS);
    const edits = pending.data?.result || pending.data || [];
    assert(!edits.some(edit => edit.id === pendingEdit?.id), '1g. pending edit removed after successful apply');
    removeIfExists(happyAbsPath);
  }
});

const outsideLeaf = `outside_apply_test_${uniqueName('outside')}.py`;
const outsideRelPath = `..\\${outsideLeaf}`;
const outsideAbsPath = path.resolve(APP_DIR, '..', outsideLeaf);
await runServerCase({
  name: 'apply-outside-workspace-blocked',
  trustAlways: true,
  verify: async (baseUrl) => {
    removeIfExists(outsideAbsPath);
    const write = await postJson(`${baseUrl}/api/write_file`, {
      path: outsideRelPath,
      content: 'print("outside")\n'
    }, APPROVED_IDE_HEADERS);
    assert(write.status === 400 || write.status === 403, '2. outside-workspace pending edit cannot be created for apply', `status=${write.status}`);
    assert(write.ok === false && write.data?.ok === false, '2a. outside-workspace write response is explicit failure');
    assert(!fs.existsSync(outsideAbsPath), '2b. outside-workspace write target does not exist on disk');
    const apply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: outsideRelPath }, APPROVED_IDE_HEADERS);
    assert(apply.status === 400 || apply.status === 403, '2c. outside-looking apply id is not applied', `status=${apply.status}`);
    assert(apply.ok === false && apply.data?.ok === false, '2d. outside-looking apply response is explicit failure');
    assert(!fs.existsSync(outsideAbsPath), '2e. outside-workspace apply attempt did not create a disk file');
  }
});

const noApprovalRelPath = `proof/apply_to_disk_${uniqueName('no_approval')}.py`;
const noApprovalAbsPath = path.join(APP_DIR, ...noApprovalRelPath.split('/'));
await runServerCase({
  name: 'apply-no-approval-blocked',
  trustAlways: true,
  verify: async (baseUrl) => {
    removeIfExists(noApprovalAbsPath);
    const write = await postJson(`${baseUrl}/api/write_file`, {
      path: noApprovalRelPath,
      content: 'print("approval required")\n'
    }, APPROVED_IDE_HEADERS);
    const pendingEdit = write.data?.result?.pendingEdit || null;
    assert(Boolean(pendingEdit?.id), '3. setup pending edit exists for no-approval apply test');

    const apply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: pendingEdit?.id });
    assert(apply.status === 403, '3a. apply_pending_edit without approval is blocked', `status=${apply.status}`);
    assert(apply.ok === false && apply.data?.ok === false, '3b. no-approval apply response is explicit failure');
    assert(!fs.existsSync(noApprovalAbsPath), '3c. no-approval apply did not write disk file');

    const pending = await postJson(`${baseUrl}/api/pending_edits`, {}, APPROVED_IDE_HEADERS);
    const edits = pending.data?.result || pending.data || [];
    assert(edits.some(edit => edit.id === pendingEdit?.id), '3d. pending edit remains after denied no-approval apply');
    removeIfExists(noApprovalAbsPath);
  }
});

const untrustedRelPath = `proof/apply_to_disk_${uniqueName('untrusted')}.py`;
const untrustedAbsPath = path.join(APP_DIR, ...untrustedRelPath.split('/'));
await runServerCase({
  name: 'apply-untrusted-blocked',
  trustAlways: false,
  verify: async (baseUrl) => {
    removeIfExists(untrustedAbsPath);
    const trust = await postJson(`${baseUrl}/api/trust`, { trusted: true });
    assert(trust.ok, '4. setup workspace trusted for pending edit creation', `status=${trust.status}`);
    const write = await postJson(`${baseUrl}/api/write_file`, {
      path: untrustedRelPath,
      content: 'print("trust required")\n'
    }, APPROVED_IDE_HEADERS);
    const pendingEdit = write.data?.result?.pendingEdit || null;
    assert(Boolean(pendingEdit?.id), '4a. setup pending edit exists for untrusted apply test');

    const untrust = await postJson(`${baseUrl}/api/trust`, { trusted: false });
    assert(untrust.ok, '4b. workspace trust removed before apply', `status=${untrust.status}`);
    const apply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: pendingEdit?.id }, APPROVED_IDE_HEADERS);
    assert(apply.status === 403, '4c. apply_pending_edit in untrusted workspace is blocked', `status=${apply.status}`);
    assert(apply.ok === false && apply.data?.ok === false, '4d. untrusted apply response is explicit failure');
    assert(!fs.existsSync(untrustedAbsPath), '4e. untrusted apply did not write disk file');

    const retrust = await postJson(`${baseUrl}/api/trust`, { trusted: true });
    assert(retrust.ok, '4f. workspace retrusted for cleanup', `status=${retrust.status}`);
    removeIfExists(untrustedAbsPath);
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) {
    console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
  }
  process.exitCode = 1;
}
