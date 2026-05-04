import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const APP_DIR = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SERVER_SCRIPT = path.join(APP_DIR, 'tools', 'nvidia-server.mjs');
const HOST = '127.0.0.1';
const APPROVED_IDE_HEADERS = { 'X-Agent-Approved': 'true' };

const CLASSIFICATIONS = {
  PASS: 'LIVE_PROVIDER_CREATE_APPLY_PASS',
  BLOCKED: 'LIVE_PROVIDER_CREATE_APPLY_BLOCKED_PROVIDER_UNAVAILABLE',
  FAIL: 'LIVE_PROVIDER_CREATE_APPLY_FAIL'
};

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

function uniqueName(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function removeIfExists(targetPath) {
  try {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isProviderUnavailableError(text) {
  return /missing api key|provider unavailable|401|403|timeout|timed out|fetch failed|enotfound|econnrefused|connection test failed|not implemented for \/proxy\/chat yet/i.test(String(text || ''));
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server not ready: ${url}`);
}

function startServer({ port, trustAlways = true }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NVIDIA_TEST_CHAT_FIXTURE;
    env.PORT = String(port);
    env.HOST = HOST;
    env.NVIDIA_SERVER_HOST = HOST;
    if (trustAlways) env.NVIDIA_WORKSPACE_TRUST = 'always';
    else delete env.NVIDIA_WORKSPACE_TRUST;

    const stdoutLines = [];
    const stderrLines = [];
    const child = spawn('node', [SERVER_SCRIPT], {
      cwd: APP_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const pushLog = (store, buf) => {
      const text = String(buf || '');
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        store.push(line);
        if (store.length > 500) store.shift();
      }
    };

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`Server startup timed out on port ${port}`));
    }, 20000);

    const onData = (target) => (buf) => {
      pushLog(target, buf);
      if (settled) return;
      if (/server running at/i.test(String(buf || ''))) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, stdoutLines, stderrLines, env });
      }
    };

    child.stdout.on('data', onData(stdoutLines));
    child.stderr.on('data', onData(stderrLines));
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

function stopServer(server) {
  return new Promise((resolve) => {
    const child = server?.child;
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
  return { status: res.status, ok: res.ok, data, text };
}

function extractToolResults(events = [], toolName) {
  return events.filter((ev) => ev?.type === 'tool_result' && ev.tool === toolName);
}

function summarizeLogs(server) {
  return [...(server?.stdoutLines || []), ...(server?.stderrLines || [])].join('\n');
}

function printFinalClassification(classification, reason = '') {
  process.stdout.write(`\nClassification: ${classification}\n`);
  if (reason) process.stdout.write(`Reason: ${reason}\n`);
  process.stdout.write(`Summary: ${passed} passed, ${failed} failed\n`);
}

async function main() {
  const providerEnv = {
    providerId: 'nvidia',
    apiKeyPresent: Boolean(String(process.env.NVIDIA_API_KEY || '').trim()),
    baseUrl: String(process.env.NVIDIA_BASE_URL || '').trim() || '(default)',
    model: String(process.env.NVIDIA_DEFAULT_MODEL || '').trim() || '(default)'
  };

  if (process.env.NVIDIA_TEST_CHAT_FIXTURE) {
    printFinalClassification(CLASSIFICATIONS.FAIL, 'NVIDIA_TEST_CHAT_FIXTURE must be unset for live provider proof.');
    process.exitCode = 1;
    return;
  }

  if (!providerEnv.apiKeyPresent) {
    printFinalClassification(CLASSIFICATIONS.BLOCKED, 'Missing NVIDIA_API_KEY for live provider proof.');
    process.exitCode = 2;
    return;
  }

  const relPath = `proof/live_provider_create_apply_${uniqueName('proof')}.py`;
  const absPath = path.join(APP_DIR, ...relPath.split('/'));
  const outsideLeaf = `outside_live_provider_${uniqueName('outside')}.py`;
  const outsideRelPath = `..\\${outsideLeaf}`;
  const outsideAbsPath = path.resolve(APP_DIR, '..', outsideLeaf);
  const prompt = `Create file ${relPath} with Python code that defines live_provider_add(a, b) and returns a + b. Use the write_file tool. Do not write outside the workspace.`;

  let server = null;
  try {
    removeIfExists(absPath);
    removeIfExists(outsideAbsPath);

    const port = 4060 + Math.floor(Math.random() * 400);
    server = await startServer({ port, trustAlways: false });
    assert(!server.env.NVIDIA_TEST_CHAT_FIXTURE, '1. live proof server started without NVIDIA_TEST_CHAT_FIXTURE');

    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl);

    const profile = await postJson(`${baseUrl}/api/profile`, { uiMode: 'ide', trustedWorkspace: true });
    assert(profile.ok, '1a. IDE profile enabled for live proof', `status=${profile.status}`);

    const trust = await postJson(`${baseUrl}/api/trust`, { trusted: true });
    assert(trust.ok && trust.data?.trusted === true, '1b. workspace trust enabled for live proof', `status=${trust.status}`);

    const providerTest = await postJson(`${baseUrl}/api/providers/test`, {
      id: 'nvidia',
      timeoutMs: 8000
    }, APPROVED_IDE_HEADERS);
    const providerReason = providerTest.data?.error || providerTest.data?.reason || providerTest.data?.provider?.message || providerTest.data?.provider?.warning || providerTest.text || 'unknown provider test failure';
    if (!(providerTest.ok && providerTest.data?.status === 'ok')) {
      printFinalClassification(CLASSIFICATIONS.BLOCKED, `Provider test blocked live proof: ${providerReason}`);
      process.exitCode = 2;
      return;
    }
    assert(providerTest.ok && providerTest.data?.status === 'ok', '1c. provider connectivity test passed');

    const liveResponse = await postJson(`${baseUrl}/proxy/chat`, {
      model: 'auto',
      messages: [{ role: 'user', content: prompt }],
      autoAccept: true,
      temperature: 0
    });

    if (!liveResponse.ok) {
      const errorText = liveResponse.data?.error || liveResponse.text || '';
      if (isProviderUnavailableError(errorText)) {
        printFinalClassification(CLASSIFICATIONS.BLOCKED, `Live provider request blocked: ${errorText}`);
        process.exitCode = 2;
        return;
      }
      assert(false, '2. /proxy/chat live request returned success', `status=${liveResponse.status} ${errorText}`);
      printFinalClassification(CLASSIFICATIONS.FAIL, `Live provider request failed: ${errorText}`);
      process.exitCode = 1;
      return;
    }

    const events = liveResponse.data?.agent?.events || [];
    const logText = summarizeLogs(server);
    const toolResults = extractToolResults(events, 'write_file');
    const successfulToolResult = toolResults.find((ev) => ev.ok);
    const parsedToolResult = tryParseJson(successfulToolResult?.result || '');
    const pendingEdit = parsedToolResult?.pendingEdit || parsedToolResult?.pending_edit || null;
    const pendingId = String(pendingEdit?.id || '');
    const normalizedRelPath = String(pendingEdit?.relPath || '').replace(/\\/g, '/');

    assert(liveResponse.ok, '2. /proxy/chat live request returned success', `status=${liveResponse.status}`);
    assert(/Provider:\s*nvidia\b/i.test(logText), '2a. server attempted real nvidia provider path', 'provider log not found');
    assert(!/fixture-/i.test(JSON.stringify(liveResponse.data || {})), '2b. live response does not contain fixture completion ids');
    assert(toolResults.some((ev) => ev.ok), '2c. live provider path produced successful write_file tool result');
    assert(Boolean(pendingId), '2d. live provider path produced pending edit id');
    assert(normalizedRelPath === relPath, '2e. pending edit relPath matches requested workspace path', normalizedRelPath || 'missing relPath');
    assert(!fs.existsSync(absPath), '2f. pending edit did not write disk file before apply');

    const pendingBeforeApply = await postJson(`${baseUrl}/api/pending_edits`, {}, APPROVED_IDE_HEADERS);
    const pendingList = pendingBeforeApply.data?.result || pendingBeforeApply.data || [];
    assert(Array.isArray(pendingList) && pendingList.some((edit) => edit.id === pendingId), '2g. pending edit is API-observable before apply');

    const noApprovalApply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: pendingId });
    assert(noApprovalApply.status === 403, '3. apply_pending_edit without approval remains blocked', `status=${noApprovalApply.status}`);
    assert(!fs.existsSync(absPath), '3a. no-approval apply did not write disk file');

    const untrust = await postJson(`${baseUrl}/api/trust`, { trusted: false });
    assert(untrust.ok && untrust.data?.trusted === false, '3b. workspace trust removed before untrusted apply check', `status=${untrust.status}`);
    const untrustedApply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: pendingId }, APPROVED_IDE_HEADERS);
    assert(untrustedApply.status === 403, '3c. apply_pending_edit in untrusted workspace remains blocked', `status=${untrustedApply.status}`);
    assert(!fs.existsSync(absPath), '3d. untrusted apply did not write disk file');

    const retrust = await postJson(`${baseUrl}/api/trust`, { trusted: true });
    assert(retrust.ok && retrust.data?.trusted === true, '3e. workspace trust restored for approved apply', `status=${retrust.status}`);

    const apply = await postJson(`${baseUrl}/api/apply_pending_edit`, { id: pendingId }, APPROVED_IDE_HEADERS);
    assert(apply.ok, '4. approved trusted apply_pending_edit succeeds', `status=${apply.status}`);
    assert(fs.existsSync(absPath), '4a. disk file exists after approved apply');

    const diskContent = normalizeText(fs.readFileSync(absPath, 'utf8'));
    assert(/def\s+live_provider_add\s*\(\s*a\s*,\s*b\s*\)\s*:/i.test(diskContent), '4b. disk content contains requested function name');
    assert(/return\s+a\s*\+\s*b/i.test(diskContent), '4c. disk content contains expected addition logic');
    assert(!/subprocess|os\.system|powershell|cmd\.exe|rm\s+-rf/i.test(diskContent), '4d. disk content does not contain obvious dangerous content');

    const pendingAfterApply = await postJson(`${baseUrl}/api/pending_edits`, {}, APPROVED_IDE_HEADERS);
    const pendingAfterList = pendingAfterApply.data?.result || pendingAfterApply.data || [];
    assert(Array.isArray(pendingAfterList) && !pendingAfterList.some((edit) => edit.id === pendingId), '4e. pending edit removed after apply');

    const outsideWrite = await postJson(`${baseUrl}/api/write_file`, {
      path: outsideRelPath,
      content: 'print("outside")\n'
    }, APPROVED_IDE_HEADERS);
    assert(outsideWrite.status === 400 || outsideWrite.status === 403, '5. outside-workspace write remains blocked', `status=${outsideWrite.status}`);
    assert(!fs.existsSync(outsideAbsPath), '5a. outside-workspace path was not written to disk');

    removeIfExists(absPath);
    assert(!fs.existsSync(absPath), '6. cleanup removed live provider proof file');

    printFinalClassification(CLASSIFICATIONS.PASS);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (error) {
    const reason = error?.message || String(error);
    printFinalClassification(isProviderUnavailableError(reason) ? CLASSIFICATIONS.BLOCKED : CLASSIFICATIONS.FAIL, reason);
    process.exitCode = isProviderUnavailableError(reason) ? 2 : 1;
  } finally {
    removeIfExists(absPath);
    removeIfExists(outsideAbsPath);
    await stopServer(server);
  }
}

await main();
