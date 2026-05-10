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
      console.error('sendMessage failed during move/rename test scenario:', error);
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

function moveToolCall(fixtureName, sourcePath, targetPath) {
  return {
    id: `${fixtureName}_move_call`,
    type: 'function',
    function: {
      name: 'move_file',
      arguments: JSON.stringify({ sourcePath, targetPath })
    }
  };
}

async function runMoveUiScenario({ fixtureName, autoAccept, sourceRelPath, targetRelPath, initialContent, prompt }) {
  const sourceAbs = path.join(APP_DIR, ...sourceRelPath.split('/'));
  const targetAbs = path.join(APP_DIR, ...targetRelPath.split('/'));
  const sourceSnapshot = fs.existsSync(sourceAbs) ? { existed: true, content: fs.readFileSync(sourceAbs, 'utf8') } : { existed: false, content: '' };
  const targetSnapshot = fs.existsSync(targetAbs) ? { existed: true, content: fs.readFileSync(targetAbs, 'utf8') } : { existed: false, content: '' };

  const fixturePath = writeFixtureFile(fixtureName, [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [moveToolCall(fixtureName, sourceRelPath, targetRelPath)]
      }
    }
  ]);

  let server = null;
  let browser = null;
  let context = null;
  let page = null;
  try {
    removeIfExists(sourceAbs);
    removeIfExists(targetAbs);
    fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
    fs.writeFileSync(sourceAbs, initialContent, 'utf8');

    assert(fs.existsSync(sourceAbs), `${fixtureName} source exists before request`);
    assert(!fs.existsSync(targetAbs), `${fixtureName} target absent before request`);

    const port = 4580 + Math.floor(Math.random() * 300);
    server = await startServer({ port, fixturePath, trustAlways: true });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl, 20000);

    const profile = await requestJson(`${baseUrl}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: true } });
    assert(profile.statusCode === 200, `${fixtureName} profile switched to IDE mode`, `status=${profile.statusCode}`);
    const trust = await requestJson(`${baseUrl}/api/trust`, { method: 'POST', body: { trusted: true } });
    assert(trust.statusCode === 200 && trust.json?.trusted === true, `${fixtureName} workspace trust enabled`, `status=${trust.statusCode}`);

    ({ browser, context, page } = await openScenarioPage(baseUrl, autoAccept));
    const submit = await submitPrompt(page, prompt);
    assert(submit.proxyChatSeen, `${fixtureName} prompt submitted through UI chat path`);
    assert(submit.proxyResponseStatus === 200, `${fixtureName} /proxy/chat returned 200`, `status=${submit.proxyResponseStatus}`);

    assert(fs.existsSync(sourceAbs), `${fixtureName} source still exists before approval/apply`);
    assert(!fs.existsSync(targetAbs), `${fixtureName} target still absent before approval/apply`);

    if (!autoAccept) {
      await page.waitForSelector('#modal-overlay.active', { state: 'visible' });
      const modalText = await page.locator('#modal-overlay').textContent() || '';
      assert(/Move\/Rename Approval Required/i.test(modalText), `${fixtureName} move/rename approval modal visible`);
      assert(modalText.includes(sourceRelPath) && modalText.includes(targetRelPath), `${fixtureName} approval modal includes source and target`);
      const beforeApprovalPending = await getPendingEdits(baseUrl);
      assert(!beforeApprovalPending.some((edit) => normalizeRelPath(edit.targetRelPath) === targetRelPath), `${fixtureName} no pending move before approval`);
      await page.locator('#btn-allow').click();
    }

    await waitForCondition(async () => {
      const edits = await getPendingEdits(baseUrl);
      return edits.some((edit) => normalizeRelPath(edit.operation) === 'move' && normalizeRelPath(edit.targetRelPath) === targetRelPath);
    }, 20000, 'pending move after approval/auto-accept');

    const pendingEdits = await getPendingEdits(baseUrl);
    const pendingEdit = pendingEdits.find((edit) => normalizeRelPath(edit.targetRelPath) === targetRelPath) || pendingEdits[0];
    assert(Boolean(pendingEdit?.id), `${fixtureName} pending move created`);
    assert(pendingEdit?.operation === 'move', `${fixtureName} pending operation is move`);
    assert(normalizeRelPath(pendingEdit?.sourceRelPath) === sourceRelPath, `${fixtureName} pending source path captured`);
    assert(normalizeRelPath(pendingEdit?.targetRelPath) === targetRelPath, `${fixtureName} pending target path captured`);

    assert(fs.existsSync(sourceAbs), `${fixtureName} source still exists before Review + Apply`);
    assert(!fs.existsSync(targetAbs), `${fixtureName} target still absent before Review + Apply`);

    const pendingCard = page.locator('.pending-edit-card').filter({ hasText: targetRelPath.split('/').pop() }).last();
    await pendingCard.waitFor({ state: 'visible' });
    await pendingCard.locator('button', { hasText: 'Review + Apply' }).click();

    await waitForCondition(async () => !fs.existsSync(sourceAbs) && fs.existsSync(targetAbs), 10000, 'move applied to disk');
    assert(!fs.existsSync(sourceAbs), `${fixtureName} source absent after approved apply`);
    assert(fs.existsSync(targetAbs), `${fixtureName} target exists after approved apply`);
    assert(fs.readFileSync(targetAbs, 'utf8') === initialContent, `${fixtureName} content preserved after move/rename`);
  } finally {
    if (sourceSnapshot.existed) {
      fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
      fs.writeFileSync(sourceAbs, sourceSnapshot.content, 'utf8');
    } else {
      removeIfExists(sourceAbs);
    }
    if (targetSnapshot.existed) {
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, targetSnapshot.content, 'utf8');
    } else {
      removeIfExists(targetAbs);
    }
    removeIfExists(path.dirname(targetAbs));
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

async function runBoundaryCases() {
  const outsideLeaf = `outside_move_safety_${Date.now()}.txt`;
  const outsideTarget = `..\\${outsideLeaf}`;
  const outsideAbs = path.resolve(APP_DIR, '..', outsideLeaf);

  const noApprovalFixturePath = writeFixtureFile('move-safety-no-approval', [{
    message: { role: 'assistant', content: '', tool_calls: [moveToolCall('no_approval', 'proof/rename_source.txt', 'proof/rename_target.txt')] }
  }]);
  const outsideFixturePath = writeFixtureFile('move-safety-outside', [{
    message: { role: 'assistant', content: '', tool_calls: [moveToolCall('outside', 'proof/rename_source.txt', outsideTarget)] }
  }]);
  const traversalFixturePath = writeFixtureFile('move-safety-traversal', [{
    message: { role: 'assistant', content: '', tool_calls: [moveToolCall('traversal', 'proof/rename_source.txt', '../proof/escape.txt')] }
  }]);
  const wildcardFixturePath = writeFixtureFile('move-safety-wildcard', [{
    message: { role: 'assistant', content: '', tool_calls: [moveToolCall('wildcard', 'proof/*.txt', 'proof/wild_target.txt')] }
  }]);
  const dirMoveFixturePath = writeFixtureFile('move-safety-dir', [{
    message: { role: 'assistant', content: '', tool_calls: [moveToolCall('dir', 'proof', 'proof/moved_dir')] }
  }]);
  const untrustedFixturePath = writeFixtureFile('move-safety-untrusted', [{
    message: { role: 'assistant', content: '', tool_calls: [moveToolCall('untrusted', 'proof/untrusted_source.txt', 'proof/untrusted_target.txt')] }
  }]);

  let serverNoApproval = null;
  let serverOutside = null;
  let serverTraversal = null;
  let serverWildcard = null;
  let serverDir = null;
  let serverUntrusted = null;
  let apiServer = null;
  try {
    serverNoApproval = await startServer({ port: 4631, fixturePath: noApprovalFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4631`;
      await waitForServer(baseUrl, 20000);
      const res = await postJson(`${baseUrl}/proxy/chat`, {
        model: 'auto',
        messages: [{ role: 'user', content: '??i ten file proof/rename_source.txt thanh proof/rename_target.txt' }],
        autoAccept: false
      });
      assert(res.ok, 'boundary no-approval move /proxy/chat returns 200', `status=${res.status}`);
      const toolResults = extractToolResults(res.data?.agent?.events || [], 'move_file');
      const blocked = toolResults.find((ev) => !ev.ok && /requires user approval or auto-accept/i.test(ev.result || ''));
      const blockedPayload = tryParseJson(blocked?.result || '');
      assert(Boolean(blocked), 'boundary no-approval move blocked');
      assert(blockedPayload?.approvalRequired === true, 'boundary no-approval move exposes approvalRequired metadata');
    }

    serverOutside = await startServer({ port: 4632, fixturePath: outsideFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4632`;
      await waitForServer(baseUrl, 20000);
      removeIfExists(outsideAbs);
      const res = await postJson(`${baseUrl}/proxy/chat`, {
        model: 'auto',
        messages: [{ role: 'user', content: `??i ten file proof/rename_source.txt thanh ${outsideTarget}` }],
        autoAccept: true
      });
      assert(res.ok, 'boundary outside-workspace move /proxy/chat returns 200', `status=${res.status}`);
      const toolResults = extractToolResults(res.data?.agent?.events || [], 'move_file');
      assert(toolResults.some((ev) => !ev.ok && /outside workspace|path traversal/i.test(ev.result || '')), 'boundary outside-workspace target blocked');
      assert(!fs.existsSync(outsideAbs), 'boundary outside-workspace move did not mutate disk');
    }

    serverTraversal = await startServer({ port: 4633, fixturePath: traversalFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4633`;
      await waitForServer(baseUrl, 20000);
      const res = await postJson(`${baseUrl}/proxy/chat`, {
        model: 'auto',
        messages: [{ role: 'user', content: 'Di chuy?n file proof/rename_source.txt sang ../proof/escape.txt' }],
        autoAccept: true
      });
      assert(res.ok, 'boundary traversal move /proxy/chat returns 200', `status=${res.status}`);
      const toolResults = extractToolResults(res.data?.agent?.events || [], 'move_file');
      assert(toolResults.some((ev) => !ev.ok && /path traversal|outside workspace/i.test(ev.result || '')), 'boundary path traversal blocked');
    }

    serverWildcard = await startServer({ port: 4634, fixturePath: wildcardFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4634`;
      await waitForServer(baseUrl, 20000);
      const res = await postJson(`${baseUrl}/proxy/chat`, {
        model: 'auto',
        messages: [{ role: 'user', content: 'Di chuy?n file proof/*.txt sang proof/wild_target.txt' }],
        autoAccept: true
      });
      assert(res.ok, 'boundary wildcard move /proxy/chat returns 200', `status=${res.status}`);
      const toolResults = extractToolResults(res.data?.agent?.events || [], 'move_file');
      assert(toolResults.some((ev) => !ev.ok && /wildcards are not allowed/i.test(ev.result || '')), 'boundary wildcard move blocked');
    }

    serverDir = await startServer({ port: 4635, fixturePath: dirMoveFixturePath, trustAlways: true });
    {
      const baseUrl = `http://${HOST}:4635`;
      await waitForServer(baseUrl, 20000);
      const dirSource = path.join(APP_DIR, 'proof');
      const dirChild = path.join(dirSource, 'dir_move_fixture.txt');
      fs.mkdirSync(dirSource, { recursive: true });
      fs.writeFileSync(dirChild, 'dir fixture\\n', 'utf8');
      const res = await postJson(`${baseUrl}/proxy/chat`, {
        model: 'auto',
        messages: [{ role: 'user', content: 'Di chuy?n th? m?c proof sang proof/moved_dir' }],
        autoAccept: true
      });
      assert(res.ok, 'boundary directory move /proxy/chat returns 200', `status=${res.status}`);
      const toolResults = extractToolResults(res.data?.agent?.events || [], 'move_file');
      assert(toolResults.some((ev) => !ev.ok && /only supports regular source files|directory move is not allowed/i.test(ev.result || '')), 'boundary directory move blocked');
      removeIfExists(dirChild);
    }

    serverUntrusted = await startServer({ port: 4636, fixturePath: untrustedFixturePath, trustAlways: false });
    {
      const baseUrl = `http://${HOST}:4636`;
      await waitForServer(baseUrl, 20000);
      const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-untrusted-move-safety-'));
      fs.mkdirSync(path.join(tempWorkspace, 'proof'), { recursive: true });
      fs.writeFileSync(path.join(tempWorkspace, 'proof', 'untrusted_source.txt'), 'untrusted move fixture\n', 'utf8');
      try {
        const switched = await postJson(`${baseUrl}/api/workspace`, { path: tempWorkspace });
        assert(switched.ok, 'boundary untrusted move switched to temp workspace', `status=${switched.status}`);
        const res = await postJson(`${baseUrl}/proxy/chat`, {
          model: 'auto',
          messages: [{ role: 'user', content: '??i ten file proof/untrusted_source.txt thanh proof/untrusted_target.txt' }],
          autoAccept: true
        });
        assert(res.ok, 'boundary untrusted move /proxy/chat returns 200', `status=${res.status}`);
        const toolResults = extractToolResults(res.data?.agent?.events || [], 'move_file');
        assert(toolResults.some((ev) => !ev.ok && /trusted workspace/i.test(ev.result || '')), 'boundary untrusted workspace move blocked');
      } finally {
        removeIfExists(tempWorkspace);
      }
    }

    const apiFixture = writeFixtureFile('move-safety-api-bounds', []);
    try {
      apiServer = await startServer({ port: 4637, fixturePath: apiFixture, trustAlways: true });
      const baseUrl = `http://${HOST}:4637`;
      await waitForServer(baseUrl, 20000);
      const approvedHeaders = { 'X-Agent-Approved': 'true' };

      const source = path.join(APP_DIR, 'proof', 'collision_source.txt');
      const target = path.join(APP_DIR, 'proof', 'collision_target.txt');
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, 'collision source\n', 'utf8');
      fs.writeFileSync(target, 'collision target\n', 'utf8');

      const collisionRes = await postJson(`${baseUrl}/api/move_file`, {
        sourcePath: 'proof/collision_source.txt',
        targetPath: 'proof/collision_target.txt'
      }, approvedHeaders);
      assert(collisionRes.ok === false, 'boundary overwrite/collision blocked');

      const absoluteOutside = process.platform === 'win32' ? 'C:/Windows/system32/outside.txt' : '/tmp/outside.txt';
      const absoluteRes = await postJson(`${baseUrl}/api/move_file`, {
        sourcePath: 'proof/collision_source.txt',
        targetPath: absoluteOutside
      }, approvedHeaders);
      assert(absoluteRes.ok === false, 'boundary absolute outside-workspace target blocked');

      removeIfExists(source);
      removeIfExists(target);
    } finally {
      await stopServer(apiServer);
      try { fs.unlinkSync(apiFixture); } catch {}
    }
  } finally {
    await stopServer(serverNoApproval);
    await stopServer(serverOutside);
    await stopServer(serverTraversal);
    await stopServer(serverWildcard);
    await stopServer(serverDir);
    await stopServer(serverUntrusted);
    try { fs.unlinkSync(noApprovalFixturePath); } catch {}
    try { fs.unlinkSync(outsideFixturePath); } catch {}
    try { fs.unlinkSync(traversalFixturePath); } catch {}
    try { fs.unlinkSync(wildcardFixturePath); } catch {}
    try { fs.unlinkSync(dirMoveFixturePath); } catch {}
    try { fs.unlinkSync(untrustedFixturePath); } catch {}
  }
}

