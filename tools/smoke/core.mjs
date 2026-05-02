import http from 'http';
import https from 'https';

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function fetchText(url, timeoutMs = 10000) {
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

export function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname || '/'}${u.search || ''}`,
      method,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'nvidia-browser-smoke/14',
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch {}
        resolve({ statusCode: res.statusCode || 0, json, raw });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function waitForServer(url, timeoutMs = 15000) {
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
