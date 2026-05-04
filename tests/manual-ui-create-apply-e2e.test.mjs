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

function snapshotFile(targetPath) {
  if (!fs.existsSync(targetPath)) return { existed: false, content: '' };
  return { existed: true, content: fs.readFileSync(targetPath, 'utf8') };
}

function restoreFile(targetPath, snapshot) {
  if (snapshot?.existed) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, snapshot.content, 'utf8');
  } else {
    removeIfExists(targetPath);
  }
}

function buildWriteFixtureResponses(relPath, content, introText) {
  return [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: `tc_${path.basename(relPath).replace(/[^a-z0-9_]/gi, '_')}`,
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
    }
  ];
}

async function getPendingEdits(baseUrl) {
  const pending = await requestJson(`${baseUrl}/api/pending_edits`, {
    method: 'POST',
    headers: { 'X-Agent-Approved': 'true' },
    body: {}
  });
  return pending.json?.result || [];
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
    return Boolean(debugConsole && /ready\./i.test(debugConsole.textContent || ''));
  });
  await page.evaluate(() => {
    const hasSession = typeof currentSessionId !== 'undefined'
      && typeof sessions !== 'undefined'
      && currentSessionId
      && sessions[currentSessionId];
    if (!hasSession && typeof createNewSession === 'function') createNewSession();
  });
  await page.evaluate(async (nextAutoAccept) => {
    if (typeof window.setUIMode === 'function') {
      await window.setUIMode('ide', { persist: false });
    }
    const autoAccept = document.getElementById('auto-accept');
    if (autoAccept) autoAccept.checked = nextAutoAccept;
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
      console.error('sendMessage failed during test scenario:', error);
    });
    return true;
  }, prompt);
  await waitForCondition(async () => proxyChatSeen, 10000, '/proxy/chat request');
  const proxyResponse = await proxyResponsePromise;
  let proxyResponseJson = null;
  try {
    proxyResponseJson = await proxyResponse.json();
  } catch {}
  return { proxyChatSeen, proxyResponseStatus: proxyResponse.status(), proxyResponseJson };
}

async function verifyApplyFlow(page, baseUrl, relPath, absPath, contentChecks, labelPrefix) {
  const pendingEdits = await getPendingEdits(baseUrl);
  const pendingEdit = pendingEdits.find((edit) => normalizeRelPath(edit.relPath) === relPath) || pendingEdits[0];
  const uiRelPath = normalizeRelPath(pendingEdit?.relPath || relPath);
  assert(Boolean(pendingEdit?.id), `${labelPrefix} pending edit exists before apply`);

  const pendingCard = page.locator('.pending-edit-card').filter({ hasText: path.basename(uiRelPath) }).last();
  await pendingCard.waitFor({ state: 'visible' });
  const pendingText = await pendingCard.textContent() || '';
  assert(/Pending edit:/i.test(pendingText), `${labelPrefix} pending edit card visible`);
  assert(/proposed change only/i.test(pendingText), `${labelPrefix} pending edit remains proposed before apply`);
  assert(/Review \+ Apply/i.test(pendingText), `${labelPrefix} Review + Apply visible`);
  assert(!fs.existsSync(absPath), `${labelPrefix} file absent before apply`);

  await page.locator('#btn-tasks').click();
  const changedFilesItems = page.locator('#changed-files-list .file-item').filter({ hasText: path.basename(uiRelPath) });
  await changedFilesItems.first().waitFor({ state: 'visible' });
  assert(await changedFilesItems.count() > 0, `${labelPrefix} changed files list shows pending edit`);

  await pendingCard.locator('button', { hasText: 'Review + Apply' }).click();

  await waitForCondition(async () => fs.existsSync(absPath), 10000, 'applied file on disk');
  const appliedMessage = page.locator('.assistant-message').filter({ hasText: 'Applied:' }).filter({ hasText: path.basename(uiRelPath) }).last();
  await appliedMessage.waitFor({ state: 'visible' });
  assert(fs.existsSync(absPath), `${labelPrefix} file exists after apply`);

  const diskContent = fs.readFileSync(absPath, 'utf8');
  for (const expectedText of contentChecks) {
    assert(diskContent.includes(expectedText), `${labelPrefix} content contains ${expectedText}`);
  }

}

