import fs from 'fs';
import readline from 'readline';
import OpenAI from "openai";

// Tự động đọc file .env
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

// Danh sách đầy đủ các model
const models = [
  { name: "DeepSeek V4 Pro", id: "deepseek-ai/deepseek-v4-pro" },
  { name: "DeepSeek V4 Flash", id: "deepseek-ai/deepseek-v4-flash" },
  { name: "DeepSeek V3.2", id: "deepseek-ai/deepseek-v3.2" },
  { name: "Llama 3.1 405B (Meta)", id: "meta/llama-3.1-405b-instruct" },
  { name: "Nemotron 3 Super 120B", id: "nvidia/nemotron-3-super-120b-a12b" },
  { name: "Nemotron 3 Nano 30B", id: "nvidia/nemotron-3-nano-30b-a3b" },
  { name: "Qwen 3.5 397B", id: "qwen/qwen3.5-397b-a17b" },
  { name: "Qwen 3.5 122B", id: "qwen/qwen3.5-122b-a10b" },
  { name: "Kimi K2.5 (Moonshot)", id: "moonshotai/kimi-k2.5" },
  { name: "Kimi K2 Thinking", id: "moonshotai/kimi-k2-thinking" },
  { name: "GLM 5.1 (Zhipu)", id: "z-ai/glm-5.1" },
  { name: "GLM 4.7", id: "z-ai/glm-4.7" },
  { name: "Mistral Small 4", id: "mistralai/mistral-small-4-119b-2603" },
  { name: "Devstral 2 123B", id: "mistralai/devstral-2-123b-instruct-2512" },
  { name: "Gemma 4 31B IT", id: "google/gemma-4-31b-it" },
  { name: "MiniMax M2.7", id: "minimaxai/minimax-m2.7" },
  { name: "Step 3.5 Flash", id: "stepfun-ai/step-3.5-flash" }
];

// Khởi tạo giao diện nhập liệu
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Bảng màu Terminal
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m"
};

console.clear();
console.log(`${colors.green}${colors.bold}==========================================${colors.reset}`);
console.log(`${colors.green}${colors.bold}       NVIDIA NIM INTERACTIVE CLI         ${colors.reset}`);
console.log(`${colors.green}${colors.bold}==========================================${colors.reset}\n`);

console.log("Danh sách mô hình:");
models.forEach((m, idx) => console.log(`  ${colors.yellow}[${idx + 1}]${colors.reset} ${m.name}`));
console.log(`  ${colors.red}[0] Thoát${colors.reset}`);

rl.question(`\nChọn mô hình (1-${models.length}) [Mặc định: 1, 0 để Thoát]: `, (choice) => {
  if (choice === '0') {
    console.log(`${colors.yellow}Tạm biệt!${colors.reset}`);
    rl.close();
    return;
  }
  const idx = parseInt(choice) - 1;
  const selectedModel = models[idx] ? models[idx].id : models[0].id;
  const modelName = models[idx] ? models[idx].name : models[0].name;

  console.log(`\n✅ Đã kích hoạt: ${colors.green}${modelName}${colors.reset}`);
  console.log(`💡 Gõ ${colors.yellow}'exit'${colors.reset} để thoát phiên chat.\n`);

  // Vòng lặp Chat
  const chatLoop = () => {
    rl.question(`${colors.blue}${colors.bold}Bạn:${colors.reset} `, async (input) => {
      const text = input.trim();
      
      if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
        console.log(`${colors.yellow}Tạm biệt! Hẹn gặp lại.${colors.reset}`);
        rl.close();
        return;
      }
      
      if (!text) {
         chatLoop();
         return;
      }

      // Hiệu ứng loading
      process.stdout.write(`${colors.yellow}Đang suy nghĩ...${colors.reset}`);
      
      try {
        const response = await openai.chat.completions.create({
          model: selectedModel,
          messages: [{ role: "user", content: text }],
        });
        
        // Xóa dòng "Đang suy nghĩ..."
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        
        // In kết quả
        console.log(`${colors.green}${colors.bold}NVIDIA:${colors.reset}\n${response.choices[0].message.content}\n`);
      } catch (error) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        console.log(`${colors.red}Lỗi:${colors.reset} ${error.message}\n`);
      }
      
      chatLoop();
    });
  };

  chatLoop();
});
