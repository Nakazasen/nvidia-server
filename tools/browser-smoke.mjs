import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchText(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname || '/'}${u.search || ''}`,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'nvidia-browser-smoke/9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

async function waitForServer(url, timeoutMs = SERVER_READY_TIMEOUT_MS) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    try {
      const res = await fetchText(url, 2500);
      if (res.statusCode >= 200 && res.statusCode < 500) return true;
    } catch {
      // retry
    }
    await sleep(400);
  }
  throw new Error(`Server not reachable at ${url} within ${timeoutMs}ms`);
}

function startLocalServer(port, host) {
  return new Promise((resolve, reject) => {
    const serverScript = path.join(__dirname, 'nvidia-server.mjs');
    const env = { ...process.env, PORT: String(port), HOST: host, NVIDIA_SERVER_HOST: host };
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
    const finish = (stopped) => {
      const orphan = isProcessRunning(pid);
      resolve({ stopped, orphan });
    };

    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch {}
      setTimeout(() => finish(false), 800);
    }, 5000);

    child.once('exit', () => {
      clearTimeout(timer);
      setTimeout(() => finish(true), 300);
    });

    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch {
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

    const domChecks = await page.evaluate(async () => {
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

      add('Page loaded', document.readyState === 'complete' || document.readyState === 'interactive', `readyState=${document.readyState}`, true);
      add('Main chat input exists', exists('#user-input, #composer-input, textarea'), 'selector #user-input or textarea', true);
      add('JavaScript executes', typeof window.setUIMode === 'function' && typeof window.toggleUIMode === 'function', 'setUIMode/toggleUIMode available', true);

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

      const monacoOk = exists('#code-body') || exists('#editor-tabs') || exists('.monaco-editor');
      add('Monaco/editor surface renders if safe', monacoOk, 'editor shell selectors found', false);

      const extOk = exists('#sidebar-extensions') || exists('#installed-ext-list') || exists('#btn-extensions');
      add('Extensions panel exists or safely gated', extOk, 'extensions selectors found', false);

      const indexOk = exists('#index-status') || exists('#index-query') || exists('#index-results');
      add('Index Engine UI exists or safely gated', indexOk, 'index selectors found', false);

      return { checks };
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

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
