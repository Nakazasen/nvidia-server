import fs from 'fs';
import OpenAI from "openai";

// Tự động đọc file .env nếu có
if (fs.existsSync('./.env')) {
  const env = fs.readFileSync('./.env', 'utf8');
  env.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) process.env[key.trim()] = value.trim();
  });
}

const args = process.argv.slice(2);
let model = "deepseek-ai/deepseek-v4-pro";
let promptIndex = 0;

if (args[0] === "--model" && args[1]) {
  model = args[1];
  promptIndex = 2;
}

const prompt = args.slice(promptIndex).join(" ");
if (!prompt) {
  console.log("Cách dùng: node nvidia-cli.mjs [--model model_id] 'câu hỏi'");
  process.exit(0);
}

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

try {
  console.log(`--- Đang hỏi model: ${model} ---`);
  const response = await openai.chat.completions.create({
    model: model,
    messages: [{ role: "user", content: prompt }],
  });
  console.log("\n" + response.choices[0].message.content);
} catch (error) {
  console.error("Lỗi:", error.message);
}
