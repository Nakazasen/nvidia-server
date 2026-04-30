import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

export function createWorkspaceCore({
  workspace = process.cwd(),
  appDir = process.cwd(),
  stateDir = path.join(appDir, '.nvidia-agent'),
  execTimeoutMs = 120000,
  maxToolResultChars = 120000,
  maxFileReadChars = 180000
} = {}) {
  let currentWorkspace = path.resolve(workspace);
  const trustFile = path.join(stateDir, 'trusted-workspaces.json');
  const pendingEdits = new Map();
  const commandJobs = new Map();
  fs.mkdirSync(stateDir, { recursive: true });

  function setWorkspace(nextWorkspace) {
    currentWorkspace = path.resolve(nextWorkspace);
    return getWorkspace();
  }

  function getWorkspace() {
    return currentWorkspace;
  }

  function truncate(value, limit = maxToolResultChars) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[TRUNCATED ${text.length - limit} chars]`;
  }

  function redactSecrets(text = '') {
    return String(text)
      .replace(/^(\s*[\w.-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE[_-]?KEY)[\w.-]*\s*=\s*)(.+)$/gim, '$1[REDACTED]')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
      .replace(/\b(?:sk|nvapi|nvidia)[-_][A-Za-z0-9._-]{16,}\b/gi, '[REDACTED_SECRET]');
  }

  function toolResult(value, limit = maxToolResultChars) {
    return truncate(redactSecrets(typeof value === 'string' ? value : JSON.stringify(value, null, 2)), limit);
  }

  function isPathInside(parentDir, childPath) {
    const rel = path.relative(path.resolve(parentDir), path.resolve(childPath));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function resolveWorkspacePath(inputPath = '.') {
    const resolved = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(currentWorkspace, inputPath));
    if (!isPathInside(currentWorkspace, resolved)) throw new Error(`Path is outside workspace: ${inputPath}`);
    return resolved;
  }

  function isLikelyTextFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return new Set([
      '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css', '.json', '.md',
      '.txt', '.yml', '.yaml', '.toml', '.env', '.gitignore', '.py', '.ps1', '.sh',
      '.java', '.go', '.rs', '.cpp', '.c', '.h', '.hpp', '.cs', '.xml', '.svg',
      '.sql', '.prisma', '.ini', '.conf', '.bat', '.cmd'
    ]).has(ext) || path.basename(filePath).startsWith('.');
  }

  function shouldSkipDir(name) {
    return new Set(['node_modules', '.git', 'dist', 'build', '.brain', '.nvidia-agent', '.next', 'coverage', '.venv', '__pycache__']).has(name);
  }

  function getFilesFlat(dir = currentWorkspace, baseDir = '') {
    const fullDirPath = path.isAbsolute(dir) ? dir : path.join(currentWorkspace, dir);
    if (!fs.existsSync(fullDirPath)) return [];
    let results = [];
    for (const item of fs.readdirSync(fullDirPath, { withFileTypes: true })) {
      if (item.isDirectory() && shouldSkipDir(item.name)) continue;
      const fullPath = path.join(fullDirPath, item.name);
      const relPath = path.join(baseDir, item.name);
      if (item.isDirectory()) results = results.concat(getFilesFlat(fullPath, relPath));
      else results.push({ name: item.name, path: fullPath, relPath, size: fs.statSync(fullPath).size });
    }
    return results;
  }

  function getFileTree(dir = currentWorkspace, depth = 0, maxDepth = 5) {
    if (depth > maxDepth) return [];
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(item => !shouldSkipDir(item.name))
        .map(item => {
          const fullPath = path.join(dir, item.name);
          return {
            name: item.name,
            path: fullPath,
            relPath: path.relative(currentWorkspace, fullPath),
            type: item.isDirectory() ? 'dir' : 'file',
            children: item.isDirectory() ? getFileTree(fullPath, depth + 1, maxDepth) : null
          };
        });
    } catch {
      return [];
    }
  }

  function loadTrustedWorkspaces() {
    try {
      const parsed = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
      return Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    } catch {
      return [];
    }
  }

  function saveTrustedWorkspaces(workspaces) {
    fs.mkdirSync(path.dirname(trustFile), { recursive: true });
    fs.writeFileSync(trustFile, JSON.stringify({ workspaces: [...new Set(workspaces.map(p => path.resolve(p)))] }, null, 2));
  }

  function isWorkspaceTrusted(workspaceArg = currentWorkspace) {
    if (process.env.NVIDIA_WORKSPACE_TRUST === 'always') return true;
    const resolved = path.resolve(workspaceArg);
    return loadTrustedWorkspaces().some(trusted => path.resolve(trusted) === resolved);
  }

  function setWorkspaceTrust(workspaceArg = currentWorkspace, trusted = true) {
    const resolved = path.resolve(workspaceArg);
    const workspaces = loadTrustedWorkspaces().filter(item => path.resolve(item) !== resolved);
    if (trusted) workspaces.push(resolved);
    saveTrustedWorkspaces(workspaces);
    return getWorkspaceTrustStatus(workspaceArg);
  }

  function getWorkspaceTrustStatus(workspaceArg = currentWorkspace) {
    return { workspace: path.resolve(workspaceArg), trusted: isWorkspaceTrusted(workspaceArg), trustFile };
  }

  function fileHash(filePath) {
    const data = fs.readFileSync(filePath);
    let hash = 0;
    for (const byte of data) hash = ((hash << 5) - hash + byte) >>> 0;
    return hash.toString(16).padStart(8, '0');
  }

  function makeUnifiedDiff(relPath, oldText, newText) {
    const oldLines = String(oldText || '').split(/\r?\n/);
    const newLines = String(newText || '').split(/\r?\n/);
    const lines = [`--- a/${relPath}`, `+++ b/${relPath}`];
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] === newLines[i]) {
        if (oldLines[i] !== undefined) lines.push(` ${oldLines[i]}`);
      } else {
        if (oldLines[i] !== undefined) lines.push(`-${oldLines[i]}`);
        if (newLines[i] !== undefined) lines.push(`+${newLines[i]}`);
      }
      if (lines.length > 500) {
        lines.push('[DIFF TRUNCATED]');
        break;
      }
    }
    return lines.join('\n');
  }

  function makeLineHunks(oldText, newText) {
    const oldLines = String(oldText || '').split(/\r?\n/);
    const newLines = String(newText || '').split(/\r?\n/);
    const hunks = [];
    let current = null;
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] === newLines[i]) {
        if (current) {
          hunks.push(current);
          current = null;
        }
        continue;
      }
      if (!current) {
        current = { id: `hunk_${hunks.length + 1}`, oldStart: i + 1, newStart: i + 1, oldLines: [], newLines: [] };
      }
      current.oldLines.push(oldLines[i] ?? null);
      current.newLines.push(newLines[i] ?? null);
    }
    if (current) hunks.push(current);
    return hunks.map(hunk => ({
      ...hunk,
      oldCount: hunk.oldLines.filter(line => line !== null).length,
      newCount: hunk.newLines.filter(line => line !== null).length,
      preview: [
        `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
        ...hunk.oldLines.filter(line => line !== null).map(line => `-${line}`),
        ...hunk.newLines.filter(line => line !== null).map(line => `+${line}`)
      ].join('\n')
    }));
  }

  function readFileTool({ filePath, path: inputPath, maxChars = maxFileReadChars }) {
    const resolved = resolveWorkspacePath(filePath || inputPath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath || inputPath}`);
    if (!isLikelyTextFile(resolved)) throw new Error(`Refusing to read likely-binary file: ${filePath || inputPath}`);
    return { path: resolved, relPath: path.relative(currentWorkspace, resolved), size: stat.size, content: truncate(redactSecrets(fs.readFileSync(resolved, 'utf8')), maxChars) };
  }

  function readFilePagedTool({ filePath, path: inputPath, startLine = 1, start_line, lineCount = 500, line_count }) {
    const resolved = resolveWorkspacePath(filePath || inputPath);
    if (!fs.statSync(resolved).isFile()) throw new Error(`Not a file: ${filePath || inputPath}`);
    if (!isLikelyTextFile(resolved)) throw new Error(`Refusing to read likely-binary file: ${filePath || inputPath}`);
    const lines = redactSecrets(fs.readFileSync(resolved, 'utf8')).split(/\r?\n/);
    const start = Math.max(1, Number(start_line || startLine) || 1);
    const count = Math.max(1, Math.min(Number(line_count || lineCount) || 500, 2000));
    return { path: resolved, relPath: path.relative(currentWorkspace, resolved), startLine: start, endLine: Math.min(lines.length, start + count - 1), totalLines: lines.length, content: lines.slice(start - 1, start - 1 + count).join('\n') };
  }

  function listDirTool({ dirPath = '.', path: inputPath = dirPath, maxDepth = 1 }) {
    const resolved = resolveWorkspacePath(inputPath);
    return fs.readdirSync(resolved, { withFileTypes: true })
      .filter(item => !shouldSkipDir(item.name))
      .map(item => {
        const fullPath = path.join(resolved, item.name);
        const stat = fs.statSync(fullPath);
        return { name: item.name, type: item.isDirectory() ? 'dir' : 'file', relPath: path.relative(currentWorkspace, fullPath), size: item.isDirectory() ? undefined : stat.size, children: item.isDirectory() && maxDepth > 1 ? listDirTool({ path: fullPath, maxDepth: maxDepth - 1 }) : undefined };
      });
  }

  function searchFiles({ query, path: searchPath = '.', limit = 100 }) {
    if (!query) throw new Error('query is required');
    const root = resolveWorkspacePath(searchPath);
    const results = [];
    const lowerQuery = query.toLowerCase();
    for (const file of getFilesFlat(root)) {
      if (results.length >= limit) break;
      if (!isLikelyTextFile(file.path)) continue;
      try {
        const content = redactSecrets(fs.readFileSync(file.path, 'utf8'));
        content.split(/\r?\n/).forEach((line, index) => {
          if (results.length < limit && line.toLowerCase().includes(lowerQuery)) {
            results.push({ file: path.relative(currentWorkspace, file.path), path: file.path, line: index + 1, content: redactSecrets(line.trim()) });
          }
        });
      } catch {
        // Ignore unreadable files.
      }
    }
    return results;
  }

  function projectIndexerTool({ query = '', maxFiles = 200, includeContent = false } = {}) {
    const files = getFilesFlat(currentWorkspace);
    const textFiles = files.filter(f => isLikelyTextFile(f.path));
    const lowerQuery = String(query || '').toLowerCase();
    const relevant = lowerQuery ? textFiles.filter(f => f.relPath.toLowerCase().includes(lowerQuery) || f.name.toLowerCase().includes(lowerQuery)).slice(0, maxFiles) : textFiles.slice(0, maxFiles);
    const summary = { workspace: currentWorkspace, totalFiles: files.length, textFiles: textFiles.length, topLevel: listDirTool({ path: '.', maxDepth: 1 }), relevantFiles: relevant.map(f => ({ relPath: f.relPath, size: f.size })) };
    if (includeContent) summary.content = relevant.slice(0, 12).map(f => readFileTool({ filePath: f.relPath, maxChars: 30000 }));
    return summary;
  }

  function semanticIndexTool({ query = '', limit = 20, maxFiles = 400 } = {}) {
    const textFiles = getFilesFlat(currentWorkspace)
      .filter(f => isLikelyTextFile(f.path))
      .slice(0, Math.max(1, Math.min(Number(maxFiles) || 400, 2000)));
    const terms = String(query || '').toLowerCase().split(/[^a-z0-9_.$-]+/).filter(Boolean);
    const chunks = [];
    for (const file of textFiles) {
      try {
        const lines = redactSecrets(fs.readFileSync(file.path, 'utf8')).split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 80) {
          const text = lines.slice(i, i + 80).join('\n');
          const lower = text.toLowerCase();
          const score = terms.length ? terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0) : 0;
          if (!terms.length || score > 0) {
            chunks.push({
              file: path.relative(currentWorkspace, file.path),
              path: file.path,
              startLine: i + 1,
              endLine: Math.min(lines.length, i + 80),
              score,
              preview: truncate(text, 1200)
            });
          }
        }
      } catch {
        // Ignore unreadable files.
      }
    }
    return chunks.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
  }

  function gitContextTool({ includeDiff = true, includeLog = true } = {}) {
    const run = command => new Promise(resolve => {
      exec(command, { cwd: currentWorkspace, timeout: 30000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, command, stdout: truncate(redactSecrets(stdout || ''), 40000), stderr: truncate(redactSecrets(stderr || ''), 10000), error: err ? err.message : null });
      });
    });
    return Promise.all([
      run('git status --short --branch'),
      includeDiff ? run('git diff --stat') : Promise.resolve(null),
      includeDiff ? run('git diff -- .') : Promise.resolve(null),
      includeLog ? run('git log --oneline -n 20') : Promise.resolve(null)
    ]).then(([status, diffStat, diff, log]) => ({ status, diffStat, diff, log }));
  }

  function createPendingEdit({ filePath, path: inputPath, content, oldContent = null, reason = '' }) {
    if (!isWorkspaceTrusted()) throw new Error('Workspace is not trusted. Trust it before proposing edits.');
    if (typeof content !== 'string') throw new Error('content must be a string');
    const resolved = resolveWorkspacePath(filePath || inputPath);
    const relPath = path.relative(currentWorkspace, resolved);
    const previous = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
    const id = `edit_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    if (oldContent !== null && previous !== oldContent) return { ok: false, conflict: true, relPath, message: 'The file changed since the proposed oldContent snapshot. Re-read the file before editing.' };
    const edit = { id, filePath: resolved, relPath, content, reason, createdAt: new Date().toISOString(), beforeContent: previous, before: fs.existsSync(resolved) ? { existed: true, bytes: fs.statSync(resolved).size, hash: fileHash(resolved) } : { existed: false, bytes: 0, hash: null }, after: { bytes: Buffer.byteLength(content) }, diff: makeUnifiedDiff(relPath, previous, content), hunks: makeLineHunks(previous, content) };
    pendingEdits.set(id, edit);
    return { ok: true, pendingEdit: edit };
  }

  function applyPatchTool({ filePath, path: inputPath, find, replace, replacements, reason = '' }) {
    const resolved = resolveWorkspacePath(filePath || inputPath);
    if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${filePath || inputPath}`);
    if (!isLikelyTextFile(resolved)) throw new Error(`Refusing to patch likely-binary file: ${filePath || inputPath}`);
    let next = fs.readFileSync(resolved, 'utf8');
    const ops = Array.isArray(replacements) ? replacements : [{ find, replace }];
    for (const op of ops) {
      if (typeof op.find !== 'string' || typeof op.replace !== 'string') throw new Error('Each replacement requires find and replace strings');
      if (!next.includes(op.find)) throw new Error(`Patch find text not found in ${filePath || inputPath}: ${op.find.slice(0, 120)}`);
      next = next.replace(op.find, op.replace);
    }
    return createPendingEdit({ filePath: filePath || inputPath, content: next, reason: reason || 'apply_patch' });
  }

  function applyPendingEditTool({ id, hunkIds = null }) {
    if (!isWorkspaceTrusted()) throw new Error('Workspace is not trusted.');
    const edit = pendingEdits.get(id);
    if (!edit) throw new Error(`Pending edit not found: ${id}`);
    fs.mkdirSync(path.dirname(edit.filePath), { recursive: true });
    let nextContent = edit.content;
    if (Array.isArray(hunkIds) && Array.isArray(edit.hunks) && edit.hunks.length > 0) {
      const selected = new Set(hunkIds);
      const oldLines = String(edit.beforeContent || '').split(/\r?\n/);
      const output = [];
      let cursor = 0;
      for (const hunk of edit.hunks) {
        const start = Math.max(0, hunk.oldStart - 1);
        while (cursor < start) output.push(oldLines[cursor++]);
        const oldSpan = hunk.oldLines.length;
        if (selected.has(hunk.id)) {
          output.push(...hunk.newLines.filter(line => line !== null));
        } else {
          output.push(...oldLines.slice(start, start + oldSpan));
        }
        cursor = start + oldSpan;
      }
      output.push(...oldLines.slice(cursor));
      nextContent = output.join('\n');
    }
    fs.writeFileSync(edit.filePath, nextContent);
    pendingEdits.delete(id);
    return { ok: true, id, relPath: edit.relPath, before: edit.before, after: { bytes: fs.statSync(edit.filePath).size, hash: fileHash(edit.filePath) } };
  }

  function discardPendingEditTool({ id }) {
    const edit = pendingEdits.get(id);
    if (!edit) throw new Error(`Pending edit not found: ${id}`);
    pendingEdits.delete(id);
    return { ok: true, id, relPath: edit.relPath, discarded: true };
  }

  function listPendingEditsTool() {
    return Array.from(pendingEdits.values()).map(edit => ({ id: edit.id, relPath: edit.relPath, reason: edit.reason, createdAt: edit.createdAt, before: edit.before, after: edit.after, beforeContent: edit.beforeContent, content: edit.content, diff: edit.diff, hunks: edit.hunks }));
  }

  function executeCommandTool({ command, timeoutMs = execTimeoutMs }) {
    if (!isWorkspaceTrusted()) throw new Error('Workspace is not trusted. Trust it before running commands.');
    if (!command || typeof command !== 'string') throw new Error('command is required');
    return new Promise(resolve => {
      exec(command, { cwd: currentWorkspace, timeout: Math.min(Math.max(Number(timeoutMs) || execTimeoutMs, 1000), 300000), maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, command, cwd: currentWorkspace, exitCode: err?.code ?? 0, signal: err?.signal, stdout: truncate(redactSecrets(stdout || ''), 80000), stderr: truncate(redactSecrets(stderr || ''), 80000), error: err ? err.message : null, observation: err ? 'Command failed. Analyze stdout/stderr, update your hypothesis, and try the smallest corrective next action.' : 'Command succeeded.' });
      });
    });
  }

  function startCommandJobTool({ command, timeoutMs = execTimeoutMs }) {
    if (!isWorkspaceTrusted()) throw new Error('Workspace is not trusted. Trust it before running commands.');
    if (!command || typeof command !== 'string') throw new Error('command is required');
    const id = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const job = { id, command, cwd: currentWorkspace, status: 'running', startedAt: new Date().toISOString(), stdout: '', stderr: '', exitCode: null, signal: null, error: null };
    const child = exec(command, { cwd: currentWorkspace, timeout: Math.min(Math.max(Number(timeoutMs) || execTimeoutMs, 1000), 3600000), maxBuffer: 50 * 1024 * 1024, windowsHide: true }, err => {
      job.exitCode = err?.code ?? 0;
      job.signal = err?.signal || null;
      job.error = err ? err.message : null;
      job.status = err ? (err.killed ? 'cancelled' : 'failed') : 'completed';
      job.finishedAt = new Date().toISOString();
      job.child = null;
    });
    job.child = child;
    child.stdout?.on('data', chunk => { job.stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { job.stderr += chunk.toString(); });
    commandJobs.set(id, job);
    return { ok: true, id, status: job.status, command, cwd: currentWorkspace };
  }

  function commandJobStatusTool({ id, stdoutOffset = 0, stderrOffset = 0 } = {}) {
    const maxChunkChars = 80000;
    if (id) {
      const job = commandJobs.get(id);
      if (!job) throw new Error(`Command job not found: ${id}`);
      const safeStdoutOffset = Math.max(0, Math.min(Number(stdoutOffset) || 0, job.stdout.length));
      const safeStderrOffset = Math.max(0, Math.min(Number(stderrOffset) || 0, job.stderr.length));
      const stdoutSlice = job.stdout.slice(safeStdoutOffset);
      const stderrSlice = job.stderr.slice(safeStderrOffset);
      const stdoutRawChunk = stdoutSlice.slice(0, maxChunkChars);
      const stderrRawChunk = stderrSlice.slice(0, maxChunkChars);
      return {
        ...job,
        child: undefined,
        stdout: redactSecrets(stdoutRawChunk),
        stderr: redactSecrets(stderrRawChunk),
        stdoutNextOffset: safeStdoutOffset + stdoutRawChunk.length,
        stderrNextOffset: safeStderrOffset + stderrRawChunk.length,
        stdoutLength: job.stdout.length,
        stderrLength: job.stderr.length
      };
    }
    return Array.from(commandJobs.values()).map(job => ({ id: job.id, command: job.command, cwd: job.cwd, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, exitCode: job.exitCode, signal: job.signal, stdoutLength: job.stdout.length, stderrLength: job.stderr.length }));
  }

  function cancelCommandJobTool({ id }) {
    const job = commandJobs.get(id);
    if (!job) throw new Error(`Command job not found: ${id}`);
    if (job.status !== 'running' || !job.child) return { ok: true, id, status: job.status, message: 'Job is not running.' };
    job.child.kill();
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    return { ok: true, id, status: job.status };
  }

  async function callTool(name, args = {}) {
    if (name === 'project_indexer') return projectIndexerTool(args);
    if (name === 'semantic_index') return semanticIndexTool(args);
    if (name === 'git_context') return gitContextTool(args);
    if (name === 'list_dir') return listDirTool(args);
    if (name === 'read_file') return readFileTool(args);
    if (name === 'read_file_paged') return readFilePagedTool(args);
    if (name === 'write_file') return createPendingEdit(args);
    if (name === 'apply_patch') return applyPatchTool(args);
    if (name === 'apply_pending_edit') return applyPendingEditTool(args);
    if (name === 'discard_pending_edit') return discardPendingEditTool(args);
    if (name === 'pending_edits') return listPendingEditsTool(args);
    if (name === 'search_files' || name === 'search' || name === 'grep_search') return searchFiles(args);
    if (name === 'execute_command') return executeCommandTool(args);
    if (name === 'start_command_job') return startCommandJobTool(args);
    if (name === 'command_job_status') return commandJobStatusTool(args);
    if (name === 'cancel_command_job') return cancelCommandJobTool(args);
    throw new Error(`Unknown workspace core tool: ${name}`);
  }

  return {
    setWorkspace, getWorkspace, truncate, redactSecrets, toolResult, isPathInside,
    resolveWorkspacePath, isLikelyTextFile, shouldSkipDir, getFilesFlat, getFileTree,
    isWorkspaceTrusted, setWorkspaceTrust, getWorkspaceTrustStatus,
    fileHash, makeUnifiedDiff, makeLineHunks, readFileTool, readFilePagedTool, listDirTool, searchFiles,
    projectIndexerTool, semanticIndexTool, gitContextTool, createPendingEdit, applyPatchTool, applyPendingEditTool, discardPendingEditTool,
    listPendingEditsTool, executeCommandTool, startCommandJobTool, commandJobStatusTool,
    cancelCommandJobTool, callTool
  };
}
