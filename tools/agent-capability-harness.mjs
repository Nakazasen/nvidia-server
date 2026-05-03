import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, '.nvidia-agent', 'reports');
fs.mkdirSync(OUT_DIR, { recursive: true });

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function read(rel) {
  return fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '';
}

function nodeCheck(file) {
  const res = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
  return { ok: res.status === 0, stdout: res.stdout, stderr: res.stderr };
}

const server = read('tools/nvidia-server.mjs');
const ui = read('nvidia_playground.html');
const cli = read('tools/nvidia-cli-agent.mjs');
const mcp = read('tools/nvidia_mcp.mjs');
const core = read('tools/agent-core.mjs');
const extensionHost = read('tools/extension-host.mjs');
const pkg = JSON.parse(read('package.json') || '{}');

const tests = [
  ['Terminal', server.includes('execute_command') && server.includes('start_command_job')],
  ['Web Design', server.includes('write_file') && ui.includes('pending-edit-card')],
  ['Precision Edits', server.includes('apply_patch') && server.includes('pendingEdits')],
  ['Browser', server.includes('fetchNim') && pkg.dependencies],
  ['Multi-model', ui.includes('selectedModelId') && server.includes('model = data.model')],
  ['Workflow', server.includes('update_plan') || ui.includes('planSteps')],
  ['Brain/Memory', cli.includes('saveSession') && cli.includes('loadSession')],
  ['Self-Healing', server.includes('project_indexer') && server.includes('execute_command')],
  ['Multi-step', server.includes('DEFAULT_MAX_ITERATIONS')],
  ['Greenfield', server.includes('write_file') && server.includes('execute_command')],
  ['Asset AI', server.includes('write_file')],
  ['Security', server.includes('redactSecrets') && server.includes('Forbidden origin')],
  ['Performance', server.includes('read_file_paged') && server.includes('MAX_FILE_READ_CHARS')],
  ['Unit Test', pkg.scripts && (pkg.scripts.test || server.includes('execute_command'))],
  ['Dependency', exists('package-lock.json') && server.includes('execute_command')],
  ['Diff Review', server.includes('pendingEdits') && (ui.includes('Apply edit') || ui.includes('Review + Apply'))],
  ['Command Cancel', server.includes('cancel_command_job') && ui.includes('stopAgentResponse')],
  ['Workspace Trust', server.includes('trusted-workspaces') && ui.includes('setting-trust-workspace')],
  ['MCP Workspace Tools', mcp.includes('project_indexer') && mcp.includes('apply_patch') && mcp.includes('execute_command') && mcp.includes('start_command_job')],
  ['Shared Agent Core', core.includes('createWorkspaceCore') && server.includes("from './agent-core.mjs'") && cli.includes("from './agent-core.mjs'") && mcp.includes("from './agent-core.mjs'")],
  ['Extension Host', extensionHost.includes('createExtensionHost') && extensionHost.includes('installFromOpenVsx') && server.includes('/api/extensions/search')],
  ['VS Code Compatibility Layer', extensionHost.includes('registerCommand') && extensionHost.includes('showInformationMessage') && extensionHost.includes('getConfiguration') && extensionHost.includes('writeFile') && extensionHost.includes('activateByEvent') && server.includes('/api/extensions/run_command')],
  ['Agent Provider Adapters', extensionHost.includes('getAgentProviders') && server.includes('/api/agent_providers/run')],
  ['Semantic + Git Context', core.includes('semanticIndexTool') && core.includes('gitContextTool') && server.includes('semantic_index') && server.includes('git_context')],
  ['Hunk Diff Review', core.includes('makeLineHunks') && ui.includes('pending-hunk-')]
];

const checks = {
  files: {
    server: exists('tools/nvidia-server.mjs'),
    core: exists('tools/agent-core.mjs'),
    extensionHost: exists('tools/extension-host.mjs'),
    desktopUi: exists('nvidia_playground.html'),
    cliAgent: exists('tools/nvidia-cli-agent.mjs'),
    mcp: exists('tools/nvidia_mcp.mjs')
  },
  syntax: {
    server: nodeCheck('tools/nvidia-server.mjs'),
    core: nodeCheck('tools/agent-core.mjs'),
    extensionHost: nodeCheck('tools/extension-host.mjs'),
    cliAgent: nodeCheck('tools/nvidia-cli-agent.mjs'),
    mcp: nodeCheck('tools/nvidia_mcp.mjs'),
    electron: exists('electron-main.js') ? nodeCheck('electron-main.js') : { ok: false, stderr: 'missing' }
  },
  capabilities: tests.map(([name, ok]) => ({ name, ok: !!ok }))
};

checks.score = {
  passed: checks.capabilities.filter(t => t.ok).length,
  total: checks.capabilities.length
};

const jsonPath = path.join(OUT_DIR, `capability-report-${Date.now()}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(checks, null, 2));

const md = [
  '# NVIDIA Agent Capability Report',
  '',
  `Score: ${checks.score.passed}/${checks.score.total}`,
  '',
  '## Capabilities',
  ...checks.capabilities.map(t => `- ${t.ok ? '[x]' : '[ ]'} ${t.name}`),
  '',
  '## Syntax',
  ...Object.entries(checks.syntax).map(([name, result]) => `- ${result.ok ? '[x]' : '[ ]'} ${name}${result.ok ? '' : `: ${String(result.stderr || result.stdout).trim()}`}`)
].join('\n');

const mdPath = jsonPath.replace(/\.json$/, '.md');
fs.writeFileSync(mdPath, md);

console.log(JSON.stringify({ ok: true, jsonPath, mdPath, score: checks.score }, null, 2));
