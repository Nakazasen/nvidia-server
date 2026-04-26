import http from 'http';
import fs from 'fs';
import OpenAI from 'openai';
import { exec } from 'child_process';
import path from 'path';

const PORT = 3000;

// --- 1. Tự động nạp API Key từ .env ---
if (fs.existsSync('./.env')) {
    const env = fs.readFileSync('./.env', 'utf8');
    env.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) process.env[key.trim()] = value.trim();
    });
}

const openai = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
});

// Helper để đọc Body từ Request
function getBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(JSON.parse(body || '{}')));
    });
}

const server = http.createServer(async (req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // --- 2. Các Endpoint GET ---
    if (req.method === 'GET') {
        if (req.url === '/' || req.url === '/index.html') {
            fs.readFile('./nvidia_playground.html', (err, data) => {
                if (err) { res.writeHead(404); res.end('Not Found'); }
                else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); }
            });
        } else if (req.url === '/api/models') {
            try {
                const response = await fetch(`${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/models`, {
                    headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}` }
                });
                const data = await response.json();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
            }
        } else {
            res.writeHead(404); res.end();
        }
        return;
    }

    // --- 3. Các Endpoint POST ---
    if (req.method === 'POST') {
        if (req.url === '/proxy/chat') {
            const data = await getBody(req);
            try {
                const response = await fetch(`${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`
                    },
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
            }
        } else if (req.url.startsWith('/api/')) {
            const toolName = req.url.split('/')[2];
            const args = await getBody(req);
            try {
                let result = '';
                if (toolName === 'list_dir') result = JSON.stringify(fs.readdirSync(args.path || '.'), null, 2);
                else if (toolName === 'read_file') result = fs.readFileSync(args.path, 'utf8');
                else if (toolName === 'write_file') { fs.writeFileSync(args.path, args.content); result = "Success"; }
                else if (toolName === 'execute_command') {
                    result = await new Promise(resolve => {
                        exec(args.command, (err, out, serr) => resolve(err ? `Error: ${err.message}\n${serr}` : out || "Success"));
                    });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result }));
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
            }
        }
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Server Agent v3.0 (Auto Discovery) đang chạy tại: http://localhost:${PORT}`);
});
