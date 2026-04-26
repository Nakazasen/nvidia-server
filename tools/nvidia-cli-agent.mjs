import OpenAI from "openai";
import readline from "readline";
import { exec } from "child_process";
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// --- 1. Cấu hình & Khởi tạo ---
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const colors = { cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m", reset: "\x1b[0m" };

// --- 2. Định nghĩa các Tools (Công cụ) ---
const tools_logic = {
  update_plan: (args) => {
    console.log(`\n${colors.cyan}${colors.bold}📋 KẾ HOẠCH HÀNH ĐỘNG:${colors.reset}`);
    args.steps.forEach((step, i) => console.log(`${colors.cyan}  ${i + 1}. [ ] ${step}${colors.reset}`));
    return "Plan updated visually.";
  },
  list_dir: (args) => JSON.stringify(fs.readdirSync(args.dirPath || '.'), null, 2),
  read_file: (args) => fs.readFileSync(args.filePath, 'utf8'),
  read_file_paged: (args) => {
    const content = fs.readFileSync(args.filePath, 'utf8').split('\n');
    const start = args.start_line || 1;
    const count = args.line_count || 500;
    return content.slice(start - 1, start - 1 + count).join('\n');
  },
  write_file: async (args) => {
    if (!autoAccept) {
      const answer = await new Promise(resolve => {
        rl.question(`${colors.yellow}[BẢO MẬT] Agent muốn GHI vào file: ${args.filePath}\nBạn có đồng ý không? (y/n): ${colors.reset}`, resolve);
      });
      if (answer.toLowerCase() !== 'y') return "User denied file write.";
    }
    fs.writeFileSync(args.filePath, args.content);
    return "File written successfully.";
  },
  execute_command: async (args) => {
    if (!autoAccept) {
      const answer = await new Promise(resolve => {
        rl.question(`${colors.yellow}[BẢO MẬT] Agent muốn CHẠY lệnh: ${args.command}\nBạn có đồng ý không? (y/n): ${colors.reset}`, resolve);
      });
      if (answer.toLowerCase() !== 'y') return "User denied command execution.";
    }
    return new Promise(resolve => {
      exec(args.command, (error, stdout, stderr) => {
        if (error) resolve(`Error: ${error.message}\n${stderr}`);
        else resolve(stdout || "Success");
      });
    });
  }
};

const tools_def = [
  { type: "function", function: { name: "update_plan", description: "Cập nhật kế hoạch", parameters: { type: "object", properties: { steps: { type: "array", items: { type: "string" } } } } } },
  { type: "function", function: { name: "list_dir", description: "Liệt kê file", parameters: { type: "object", properties: { dirPath: { type: "string" } } } } },
  { type: "function", function: { name: "read_file", description: "Đọc file nhỏ", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
  { type: "function", function: { name: "read_file_paged", description: "Đọc file lớn", parameters: { type: "object", properties: { filePath: { type: "string" }, start_line: { type: "integer" }, line_count: { type: "integer" } }, required: ["filePath"] } } },
  { type: "function", function: { name: "write_file", description: "Ghi file", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
  { type: "function", function: { name: "execute_command", description: "Chạy lệnh", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }
];

let models = [];

async function fetchModels() {
  process.stdout.write(`${colors.yellow}⏳ Đang nạp danh sách mô hình từ NVIDIA...${colors.reset}\r`);
  try {
    const response = await openai.models.list();
    models = response.data.sort((a, b) => a.id.localeCompare(b.id)).map(m => ({ name: m.id, id: m.id }));
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  } catch (e) {
    models = [{ name: "DeepSeek V4 Flash (Fallback)", id: "deepseek-ai/deepseek-v4-flash" }];
  }
}

let autoAccept = false;

function showMenu() {
  console.log(`\n${colors.cyan}${colors.bold}==========================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}       NVIDIA NIM AGENT CLI v1.10          ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}==========================================${colors.reset}`);
  console.log("Danh sách mô hình:");
  models.forEach((m, i) => console.log(`  [${i + 1}] ${m.name}`));
  rl.question(`\nChọn mô hình (1-${models.length}) [Mặc định: 1]: `, (choice) => {
    const idx = parseInt(choice) - 1 || 0;
    rl.question(`Bật chế độ Tự động duyệt (Auto-Accept)? (y/n): `, (aa) => {
      autoAccept = aa.toLowerCase() === 'y';
      agentLoop(models[idx].id);
    });
  });
}

async function agentLoop(selectedModel) {
  console.log(`\n${colors.green}✅ Agent kích hoạt: ${selectedModel}${colors.reset}`);
  const loop = () => {
    rl.question(`\n${colors.bold}Bạn:${colors.reset} `, async (input) => {
      if (input.toLowerCase() === 'exit') process.exit();
      if (input.toLowerCase() === 'menu') return showMenu();
      
      try {
        // System Prompt ép AI lập kế hoạch
        const systemMsg = { role: 'system', content: 'Bạn là một Agent thông minh. Trước khi thực hiện các tác vụ phức tạp, bạn PHẢI gọi công cụ update_plan để hiển thị các bước thực hiện cho người dùng.' };
        
        let response = await openai.chat.completions.create({
          model: selectedModel,
          messages: [systemMsg, { role: "user", content: input }],
          tools: tools_def
        });

        let msg = response.choices[0].message;
        while (msg.tool_calls) {
          const results = [];
          for (const tc of msg.tool_calls) {
            console.log(`${colors.yellow}🚀 Thực thi: ${tc.function.name}${colors.reset}`);
            const res = await tools_logic[tc.function.name](JSON.parse(tc.function.arguments));
            results.push({ tool_call_id: tc.id, role: "tool", name: tc.function.name, content: res });
          }
          response = await openai.chat.completions.create({
            model: selectedModel,
            messages: [systemMsg, { role: "user", content: input }, msg, ...results],
            tools: tools_def
          });
          msg = response.choices[0].message;
        }
        console.log(`\n${colors.bold}Agent:${colors.reset} ${msg.content}`);
        loop();
      } catch (e) { console.log(`${colors.red}Lỗi: ${e.message}${colors.reset}`); loop(); }
    });
  };
  loop();
}

async function start() { await fetchModels(); showMenu(); }
start();
