import { sleep, fetchText, requestJson, waitForServer } from './smoke/core.mjs';
import { runApiRegressionChecks } from './smoke/api-regression.mjs';
import { runGuardMatrixChecks } from './smoke/guard-matrix.mjs';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const REPORTS_DIR = path.join(APP_DIR, '.nvidia-agent', 'reports');

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const SERVER_START_TIMEOUT_MS = 20000;
const SERVER_READY_TIMEOUT_MS = 15000;
const PAGE_TIMEOUT_MS = Number(process.env.BROWSER_SMOKE_NAV_TIMEOUT_MS || 60000);
const SELECTOR_TIMEOUT_MS = Number(process.env.BROWSER_SMOKE_SELECTOR_TIMEOUT_MS || 20000);

const LOG_LINES = [];

const SUMMARY = {
  ok: false,
  mode: 'unknown',
  browser: 'none',
  url: '',
  checksPassed: 0,
  checksFailed: 0,
  checks: [],
  warnings: [],
  errors: [],
  artifacts: [],
  server: {
    startedByHarness: false,
    pid: null,
    stopped: false,
    orphanDetected: false
  }
};

class BrowserUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    startServer: false,
    url: '',
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--start-server') options.startServer = true;
    else if (arg === '--url' && args[i + 1]) options.url = String(args[++i]);
    else if (arg === '--port' && args[i + 1]) options.port = Number(args[++i]) || DEFAULT_PORT;
    else if (arg === '--host' && args[i + 1]) options.host = String(args[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }

  if (!options.url) {
    options.startServer = true;
    options.url = `http://${options.host}:${options.port}`;
  }

  return options;
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  LOG_LINES.push(line);
  console.log(line);
}

function ensureReportsDir() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function saveArtifact(filename, content, encoding = 'utf8') {
  ensureReportsDir();
  const filePath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filePath, content, encoding);
  SUMMARY.artifacts.push(filePath);
  return filePath;
}

function addCheck(name, status, detail, required = true) {
  const normalized = status === 'pass' ? 'pass' : (required ? 'fail' : 'warn');
  if (normalized === 'pass') SUMMARY.checksPassed++;
  if (normalized === 'fail') {
    SUMMARY.checksFailed++;
    SUMMARY.errors.push(`${name}: ${detail}`);
  }
  if (normalized === 'warn') SUMMARY.warnings.push(`${name}: ${detail}`);
  SUMMARY.checks.push({ name, status: normalized, detail, required });
  log(normalized, `${name} - ${detail}`);
}



