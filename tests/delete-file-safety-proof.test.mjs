import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { requestJson, waitForServer, sleep } from '../tools/smoke/core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(path.join(__dirname, '..'));
const SERVER_SCRIPT = path.join(APP_DIR, 'tools', 'nvidia-server.mjs');
const HOST = '127.0.0.1';
const PAGE_TIMEOUT_MS = 60000;
const SELECTOR_TIMEOUT_MS = 20000;

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

function removeIfExists(targetPath) {
  try {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
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

async function waitForCondition(predicate, timeoutMs, label) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    if (await predicate()) return true;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
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
  return events.filter((ev) => ev.type === 'tool_result' && ev.tool === toolName);
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

async function openScenarioPage(baseUrl, autoAccept) {
  const chromePath = findChromeExecutable();
  if (!chromePath) throw new Error('No Chrome/Edge executable found. Set CHROME_PATH or install Chrome/Edge.');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultTimeout(SELECTOR_TIMEOUT_MS);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#user-input', { state: 'visible' });
  await page.waitForFunction(() => typeof window.sendMessage === 'function' && typeof window.setUIMode === 'function');
  await page.waitForFunction(() => {
    const debugConsole = document.getElementById('debug-console');
    const text = debugConsole?.textContent || '';
    return Boolean(debugConsole && (/ready\./i.test(text) || /sẵn sàng/i.test(text)));
  });
  await page.evaluate(() => {
    const hasSession = typeof currentSessionId !== 'undefined'
      && typeof sessions !== 'undefined'
      && currentSessionId
      && sessions[currentSessionId];
    if (!hasSession && typeof createNewSession === 'function') createNewSession();
  });
  await page.evaluate(async (nextAutoAccept) => {
    if (typeof window.setUIMode === 'function') await window.setUIMode('ide', { persist: false });
    const autoAcceptToggle = document.getElementById('auto-accept');
    if (autoAcceptToggle) autoAcceptToggle.checked = nextAutoAccept;
  }, autoAccept);
  return { browser, context, page };
}

async function submitPrompt(page, prompt) {
  let proxyChatSeen = false;
  page.on('request', (request) => {
    if (request.url().includes('/proxy/chat') && request.method() === 'POST') proxyChatSeen = true;
  });
  const proxyResponsePromise = page.waitForResponse((response) =>
    response.url().includes('/proxy/chat') && response.request().method() === 'POST'
  );
  await page.evaluate((nextPrompt) => {
    const input = document.getElementById('user-input');
    if (!input) throw new Error('user-input not found');
    input.value = nextPrompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof window.sendMessage !== 'function') throw new Error('sendMessage not available');
    window.sendMessage().catch((error) => {
      console.error('sendMessage failed during delete safety test scenario:', error);
    });
  }, prompt);
  await waitForCondition(async () => proxyChatSeen, 10000, '/proxy/chat request');
  const proxyResponse = await proxyResponsePromise;
  let proxyResponseJson = null;
  try {
    proxyResponseJson = await proxyResponse.json();
  } catch {}
  return { proxyChatSeen, proxyResponseStatus: proxyResponse.status(), proxyResponseJson };
}

async function getPendingEdits(baseUrl) {
  const pending = await requestJson(`${baseUrl}/api/pending_edits`, {
    method: 'POST',
    headers: { 'X-Agent-Approved': 'true' },
    body: {}
  });
  return pending.json?.result || [];
}

async function runDeleteUiScenario({ fixtureName, autoAccept, relPath, prompt }) {
  const absPath = path.join(APP_DIR, ...relPath.split('/'));
  const snapshot = fs.existsSync(absPath)
    ? { existed: true, content: fs.readFileSync(absPath, 'utf8') }
    : { existed: false, content: '' };
  const fixturePath = writeFixtureFile(fixtureName, [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: `${fixtureName}_delete_call`,
          type: 'function',
          function: {
            name: 'delete_file',
            arguments: JSON.stringify({
              filePath: relPath
            })
          }
        }]
      }
    }
  ]);

  let server = null;
  let browser = null;
  let context = null;
  let page = null;
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, 'DELETE SAFETY FIXTURE - DO NOT KEEP\n', 'utf8');
    assert(fs.existsSync(absPath), `${fixtureName} fixture exists before request`);

    const port = 4320 + Math.floor(Math.random() * 300);
    server = await startServer({ port, fixturePath, trustAlways: true });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl, 20000);

    const profile = await requestJson(`${baseUrl}/api/profile`, {
      method: 'POST',
      body: { uiMode: 'ide', trustedWorkspace: true }
    });
    assert(profile.statusCode === 200, `${fixtureName} profile switched to IDE mode`, `status=${profile.statusCode}`);
    const trust = await requestJson(`${baseUrl}/api/trust`, {
      method: 'POST',
      body: { trusted: true }
    });
    assert(trust.statusCode === 200 && trust.json?.trusted === true, `${fixtureName} workspace trust enabled`, `status=${trust.statusCode}`);

    ({ browser, context, page } = await openScenarioPage(baseUrl, autoAccept));
    const submit = await submitPrompt(page, prompt);
    assert(submit.proxyChatSeen, `${fixtureName} prompt submitted through UI chat path`);
    assert(submit.proxyResponseStatus === 200, `${fixtureName} /proxy/chat returned 200`, `status=${submit.proxyResponseStatus}`);
    assert(fs.existsSync(absPath), `${fixtureName} file still exists before approval/apply`);

    const userMessage = page.locator('.user-message').filter({ hasText: prompt }).last();
    await userMessage.waitFor({ state: 'visible' });
    assert(await userMessage.count() > 0, `${fixtureName} user prompt visible in transcript`);

    const finalAssistantContent = String(submit.proxyResponseJson?.choices?.[0]?.message?.content || '');

    if (!autoAccept) {
      await page.waitForSelector('#modal-overlay.active', { state: 'visible' });
      const modalText = await page.locator('#modal-overlay').textContent() || '';
      assert(/Delete Approval Required/i.test(modalText), `${fixtureName} delete approval modal visible`);
      assert(modalText.includes(relPath), `${fixtureName} delete approval modal references target path`);
      assert(/approve/i.test(finalAssistantContent), `${fixtureName} approval-required assistant message shown`);
      const beforeApprovalPending = await getPendingEdits(baseUrl);
      assert(!beforeApprovalPending.some((edit) => normalizeRelPath(edit.relPath) === relPath), `${fixtureName} no pending delete before approval`);
      await page.locator('#btn-allow').click();
      await waitForCondition(async () => {
        const edits = await getPendingEdits(baseUrl);
        return edits.some((edit) => normalizeRelPath(edit.relPath) === relPath);
      }, 20000, 'pending delete after approval');
      assert(fs.existsSync(absPath), `${fixtureName} file still exists after approval but before apply`);
      assert(!/không có lệnh write_file nào chạy thành công/i.test(finalAssistantContent), `${fixtureName} no misleading write_file fallback`);
    } else {
      await waitForCondition(async () => {
        const edits = await getPendingEdits(baseUrl);
        return edits.some((edit) => normalizeRelPath(edit.relPath) === relPath);
      }, 20000, 'pending delete from auto-accept flow');
      assert(!(await page.locator('#modal-overlay.active').isVisible().catch(() => false)), `${fixtureName} no approval modal for auto-accept`);
      assert(fs.existsSync(absPath), `${fixtureName} file exists before apply in auto-accept flow`);
    }

    const pendingEdits = await getPendingEdits(baseUrl);
    const pendingEdit = pendingEdits.find((edit) => normalizeRelPath(edit.relPath) === relPath) || pendingEdits[0];
    assert(Boolean(pendingEdit?.id), `${fixtureName} pending delete created`);
    assert(String(pendingEdit?.diff || '').includes('+++ /dev/null'), `${fixtureName} pending delete diff indicates file removal`);
    assert(fs.existsSync(absPath), `${fixtureName} file unchanged before Review + Apply`);

    const pendingCard = page.locator('.pending-edit-card').filter({ hasText: 'delete_safety' }).last();
    await pendingCard.waitFor({ state: 'visible' });
    await pendingCard.locator('button', { hasText: 'Review + Apply' }).click();
    await waitForCondition(async () => !fs.existsSync(absPath), 10000, 'file removed after apply');
    assert(!fs.existsSync(absPath), `${fixtureName} file removed after approved apply`);
  } finally {
    if (snapshot.existed) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, snapshot.content, 'utf8');
    } else {
      removeIfExists(absPath);
    }
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