async function runUiScenario({
  fixtureName,
  prompt,
  relPath,
  content,
  introText,
  autoAccept,
  contentChecks,
  expectApprovalModal = false
}) {
  const absPath = path.join(APP_DIR, ...relPath.split('/'));
  const snapshot = snapshotFile(absPath);
  const fixturePath = writeFixtureFile(fixtureName, buildWriteFixtureResponses(relPath, content, introText));
  let server = null;
  let browser = null;
  let context = null;
  let page = null;

  try {
    removeIfExists(absPath);
    const port = 3860 + Math.floor(Math.random() * 400);
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
    const autoAcceptChecked = await page.locator('#auto-accept').isChecked();
    assert(autoAcceptChecked === autoAccept, `${fixtureName} Auto-Accept state set`, `checked=${autoAcceptChecked}`);

    const submit = await submitPrompt(page, prompt);
    assert(submit.proxyChatSeen, `${fixtureName} prompt submitted through UI chat path`);
    assert(submit.proxyResponseStatus === 200, `${fixtureName} /proxy/chat returned 200`, `status=${submit.proxyResponseStatus}`);

    const userMessage = page.locator('.user-message').filter({ hasText: prompt });
    await userMessage.waitFor({ state: 'visible' });
    assert(await userMessage.count() > 0, `${fixtureName} user prompt visible in transcript`);

    const finalAssistantContent = String(submit.proxyResponseJson?.choices?.[0]?.message?.content || '');

    if (expectApprovalModal) {
      await page.waitForSelector('#modal-overlay.active', { state: 'visible' });
      const modalText = await page.locator('#modal-overlay').textContent() || '';
      assert(/Write Approval Required/i.test(modalText), `${fixtureName} approval-required modal visible`);
      assert(modalText.includes(relPath), `${fixtureName} approval modal references target path`);
      assert(!/không có lệnh write_file nào chạy thành công/i.test(finalAssistantContent), `${fixtureName} misleading chatbot fallback removed`);
      assert(/approve/i.test(finalAssistantContent), `${fixtureName} final assistant message asks for approval`);
      assert(!fs.existsSync(absPath), `${fixtureName} file absent before approval`);
      const beforeApprovalEdits = await getPendingEdits(baseUrl);
      assert(Array.isArray(beforeApprovalEdits) && !beforeApprovalEdits.some((edit) => normalizeRelPath(edit.relPath) === relPath), `${fixtureName} no pending edit exists before approval`);
      await page.locator('#btn-allow').click();
      await waitForCondition(async () => {
        const edits = await getPendingEdits(baseUrl);
        return edits.some((edit) => normalizeRelPath(edit.relPath) === relPath);
      }, 20000, 'pending edit after approval');
      assert(!fs.existsSync(absPath), `${fixtureName} file still absent after approval but before apply`);
    } else {
      await waitForCondition(async () => {
        const edits = await getPendingEdits(baseUrl);
        return edits.some((edit) => normalizeRelPath(edit.relPath) === relPath);
      }, 20000, 'pending edit from UI chat');
      assert(!(await page.locator('#modal-overlay.active').isVisible().catch(() => false)), `${fixtureName} no approval modal interrupted Auto-Accept flow`);
      assert(!fs.existsSync(absPath), `${fixtureName} file absent before apply`);
    }

    await verifyApplyFlow(page, baseUrl, relPath, absPath, contentChecks, fixtureName);
  } finally {
    restoreFile(absPath, snapshot);
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    try { fs.unlinkSync(fixturePath); } catch {}
  }
}

async function main() {
  await runUiScenario({
    fixtureName: 'manual-ui-auto-accept-off-docs',
    prompt: 'Tạo file docs/fix-proposal.md với nội dung markdown',
    relPath: 'docs/fix-proposal.md',
    content: '# Fix Proposal\n\n- Diagnose the approval flow.\n',
    introText: 'Tôi sẽ chuẩn bị nội dung markdown cho file đó.',
    autoAccept: false,
    contentChecks: ['# Fix Proposal', 'Diagnose the approval flow.'],
    expectApprovalModal: true
  });

  await runUiScenario({
    fixtureName: 'manual-ui-auto-accept-on-docs',
    prompt: 'Tạo file docs/fix-proposal.md với nội dung markdown',
    relPath: 'docs/fix-proposal.md',
    content: '# Fix Proposal\n\n- Diagnose the approval flow.\n',
    introText: 'Tôi sẽ chuẩn bị nội dung markdown cho file đó.',
    autoAccept: true,
    contentChecks: ['# Fix Proposal', 'Diagnose the approval flow.']
  });

  await runUiScenario({
    fixtureName: 'manual-ui-vietnamese-sum-ab',
    prompt: 'viết cho tôi chương trình tính tổng 2 số A+B và đóng gói nó thành một file',
    relPath: 'proof/sum_ab.py',
    content: 'def sum_ab(a, b):\n    return a + b\n',
    introText: 'Đây là mã Python cho chương trình cộng hai số A + B.',
    autoAccept: true,
    contentChecks: ['def sum_ab(a, b):', 'return a + b']
  });

  process.stdout.write(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const failure of failures) {
      console.error(`- ${failure.test}${failure.detail ? `: ${failure.detail}` : ''}`);
    }
    process.exitCode = 1;
  }
}

await main();