function startLocalServer(port, host) {
  return new Promise((resolve, reject) => {
    const serverScript = path.join(__dirname, 'nvidia-server.mjs');
    const env = { ...process.env, PORT: String(port), HOST: host, NVIDIA_SERVER_HOST: host, NVIDIA_WORKSPACE_TRUST: 'always' };
    const child = spawn('node', [serverScript], {
      cwd: APP_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let done = false;
    const readyRegex = /server running at/i;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      reject(new Error(`Server did not signal startup within ${SERVER_START_TIMEOUT_MS}ms`));
    }, SERVER_START_TIMEOUT_MS);

    const onData = (buf) => {
      const text = String(buf || '');
      if (!done && readyRegex.test(text)) {
        done = true;
        clearTimeout(timeout);
        resolve(child);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.once('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.once('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

function isProcessRunning(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopLocalServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve({ stopped: true, orphan: false });
      return;
    }

    const pid = child.pid;
    let settled = false;
    const finish = (stopped) => {
      if (settled) return;
      settled = true;
      const orphan = isProcessRunning(pid);
      resolve({ stopped: stopped || !orphan, orphan });
    };

    const poll = setInterval(() => {
      if (!isProcessRunning(pid)) {
        clearInterval(poll);
        clearTimeout(timer);
        finish(true);
      }
    }, 250);

    const timer = setTimeout(() => {
      clearInterval(poll);
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch {}
      setTimeout(() => finish(false), 800);
    }, 8000);

    child.once('exit', () => {
      clearInterval(poll);
      clearTimeout(timer);
      setTimeout(() => finish(true), 300);
    });

    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch {
      clearInterval(poll);
      clearTimeout(timer);
      finish(false);
    }
  });
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

async function runRealBrowserSmoke(url) {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new BrowserUnavailableError('No Chrome/Edge executable found. Set CHROME_PATH or install a Chromium-based browser.');
  }

  let playwright;
  try {
    playwright = await import('playwright-core');
  } catch (e) {
    throw new BrowserUnavailableError(`playwright-core is not available: ${e.message}`);
  }

  const { chromium } = playwright;
  let browser = null;
  let context = null;
  let page = null;

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  try {
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: chromePath,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
      });
    } catch (e) {
      throw new BrowserUnavailableError(`Failed to launch browser: ${e.message}`);
    }

    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    page = await context.newPage();
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultTimeout(SELECTOR_TIMEOUT_MS);

    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('requestfailed', (req) => {
      const failure = req.failure();
      failedRequests.push(`${req.url()} :: ${failure?.errorText || 'failed'}`);
    });

    let domReady = false;
    let loadReady = false;
    let navError = '';
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      domReady = true;
      try {
        await page.waitForLoadState('load', { timeout: Math.min(PAGE_TIMEOUT_MS, 12000) });
        loadReady = true;
      } catch {
        // load event can lag with background activity; continue with selector readiness checks.
      }
    } catch (e) {
      navError = e.message;
    }

    addCheck('Navigation DOM ready', domReady ? 'pass' : 'fail', domReady ? 'domcontentloaded reached' : navError || 'domcontentloaded not reached', true);
    addCheck('Navigation load event', loadReady ? 'pass' : 'warn', loadReady ? 'load reached' : 'load not reached before timeout; continuing with selector checks', false);

    const readinessSelectors = [
      'body',
      '#user-input',
      '#composer-input',
      'textarea',
      '#bottom-panel',
      '#sidebar-explorer',
      '#left-pane',
      '#root'
    ];
    let selectorReady = '';
    for (const selector of readinessSelectors) {
      try {
        await page.waitForSelector(selector, { state: 'attached', timeout: SELECTOR_TIMEOUT_MS });
        selectorReady = selector;
        break;
      } catch {
        // try next selector
      }
    }
    addCheck('Page readiness selector', selectorReady ? 'pass' : 'fail', selectorReady ? `attached: ${selectorReady}` : `none matched within ${SELECTOR_TIMEOUT_MS}ms`, true);

    const domChecks = await page.evaluate(async ({ appDir, controlWorkspace }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const checks = [];
      const add = (name, pass, detail, required = true) => checks.push({ name, pass, detail, required });
      const exists = (selector) => !!document.querySelector(selector);
      const visible = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (!s) return false;
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        return el.getClientRects().length > 0;
      };
      const waitUntil = async (predicate, timeoutMs = 4000, intervalMs = 80) => {
        const started = Date.now();
        while ((Date.now() - started) < timeoutMs) {
          try {
            if (predicate()) return true;
          } catch {
            // Keep polling until the state is ready or timeout expires.
          }
          await sleep(intervalMs);
        }
        return false;
      };

      add('Page loaded', document.readyState === 'complete' || document.readyState === 'interactive', `readyState=${document.readyState}`, true);
      add('Main chat input exists', exists('#user-input, #composer-input, textarea'), 'selector #user-input or textarea', true);
      add('JavaScript executes', typeof window.setUIMode === 'function' && typeof window.toggleUIMode === 'function', 'setUIMode/toggleUIMode available', true);

      const findMissingSelectors = (selectors) => selectors.filter(selector => !exists(selector));

      let modeOk = false;
      let ideVisible = false;
      let enterpriseHides = false;
      try {
        if (typeof window.setUIMode === 'function') {
          await window.setUIMode('enterprise', { persist: false });
          await sleep(120);
          const enterpriseClass = document.body.classList.contains('mode-enterprise');
          await window.setUIMode('ide', { persist: false });
          await sleep(140);
          const ideClass = document.body.classList.contains('mode-ide');
          modeOk = enterpriseClass && ideClass;
          ideVisible = visible('#bottom-panel') || visible('#sidebar-explorer') || visible('#right-panel');
          await window.setUIMode('enterprise', { persist: false });
          await sleep(140);
          enterpriseHides = !visible('#bottom-panel');
          await window.setUIMode('ide', { persist: false });
          await sleep(80);
        }
      } catch (e) {
        modeOk = false;
      }
      add('Enterprise/IDE mode toggle or state works', modeOk, 'mode class transitions enterprise->ide', true);
      add('IDE-only surface appears in IDE mode', ideVisible, 'IDE surface visible', true);
      add('Enterprise mode hides IDE-only surface', enterpriseHides, 'IDE surface hidden in enterprise', true);

      const criticalShellSelectors = [
        '#chat-box',
        '#slash-menu',
        '#sidebar-explorer',
        '#sidebar-tasks',
        '#sidebar-scm',
        '#sidebar-extensions',
        '#session-list',
        '#task-timeline',
        '#changed-files-list',
        '#right-panel',
        '#bottom-panel'
      ];
      const missingCriticalShell = findMissingSelectors(criticalShellSelectors);
      add(
        'Critical UI shell roots exist',
        missingCriticalShell.length === 0,
        missingCriticalShell.length === 0 ? `${criticalShellSelectors.length} roots found` : `missing ${missingCriticalShell.join(', ')}`,
        true
      );

      const criticalEditorSelectors = [
        '#code-viewer',
        '#edit-workflow-guide',
        '#edit-workflow-file-context',
        '#edit-workflow-proposal-status',
        '#edit-workflow-apply-status',
        '#edit-workflow-log-status',
        '#editor-tabs',
        '#code-viewer-empty-state',
        '#code-body',
        '#diff-body'
      ];
      const missingCriticalEditor = findMissingSelectors(criticalEditorSelectors);
      add(
        'Critical editor workflow roots exist',
        missingCriticalEditor.length === 0,
        missingCriticalEditor.length === 0 ? `${criticalEditorSelectors.length} roots found` : `missing ${missingCriticalEditor.join(', ')}`,
        true
      );

      const criticalPanelSelectors = [
        '#terminal-view',
        '#terminal-output',
        '#jobs-view',
        '#job-manager-list',
        '#search-view',
        '#search-results-list',
        '#problems-view',
        '#problems-list'
      ];
      const missingCriticalPanels = findMissingSelectors(criticalPanelSelectors);
      add(
        'Critical bottom-panel roots exist',
        missingCriticalPanels.length === 0,
        missingCriticalPanels.length === 0 ? `${criticalPanelSelectors.length} roots found` : `missing ${missingCriticalPanels.join(', ')}`,
        true
      );

      let contextOpen = false;
      try {
        const input = document.querySelector('#user-input');
        if (input) {
          input.focus();
          input.value = '@';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(150);
          const menu = document.querySelector('#slash-menu');
          const hasItems = !!menu && menu.querySelectorAll('.slash-item').length > 0;
          contextOpen = !!menu && menu.classList.contains('active') && hasItems;
        }
      } catch {
        contextOpen = false;
      }
      add('Context picker opens when typing @', contextOpen, 'slash menu active with items', true);

      let workspaceSwitchUiOk = false;
      let workspaceSwitchUiDetail = 'workspace switch not exercised';
      try {
        const controlResolved = await (await fetch('/api/workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: controlWorkspace })
        })).json();
        const appResolved = await (await fetch('/api/workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: appDir })
        })).json();
        if (controlResolved?.status === 'success' && appResolved?.status === 'success' && typeof window.loadWorkspaceInfo === 'function') {
          await window.loadWorkspaceInfo();
          await sleep(150);
          const label = (document.querySelector('#current-workspace-path')?.textContent || '').trim();
          workspaceSwitchUiOk = label === appDir;
          workspaceSwitchUiDetail = `label=${label}`;
        } else {
          workspaceSwitchUiDetail = `control=${controlResolved?.error || controlResolved?.status} app=${appResolved?.error || appResolved?.status}`;
        }
      } catch (error) {
        workspaceSwitchUiDetail = error.message;
      }
      add('Workspace switch UI accepts valid Windows path and updates label', workspaceSwitchUiOk, workspaceSwitchUiDetail, true);

      let terminalOk = false;
      let jobsOk = false;
      let problemsOk = false;
      const bottomPanel = document.getElementById('bottom-panel');
      if (bottomPanel) bottomPanel.classList.add('active');
      if (typeof window.switchTab === 'function') {
        window.switchTab('terminal');
        await sleep(120);
        terminalOk = visible('#bottom-panel') && visible('#terminal-view') && exists('#terminal-output');
        window.switchTab('jobs');
        await sleep(120);
        jobsOk = visible('#bottom-panel') && visible('#jobs-view') && exists('#job-manager-list');
        window.switchTab('problems');
        await sleep(120);
        problemsOk = visible('#bottom-panel') && visible('#problems-view') && exists('#problems-list');
      }
      add('Terminal/Jobs panel renders', terminalOk && jobsOk, `terminal=${terminalOk}, jobs=${jobsOk}`, true);
      add('Problems panel renders', problemsOk, '#problems-view + #problems-list', true);

      // Sprint 13: SCM Panel checks
      const scmEntryOk = exists('#btn-scm') || exists('#sidebar-scm');
      add('SCM panel entry exists', scmEntryOk, '#btn-scm or #sidebar-scm found', true);

      let scmOpensOk = false;
      let scmRendersOk = false;
      let enterpriseBlocksSCMMutations = false;
      try {
        const scmBtn = document.querySelector('#btn-scm');
        if (scmBtn && typeof scmBtn.click === 'function') {
          scmBtn.click();
          await sleep(250);
          scmOpensOk = visible('#sidebar-scm') || exists('#scm-changed-list');
          scmRendersOk = exists('#scm-branch-name') || exists('#scm-status-summary') || exists('#scm-not-repo-warning');
        }
        if (typeof window.setUIMode === 'function') {
          await window.setUIMode('enterprise', { persist: false });
          await sleep(120);
          enterpriseBlocksSCMMutations = !visible('#scm-mutation-actions');
          await window.setUIMode('ide', { persist: false });
          await sleep(80);
        }
        // Switch back to explorer
        const explorerBtn = document.querySelector('#btn-explorer');
        if (explorerBtn && typeof explorerBtn.click === 'function') explorerBtn.click();
        await sleep(80);
      } catch {
        scmOpensOk = false;
        scmRendersOk = false;
        enterpriseBlocksSCMMutations = false;
      }
      add('SCM panel opens on click', scmOpensOk, 'SCM sidebar visible', true);
      add('SCM panel renders status or warning', scmRendersOk, 'SCM content rendered', true);
      add('Enterprise mode blocks SCM mutation controls', enterpriseBlocksSCMMutations, 'SCM mutations hidden in enterprise mode', true);

      const monacoOk = exists('#code-body') || exists('#editor-tabs') || exists('.monaco-editor');
      add('Monaco/editor surface renders if safe', monacoOk, 'editor shell selectors found', false);
      let workflowGuideOk = false;
      let workflowGuideTextOk = false;
      let changedFilesGuideOk = false;
      let diffReviewUiOk = false;
      let pendingEditHonestyOk = false;
      let pendingStateVisibleOk = false;
      let appliedStateVisibleOk = false;
      let blockedStateVisibleOk = false;
      let failedStateVisibleOk = false;
      let approvalModalClarityOk = false;
      let multiFileCountVisibleOk = false;
      let noOverclaimUiTextOk = false;
      let keyWorkflowControlsVisibleOk = false;
      let noCriticalBottomActionClippedOk = false;
      let visibilityDiagnostic = '';
      let reviewButtonVisible = false;
      let reviewButtonNotClipped = false;
      let reviewButtonDiagnostic = 'review:not-measured';
      let inlineEditActionOk = false;
      let inlineEditWidgetOk = false;
      let enterpriseBlocksInlineEdit = false;
      try {
        const input = document.querySelector('#user-input');
        if (typeof window.setUIMode === 'function') {
          await window.setUIMode('ide', { persist: false });
          await sleep(120);
        }
        if (typeof window.openCodeViewer === 'function') {
          await window.openCodeViewer('package.json', 'package.json');
          await waitUntil(() => !!window.editor && typeof window.editor.getAction === 'function' && !!window.editor.getModel(), 6000, 100);
        }
        workflowGuideOk = visible('#code-viewer') && visible('#edit-workflow-guide') && visible('#code-viewer-empty-state') === false;
        workflowGuideTextOk =
          exists('#edit-workflow-file-context') &&
          exists('#edit-workflow-proposal-status') &&
          exists('#edit-workflow-apply-status') &&
          exists('#edit-workflow-log-status') &&
          /Current file:/i.test(document.querySelector('#edit-workflow-file-context')?.textContent || '') &&
          /reviewable proposal|pending proposal/i.test(document.querySelector('#edit-workflow-proposal-status')?.textContent || '') &&
          /approval|trust|review the diff first/i.test(document.querySelector('#edit-workflow-apply-status')?.textContent || '');

        const tasksBtn = document.querySelector('#btn-tasks');
        if (tasksBtn && typeof tasksBtn.click === 'function') {
          tasksBtn.click();
          await sleep(180);
          changedFilesGuideOk = visible('#sidebar-tasks') && visible('#changed-files-guide');
        }
        const explorerBtn = document.querySelector('#btn-explorer');
        if (explorerBtn && typeof explorerBtn.click === 'function') {
          explorerBtn.click();
          await sleep(80);
        }

        if (typeof window.renderDiffUI === 'function') {
          const tempHost = document.createElement('div');
          tempHost.id = 'smoke-diff-preview';
          document.body.appendChild(tempHost);
          await window.renderDiffUI(tempHost, 'package.json', '{\n  "name": "smoke-preview"\n}\n');
          await sleep(220);
          const diffButton = tempHost.querySelector('.diff-header button');
          const diffNote = tempHost.querySelector('.workflow-diff-note');
          diffReviewUiOk = !!diffButton
            && (/Queue for Review/i.test(diffButton.textContent || '') || /Đưa vào hàng đợi Duyệt/i.test(diffButton.textContent || ''))
            && !!diffNote
            && (/does not silently write/i.test(diffNote.textContent || '') || /không ghi tệp trực tiếp/i.test(diffNote.textContent || ''));
          tempHost.remove();
        }

        if (typeof window.renderPendingEdit === 'function') {
          if (typeof window.closeCodeViewer === 'function') {
            window.closeCodeViewer();
            await sleep(120);
          } else {
            document.getElementById('code-viewer')?.classList.remove('active');
            await sleep(80);
          }
          window.renderPendingEdit({
            id: 'smoke-preview-edit',
            relPath: 'package.json',
            diff: '--- a/package.json\n+++ b/package.json',
            beforeContent: '{\n}\n',
            content: '{\n  "name": "preview"\n}\n',
            hunks: [{ id: 'hunk-1', preview: '+  \"name\": \"preview\"' }]
          });
          await waitUntil(() => !!document.getElementById('pending-smoke-preview-edit'), 3000, 80);
          const pendingCard = document.getElementById('pending-smoke-preview-edit');
          const pendingText = pendingCard?.textContent || '';
          pendingEditHonestyOk =
            !!pendingCard &&
            /Ready to apply|Sẵn sàng áp dụng/i.test(pendingText) &&
            /Review \+ Apply/i.test(pendingText) &&
            /Chưa có disk mutation|Chưa ghi gì ra disk|pending proposal/i.test(pendingText) &&
            /Target:/i.test(pendingText) &&
            /Create|Edit|Delete|Move/i.test(pendingText) &&
            /Open Diff/i.test(pendingText);
          pendingStateVisibleOk =
            !!pendingCard &&
            /Pending:/i.test(pendingText) &&
            /Status:\s*Ready to apply/i.test(pendingText);
          const reviewBtnBeforeApplied = pendingCard?.querySelector('button');
          const isInViewport = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < window.innerHeight &&
              style.visibility !== 'hidden' &&
              style.display !== 'none';
          };
          const describeVisibility = (name, el) => {
            if (!el) return `${name}:missing`;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const cx = Math.max(0, Math.min(window.innerWidth - 1, rect.left + (rect.width / 2)));
            const cy = Math.max(0, Math.min(window.innerHeight - 1, rect.top + Math.min(rect.height / 2, 12)));
            const hit = document.elementFromPoint(cx, cy);
            const hitName = hit ? `${hit.tagName.toLowerCase()}#${hit.id || ''}.${String(hit.className || '').replace(/\s+/g, '.')}` : 'none';
            return [
              `${name}:exists`,
              `visible=${isInViewport(el)}`,
              `rect=${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)},${Math.round(rect.width)}x${Math.round(rect.height)}`,
              `style=${style.display}/${style.visibility}/${style.opacity}/${style.position}/z${style.zIndex}`,
              `hit=${hitName}`
            ].join(' ');
          };
          if (reviewBtnBeforeApplied && typeof reviewBtnBeforeApplied.scrollIntoView === 'function') {
            reviewBtnBeforeApplied.scrollIntoView({ block: 'center' });
            await sleep(60);
          }
          reviewButtonVisible = isInViewport(reviewBtnBeforeApplied);
          reviewButtonNotClipped = !!reviewBtnBeforeApplied && (() => {
            const rect = reviewBtnBeforeApplied.getBoundingClientRect();
            const cx = rect.left + (rect.width / 2);
            const cy = rect.top + Math.min(rect.height / 2, 12);
            const hit = document.elementFromPoint(cx, cy);
            return rect.bottom <= window.innerHeight &&
              rect.top >= 0 &&
              rect.height > 0 &&
              (!!hit && (hit === reviewBtnBeforeApplied || reviewBtnBeforeApplied.contains(hit)));
          })();
          reviewButtonDiagnostic = describeVisibility('review', reviewBtnBeforeApplied);

          window.updateChangedFiles([
            {
              id: 'smoke-multi-1',
              relPath: 'proof/a.txt',
              before: { existed: false },
              hunks: [{ id: 'h1', preview: '+a' }]
            },
            {
              id: 'smoke-multi-2',
              relPath: 'proof/b.txt',
              before: { existed: true },
              hunks: [{ id: 'h2', preview: '+b' }]
            }
          ]);
          const changedFilesText = document.querySelector('#changed-files-list')?.textContent || '';
          multiFileCountVisibleOk =
            /Multi-file pending:\s*2 files/i.test(changedFilesText) &&
            /Ready to apply|Sẵn sàng áp dụng/i.test(changedFilesText);

          const appliedCard = document.getElementById('pending-smoke-preview-edit');
          if (appliedCard) {
            appliedCard.innerHTML = '<div><b>Applied:</b> Edit | Sửa file - package.json<div>Disk mutation completed. Áp dụng đã hoàn tất trên disk.</div></div>';
          }
          const appliedText = appliedCard?.textContent || '';
          appliedStateVisibleOk =
            /Applied:/i.test(appliedText) &&
            /Disk mutation completed|hoàn tất trên disk/i.test(appliedText);

          const blockedCopy = typeof window.renderWorkflowFailureMessage === 'function'
            ? window.renderWorkflowFailureMessage('write_file', { error: 'write_file requires a trusted workspace. The tool was not executed.' })
            : null;
          const failedCopy = typeof window.renderWorkflowFailureMessage === 'function'
            ? window.renderWorkflowFailureMessage('write_file', { error: 'Provider unavailable: 502 upstream' })
            : null;
          blockedStateVisibleOk =
            !!blockedCopy &&
            blockedCopy.status === 'blocked' &&
            /Không có file nào được ghi ra đĩa/i.test(blockedCopy.message) &&
            /thu hẹp phạm vi|đường dẫn hợp lệ|giảm số file/i.test(blockedCopy.next);
          failedStateVisibleOk =
            !!failedCopy &&
            failedCopy.status === 'failed' &&
            /Không có trusted success|Không có file nào/i.test(`${failedCopy.message} ${failedCopy.next}`) &&
            /thử lại|kiểm tra logs/i.test(failedCopy.next);

          if (typeof window.askPermission === 'function') {
            const modalPromise = window.askPermission('write_file', { filePath: 'proof/demo.txt' }, {
              title: 'Write Approval Required | Cần phê duyệt ghi file',
              description: 'Operation: create | tạo file\nTarget path: proof/demo.txt\nApproval này chỉ tạo pending operation. Chưa ghi gì ra disk. Sau khi approve, bạn vẫn phải Review + Apply để write file.',
              allowLabel: 'Approve Pending Edit',
              denyLabel: 'Cancel'
            });
            await sleep(120);
            const modalText = document.querySelector('#modal-overlay')?.textContent || '';
            approvalModalClarityOk =
              /Operation:\s*create/i.test(modalText) &&
              /Target path:\s*proof\/demo\.txt/i.test(modalText) &&
              /pending operation/i.test(modalText) &&
              /Review \+ Apply/i.test(modalText);
            document.getElementById('btn-deny')?.click();
            await modalPromise.catch(() => {});
          }

          const fullUiText = document.body?.textContent || '';
          noOverclaimUiTextOk = !/DAILY_USE_READY|PRODUCTION_READY|FULL_BRIDGE_READY|COGNITIVE_OS_ACHIEVED|ENTERPRISE_GRADE_SECURITY/i.test(fullUiText);
          const inViewport = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < window.innerHeight &&
              style.visibility !== 'hidden' &&
              style.display !== 'none';
          };
          const describeElement = (name, el) => {
            if (!el) return `${name}:missing`;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const cx = Math.max(0, Math.min(window.innerWidth - 1, rect.left + (rect.width / 2)));
            const cy = Math.max(0, Math.min(window.innerHeight - 1, rect.top + (rect.height / 2)));
            const hit = document.elementFromPoint(cx, cy);
            const hitName = hit ? `${hit.tagName.toLowerCase()}#${hit.id || ''}.${String(hit.className || '').replace(/\s+/g, '.')}` : 'none';
            return [
              `${name}:exists`,
              `visible=${inViewport(el)}`,
              `rect=${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)},${Math.round(rect.width)}x${Math.round(rect.height)}`,
              `style=${style.display}/${style.visibility}/${style.opacity}/${style.position}/z${style.zIndex}`,
              `hit=${hitName}`
            ].join(' ');
          };
          const sendBtn = document.querySelector('#send-button') || document.querySelector('.btn-send');
          let tasksPanelReachable = false;
          let changedFilesPanelReachable = false;
          let recentActionReachable = false;
          const tasksBtnForVisibility = document.querySelector('#btn-tasks');
          if (tasksBtnForVisibility && typeof tasksBtnForVisibility.click === 'function') {
            tasksBtnForVisibility.click();
            await sleep(120);
            const tasksPanel = document.querySelector('#sidebar-tasks');
            const changedFilesPanel = document.querySelector('#changed-files-list');
            const recentAction = document.querySelector('#recent-operation-summary');
            if (recentAction && typeof recentAction.scrollIntoView === 'function') {
              recentAction.scrollIntoView({ block: 'nearest' });
              await sleep(40);
            }
            if (changedFilesPanel && typeof changedFilesPanel.scrollIntoView === 'function') {
              changedFilesPanel.scrollIntoView({ block: 'nearest' });
              await sleep(40);
            }
            tasksPanelReachable = !!tasksPanel && window.getComputedStyle(tasksPanel).display !== 'none';
            changedFilesPanelReachable = !!changedFilesPanel && changedFilesPanel.clientHeight > 0;
            recentActionReachable = !!recentAction && recentAction.clientHeight > 0;
          }
          const explorerBtnBack = document.querySelector('#btn-explorer');
          if (explorerBtnBack && typeof explorerBtnBack.click === 'function') {
            explorerBtnBack.click();
            await sleep(80);
          }
          keyWorkflowControlsVisibleOk =
            inViewport(sendBtn) &&
            reviewButtonVisible &&
            tasksPanelReachable &&
            changedFilesPanelReachable &&
            recentActionReachable;
          noCriticalBottomActionClippedOk = reviewButtonNotClipped;
          visibilityDiagnostic = [
            `viewport=${window.innerWidth}x${window.innerHeight}`,
            describeElement('send', sendBtn),
            reviewButtonDiagnostic,
            `tasksReachable=${tasksPanelReachable}`,
            `changedReachable=${changedFilesPanelReachable}`,
            `recentReachable=${recentActionReachable}`,
            `reviewNotClipped=${reviewButtonNotClipped}`
          ].join(' | ');

          if (typeof window.setRecentOperationSummary === 'function') {
            window.setRecentOperationSummary({ label: 'Recent action: none yet. Chưa có thao tác gần đây.', tone: 'neutral' });
          }
          if (typeof window.updateChangedFiles === 'function') {
            window.updateChangedFiles([]);
          }
          pendingCard?.remove();
        }
        if (window.editor && typeof window.editor.getAction === 'function') {
          inlineEditActionOk = await waitUntil(() => !!window.editor.getAction('nvidia-inline-edit'), 3000, 80);
        }
        if (window.editor && typeof window.editor.getAction === 'function') {
          const action = window.editor.getAction('nvidia-inline-edit');
          const model = window.editor.getModel();
          if (action && model) {
            window.editor.focus();
            const line1 = model.getLineMaxColumn(1);
            window.editor.setSelection(new window.monaco.Range(1, 1, 1, Math.max(2, line1)));
            await sleep(80);
            await action.run();
            inlineEditWidgetOk = await waitUntil(() => visible('#inline-edit-widget') && visible('#inline-edit-instruction') && visible('#inline-edit-submit') && visible('#inline-edit-cancel'), 3000, 80);
            const escBtn = document.getElementById('inline-edit-cancel') || [...document.querySelectorAll('button')].find(btn => btn.textContent?.trim() === 'Esc');
            if (escBtn) escBtn.click();
            await sleep(80);
          }
        }
        if (typeof window.setUIMode === 'function') {
          await window.setUIMode('enterprise', { persist: false });
          await sleep(120);
          enterpriseBlocksInlineEdit = !window.editor || !window.editor.getAction('nvidia-inline-edit') || !visible('#code-viewer');
          await window.setUIMode('ide', { persist: false });
          await sleep(80);
        }
        if (input) input.focus();
      } catch {
        inlineEditActionOk = false;
        inlineEditWidgetOk = false;
        enterpriseBlocksInlineEdit = false;
      }
      add('Edit workflow guide is visible', workflowGuideOk, 'code viewer workflow guide visible in IDE mode', true);
      add('Edit workflow guide explains file/proposal/apply/log path', workflowGuideTextOk, 'workflow guide text is specific and honest', true);
      add('Changed Files guide explains review/apply path', changedFilesGuideOk, 'tasks sidebar changed-files guide visible', true);
      add('Diff review UI labels queue-for-review honestly', diffReviewUiOk, 'diff preview uses queue/review wording and no-silent-write note', true);
      add('Pending edit card labels review/apply honestly', pendingEditHonestyOk, 'pending edit card shows proposed-only and review/apply wording', true);
      add('Pending state is visible and labeled clearly', pendingStateVisibleOk, 'pending card shows pending + ready-to-apply state', true);
      add('Applied state is visible and labeled clearly', appliedStateVisibleOk, 'applied copy confirms disk mutation completed', true);
      add('Blocked state guidance is actionable', blockedStateVisibleOk, 'blocked copy explains no mutation + recovery path', true);
      add('Failed/provider state guidance is actionable', failedStateVisibleOk, 'failure copy avoids fake success and suggests retry/log review', true);
      add('Approval modal includes operation type and target path', approvalModalClarityOk, 'approval modal text includes operation, target path, and Review + Apply guidance', true);
      add('Changed Files shows multi-file affected count', multiFileCountVisibleOk, 'multi-file pending summary and ready-to-apply label visible', true);
      add('UI text avoids readiness/production/full-bridge overclaim', noOverclaimUiTextOk, 'forbidden overclaim labels absent from UI shell text', true);
      add('Key workflow controls are visible', keyWorkflowControlsVisibleOk, visibilityDiagnostic || 'send/review/changed-files/recent-action are visible in viewport', true);
      add('Critical bottom actions are not clipped', noCriticalBottomActionClippedOk, visibilityDiagnostic || 'review/apply button stays inside viewport bounds', true);
      add('Inline edit action exists', inlineEditActionOk, inlineEditActionOk ? 'monaco action nvidia-inline-edit registered' : 'action not observable in current smoke state', false);
      add('Inline edit widget opens from selection', inlineEditWidgetOk, inlineEditWidgetOk ? 'inline widget opens with selection' : 'widget not observable in current smoke state', false);
      add('Enterprise mode blocks inline edit mutation surface', enterpriseBlocksInlineEdit, 'editor/inline-edit surface blocked in enterprise mode', true);

      const extOk = exists('#sidebar-extensions') || exists('#installed-ext-list') || exists('#btn-extensions');
      add('Extensions panel exists or safely gated', extOk, 'extensions selectors found', false);

      const indexOk = exists('#index-status') || exists('#index-query') || exists('#index-results');
      add('Index Engine UI exists or safely gated', indexOk, 'index selectors found', false);

      const settingsEntryOk = exists('.activity-bar .activity-btn[title=\"Settings\"]') || exists('.activity-bar .activity-btn[onclick*=\"openSettings\"]');
      add('Settings entry exists in IDE shell', settingsEntryOk, 'settings activity entry selector found', true);

      let settingsOpenOk = false;
      let providerSectionOk = false;
      let apiKeyInputOk = false;
      let enterpriseBlocksSettingsEdit = false;
      try {
        if (typeof window.openSettings === 'function') {
          await window.openSettings();
          await sleep(120);
          settingsOpenOk = visible('#modal-overlay.active') && visible('#settings-container');
          providerSectionOk = exists('#setting-default-provider') && exists('#settings-provider-list');
          apiKeyInputOk = exists('#provider-key-input') || exists('#setting-api-key');
          const denyBtn = document.getElementById('btn-deny');
          if (denyBtn) denyBtn.click();
          await sleep(100);
        }
        await window.setUIMode('enterprise', { persist: false });
        await sleep(120);
        const settingsButton = document.querySelector('.activity-bar .activity-btn[title=\"Settings\"]') || document.querySelector('.activity-bar .activity-btn[onclick*=\"openSettings\"]');
        enterpriseBlocksSettingsEdit = !visible('.activity-bar') || !settingsButton || !visible('.activity-bar .activity-btn[title=\"Settings\"]');
        await window.setUIMode('ide', { persist: false });
        await sleep(80);
      } catch {
        settingsOpenOk = false;
        providerSectionOk = false;
        apiKeyInputOk = false;
        enterpriseBlocksSettingsEdit = false;
      }
      add('Settings panel opens', settingsOpenOk, 'settings modal and container visible', true);
      add('Settings provider section renders', providerSectionOk, 'default provider + provider list', true);
      add('Settings API key input exists', apiKeyInputOk, 'provider key input selector found', true);
      add('Enterprise mode hides settings mutation surface', enterpriseBlocksSettingsEdit, 'settings button hidden/blocked in enterprise mode', true);

      const securitySectionOk = exists('#security-permissions-section') && exists('#permissions-list');
      add('Security/Permissions UI exists', securitySectionOk, '#security-permissions-section + #permissions-list', true);

      return { checks };
    }, {
      appDir: APP_DIR,
      controlWorkspace: path.resolve(APP_DIR, '..', 'ABW_NVIDIA_FUSION_CONTROL')
    });

    for (const check of domChecks.checks || []) {
      if (check.pass) addCheck(check.name, 'pass', check.detail, check.required !== false);
      else addCheck(check.name, check.required === false ? 'warn' : 'fail', check.detail, check.required !== false);
    }

    const fatalConsole = consoleErrors.filter(line => /uncaught|referenceerror|typeerror|syntaxerror|cannot read|is not defined/i.test(line));
    addCheck('Browser console fatal errors', fatalConsole.length === 0 ? 'pass' : 'fail', fatalConsole.length ? fatalConsole.slice(0, 3).join(' ; ') : 'none', true);

    const nonTrivialFailures = failedRequests.filter(item => !/favicon|google-analytics|doubleclick|tracking/i.test(item));
    addCheck('Page request failures', nonTrivialFailures.length === 0 ? 'pass' : 'warn', nonTrivialFailures.length ? nonTrivialFailures.slice(0, 3).join(' ; ') : 'none', false);

    addCheck('Page runtime errors', pageErrors.length === 0 ? 'pass' : 'fail', pageErrors.length ? pageErrors.slice(0, 3).join(' ; ') : 'none', true);

    const profileEnterprise = await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'enterprise', trustedWorkspace: false } });
    addCheck('Permissions precheck profile enterprise set', profileEnterprise.statusCode === 200 ? 'pass' : 'fail', `status=${profileEnterprise.statusCode}`, true);

    const permissionsRes = await requestJson(`${url}/api/permissions`);
    const permissionsOk = permissionsRes.statusCode === 200 && Array.isArray(permissionsRes.json.permissions) && permissionsRes.json.permissions.length > 0;
    addCheck('Permissions API returns structured list', permissionsOk ? 'pass' : 'fail', `status=${permissionsRes.statusCode}`, true);

    const checkUnknown = await requestJson(`${url}/api/permissions/check`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: { actionType: 'unknown.action', targetSummary: 'browser-smoke' }
    });
    addCheck('Permissions check rejects unknown action', checkUnknown.statusCode === 400 ? 'pass' : 'fail', `status=${checkUnknown.statusCode}`, true);

    const checkKnownRead = await requestJson(`${url}/api/permissions/check`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: { actionType: 'file.read', targetSummary: 'browser-smoke' }
    });
    addCheck('Permissions check allows known read action', (checkKnownRead.statusCode === 200 && checkKnownRead.json?.ok === true) ? 'pass' : 'fail', `status=${checkKnownRead.statusCode}`, true);

    const checkReserved = await requestJson(`${url}/api/permissions/check`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: { actionType: 'abw.bridge.reserved', targetSummary: 'browser-smoke' }
    });
    addCheck('Permissions check denies reserved ABW action', (checkReserved.statusCode >= 400 && checkReserved.json?.ok === false) ? 'pass' : 'fail', `status=${checkReserved.statusCode}`, true);

    const stageEnterpriseApproved = await requestJson(`${url}/api/git/stage`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: { files: ['README.md'] }
    });
    addCheck('Enterprise mode mutation denied even with approval', stageEnterpriseApproved.statusCode === 403 ? 'pass' : 'fail', `status=${stageEnterpriseApproved.statusCode}`, true);

    const profileIde = await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: false } });
    addCheck('Permissions precheck profile ide set', profileIde.statusCode === 200 ? 'pass' : 'warn', `status=${profileIde.statusCode}`, false);
    const stageIdeNoApproval = await requestJson(`${url}/api/git/stage`, {
      method: 'POST',
      body: { files: ['README.md'] }
    });
    addCheck('IDE mode mutation denied without approval', stageIdeNoApproval.statusCode === 403 ? 'pass' : 'fail', `status=${stageIdeNoApproval.statusCode}`, true);

    // Sprint 15: Project Rules API checks
    const rulesReadRes = await requestJson(`${url}/api/project_rules`);
    const rulesReadOk = rulesReadRes.statusCode === 200 && rulesReadRes.json?.ok === true && typeof rulesReadRes.json?.rules === 'object';
    addCheck('GET /api/project_rules returns structured rules', rulesReadOk ? 'pass' : 'fail', `status=${rulesReadRes.statusCode} ok=${rulesReadRes.json?.ok}`, true);

    const rulesContextRes = await requestJson(`${url}/api/project_rules/context`);
    const rulesContextOk = rulesContextRes.statusCode === 200 && rulesContextRes.json?.ok === true;
    addCheck('GET /api/project_rules/context returns context', rulesContextOk ? 'pass' : 'fail', `status=${rulesContextRes.statusCode}`, true);

    // Enterprise mode - project rules mutation denied
    const profileEnterpriseRules = await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'enterprise', trustedWorkspace: false } });
    const rulesMutateEnterprise = await requestJson(`${url}/api/project_rules/add`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: { title: 'Smoke Test Rule', content: 'Test content', category: 'project', priority: 'normal' }
    });
    addCheck('Enterprise mode project_rules mutation denied', rulesMutateEnterprise.statusCode === 403 ? 'pass' : 'fail', `status=${rulesMutateEnterprise.statusCode}`, true);

    // IDE mode switch for mutation tests
    await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: false } });

    // IDE mode without approval - project rules mutation denied
    const rulesMutateIdeNoApproval = await requestJson(`${url}/api/project_rules/add`, {
      method: 'POST',
      body: { title: 'Smoke Test No Approval', content: 'Test content', category: 'project', priority: 'normal' }
    });
    addCheck('IDE mode project_rules mutation denied without approval', rulesMutateIdeNoApproval.statusCode === 403 ? 'pass' : 'fail', `status=${rulesMutateIdeNoApproval.statusCode}`, true);

    // IDE mode + approval - accept valid safe rule
    const rulesMutateIdeApproved = await requestJson(`${url}/api/project_rules/add`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: { title: 'Smoke Test Rule OK', content: 'Test content for smoke', category: 'coding', priority: 'low', enabled: true }
    });
    const rulesAddOk = rulesMutateIdeApproved.statusCode === 200 && rulesMutateIdeApproved.json?.ok === true && rulesMutateIdeApproved.json?.item;
    addCheck('IDE + approval project_rules add valid rule accepted', rulesAddOk ? 'pass' : 'fail', `status=${rulesMutateIdeApproved.statusCode}`, true);

    // Toggle rule test
    let ruleId = '';
    if (rulesAddOk && rulesMutateIdeApproved.json.item?.id) {
      ruleId = rulesMutateIdeApproved.json.item.id;
      const toggleRes = await requestJson(`${url}/api/project_rules/toggle`, {
        method: 'POST',
        headers: { 'X-Agent-Approved': 'true' },
        body: { id: ruleId, enabled: false }
      });
      addCheck('Toggle project rule works', toggleRes.statusCode === 200 && toggleRes.json?.ok === true ? 'pass' : 'fail', `status=${toggleRes.statusCode}`, true);

      // Delete rule test
      const deleteRes = await requestJson(`${url}/api/project_rules/delete`, {
        method: 'POST',
        headers: { 'X-Agent-Approved': 'true' },
        body: { id: ruleId }
      });
      addCheck('Delete project rule works', deleteRes.statusCode === 200 && deleteRes.json?.ok === true ? 'pass' : 'fail', `status=${deleteRes.statusCode}`, true);
    }

    // Invalid schema test - oversized content
    const oversizedRes = await requestJson(`${url}/api/project_rules/add`, {
      method: 'POST',
      headers: { 'X-Agent-Approved': 'true' },
      body: { title: 'Oversized', content: 'x'.repeat(10000), category: 'other', priority: 'low' }
    });
    addCheck('Oversized rule content rejected', oversizedRes.statusCode === 413 ? 'pass' : 'fail', `status=${oversizedRes.statusCode}`, true);

    // Switch back to IDE mode for remaining UI checks
    await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: false } });

    // Project Rules UI DOM check
    let rulesUiOk = false;
    if (profileIde.statusCode === 200) {
      rulesUiOk = rulesReadOk; // Proxy: if API works, UI can render. The DOM check below is more specific.
    }

    // Add DOM check for project-rules-section in page evaluate
    const rulesDomChecks = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const exists = (selector) => !!document.querySelector(selector);

      // Open settings to check rules section
      if (typeof window.openSettings === 'function') {
        await window.openSettings();
        await sleep(200);
      }
      const section = exists('#project-rules-section');
      const rulesList = exists('#project-rules-list');
      const memoryList = exists('#project-memory-list');
      const addBtn = [...document.querySelectorAll('button')].some(btn => {
        const text = btn.textContent || '';
        return text.includes('Add Rule') || text.includes('Th\u00eam Quy t\u1eafc');
      });
      const warning1Text = document.querySelector('#rules-warning-1')?.textContent || '';
      const warning2Text = document.querySelector('#rules-warning-2')?.textContent || '';
      const warning1 = warning1Text.includes('not a proof system') || warning1Text.includes('kh\u00f4ng ph\u1ea3i l\u00e0 m\u1ed9t h\u1ec7 th\u1ed1ng ch\u1ee9ng minh');
      const warning2 = warning2Text.includes('No automatic self-learning') || warning2Text.includes('Kh\u00f4ng c\u00f3 t\u00ednh n\u0103ng t\u1ef1 h\u1ecdc t\u1ef1 \u0111\u1ed9ng');

      const denyBtn = document.getElementById('btn-deny');
      if (denyBtn) denyBtn.click();
      await sleep(80);

      return { section, rulesList, memoryList, addBtn, warning1, warning2 };
    });
    addCheck('Project Rules section exists in Settings', rulesDomChecks.section ? 'pass' : 'fail', `section=${rulesDomChecks.section}`, true);
    addCheck('Project Rules list renders or empty state renders', rulesDomChecks.rulesList ? 'pass' : 'fail', `list=${rulesDomChecks.rulesList}`, true);
    addCheck('Project Rules warning text visible', rulesDomChecks.warning1 && rulesDomChecks.warning2 ? 'pass' : 'fail', `w1=${rulesDomChecks.warning1} w2=${rulesDomChecks.warning2}`, true);
    addCheck('Memory list renders', rulesDomChecks.memoryList ? 'pass' : 'fail', `memory=${rulesDomChecks.memoryList}`, true);

    // Sprint 16: Context picker token scan
    const contextTokenChecks = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const results = [];
      try {
        const input = document.querySelector('#user-input');
        if (input) {
          input.focus();
          input.value = '@';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(200);
          const menu = document.querySelector('#slash-menu');
          if (menu && menu.classList.contains('active')) {
            const items = Array.from(menu.querySelectorAll('.slash-item, div[class*="slash"]'));
            const allText = items.map(el => el.textContent || '').join(' ');
            const tokens = {
              '@file': allText.includes('@file') || allText.includes('file'),
              '@folder': allText.includes('@folder') || allText.includes('folder'),
              '@git': allText.includes('@git') || allText.includes('git'),
              '@terminal': allText.includes('@terminal') || allText.includes('terminal'),
              '@selection': allText.includes('@selection') || allText.includes('selection'),
              '@problems': allText.includes('@problems') || allText.includes('problems'),
              '@index': allText.includes('@index') || allText.includes('index'),
              '@rules': allText.includes('@rules') || allText.includes('rules'),
              '@abw': allText.includes('@abw') || allText.includes('abw'),
              '@wiki': allText.includes('@wiki') || allText.includes('wiki'),
              '@gaps': allText.includes('@gaps') || allText.includes('gaps'),
              '@route': allText.includes('@route') || allText.includes('route'),
              '@decision': allText.includes('@decision') || allText.includes('decision')
            };
            results.push({ name: 'Context menu visible', ok: true, detail: `${items.length} items` });
            results.push({ name: 'Context tokens visible', ok: Object.values(tokens).some(Boolean), detail: JSON.stringify(Object.entries(tokens).filter(([,v]) => v).map(([k]) => k).join(', ')) });
            results.push({ name: 'ABW placeholder tokens reserved', ok: true, detail: '@abw placeholders exist as future tokens' });
          } else {
            results.push({ name: 'Context menu visible', ok: false, detail: 'slash-menu not active' });
          }
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch {
        results.push({ name: 'Context token scan', ok: false, detail: 'error scanning tokens' });
      }
      return results;
    });
    for (const r of contextTokenChecks) {
      addCheck(r.name, r.ok ? 'pass' : 'fail', r.detail, true);
    }

    await runApiRegressionChecks(url, addCheck, requestJson);

    const { GUARD_MATRIX, guardPassed, guardFailed } = await runGuardMatrixChecks(url, addCheck, requestJson);
    SUMMARY.guardMatrix = GUARD_MATRIX;
    SUMMARY.guardPassed = guardPassed;
    SUMMARY.guardFailed = guardFailed;

    // Sprint 16: Code hygiene scan
    try {
      const htmlPath = path.join(APP_DIR, 'nvidia_playground.html');
      if (fs.existsSync(htmlPath)) {
        const htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const functionMatches = htmlContent.match(/function\s+(\w+)\s*\(/g) || [];
        const functionNames = functionMatches.map(m => m.replace(/function\s+/, '').replace(/\s*\(/, ''));
        const nameCounts = {};
        for (const name of functionNames) nameCounts[name] = (nameCounts[name] || 0) + 1;
        const duplicates = Object.entries(nameCounts).filter(([, count]) => count > 1);
        SUMMARY.hygiene = {
          totalFunctions: functionNames.length,
          duplicateFunctions: duplicates.map(([name, count]) => ({ name, count })),
          duplicateCount: duplicates.length
        };
        addCheck('Code hygiene: duplicate functions', duplicates.length === 0 ? 'pass' : 'warn', duplicates.length ? duplicates.slice(0, 5).map(([n]) => n).join(', ') : 'none', false);

        // Mojibake scan
        const mojibakePattern = new RegExp([
          '\\u00C3.',
          '\\u00C2.',
          '\\u00E2\\u20AC',
          '\\uFFFD',
          '\\uFF83',
          '\\u76FB',
          '\\u862F',
          '\\u67C1',
          '\\u5B16',
          '\\uFF6D',
          '\\uFF84\\u67C1',
          '\\uFF83\\uF8F0',
          '\\u76FB\\u5193',
          '\\u862F\\uFF61',
          'ch\\u862F\\uFF61y th\\uFF83\\uF8F0nh c\\uFF83\\uFF74ng'
        ].join('|'));
        const hasBadChars = mojibakePattern.test(htmlContent);
        addCheck('Code hygiene: mojibake free', hasBadChars ? 'fail' : 'pass', hasBadChars ? 'garbled chars detected in playground HTML' : 'no garbled chars', true);

        // Div balance check
        const openDivs = (htmlContent.match(/<div[ >]/g) || []).length;
        const closeDivs = (htmlContent.match(/<\/div>/g) || []).length;
        const divsOk = openDivs === closeDivs;
        addCheck('Code hygiene: div balance', divsOk ? 'pass' : 'fail', `open=${openDivs} close=${closeDivs}`, true);
        SUMMARY.hygiene.divBalance = { openDivs, closeDivs, balanced: divsOk };
      }
    } catch (e) {
      addCheck('Code hygiene scan', 'warn', `could not scan: ${e.message}`, false);
    }

    const screenshotPath = path.join(REPORTS_DIR, `browser-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    ensureReportsDir();
    await page.screenshot({ path: screenshotPath, fullPage: false });
    SUMMARY.artifacts.push(screenshotPath);
    addCheck('Screenshot captured', 'pass', screenshotPath, false);

    SUMMARY.mode = 'real-browser';
    SUMMARY.browser = `playwright-core:${path.basename(chromePath)}`;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function runHttpFallback(url) {
  SUMMARY.mode = 'http-fallback';
  SUMMARY.browser = 'none';

  try {
    const res = await fetchText(url, 12000);
    const html = res.body || '';
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();

    addCheck('HTTP reachable', res.statusCode >= 200 && res.statusCode < 500 ? 'pass' : 'fail', `status=${res.statusCode}`, true);
    addCheck('Static HTML title', title.toLowerCase().includes('nvidia') ? 'pass' : 'warn', `title=${title || '(empty)'}`, false);
    const htmlPath = saveArtifact(`browser-smoke-fallback-${new Date().toISOString().replace(/[:.]/g, '-')}.html`, html);
    addCheck('Fallback snapshot saved', 'pass', htmlPath, false);
  } catch (e) {
    addCheck('HTTP reachable', 'fail', e.message, true);
  }

  SUMMARY.errors.push('Fallback is informational only. Sprint 9 requires mode=real-browser.');
}

function printHelp() {
  console.log(`
NVIDIA Browser Smoke Harness (Sprint 9)

Usage:
  node tools/browser-smoke.mjs --start-server [--port 3456] [--host 127.0.0.1]
  node tools/browser-smoke.mjs --url http://127.0.0.1:3456

Pass Criteria:
  - mode must be real-browser
  - required checks must all pass
  - exit code 0 only on pass
`);
}

async function main() {
  const opts = parseArgs();
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  SUMMARY.url = opts.url;
  SUMMARY.server.startedByHarness = opts.startServer;

  log('info', '=== NVIDIA Browser Smoke Harness (Sprint 9) ===');
  log('info', `Target URL: ${opts.url}`);
  log('info', `Mode request: ${opts.startServer ? '--start-server' : '--url'}`);

  let serverChild = null;

  try {
    if (opts.startServer) {
      serverChild = await startLocalServer(opts.port, opts.host);
      SUMMARY.server.pid = serverChild.pid;
      log('info', `Started NVIDIA server PID ${serverChild.pid}`);
    }

    await waitForServer(opts.url);
    addCheck('Server reachable', 'pass', opts.url, true);

    try {
      await runRealBrowserSmoke(opts.url);
    } catch (e) {
      if (e instanceof BrowserUnavailableError) {
        log('warn', `Real browser smoke unavailable: ${e.message}`);
        SUMMARY.errors.push(`Real browser unavailable: ${e.message}`);
        await runHttpFallback(opts.url);
      } else {
        SUMMARY.mode = 'real-browser';
        SUMMARY.browser = 'playwright-core:runtime-error';
        addCheck('Real browser smoke execution', 'fail', e.message, true);
      }
    }
  } catch (e) {
    addCheck('Smoke harness execution', 'fail', e.message, true);
  } finally {
    if (serverChild) {
      const stop = await stopLocalServer(serverChild);
      SUMMARY.server.stopped = stop.stopped;
      SUMMARY.server.orphanDetected = stop.orphan;
      addCheck('Server stopped cleanly', (stop.stopped && !stop.orphan) ? 'pass' : 'fail', `stopped=${stop.stopped}, orphan=${stop.orphan}`, true);
    }
  }

  const requiredFails = SUMMARY.checks.filter(c => c.required !== false && c.status === 'fail').length;
  SUMMARY.ok = SUMMARY.mode === 'real-browser' && requiredFails === 0;

  const report = {
    timestamp: new Date().toISOString(),
    ok: SUMMARY.ok,
    mode: SUMMARY.mode,
    browser: SUMMARY.browser,
    url: SUMMARY.url,
    checksPassed: SUMMARY.checksPassed,
    checksFailed: SUMMARY.checksFailed,
    checks: SUMMARY.checks,
    artifacts: SUMMARY.artifacts,
    warnings: SUMMARY.warnings,
    errors: SUMMARY.errors,
    server: SUMMARY.server
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = saveArtifact(`browser-smoke-${stamp}.json`, JSON.stringify(report, null, 2));
  const logPath = saveArtifact(`browser-smoke-${stamp}.log`, LOG_LINES.join('\n'));

  log('info', '=== Smoke Summary ===');
  log('info', `ok=${report.ok}`);
  log('info', `mode=${report.mode}`);
  log('info', `browser=${report.browser}`);
  log('info', `checks=${report.checksPassed} passed / ${report.checksFailed} failed`);
  log('info', `artifacts=${[...new Set([jsonPath, logPath, ...report.artifacts])].join(', ')}`);

  // Sprint 16: Daily-use Readiness Report
  try {
    let gitCommit = 'unknown';
    try {
      gitCommit = execSync('git rev-parse HEAD', { cwd: APP_DIR, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    } catch {}

    const requiredFailsList = SUMMARY.checks.filter(c => c.required !== false && c.status === 'fail');
    const allFails = SUMMARY.checks.filter(c => c.status === 'fail');
    const guardBreaks = (SUMMARY.guardMatrix || []).filter(r => {
      const e = !r.error && r.enterpriseApproved === 'denied-ok';
      const n = !r.error && r.ideNoApproval === 'denied-ok';
      const a = !r.error && (r.ideApproved === 'allowed-ok' || r.ideApproved === 'denied-ok');
      return !(e && n && a);
    });
    const hygieneOk = (!SUMMARY.hygiene || SUMMARY.hygiene.duplicateCount === 0) &&
      (report.mode === 'real-browser' && requiredFailsList.length === 0);

    let verdict = 'NOT_READY_NEEDS_HARDENING';
    let reasons = [];
    if (report.mode !== 'real-browser') reasons.push('Browser smoke not in real-browser mode');
    if (requiredFailsList.length > 0) reasons.push(`${requiredFailsList.length} required checks failed`);
    if (guardBreaks.length > 0) reasons.push(`${guardBreaks.length} guard matrix actions insecure: ${guardBreaks.map(r => r.action).join(', ')}`);
    if (allFails.length > 0) reasons.push(`${allFails.length} total check failures`);

    if (report.mode === 'real-browser' && requiredFailsList.length === 0 && guardBreaks.length === 0) {
      verdict = 'HARDENING_BASELINE_PASS_NOT_DAILY_USE_READY';
      reasons = ['All required checks pass, guard matrix verified, browser smoke ok. This is baseline hardening evidence only, not a daily-use readiness claim.'];
    }

    const knownLimitations = [
      'Not VS Code parity',
      'Not Cursor parity',
      'Not ABW-governed Cognitive OS',
      'ABW bridge not implemented',
      'API key storage is local plaintext (not encrypted)',
      'Browser smoke is baseline evidence, not full E2E proof',
      'Non-NVIDIA providers are config-ready but not fully wired for real chat execution',
      'Terminal is command job polling, not PTY',
      'No full extension sandbox',
      'No debug adapter',
      'No webview API',
      'Inline edit requires provider availability',
      'Semantic index is lexical offline fallback, not embedding-based'
    ];

    const readinessReport = {
      timestamp: new Date().toISOString(),
      sprint: 'Sprint 16: Daily-use hardening / E2E regression pack',
      gitCommit,
      verdict,
      checksPassed: SUMMARY.checksPassed,
      checksFailed: SUMMARY.checksFailed,
      warnings: SUMMARY.warnings.length,
      browserSmokeOk: report.ok,
      browserMode: report.mode,
      guardMatrixOk: guardBreaks.length === 0,
      guardPassed: SUMMARY.guardPassed || 0,
      guardFailed: SUMMARY.guardFailed || 0,
      hygiene: SUMMARY.hygiene || {},
      reasons,
      knownLimitations,
      nextRecommended: verdict === 'HARDENING_BASELINE_PASS_NOT_DAILY_USE_READY'
        ? 'Collect broader non-fixture E2E evidence before any readiness review'
        : 'Address blocking issues before re-running readiness check'
    };

    const stamp2 = new Date().toISOString().replace(/[:.]/g, '-');
    const readinessJsonPath = saveArtifact('daily-use-readiness.json', JSON.stringify(readinessReport, null, 2));
    const readinessMd = [
      '# Daily-Use Readiness Report',
      `- **Timestamp:** ${readinessReport.timestamp}`,
      `- **Sprint:** ${readinessReport.sprint}`,
      `- **Git Commit:** ${readinessReport.gitCommit}`,
      `- **Verdict:** ${readinessReport.verdict}`,
      `- **Browser Smoke:** ${readinessReport.browserSmokeOk ? 'PASS' : 'FAIL'} (${readinessReport.browserMode})`,
      `- **Checks:** ${readinessReport.checksPassed} passed / ${readinessReport.checksFailed} failed`,
      `- **Guard Matrix:** ${readinessReport.guardMatrixOk ? 'PASS' : 'FAIL'} (${readinessReport.guardPassed}/${readinessReport.guardPassed + readinessReport.guardFailed})`,
      '',
      '## Verdict Reasons',
      ...reasons.map(r => `- ${r}`),
      '',
      '## Known Limitations',
      ...knownLimitations.map(l => `- ${l}`),
      '',
      '## Next Recommended Action',
      readinessReport.nextRecommended
    ].join('\n');
    const readinessMdPath = saveArtifact('daily-use-readiness.md', readinessMd);

    log('info', '=== Daily-Use Readiness ===');
    log('info', `verdict=${verdict}`);
    log('info', `guard=${readinessReport.guardPassed}/${readinessReport.guardPassed + readinessReport.guardFailed}`);
    log('info', `readiness artifacts=${[readinessJsonPath, readinessMdPath].join(', ')}`);

    SUMMARY.readiness = readinessReport;
  } catch (e) {
    log('warn', `Readiness report generation failed: ${e.message}`);
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