async function main() {
  console.log('\nMove/Rename File Workflow Proof Tests\n');

  await runMoveUiScenario({
    fixtureName: 'move-rename-scenario-a-rename',
    autoAccept: true,
    sourceRelPath: 'proof/rename_source.txt',
    targetRelPath: 'proof/rename_target.txt',
    initialContent: 'RENAME SAFETY FIXTURE\n',
    prompt: '??i ten file proof/rename_source.txt thanh proof/rename_target.txt'
  });

  await runMoveUiScenario({
    fixtureName: 'move-rename-scenario-b-move',
    autoAccept: true,
    sourceRelPath: 'proof/move_source.txt',
    targetRelPath: 'proof/moved/move_target.txt',
    initialContent: 'MOVE SAFETY FIXTURE\n',
    prompt: 'Di chuy?n file proof/move_source.txt sang proof/moved/move_target.txt'
  });

  await runMoveUiScenario({
    fixtureName: 'move-rename-scenario-c-approval',
    autoAccept: false,
    sourceRelPath: 'proof/rename_approval_source.txt',
    targetRelPath: 'proof/rename_approval_target.txt',
    initialContent: 'APPROVAL SAFETY FIXTURE\n',
    prompt: '??i ten file proof/rename_approval_source.txt thanh proof/rename_approval_target.txt'
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
