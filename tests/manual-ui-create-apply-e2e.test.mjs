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

function uniqueName(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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

function removeIfExists(targetPath) {
  try {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/');
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

async function waitForCondition(predicate, timeoutMs, label) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    if (await predicate()) return true;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const relPath = 'proof/sum_ab.py';
  const absPath = path.join(APP_DIR, ...relPath.split('/'));
  const content = 'def sum_ab(a, b):\n    return a + b\n';
  const prompt = 'viết cho tôi chương trình tính tổng 2 số A+B và đóng gói nó thành một file';
  const fixturePath = writeFixtureFile('manual-ui-create-apply', [
    {
      message: {
        role: 'assistant',
        content: 'Đây là mã Python cho chương trình cộng hai số A + B.'
      }
    },
    {
      match: { toolChoice: 'required' },
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_manual_ui_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              filePath: relPath,
              content
            })
          }
        }]
      }
    },
    {
      message: {
        role: 'assistant',
        content: `Pending edit prepared for ${relPath}. Review the diff and apply it if approved.`
      }
    }
  ]);

  let server = null;
  let browser = null;
  let context = null;
  let page = null;

  try {
    const chromePath = findChromeExecutable();
    if (!chromePath) throw new Error('No Chrome/Edge executable found. Set CHROME_PATH or install Chrome/Edge.');
    const { chromium } = await import('playwright-core');

    removeIfExists(absPath);
    const port = 3860 + Math.floor(Math.random() * 400);
    server = await startServer({ port, fixturePath, trustAlways: true });
    const baseUrl = `http://${HOST}:${port}`;
    await waitForServer(baseUrl, 20000);

    const profile = await requestJson(`${baseUrl}/api/profile`, {
      method: 'POST',
      body: { uiMode: 'ide', trustedWorkspace: true }
    });
    assert(profile.statusCode === 200, '1. UI profile switched to IDE mode', `status=${profile.statusCode}`);

    const trust = await requestJson(`${baseUrl}/api/trust`, {
      method: 'POST',
      body: { trusted: true }
    });
    assert(trust.statusCode === 200 && trust.json?.trusted === true, '1a. workspace trust enabled for manual UI proof', `status=${trust.statusCode}`);

    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    page = await context.newPage();
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultTimeout(SELECTOR_TIMEOUT_MS);

    let proxyChatSeen = false;
    let proxyResponseStatus = null;
    let proxyResponseJson = null;
    page.on('request', (request) => {
      if (request.url().includes('/proxy/chat') && request.method() === 'POST') proxyChatSeen = true;
    });
    page.on('response', async (response) => {
      if (!response.url().includes('/proxy/chat') || response.request().method() !== 'POST') return;
      proxyResponseStatus = response.status();
      try {
        proxyResponseJson = await response.json();
      } catch {}
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#user-input', { state: 'visible' });
    await page.waitForFunction(() => typeof window.sendMessage === 'function' && typeof window.setUIMode === 'function');
    await page.waitForFunction(() => {
      const debugConsole = document.getElementById('debug-console');
      return Boolean(debugConsole && /ready\./i.test(debugConsole.textContent || ''));
    });
    await page.evaluate(() => {
      const hasSession = typeof currentSessionId !== 'undefined'
        && typeof sessions !== 'undefined'
        && currentSessionId
        && sessions[currentSessionId];
      if (!hasSession && typeof createNewSession === 'function') {
        createNewSession();
      }
    });
    await page.evaluate(async () => {
      if (typeof window.setUIMode === 'function') {
        await window.setUIMode('ide', { persist: false });
      }
    });
    await page.evaluate(() => {
      const autoAccept = document.getElementById('auto-accept');
      if (autoAccept) autoAccept.checked = true;
    });
    const autoAcceptChecked = await page.locator('#auto-accept').isChecked();
    assert(autoAcceptChecked, '1b. Auto-Accept enabled for prompt-to-pending-edit path');

    await page.evaluate((nextPrompt) => {
      const input = document.getElementById('user-input');
      if (!input) throw new Error('user-input not found');
      input.value = nextPrompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof window.sendMessage !== 'function') throw new Error('sendMessage not available');
      return window.sendMessage();
    }, prompt);

    await waitForCondition(async () => proxyChatSeen, 10000, '/proxy/chat request');
    assert(proxyChatSeen, '2. user prompt submitted through UI chat path');
    await waitForCondition(async () => proxyResponseStatus !== null, 20000, '/proxy/chat response');
    await waitForCondition(async () => {
      const pending = await requestJson(`${baseUrl}/api/pending_edits`, {
        method: 'POST',
        headers: { 'X-Agent-Approved': 'true' },
        body: {}
      });
      const edits = pending.json?.result || [];
      return Array.isArray(edits) && edits.length > 0;
    }, 20000, 'pending edit from UI chat');
    const pendingBeforeApply = await requestJson(`${baseUrl}/api/pending_edits`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: {}
    });
    const pendingEdits = pendingBeforeApply.json?.result || [];
    const pendingEdit = pendingEdits.find((edit) => normalizeRelPath(edit.relPath) === relPath) || pendingEdits[0];
    const uiRelPath = normalizeRelPath(pendingEdit?.relPath || relPath);
    assert(proxyResponseStatus === 200, '2a. /proxy/chat returned 200 to the UI', `status=${proxyResponseStatus}`);
    assert(Boolean(pendingEdit?.id), '2b. UI chat created a pending edit record for the Vietnamese create-file prompt');

    const userMessage = page.locator('.user-message').filter({ hasText: prompt });
    await userMessage.waitFor({ state: 'visible' });
    assert(await userMessage.count() > 0, '2c. user prompt is visible in UI transcript');
    assert(!(await page.locator('#modal-overlay.active').isVisible().catch(() => false)), '2d. no extra approval modal interrupted Auto-Accept prompt path');

    const pendingCard = page.locator('.pending-edit-card').filter({ hasText: path.basename(uiRelPath) });
    await pendingCard.waitFor({ state: 'visible' });
    const pendingText = await pendingCard.textContent() || '';
    assert(/Pending edit:/i.test(pendingText), '3. pending edit card visible in UI');
    assert(/sum_ab\.py/i.test(pendingText), '3a. target path visible in pending edit UI');
    assert(/proposed change only/i.test(pendingText), '3b. UI marks change as proposed only before apply');
    assert(/Review \+ Apply/i.test(pendingText), '3c. Review + Apply control visible on pending edit card');
    assert(!fs.existsSync(absPath), '3d. disk file does not exist before apply');
    assert(!/Applied:/i.test(pendingText), '3e. UI does not claim applied status before apply');

    await page.locator('#btn-tasks').click();
    const changedFilesItem = page.locator('#changed-files-list .file-item').filter({ hasText: path.basename(uiRelPath) });
    await changedFilesItem.waitFor({ state: 'visible' });
    assert(await changedFilesItem.count() > 0, '3f. pending edit also appears in Changed Files list');

    await pendingCard.locator('button', { hasText: 'Review + Apply' }).click();

    await waitForCondition(async () => fs.existsSync(absPath), 10000, 'applied file on disk');
    const appliedMessage = page.locator('.assistant-message').filter({ hasText: `Applied:` }).filter({ hasText: path.basename(uiRelPath) }).last();
    await appliedMessage.waitFor({ state: 'visible' });
    const appliedText = await appliedMessage.textContent();
    assert(Boolean(appliedText), '4. Review + Apply click updates UI to applied state');
    assert(fs.existsSync(absPath), '4a. file exists on disk after Review + Apply');

    const diskContent = fs.readFileSync(absPath, 'utf8');
    assert(diskContent.includes('def sum_ab(a, b):'), '4b. disk content contains expected Python function');
    assert(diskContent.includes('return a + b'), '4c. disk content contains expected return expression');

    await waitForCondition(async () => (await changedFilesItem.count()) === 0, 10000, 'pending edit removed from Changed Files');
    assert((await changedFilesItem.count()) === 0, '4d. pending edit removed from Changed Files after apply');

    const pendingAfter = await requestJson(`${baseUrl}/api/pending_edits`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: {}
    });
    const edits = pendingAfter.json?.result || [];
    assert(Array.isArray(edits) && !edits.some((edit) => normalizeRelPath(edit.relPath) === uiRelPath), '4e. pending_edits API no longer lists the applied edit');

    removeIfExists(absPath);
    assert(!fs.existsSync(absPath), '5. proof file cleaned up after verification');
  } finally {
    removeIfExists(absPath);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}
  }

  process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const failure of failures) {
      console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
    }
    process.exitCode = 1;
  }
}

await main();
