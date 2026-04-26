import http from 'http';
import fs from 'fs';
import OpenAI from 'openai';

const PORT = 3000;
// Tự động đọc file .env nếu có
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

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/api/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { model, prompt } = JSON.parse(body);
                const response = await openai.chat.completions.create({
                    model: model,
                    messages: [{ role: "user", content: prompt }],
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            } catch (error) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: error.message }));
            }
        });
        return;
    }

    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile('./nvidia_playground.html', (err, data) => {
            if (err) { res.writeHead(500); res.end('Error loading HTML'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); }
        });
        return;
    }
    res.writeHead(404); res.end();
});

server.listen(PORT, () => {
    console.log(`--- NVIDIA Playground Server tại http://localhost:${PORT} ---`);
});
