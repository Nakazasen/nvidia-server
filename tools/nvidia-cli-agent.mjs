import fs from 'fs';
import readline from 'readline';
import OpenAI from "openai";
import { exec } from 'child_process';

// 1. Tự động nạp API Key từ .env
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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const colors = {
  reset: "\x1b[0m", green: "\x1b[32m", blue: "\x1b[36m",
  yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m"
};

// 2. Định nghĩa các "Đôi tay" (Tools Implementation)
const tools_impl = {
  list_dir: async ({ dirPath }) => {
    try {
      const files = fs.readdirSync(dirPath || '.');
      return JSON.stringify(files, null, 2);
    } catch (e) { return `Error: ${e.message}`; }
  },
  read_file: async ({ filePath }) => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (e) { return `Error: ${e.message}`; }
  },
  write_file: async ({ filePath, content }) => {
    const answer = await new Promise(resolve => {
      console.log(`\n${colors.yellow}${colors.bold}[BẢO MẬT]${colors.reset} Agent muốn GHI vào file: ${colors.cyan}${filePath}${colors.reset}`);
      rl.question(`Bạn có đồng ý không? (y/n): `, resolve);
    });
    if (answer.toLowerCase() !== 'y') return "User denied file write.";
    try {
      fs.writeFileSync(filePath, content);
      return "Success: File written.";
    } catch (e) { return `Error: ${e.message}`; }
  },
  execute_command: async ({ command }) => {
    const answer = await new Promise(resolve => {
      console.log(`\n${colors.yellow}${colors.bold}[BẢO MẬT]${colors.reset} Agent muốn CHẠY lệnh: ${colors.cyan}${command}${colors.reset}`);
      rl.question(`Bạn có đồng ý không? (y/n): `, resolve);
    });
    if (answer.toLowerCase() !== 'y') return "User denied command execution.";
    return new Promise(resolve => {
      exec(command, (error, stdout, stderr) => {
        if (error) resolve(`Error: ${error.message}\n${stderr}`);
        else resolve(stdout || "Command executed successfully (no output).");
      });
    });
  }
};

// 3. Khai báo Tools cho AI (JSON Schema)
const tools_def = [
  { type: "function", function: { name: "list_dir", description: "Liệt kê file và thư mục", parameters: { type: "object", properties: { dirPath: { type: "string" } } } } },
  { type: "function", function: { name: "read_file", description: "Đọc nội dung file", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
  { type: "function", function: { name: "write_file", description: "Ghi/Sửa nội dung file", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
  { type: "function", function: { name: "execute_command", description: "Chạy lệnh terminal", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }
];

const models = [
  { name: "DeepSeek V4 Pro (Khuyên dùng - IQ cao)", id: "deepseek-ai/deepseek-v4-pro" },
  { name: "DeepSeek V4 Flash (Khuyên dùng - Nhanh)", id: "deepseek-ai/deepseek-v4-flash" },
  { name: "DeepSeek V3.2", id: "deepseek-ai/deepseek-v3.2" },
  { name: "Llama 3.1 405B (Meta - Siêu mạnh)", id: "meta/llama-3.1-405b-instruct" },
  { name: "Nemotron 3 Super 120B (NVIDIA - Chuẩn)", id: "nvidia/nemotron-3-super-120b-a12b" },
  { name: "Nemotron 3 Nano 30B", id: "nvidia/nemotron-3-nano-30b" },
  { name: "Qwen 3.5 397B", id: "qwen/qwen3.5-397b-a17b" },
  { name: "Qwen 3.5 122B", id: "qwen/qwen3.5-122b-a20b" },
  { name: "Kimi K2.5 (Moonshot)", id: "moonshotai/kimi-k2.5" },
  { name: "Kimi K2 Thinking", id: "moonshotai/kimi-k2-thinking" },
  { name: "GLM 5.1 (Zhipu)", id: "z-ai/glm-5.1" },
  { name: "GLM 4.7", id: "z-ai/glm-4.7" },
  { name: "Mistral Small 4", id: "mistralai/mistral-small-2409" },
  { name: "Devstral 2 123B", id: "mistralai/mistral-large-2407" },
  { name: "Gemma 4 31B IT", id: "google/gemma-2-27b-it" },
  { name: "MiniMax M2.7", id: "minimax/minimax-01" },
  { name: "Step 3.5 Flash (Không hỗ trợ Agent)", id: "stepfun/step-1.5v-flash" }
];

console.clear();
console.log(`${colors.cyan}${colors.bold}==========================================${colors.reset}`);
console.log(`${colors.cyan}${colors.bold}       NVIDIA NIM AGENT CLI v1.1          ${colors.reset}`);
console.log(`${colors.cyan}${colors.bold}==========================================${colors.reset}\n`);

console.log("Danh sách mô hình:");
models.forEach((m, idx) => console.log(`  ${colors.yellow}[${idx + 1}]${colors.reset} ${m.name}`));
console.log(`  ${colors.red}[0] Thoát${colors.reset}`);

rl.question(`\nChọn mô hình (1-${models.length}) [Mặc định: 1]: `, (choice) => {
  if (choice === '0') { console.log("Tạm biệt!"); rl.close(); return; }
  const idx = parseInt(choice) - 1;
  const selectedModel = models[idx] ? models[idx].id : models[0].id;
  const modelName = models[idx] ? models[idx].name : models[0].name;

  console.log(`\n✅ Agent đã kích hoạt với: ${colors.green}${modelName}${colors.reset}`);
  console.log(`💡 Gõ 'exit' để thoát.\n`);

  // Bắt đầu vòng lặp Agent với model đã chọn
  agentLoop(selectedModel);
});

// 4. Vòng lặp Agent thực thụ
async function agentLoop(selectedModel) {
  let messages = [{ role: "system", content: "You are a powerful AI Agent. You can see local files and execute commands to solve tasks. Use your tools whenever needed." }];

  const askUser = () => {
    rl.question(`${colors.blue}${colors.bold}Bạn:${colors.reset} `, async (input) => {
      if (input.toLowerCase() === 'exit') return rl.close();
      messages.push({ role: "user", content: input });
      await runAgent();
    });
  };

  async function runAgent() {
    while (true) {
      process.stdout.write(`${colors.yellow}Đang suy nghĩ...${colors.reset}`);
      try {
        const response = await openai.chat.completions.create({ 
          model: selectedModel, 
          messages, 
          tools: tools_def 
        });
        const choice = response.choices[0];
        messages.push(choice.message);

        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);

        if (choice.message.tool_calls) {
          for (const toolCall of choice.message.tool_calls) {
            const funcName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            console.log(`\n${colors.yellow}🚀 Agent đang thực thi:${colors.reset} ${colors.bold}${funcName}${colors.reset}`);
            
            const result = await tools_impl[funcName](args);
            console.log(`${colors.green}✔ Kết quả:${colors.reset} ${result.substring(0, 100)}${result.length > 100 ? "..." : ""}`);
            console.log(`${colors.blue}🔄 Đang báo cáo kết quả cho AI...${colors.reset}`);
            
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
          }
        } else {
          console.log(`${colors.green}${colors.bold}NVIDIA:${colors.reset} ${choice.message.content}\n`);
          break;
        }
      } catch (error) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        console.log(`${colors.red}Lỗi:${colors.reset} ${error.message}\n`);
        break;
      }
    }
    askUser();
  }

  askUser();
}
