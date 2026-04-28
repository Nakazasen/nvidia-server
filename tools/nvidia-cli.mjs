import fs from 'fs';
import readline from 'readline';
import OpenAI from "openai";
import path from 'path';
import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import ora from 'ora';
import boxen from 'boxen';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

// Cấu hình Markdown Renderer cho Terminal
marked.setOptions({
  renderer: new TerminalRenderer({
    codespan: chalk.yellow,
    firstHeading: chalk.green.bold,
    strong: chalk.bold.cyan,
    em: chalk.italic.magenta,
  })
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');

const SKILLS_DIR = path.join(APP_DIR, 'skills');
const currentWorkspace = process.cwd();

// Tự động đọc file .env
const envPaths = [
  path.join(process.cwd(), '.env'),
  path.join(APP_DIR, '.env'),
  path.join(path.dirname(process.execPath), '.env')
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    env.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value && !process.env[key.trim()]) process.env[key.trim()] = value.trim();
    });
  }
}

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

const tools_def = [
    { type: "function", function: { name: "list_dir", description: "Liệt kê tệp/thư mục", parameters: { type: "object", properties: { dirPath: { type: "string" } } } } },
    { type: "function", function: { name: "read_file", description: "Đọc tệp", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
    { type: "function", function: { name: "write_file", description: "Ghi tệp", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
    { type: "function", function: { name: "execute_command", description: "Thực thi lệnh hệ thống", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }
];

const models = [
  { name: "DeepSeek V3", id: "deepseek-ai/deepseek-v3" },
  { name: "Llama 3.1 8B (Fast)", id: "meta/llama-3.1-8b-instruct" },
  { name: "Llama 3.1 405B (Meta)", id: "meta/llama-3.1-405b-instruct" }
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.clear();
console.log(boxen(chalk.green.bold("NVIDIA NIM AGENT CLI v3.0\n") + chalk.white("Agentic - Pro UI - Global Context"), {
    padding: 1,
    margin: 1,
    borderStyle: 'double',
    borderColor: 'green'
}));

console.log("Danh sách mô hình:");
models.forEach((m, idx) => console.log(`  ${chalk.yellow(`[${idx + 1}]`)} ${m.name}`));

rl.question(`\nChọn mô hình (1-${models.length}) [Mặc định: 1]: `, (choice) => {
  const idx = (parseInt(choice) || 1) - 1;
  const selectedModel = models[idx] ? models[idx].id : models[0].id;
  const modelName = models[idx] ? models[idx].name : models[0].name;

  console.log(`\n✅ Đã kích hoạt Agent: ${chalk.green.bold(modelName)}`);
  console.log(`💡 Mẹo: Dùng ${chalk.yellow("@filename")} để đính kèm file. Gõ ${chalk.red("'exit'")} để thoát.\n`);

  let messages = [
      { role: "system", content: "Bạn là một AI Coding Assistant mạnh mẽ có quyền truy cập hệ thống file và terminal qua tools. Hãy luôn giải quyết vấn đề của người dùng một cách triệt để." }
  ];

  const chatLoop = async () => {
    rl.question(chalk.blue.bold("Bạn: "), async (input) => {
      let text = input.trim();
      
      if (text.toLowerCase() === 'exit') {
        console.log(chalk.yellow("Tạm biệt!"));
        rl.close();
        return;
      }
      
      if (!text) { chatLoop(); return; }

      // Xử lý Slash Command
      if (text.startsWith('/')) {
          const parts = text.split(' ');
          const cmd = parts[0].substring(1);
          const skillFile = path.join(SKILLS_DIR, `${cmd}.md`);
          
          if (fs.existsSync(skillFile)) {
              console.log(chalk.magenta(`[Skill] Đã kích hoạt workflow: /${cmd}`));
              const skillContent = fs.readFileSync(skillFile, 'utf8');
              messages.push({ 
                  role: "system", 
                  content: `Bạn đang thực hiện workflow: ${cmd}. Hướng dẫn chi tiết:\n${skillContent}` 
              });
              text = parts.slice(1).join(' ').trim() || "Bắt đầu workflow.";
          } else {
              console.log(chalk.red(`[Lỗi] Không tìm thấy kỹ năng: /${cmd}`));
              chatLoop();
              return;
          }
      }

      // Xử lý @ mention
      const mentions = text.match(/@(\S+)/g);
      if (mentions) {
          for (const m of mentions) {
              const filename = m.substring(1);
              const filepath = path.resolve(currentWorkspace, filename);
              if (fs.existsSync(filepath)) {
                  const content = fs.readFileSync(filepath, 'utf8');
                  messages.push({ role: "system", content: `Dưới đây là nội dung file ${filename} để tham khảo:\n\`\`\`\n${content}\n\`\`\`` });
                  text = text.replace(m, `[File: ${filename}]`);
              } else {
                  console.log(chalk.yellow(`[Cảnh báo] Không tìm thấy file: ${filename}`));
              }
          }
      }

      messages.push({ role: "user", content: text });
      
      const spinner = ora(chalk.yellow('AI đang suy nghĩ...')).start();

      try {
        while(true) {
            const response = await openai.chat.completions.create({
              model: selectedModel,
              messages: messages,
              tools: tools_def,
              tool_choice: "auto"
            });

            const msg = response.choices[0].message;
            messages.push(msg);

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    const name = tc.function.name;
                    const args = JSON.parse(tc.function.arguments);
                    spinner.text = chalk.cyan(`Đang thực thi: ${name}...`);
                    
                    let result = "";
                    try {
                        if (name === 'list_dir') result = fs.readdirSync(args.dirPath || '.').join('\n');
                        else if (name === 'read_file') result = fs.readFileSync(args.filePath || args.path, 'utf8');
                        else if (name === 'write_file') { fs.writeFileSync(args.filePath || args.path, args.content); result = "Ghi file thành công."; }
                        else if (name === 'execute_command') {
                            result = await new Promise(resolve => {
                                exec(args.command, { cwd: currentWorkspace }, (err, out, serr) => {
                                    resolve((out || "") + (serr || "") + (err ? `\nLỗi: ${err.message}` : ""));
                                });
                            });
                        }
                    } catch (e) { result = `Lỗi: ${e.message}`; }

                    messages.push({ role: "tool", tool_call_id: tc.id, content: result });
                }
            } else {
                spinner.stop();
                console.log(boxen(marked(msg.content || ""), {
                    padding: 1,
                    borderColor: 'green',
                    title: 'NVIDIA AI',
                    titleAlignment: 'center'
                }));
                break;
            }
        }
      } catch (error) {
        spinner.fail(chalk.red(`Lỗi: ${error.message}`));
      }
      
      chatLoop();
    });
  };

  chatLoop();
});
