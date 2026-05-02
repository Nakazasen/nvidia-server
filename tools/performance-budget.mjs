import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import http from 'http';
import { once } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const STATE_DIR = path.join(APP_DIR, '.nvidia-agent');
const REPORTS_DIR = path.join(STATE_DIR, 'reports');

async function getDirStats(dirPath) {
    let size = 0;
    let count = 0;
    if (!fs.existsSync(dirPath)) return { size, count };

    const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        if (item.isDirectory()) {
            const sub = await getDirStats(fullPath);
            size += sub.size;
            count += sub.count;
        } else {
            const stat = await fs.promises.stat(fullPath);
            size += stat.size;
            count += 1;
        }
    }
    return { size, count };
}

async function getFileStats(filePath) {
    if (!fs.existsSync(filePath)) return { size: 0, lines: 0 };
    const stat = await fs.promises.stat(filePath);
    const content = await fs.promises.readFile(filePath, 'utf-8');
    // Stable across LF/CRLF/mixed endings; trailing newline does not create a synthetic extra line.
    const lines = content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length;
    return { size: stat.size, lines, lineCountMethod: 'split(/\\r\\n|\\n|\\r/)' };
}

function checkReachability(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => {
            req.destroy();
            resolve(false);
        });
    });
}

function measureProcessMemory(pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
        return {
            idleMemoryEstimateMb: 'NOT_MEASURED_YET',
            idleMemoryStatus: 'UNAVAILABLE',
            idleMemoryReason: 'Invalid or missing PID',
            idleMemoryMethod: null,
            idleMemoryPid: pid || null
        };
    }
    try {
        const raw = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
            encoding: 'ascii',
            timeout: 3000,
            windowsHide: true
        }).trim();
        const match = raw.match(/"[^"]*","[^"]*","[^"]*","[^"]*","([0-9,.]+)\s*K"/i);
        if (match) {
            const kb = parseFloat(match[1].replace(/,/g, ''));
            if (Number.isFinite(kb) && kb > 0) {
                const mb = Math.round((kb / 1024) * 100) / 100;
                return {
                    idleMemoryEstimateMb: mb,
                    idleMemoryStatus: 'MEASURED',
                    idleMemoryReason: null,
                    idleMemoryMethod: 'tasklist /FI (Windows) working-set K -> MB',
                    idleMemoryPid: pid
                };
            }
        }
        if (raw.toLowerCase().includes('no tasks')) {
            return {
                idleMemoryEstimateMb: 'NOT_MEASURED_YET',
                idleMemoryStatus: 'UNAVAILABLE',
                idleMemoryReason: 'Process PID not found in tasklist (possibly exited)',
                idleMemoryMethod: 'tasklist /FI (attempted)',
                idleMemoryPid: pid
            };
        }
        return {
            idleMemoryEstimateMb: 'NOT_MEASURED_YET',
            idleMemoryStatus: 'UNAVAILABLE',
            idleMemoryReason: `tasklist parse failed: output did not match expected K pattern`,
            idleMemoryMethod: 'tasklist /FI (attempted)',
            idleMemoryPid: pid
        };
    } catch (e) {
        return {
            idleMemoryEstimateMb: 'NOT_MEASURED_YET',
            idleMemoryStatus: 'UNAVAILABLE',
            idleMemoryReason: `Measurement error: ${e.message.slice(0, 200)}`,
            idleMemoryMethod: 'tasklist /FI (attempted)',
            idleMemoryPid: pid
        };
    }
}