async function runBoundaryCases() {
  const outsideLeaf = `outside_delete_safety_${Date.now()}.txt`;
  const outsidePath = `..\\${outsideLeaf}`;
  const outsideAbs = path.resolve(APP_DIR, '..', outsideLeaf);

  const outsideFixturePath = writeFixtureFile('delete-safety-outside', [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_delete_outside',
          type: 'function',
          function: {
            name: 'delete_file',
            arguments: JSON.stringify({
              filePath: outsidePath
            })
          }
        }]
      }
    }
  ]);
  const noApprovalFixturePath = writeFixtureFile('delete-safety-no-approval', [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_delete_no_approval',
          type: 'function',
          function: {
            name: 'delete_file',
            arguments: JSON.stringify({
              filePath: 'proof/delete_safety_no_approval.txt'
            })
          }
        }]
      }
    }
  ]);
  const untrustedFixturePath = writeFixtureFile('delete-safety-untrusted', [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_delete_untrusted',
          type: 'function',
          function: {
            name: 'delete_file',
            arguments: JSON.stringify({
              filePath: 'proof/delete_safety_untrusted.txt'
            })
          }
        }]
      }
    }
  ]);

  let serverOutside = null;
  let serverNoApproval = null;
  let serverUntrusted = null;
  try {
    serverOutside = await startServer({ port: 4511, fixturePath: outsideFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4511`;
      await waitForServer(baseUrl, 20000);
      removeIfExists(outsideAbs);
      const res = await postJson(`${baseUrl}/proxy/chat`, {
        model: 'auto',
        messages: [{ role: 'user', content: `Xóa file ${outsidePath}` }],
        autoAccept: true
      });
      assert(res.ok, 'boundary outside-workspace delete /proxy/chat returns 200', `status=${res.status}`);
      const events = res.data?.agent?.events || [];
      const toolResults = extractToolResults(events, 'delete_file');
      assert(toolResults.some((ev) => !ev.ok && /outside workspace/i.test(ev.result || '')), 'boundary outside-workspace delete blocked');
      assert(!fs.existsSync(outsideAbs), 'boundary outside-workspace delete did not mutate disk');
    }

    serverNoApproval = await startServer({ port: 4512, fixturePath: noApprovalFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4512`;
      await waitForServer(baseUrl, 20000);
      const target = path.join(APP_DIR, 'proof', 'delete_safety_no_approval.txt');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'no approval delete fixture\n', 'utf8');
      const res = await postJson(`${baseUrl}/proxy/chat`, {
        model: 'auto',
        messages: [{ role: 'user', content: 'Xóa file proof/delete_safety_no_approval.txt' }],
        autoAccept: false
      });
      assert(res.ok, 'boundary no-approval delete /proxy/chat returns 200', `status=${res.status}`);
      const events = res.data?.agent?.events || [];
      const toolResults = extractToolResults(events, 'delete_file');
      const blocked = toolResults.find((ev) => !ev.ok && /requires user approval or auto-accept/i.test(ev.result || ''));
      const blockedPayload = tryParseJson(blocked?.result || '');
      assert(Boolean(blocked), 'boundary no-approval delete blocked');
      assert(blockedPayload?.approvalRequired === true, 'boundary no-approval delete exposes approvalRequired metadata');
      assert(events.some((ev) => ev.type === 'status' && ev.status === 'awaiting_user_approval'), 'boundary no-approval delete enters awaiting_user_approval');
      assert(fs.existsSync(target), 'boundary no-approval delete does not remove file');
      removeIfExists(target);
    }

    serverUntrusted = await startServer({ port: 4513, fixturePath: untrustedFixturePath, trustAlways: false });
    {
      const baseUrl = `http://${HOST}:4513`;
      await waitForServer(baseUrl, 20000);
      const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-untrusted-delete-safety-'));
      fs.mkdirSync(path.join(tempWorkspace, 'proof'), { recursive: true });
      fs.writeFileSync(path.join(tempWorkspace, 'proof', 'delete_safety_untrusted.txt'), 'untrusted delete fixture\n', 'utf8');
      try {
        const switched = await postJson(`${baseUrl}/api/workspace`, { path: tempWorkspace });
        assert(switched.ok, 'boundary untrusted delete switched to temp workspace', `status=${switched.status}`);
        const res = await postJson(`${baseUrl}/proxy/chat`, {
          model: 'auto',
          messages: [{ role: 'user', content: 'Xóa file proof/delete_safety_untrusted.txt' }],
          autoAccept: true
        });
        assert(res.ok, 'boundary untrusted delete /proxy/chat returns 200', `status=${res.status}`);
        const events = res.data?.agent?.events || [];
        const toolResults = extractToolResults(events, 'delete_file');
        assert(toolResults.some((ev) => !ev.ok && /trusted workspace/i.test(ev.result || '')), 'boundary untrusted delete blocked');
      } finally {
        removeIfExists(tempWorkspace);
      }
    }

    // API-level hard boundary checks for directory/wildcard/path traversal
    const apiFixture = writeFixtureFile('delete-safety-api-bounds', []);
    let apiServer = null;
    try {
      apiServer = await startServer({ port: 4514, fixturePath: apiFixture, trustAlways: true });
      const baseUrl = `http://${HOST}:4514`;
      await waitForServer(baseUrl, 20000);
      const approvedHeaders = { 'X-Agent-Approved': 'true' };

      const dirRes = await postJson(`${baseUrl}/api/delete_file`, { path: 'proof' }, approvedHeaders);
      assert(dirRes.ok === false, 'boundary directory delete blocked');

      const wildcardRes = await postJson(`${baseUrl}/api/delete_file`, { path: 'proof/*.txt' }, approvedHeaders);
      assert(wildcardRes.ok === false, 'boundary wildcard delete blocked');

      const traversalRes = await postJson(`${baseUrl}/api/delete_file`, { path: '../outside.txt' }, approvedHeaders);
      assert(traversalRes.ok === false, 'boundary traversal delete blocked');
    } finally {
      await stopServer(apiServer);
      try { fs.unlinkSync(apiFixture); } catch {}
    }
  } finally {
    await stopServer(serverOutside);
    await stopServer(serverNoApproval);
    await stopServer(serverUntrusted);
    try { fs.unlinkSync(outsideFixturePath); } catch {}
    try { fs.unlinkSync(noApprovalFixturePath); } catch {}
    try { fs.unlinkSync(untrustedFixturePath); } catch {}
  }
}

async function main() {
  console.log('\nDelete File Safety Proof Tests\n');
  await runDeleteUiScenario({
    fixtureName: 'delete-safety-auto-accept-on',
    autoAccept: true,
    relPath: 'proof/delete_safety_target.txt',
    prompt: 'Xóa file proof/delete_safety_target.txt'
  });

  await runDeleteUiScenario({
    fixtureName: 'delete-safety-auto-accept-off',
    autoAccept: false,
    relPath: 'proof/delete_safety_approval_target.txt',
    prompt: 'Xóa file proof/delete_safety_approval_target.txt'
  });

  await runBoundaryCases();

  process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const failure of failures) {
      console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
    }
    process.exitCode = 1;
  }
}

await main();
