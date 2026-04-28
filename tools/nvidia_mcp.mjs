import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWorkspaceCore } from './agent-core.mjs';

const WORKSPACE = process.cwd();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const STATE_DIR = path.join(WORKSPACE, '.nvidia-agent');

loadEnv();

const workspaceCore = createWorkspaceCore({ workspace: WORKSPACE, appDir: APP_DIR, stateDir: STATE_DIR });
const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
});

function loadEnv() {
  for (const envPath of [path.join(WORKSPACE, '.env'), path.join(APP_DIR, '.env')]) {
    if (!fs.existsSync(envPath)) continue;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && value && !process.env[key]) process.env[key] = value;
    });
  }
}

const server = new Server({ name: "nvidia-nim-workspace", version: "2.1.0" }, { capabilities: { tools: {} } });

const toolDefs = [
  { name: "ask_nvidia", description: "Ask NVIDIA NIM models.", inputSchema: { type: "object", properties: { prompt: { type: "string" }, model: { type: "string" } }, required: ["prompt"] } },
  { name: "workspace_trust_status", description: "Show whether this workspace is trusted.", inputSchema: { type: "object", properties: {} } },
  { name: "project_indexer", description: "Index the workspace and return files, metadata, and entry points.", inputSchema: { type: "object", properties: { query: { type: "string" }, maxFiles: { type: "integer" }, includeContent: { type: "boolean" } } } },
  { name: "semantic_index", description: "Find relevant workspace chunks using lightweight semantic indexing.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" }, maxFiles: { type: "integer" } } } },
  { name: "git_context", description: "Read git branch/status/diff/log context.", inputSchema: { type: "object", properties: { includeDiff: { type: "boolean" }, includeLog: { type: "boolean" } } } },
  { name: "list_dir", description: "List workspace files/folders.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "read_file", description: "Read a text file with secret redaction.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, maxChars: { type: "integer" } }, required: ["filePath"] } },
  { name: "read_file_paged", description: "Read a line range from a large text file.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, startLine: { type: "integer" }, lineCount: { type: "integer" } }, required: ["filePath"] } },
  { name: "search_files", description: "Search text in workspace.", inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
  { name: "write_file", description: "Create a pending diff review for a full file write.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" }, reason: { type: "string" } }, required: ["filePath", "content"] } },
  { name: "apply_patch", description: "Create a pending diff review from exact text replacement.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["filePath", "find", "replace"] } },
  { name: "apply_pending_edit", description: "Apply a pending edit by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "discard_pending_edit", description: "Discard a pending edit by id without writing it.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "pending_edits", description: "List pending diff reviews.", inputSchema: { type: "object", properties: {} } },
  { name: "execute_command", description: "Run a short shell command in the trusted workspace.", inputSchema: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "integer" } }, required: ["command"] } },
  { name: "start_command_job", description: "Start a cancellable command job.", inputSchema: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "integer" } }, required: ["command"] } },
  { name: "command_job_status", description: "Get command job output/status.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "cancel_command_job", description: "Cancel command job.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  const name = request.params.name;
  try {
    let result;
    if (name === "ask_nvidia") {
      const response = await openai.chat.completions.create({
        model: args.model || "deepseek-ai/deepseek-v4-pro",
        messages: [{ role: "user", content: args.prompt }],
      });
      result = response.choices[0].message.content;
    } else if (name === 'workspace_trust_status') {
      result = workspaceCore.getWorkspaceTrustStatus();
    } else {
      result = await workspaceCore.callTool(name, args);
    }
    return { content: [{ type: "text", text: workspaceCore.toolResult(result) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
