import OpenAI from "openai";
import fs from 'fs';

// Đọc key từ .env
const env = fs.readFileSync('./.env', 'utf8');
const apiKey = env.split('\n').find(l => l.startsWith('NVIDIA_API_KEY=')).split('=')[1].trim();

const openai = new OpenAI({
  apiKey: apiKey,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

async function main() {
  const response = await openai.chat.completions.create({
    model: "meta/llama-3.1-405b-instruct",
    messages: [{ role: "user", content: "Write a complete Node.js script 'nvidia-cli-agent.mjs' that acts as an AI Agent. Use 'openai' library. Interactive Chat Loop. Tool Calling (Function Calling) for: read_file, write_file, list_dir, execute_command. Safety: MUST ASK user (Y/N) before write_file or execute_command. Loop until finished. Use ES Modules & ANSI colors. Provide ONLY the raw code." }],
  });
  console.log(response.choices[0].message.content);
}
main();
