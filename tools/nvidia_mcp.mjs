import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import fs from 'fs';

// Tự động đọc file .env nếu có
if (fs.existsSync('./.env')) {
    const env = fs.readFileSync('./.env', 'utf8');
    env.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) process.env[key.trim()] = value.trim();
    });
}

const server = new Server(
    { name: "nvidia-nim", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

const openai = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
        name: "ask_nvidia",
        description: "Ask NVIDIA NIM models (DeepSeek, Llama, etc.)",
        inputSchema: {
            type: "object",
            properties: {
                prompt: { type: "string" },
                model: { type: "string", default: "deepseek-ai/deepseek-v4-pro" }
            },
            required: ["prompt"]
        }
    }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "ask_nvidia") {
        const { prompt, model } = request.params.arguments;
        try {
            const response = await openai.chat.completions.create({
                model: model || "deepseek-ai/deepseek-v4-pro",
                messages: [{ role: "user", content: prompt }],
            });
            return { content: [{ type: "text", text: response.choices[0].message.content }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