async function measureServerStart() {
    const port = 3876;
    const env = { ...process.env, PORT: String(port) };
    const startTime = Date.now();

    if (await checkReachability(port)) {
        return {
            coldStartTimeMs: -1,
            reachabilityTimeMs: -1,
            idleMemoryEstimateMb: 'NOT_MEASURED_YET',
            error: `Port ${port} is already reachable before measurement (port collision or existing server).`
        };
    }

    const serverProcess = spawn('node', [path.join(APP_DIR, 'tools', 'nvidia-server.mjs')], {
        cwd: APP_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const killProcessTree = async () => {
        if (serverProcess.killed || serverProcess.exitCode !== null) return;
        serverProcess.kill('SIGTERM');
        const exited = await Promise.race([
            once(serverProcess, 'exit').then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 1000))
        ]);
        if (!exited && process.platform === 'win32' && Number.isInteger(serverProcess.pid)) {
            await new Promise((resolve) => {
                const killer = spawn('taskkill', ['/pid', String(serverProcess.pid), '/t', '/f'], { stdio: 'ignore' });
                killer.on('exit', () => resolve());
                killer.on('error', () => resolve());
            });
        }
    };

    let coldStartTime = null;
    let reachabilityTime = null;

    serverProcess.stdout.on('data', (data) => {
        const out = data.toString();
        if (!coldStartTime && out.includes(`http://127.0.0.1:${port}`)) {
            coldStartTime = Date.now() - startTime;
        }
    });

    const started = await new Promise((resolve) => {
        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            resolve(result);
        };

        const poll = setInterval(async () => {
            if (await checkReachability(port)) {
                reachabilityTime = Date.now() - startTime;
                clearInterval(poll);
                clearTimeout(timeout);
                const mem = measureProcessMemory(serverProcess.pid);
                finish({
                    coldStartTimeMs: coldStartTime || reachabilityTime,
                    reachabilityTimeMs: reachabilityTime,
                    ...mem
                });
            }
        }, 100);

        const timeout = setTimeout(() => {
            clearInterval(poll);
            finish({
                coldStartTimeMs: -1,
                reachabilityTimeMs: -1,
                idleMemoryEstimateMb: 'NOT_MEASURED_YET',
                error: 'Timeout waiting for server reachability'
            });
        }, 5000);

        serverProcess.once('exit', (code, signal) => {
            clearInterval(poll);
            clearTimeout(timeout);
            finish({
                coldStartTimeMs: -1,
                reachabilityTimeMs: -1,
                idleMemoryEstimateMb: 'NOT_MEASURED_YET',
                error: `Server exited before measurement (code=${code}, signal=${signal ?? 'none'})`
            });
        });
    });

    await killProcessTree();
    return started;
}

async function main() {
    console.log('Measuring performance budget baseline...');
    
    const fileStats = {
        'nvidia_playground.html': await getFileStats(path.join(APP_DIR, 'nvidia_playground.html')),
        'tools/browser-smoke.mjs': await getFileStats(path.join(APP_DIR, 'tools', 'browser-smoke.mjs')),
        'tools/nvidia-server.mjs': await getFileStats(path.join(APP_DIR, 'tools', 'nvidia-server.mjs')),
        'tools/agent-core.mjs': await getFileStats(path.join(APP_DIR, 'tools', 'agent-core.mjs'))
    };

    const dirStats = {
        'reports': await getDirStats(path.join(STATE_DIR, 'reports')),
        'security': await getDirStats(path.join(STATE_DIR, 'security')),
        'index': await getDirStats(path.join(STATE_DIR, 'index')),
        'tmp': await getDirStats(path.join(STATE_DIR, 'tmp'))
    };

    const serverStats = await measureServerStart();

    const report = {
        timestamp: new Date().toISOString(),
        serverStart: serverStats,
        files: fileStats,
        directories: dirStats
    };

    if (!fs.existsSync(REPORTS_DIR)) {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
    }

    const jsonPath = path.join(REPORTS_DIR, 'performance-budget.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const mdPath = path.join(REPORTS_DIR, 'performance-budget.md');
    const memDisplay = typeof serverStats.idleMemoryEstimateMb === 'number'
        ? `${serverStats.idleMemoryEstimateMb} MB`
        : String(serverStats.idleMemoryEstimateMb);
    const mdContent = `# Performance Budget Baseline

## Server Metrics
- Cold Start Time: ${serverStats.coldStartTimeMs} ms
- Reachability Time: ${serverStats.reachabilityTimeMs} ms
- Idle Memory: ${memDisplay}
- Memory Status: ${serverStats.idleMemoryStatus || 'N/A'}
- Memory Method: ${serverStats.idleMemoryMethod || 'N/A'}
${serverStats.idleMemoryReason ? `- Memory Note: ${serverStats.idleMemoryReason}` : ''}
${serverStats.idleMemoryPid ? `- Server PID: ${serverStats.idleMemoryPid}` : ''}

## Source Files
${Object.entries(fileStats).map(([name, stat]) => `- ${name}: ${stat.size} bytes / ${stat.lines} lines`).join('\n')}

## Runtime Directories
${Object.entries(dirStats).map(([name, stat]) => `- .nvidia-agent/${name}: ${stat.count} files / ${stat.size} bytes`).join('\n')}
`;
    fs.writeFileSync(mdPath, mdContent);

    console.log('Report generated at:', jsonPath);
    console.log('Performance budget check completed.');
}

main().catch(console.error);
