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
  const indexDir = path.join(stateDir, 'index');
  const indexMetaPath = path.join(indexDir, 'index-meta.json');
  const indexFilesPath = path.join(indexDir, 'index-files.json');
  const indexChunksPath = path.join(indexDir, 'index-chunks.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });

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

  function detectLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
      '.ts': 'typescript', '.tsx': 'typescript', '.py': 'python', '.md': 'markdown',
      '.json': 'json', '.html': 'html', '.css': 'css', '.yml': 'yaml', '.yaml': 'yaml',
      '.sh': 'shell', '.ps1': 'powershell', '.go': 'go', '.rs': 'rust', '.java': 'java',
      '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp', '.sql': 'sql'
    };
    return map[ext] || (path.basename(filePath).toLowerCase() === 'readme.md' ? 'markdown' : 'text');
  }

  function shouldSkipIndexFile(file) {
    if (!file || !file.path) return true;
    if (!isLikelyTextFile(file.path)) return true;
    if (file.size > 1024 * 1024) return true;
    const lower = file.relPath.toLowerCase();
    if (lower.includes('.nvidia-agent\\') || lower.includes('.nvidia-agent/')) return true;
    if (lower.endsWith('.lock') || lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.pdf') || lower.endsWith('.zip') || lower.endsWith('.vsix')) return true;
    return false;
  }

  function tokenize(text = '') {
    return String(text)
      .toLowerCase()
      .split(/[^a-z0-9_.$-]+/)
      .filter(Boolean)
      .slice(0, 5000);
  }

  function buildTokenFreq(tokens = []) {
    const freq = {};
    for (const token of tokens) {
      freq[token] = (freq[token] || 0) + 1;
      if (Object.keys(freq).length > 160) break;
    }
    return freq;
  }

  function makeChunks(relPath, content, chunkSize = 60, overlap = 10) {
    const lines = String(content || '').split(/\r?\n/);
    const chunks = [];
    let start = 0;
    while (start < lines.length) {
      const end = Math.min(lines.length, start + chunkSize);
      const text = lines.slice(start, end).join('\n');
      const tokens = tokenize(text);
      chunks.push({
        id: `${relPath}:${start + 1}-${end}`,
        relPath,
        startLine: start + 1,
        endLine: end,
        preview: truncate(text, 300),
        tokenFreq: buildTokenFreq(tokens)
      });
      if (end >= lines.length) break;
      start = Math.max(start + 1, end - overlap);
    }
    return chunks;
  }

  function loadIndexCache() {
    try {
      if (!fs.existsSync(indexMetaPath) || !fs.existsSync(indexFilesPath) || !fs.existsSync(indexChunksPath)) {
        return null;
      }
      const meta = JSON.parse(fs.readFileSync(indexMetaPath, 'utf8'));
      const files = JSON.parse(fs.readFileSync(indexFilesPath, 'utf8'));
      const chunks = JSON.parse(fs.readFileSync(indexChunksPath, 'utf8'));
      return { meta, files, chunks };
    } catch {
      return null;
    }
  }

  function saveIndexCache(meta, files, chunks) {
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(indexMetaPath, JSON.stringify(meta, null, 2));
    fs.writeFileSync(indexFilesPath, JSON.stringify(files, null, 2));
    fs.writeFileSync(indexChunksPath, JSON.stringify(chunks, null, 2));
  }

  function getGitChangedFilesSet() {
    return new Promise(resolve => {
      exec('git status --short', { cwd: currentWorkspace, timeout: 10000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(new Set());
        const set = new Set();
        String(stdout || '').split(/\r?\n/).forEach(line => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const rel = trimmed.slice(3).trim();
          if (rel) set.add(rel.replace(/\\/g, '/'));
        });
        resolve(set);
      });
    });
  }

  async function buildIndexCache({ maxFiles = 1200, full = true } = {}) {
    const start = Date.now();
    const allFiles = getFilesFlat(currentWorkspace);
    const eligibleFiles = allFiles.filter(f => !shouldSkipIndexFile(f));
    const filesFlat = eligibleFiles.slice(0, Math.max(1, Math.min(Number(maxFiles) || 1200, 4000)));
    const previous = loadIndexCache();
    const previousFiles = new Map((previous?.files || []).map(item => [item.relPath, item]));
    const nextFiles = [];
    const nextChunks = [];
    const warnings = [];
    let skippedFiles = Math.max(0, allFiles.length - filesFlat.length);

    for (const file of filesFlat) {
      const stat = fs.statSync(file.path);
      const relPath = file.relPath.replace(/\\/g, '/');
      const signature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
      const prev = previousFiles.get(relPath);
      if (!full && prev && prev.signature === signature && Array.isArray(prev.chunkIds)) {
        nextFiles.push(prev);
        if (Array.isArray(previous?.chunks)) {
          const idSet = new Set(prev.chunkIds);
          previous.chunks.forEach(chunk => { if (idSet.has(chunk.id)) nextChunks.push(chunk); });
        }
        continue;
      }
      try {
        const content = redactSecrets(fs.readFileSync(file.path, 'utf8'));
        const chunkItems = makeChunks(relPath, content);
        nextChunks.push(...chunkItems);
        nextFiles.push({
          relPath,
          size: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs),
          signature,
          language: detectLanguage(file.path),
          hash: stat.size <= 512 * 1024 ? fileHash(file.path) : null,
          chunkIds: chunkItems.map(c => c.id)
        });
      } catch {
        skippedFiles += 1;
      }
    }

    const meta = {
      version: 1,
      workspace: currentWorkspace,
      lastIndexedAt: new Date().toISOString(),
      scannedFiles: allFiles.length,
      eligibleFiles: eligibleFiles.length,
      indexedFiles: nextFiles.length,
      chunks: nextChunks.length,
      skippedFiles,
      durationMs: Date.now() - start,
      warnings
    };
    saveIndexCache(meta, nextFiles, nextChunks);
    return { ok: true, status: 'ready', ...meta, errors: [] };
  }

  async function refreshIndexCache({ maxFiles = 1200 } = {}) {
    return buildIndexCache({ maxFiles, full: false });
  }

  function indexStatusTool() {
    const cache = loadIndexCache();
    if (!cache) {
      return {
        ok: true,
        status: 'missing',
        workspace: currentWorkspace,
        indexedFiles: 0,
        chunks: 0,
        skippedFiles: 0,
        durationMs: 0,
        warnings: ['Index cache not built yet.'],
        errors: []
      };
    }
    return {
      ok: true,
      status: 'ready',
      workspace: currentWorkspace,
      indexedFiles: Number(cache.meta?.indexedFiles || cache.files.length || 0),
      chunks: Number(cache.meta?.chunks || cache.chunks.length || 0),
      skippedFiles: Number(cache.meta?.skippedFiles || 0),
      durationMs: Number(cache.meta?.durationMs || 0),
      lastIndexedAt: cache.meta?.lastIndexedAt || null,
      warnings: Array.isArray(cache.meta?.warnings) ? cache.meta.warnings : [],
      errors: []
    };
  }

  async function searchIndexCache({ query = '', limit = 20, recentFiles = [], maxFiles = 1200 } = {}) {
    const searchTerms = tokenize(query);
    if (!searchTerms.length) {
      return { ok: true, status: 'ready', query, results: [], indexedFiles: 0, chunks: 0, skippedFiles: 0, durationMs: 0, warnings: [], errors: [] };
    }
    let cache = loadIndexCache();
    if (!cache) {
      await buildIndexCache({ maxFiles, full: true });
      cache = loadIndexCache();
    }
    if (!cache) throw new Error('Index cache is unavailable after build.');
    const start = Date.now();
    const recentSet = new Set((Array.isArray(recentFiles) ? recentFiles : []).map(v => String(v).replace(/\\/g, '/')));
    const changedSet = await getGitChangedFilesSet();
    const results = [];
    const fileMap = new Map(cache.files.map(f => [f.relPath, f]));

    for (const chunk of cache.chunks) {
      const tokenFreq = chunk.tokenFreq || {};
      const relPath = chunk.relPath;
      const lowerPath = relPath.toLowerCase();
      let lexicalScore = 0;
      let pathScore = 0;
      for (const term of searchTerms) {
        lexicalScore += Number(tokenFreq[term] || 0);
        if (lowerPath.includes(term)) pathScore += 2;
      }
      if (lexicalScore <= 0 && pathScore <= 0) continue;
      const file = fileMap.get(relPath);
      const recentBonus = recentSet.has(relPath) ? 1.5 : 0;
      const gitBonus = changedSet.has(relPath) ? 1.2 : 0;
      const exactBonus = searchTerms.some(term => lowerPath === term || path.basename(lowerPath) === term) ? 1.0 : 0;
      const score = lexicalScore * 2 + pathScore + recentBonus + gitBonus + exactBonus;
      results.push({
        file: relPath,
        path: path.join(currentWorkspace, relPath),
        score: Number(score.toFixed(3)),
        snippet: chunk.preview,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        language: file?.language || 'text'
      });
    }
    results.sort((a, b) => b.score - a.score);
    return {
      ok: true,
      status: 'ready',
      query,
      indexedFiles: cache.files.length,
      chunks: cache.chunks.length,
      skippedFiles: Number(cache.meta?.skippedFiles || 0),
      durationMs: Date.now() - start,
      warnings: [],
      errors: [],
      provider: 'lexical',
      fallback: 'lexical-offline',
      results: results.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
    };
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

  async function semanticIndexTool({ query = '', limit = 20, maxFiles = 1200, recentFiles = [] } = {}) {
    const result = await searchIndexCache({ query, limit, maxFiles, recentFiles });
    return result.results || [];
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

  function gitStatusTool() {
    return new Promise(resolve => {
      exec('git status --porcelain --branch -u', { cwd: currentWorkspace, timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve({
            ok: false,
            isRepo: false,
            branch: null,
            message: 'Not a git repository or git is not installed.',
            error: redactSecrets(err.message),
            changedFiles: [],
            stagedFiles: [],
            untrackedFiles: [],
            statusRaw: ''
          });
          return;
        }
        const raw = redactSecrets(stdout || '');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const branchLine = lines.find(l => l.startsWith('##'));
        const branch = branchLine ? branchLine.replace(/^##\s+/, '').split('...')[0].trim() : 'unknown';
        const aheadBehind = branchLine ? (branchLine.match(/\[(ahead\s+\d+[,\s]*behind\s+\d+|ahead\s+\d+|behind\s+\d+)\]/i)?.[1] || null) : null;

        const changedFiles = [];
        const stagedFiles = [];
        const untrackedFiles = [];

        for (const line of lines) {
          if (line.startsWith('##')) continue;
          const status = line.slice(0, 2);
          const file = line.slice(3).trim();
          if (!file) continue;
          const statusTrimmed = status.trim();

          if (statusTrimmed === '??') {
            untrackedFiles.push(file);
          } else {
            const isStaged = status[0] !== ' ';
            const isWorktree = status[1] !== ' ';
            const statusLabel = statusTrimmed.replace(/\s/g, '');

            let label = 'modified';
            if (statusLabel === 'M') label = 'modified';
            else if (statusLabel === 'A') label = 'added';
            else if (statusLabel === 'D') label = 'deleted';
            else if (statusLabel === 'R') label = 'renamed';
            else if (statusLabel === 'C') label = 'copied';
            else if (statusLabel === 'AM' || statusLabel === 'MM') label = 'modified';

            changedFiles.push({ file, status: statusLabel, staged: isStaged, worktree: isWorktree });
            if (isStaged) stagedFiles.push({ file, status: statusLabel });
          }
        }

        resolve({
          ok: true,
          isRepo: true,
          branch,
          aheadBehind,
          changedFiles,
          stagedFiles,
          untrackedFiles,
          totalChanges: changedFiles.length,
          totalUntracked: untrackedFiles.length,
          statusRaw: truncate(raw, 80000)
        });
      });
    });
  }

  function normalizeGitFilePath(inputPath) {
    const raw = String(inputPath || '').trim();
    if (!raw) throw new Error('filePath is required');
    const resolved = resolveWorkspacePath(raw);
    return path.relative(currentWorkspace, resolved).replace(/\\/g, '/');
  }

  function normalizeGitFileList(files) {
    if (!Array.isArray(files)) throw new Error('files must be an array');
    const out = files.map(normalizeGitFilePath).filter(Boolean);
    if (out.length === 0) throw new Error('files array must not be empty');
    return out;
  }

  function gitDiffTool({ filePath, cached } = {}) {
    return new Promise(resolve => {
      const safePath = filePath ? normalizeGitFilePath(filePath) : '';
      const pathArg = safePath ? ` -- ${JSON.stringify(safePath)}` : '';
      const cacheFlag = cached ? ' --cached' : '';
      const cmd = `git diff${cacheFlag} -- .${pathArg}`;
      exec(cmd, { cwd: currentWorkspace, timeout: 30000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const raw = redactSecrets(stdout || '');
        resolve({
          ok: !err,
          command: cmd,
          diff: truncate(raw, 200000),
          stat: '',
          error: err ? redactSecrets(err.message) : null
        });
      });
    });
  }

  function gitFileDiffTool({ filePath, cached } = {}) {
    if (!filePath || typeof filePath !== 'string') throw new Error('filePath is required');
    return gitDiffTool({ filePath, cached });
  }

  function gitLogTool({ count = 10, branch, filePath } = {}) {
    return new Promise(resolve => {
      const n = Math.max(1, Math.min(Number(count) || 10, 100));
      const branchArg = branch ? ` ${String(branch).trim()}` : '';
      const safePath = filePath ? normalizeGitFilePath(filePath) : '';
      const fileArg = safePath ? ` -- ${JSON.stringify(safePath)}` : '';
      const cmd = `git log --oneline -n ${n}${branchArg}${fileArg}`;
      exec(cmd, { cwd: currentWorkspace, timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const raw = redactSecrets(stdout || '');
        const entries = raw.split(/\r?\n/).filter(Boolean).map(line => {
          const spaceIdx = line.indexOf(' ');
          if (spaceIdx === -1) return { hash: line, message: '' };
          return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1).trim() };
        });
        resolve({
          ok: !err,
          command: `git log oneline -n ${n}`,
          entries,
          entriesCount: entries.length,
          logRaw: truncate(raw, 60000),
          error: err ? redactSecrets(err.message) : null
        });
      });
    });
  }

  function gitStageTool({ files, all = false } = {}) {
    if (!isWorkspaceTrusted()) throw new Error('Workspace is not trusted. Trust it before staging files.');
    if (!all && (!files || !Array.isArray(files) || files.length === 0)) throw new Error('files array or all=true is required for stage');
    return new Promise((resolve, reject) => {
      const safeFiles = all ? [] : normalizeGitFileList(files);
      const fileArgs = all ? '-A' : safeFiles.map(f => JSON.stringify(f)).join(' ');
      const cmd = all ? 'git add -A' : `git add ${fileArgs}`;
      exec(cmd, { cwd: currentWorkspace, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            command: cmd,
            staged: [],
            error: redactSecrets(err.message),
            stderr: truncate(redactSecrets(stderr || ''), 5000)
          });
          return;
        }
        resolve({
          ok: true,
          command: cmd,
          staged: all ? ['all'] : safeFiles
        });
      });
    });
  }

  function gitUnstageTool({ files, all = false } = {}) {
    if (!isWorkspaceTrusted()) throw new Error('Workspace is not trusted. Trust it before unstaging files.');
    if (!all && (!files || !Array.isArray(files) || files.length === 0)) throw new Error('files array or all=true is required for unstage');
    return new Promise((resolve, reject) => {
      const safeFiles = all ? [] : normalizeGitFileList(files);
      const normalizedArgs = all ? '.' : safeFiles.map(f => JSON.stringify(f)).join(' ');
      const cmd = `git reset HEAD -- ${normalizedArgs}`;
      exec(cmd, { cwd: currentWorkspace, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            command: cmd,
            unstaged: [],
            error: redactSecrets(err.message),
            stderr: truncate(redactSecrets(stderr || ''), 5000)
          });
          return;
        }
        resolve({
          ok: true,
          command: cmd,
          unstaged: all ? ['all'] : safeFiles
        });
      });
    });
  }

  function gitDiscardTool({ filePath, files, confirm } = {}) {
    if (!isWorkspaceTrusted()) throw new Error('Workspace is not trusted. Trust it before discarding changes.');
    if (confirm !== true) throw new Error('Discard requires explicit confirmation (confirm:true). This is a destructive operation.');
    const fileList = filePath ? [normalizeGitFilePath(filePath)] : (Array.isArray(files) ? normalizeGitFileList(files) : []);
    if (fileList.length === 0) throw new Error('filePath or files array is required for discard');
    return new Promise((resolve, reject) => {
      const fileArgs = fileList.map(f => JSON.stringify(f)).join(' ');
      const cmd = `git checkout -- ${fileArgs}`;
      exec(cmd, { cwd: currentWorkspace, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            command: cmd,
            discarded: [],
            error: redactSecrets(err.message),
            stderr: truncate(redactSecrets(stderr || ''), 5000)
          });
          return;
        }
        resolve({
          ok: true,
          command: cmd,
          discarded: fileList
        });
      });
    });
  }

  async function gitCommitMessageDraftTool({ style = 'conventional' } = {}) {
    try {
      const diff = await gitDiffTool({});
      const status = await gitStatusTool();
      if (!status.isRepo) return { ok: false, message: 'Not a git repository.', draft: '' };
      if (!status.changedFiles.length && !status.stagedFiles.length) {
        return { ok: true, message: 'No changes to commit.', draft: '', empty: true };
      }
      const stagedSummary = status.stagedFiles.length
        ? `Staged: ${status.stagedFiles.map(f => f.file).join(', ')}`
        : 'No files staged';
      const changedSummary = status.changedFiles.length
        ? status.changedFiles.filter(f => !f.staged).map(f => `${f.file} (${f.status})`).join('; ')
        : 'No working changes';
      const diffStat = diff.diff
        ? `\nDiff stats (lines changed): added ${(diff.diff.match(/\n\+/g) || []).length}, removed ${(diff.diff.match(/\n\-/g) || []).length}`
        : '';
      const draft = `[DRAFT] ${stagedSummary}\n\nChanges:\n${changedSummary}${diffStat}\n\n${style === 'conventional' ? 'Enter a descriptive commit message using conventional commits format (feat:, fix:, docs:, refactor:, etc.)' : 'Replace this with your commit message.'}`;
      return {
        ok: true,
        draft,
        branch: status.branch,
        stagedSummary,
        changedSummary,
        diffStatPreview: truncate(diff.diff, 5000)
      };
    } catch (e) {
      return { ok: false, error: e.message, draft: '' };
    }
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

  function deleteFileTool({ filePath, path: inputPath, reason = 'delete_file' }) {
    const rawPath = String(filePath || inputPath || '').trim();
    if (!rawPath) throw new Error('filePath is required');
    if (/[*?]/.test(rawPath)) throw new Error('Wildcards are not allowed for delete_file.');
    const resolved = resolveWorkspacePath(rawPath);
    if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${rawPath}`);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`delete_file only supports regular files: ${rawPath}`);
    const relPath = path.relative(currentWorkspace, resolved).replace(/\\/g, '/');
    const beforeContent = fs.readFileSync(resolved, 'utf8');
    const id = `edit_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const edit = {
      id,
      filePath: resolved,
      relPath,
      content: '',
      beforeContent,
      reason,
      operation: 'delete',
      createdAt: new Date().toISOString(),
      before: { existed: true, bytes: stat.size, hash: fileHash(resolved) },
      after: { existed: false, bytes: 0, hash: null },
      diff: [`--- a/${relPath}`, '+++ /dev/null', ...String(beforeContent).split(/\r?\n/).map(line => `-${line}`)].join('\n'),
      hunks: []
    };
    pendingEdits.set(id, edit);
    return { ok: true, pendingEdit: edit };
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
    if (edit.operation === 'delete') {
      if (!fs.existsSync(edit.filePath)) throw new Error(`File already missing for delete apply: ${edit.relPath}`);
      const stat = fs.statSync(edit.filePath);
      if (!stat.isFile()) throw new Error(`Refusing to delete non-file target: ${edit.relPath}`);
      fs.unlinkSync(edit.filePath);
      pendingEdits.delete(id);
      return { ok: true, id, relPath: edit.relPath, operation: 'delete', before: edit.before, after: { existed: false, bytes: 0, hash: null } };
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
    if (name === 'index_status') return indexStatusTool(args);
    if (name === 'index_build') return buildIndexCache(args);
    if (name === 'index_refresh') return refreshIndexCache(args);
    if (name === 'index_search') return searchIndexCache(args);
    if (name === 'git_context') return gitContextTool(args);
    if (name === 'git_status') return gitStatusTool(args);
    if (name === 'git_diff') return gitDiffTool(args);
    if (name === 'git_file_diff') return gitFileDiffTool(args);
    if (name === 'git_log') return gitLogTool(args);
    if (name === 'git_stage') return gitStageTool(args);
    if (name === 'git_unstage') return gitUnstageTool(args);
    if (name === 'git_discard') return gitDiscardTool(args);
    if (name === 'git_commit_draft') return gitCommitMessageDraftTool(args);
    if (name === 'list_dir') return listDirTool(args);
    if (name === 'read_file') return readFileTool(args);
    if (name === 'read_file_paged') return readFilePagedTool(args);
    if (name === 'write_file') return createPendingEdit(args);
    if (name === 'apply_patch') return applyPatchTool(args);
    if (name === 'apply_pending_edit') return applyPendingEditTool(args);
    if (name === 'discard_pending_edit') return discardPendingEditTool(args);
    if (name === 'delete_file') return deleteFileTool(args);
    if (name === 'pending_edits') return listPendingEditsTool(args);
    if (name === 'search_files' || name === 'search' || name === 'grep_search') return searchFiles(args);
    if (name === 'execute_command') return executeCommandTool(args);
    if (name === 'start_command_job') return startCommandJobTool(args);
    if (name === 'command_job_status') return commandJobStatusTool(args);
    if (name === 'cancel_command_job') return cancelCommandJobTool(args);
    throw new Error(`Unknown workspace core tool: ${name}`);
  }

  // --- Sprint 14: Security Permission Model ---
  const PERMISSION_DEFINITIONS = [
    { permissionId: 'file.read', actionType: 'file.read', riskLevel: 'low', modeAllowed: 'both-readonly', requiresApproval: false, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Read a file from the workspace.', exampleActions: ['read_file', 'read_file_paged', 'search_files'] },
    { permissionId: 'file.write', actionType: 'file.write', riskLevel: 'high', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: false, description: 'Write or create a file in the workspace.', exampleActions: ['write_file'] },
    { permissionId: 'file.apply_edit', actionType: 'file.apply_edit', riskLevel: 'high', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: false, description: 'Apply or discard a pending file edit.', exampleActions: ['apply_pending_edit', 'discard_pending_edit', 'apply_patch'] },
    { permissionId: 'file.delete', actionType: 'file.delete', riskLevel: 'destructive', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: false, description: 'Create a pending delete operation for a workspace file.', exampleActions: ['delete_file'] },
    { permissionId: 'terminal.run', actionType: 'terminal.run', riskLevel: 'high', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: false, description: 'Execute a shell command in the workspace.', exampleActions: ['execute_command', 'start_command_job'] },
    { permissionId: 'job.cancel', actionType: 'job.cancel', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: false, description: 'Cancel a running command job.', exampleActions: ['cancel_command_job'] },
    { permissionId: 'provider.mutate', actionType: 'provider.mutate', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Create, update, or delete API provider configuration.', exampleActions: ['POST /api/providers', 'POST /api/providers/default', 'POST /api/providers/clear_key', 'POST /api/settings'] },
    { permissionId: 'extension.install', actionType: 'extension.install', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Install an extension from folder, VSIX, or marketplace.', exampleActions: ['install_folder', 'install_vsix', 'install_openvsx'] },
    { permissionId: 'extension.mutate', actionType: 'extension.mutate', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Enable, disable, activate, or uninstall an extension.', exampleActions: ['extensions/enable', 'extensions/uninstall', 'extensions/activate'] },
    { permissionId: 'inline_edit.generate', actionType: 'inline_edit.generate', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Generate code via inline edit (no file write yet).', exampleActions: ['POST /api/inline_edit (generate phase)'] },
    { permissionId: 'inline_edit.apply', actionType: 'inline_edit.apply', riskLevel: 'high', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: false, description: 'Apply the inline edit generated code as a pending edit.', exampleActions: ['POST /api/inline_edit (apply phase)'] },
    { permissionId: 'task.mutate', actionType: 'task.mutate', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Start, pause, resume, cancel, or clear a task.', exampleActions: ['tasks/start', 'tasks/event', 'tasks/pause', 'tasks/resume', 'tasks/cancel', 'tasks/clear_completed'] },
    { permissionId: 'git.read', actionType: 'git.read', riskLevel: 'low', modeAllowed: 'both-readonly', requiresApproval: false, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Read git status, diff, or log.', exampleActions: ['git_status', 'git_diff', 'git_log'] },
    { permissionId: 'git.stage', actionType: 'git.stage', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: false, description: 'Stage files for commit.', exampleActions: ['git_stage'] },
    { permissionId: 'git.unstage', actionType: 'git.unstage', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: false, description: 'Unstage files from the index.', exampleActions: ['git_unstage'] },
    { permissionId: 'git.discard', actionType: 'git.discard', riskLevel: 'destructive', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: true, requiresConfirmation: true, description: 'Discard working-tree changes permanently.', exampleActions: ['git_discard'] },
    { permissionId: 'git.commit_draft', actionType: 'git.commit_draft', riskLevel: 'low', modeAllowed: 'both-readonly', requiresApproval: false, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Generate a commit message draft.', exampleActions: ['git_commit_draft'] },
    { permissionId: 'git.commit', actionType: 'git.commit', riskLevel: 'high', modeAllowed: 'enterprise-readonly', requiresApproval: false, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'RESERVED: git commit product flow is not implemented and this action is always denied.', exampleActions: ['git_commit'] },
    { permissionId: 'git.push', actionType: 'git.push', riskLevel: 'destructive', modeAllowed: 'enterprise-readonly', requiresApproval: false, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'RESERVED: git push product flow is not implemented and this action is always denied.', exampleActions: ['git_push'] },
    { permissionId: 'project_rules.read', actionType: 'project_rules.read', riskLevel: 'low', modeAllowed: 'both-readonly', requiresApproval: false, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Read project rules.', exampleActions: ['GET /api/project_rules', 'GET /api/project_rules/context'] },
    { permissionId: 'project_rules.mutate', actionType: 'project_rules.mutate', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Create, update, or delete project rules.', exampleActions: ['POST /api/project_rules/add', 'POST /api/project_rules/update', 'POST /api/project_rules/delete', 'POST /api/project_rules/toggle'] },
    { permissionId: 'memory.read', actionType: 'memory.read', riskLevel: 'low', modeAllowed: 'both-readonly', requiresApproval: false, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Read project memory notes.', exampleActions: ['GET /api/project_rules (memory fields)'] },
    { permissionId: 'memory.mutate', actionType: 'memory.mutate', riskLevel: 'medium', modeAllowed: 'ide', requiresApproval: true, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'Create, update, or delete project memory notes.', exampleActions: ['POST /api/project_rules/add (memory)'] },
    { permissionId: 'abw.bridge.reserved', actionType: 'abw.bridge.reserved', riskLevel: 'destructive', modeAllowed: 'enterprise-readonly', requiresApproval: false, requiresTrustedWorkspace: false, requiresConfirmation: false, description: 'RESERVED: ABW bridge actions are not implemented yet. This action is always denied.', exampleActions: ['abw.*'] }
  ];

  function getPermission(actionType) {
    return PERMISSION_DEFINITIONS.find(p => p.actionType === actionType) || null;
  }

  function getAllPermissions() {
    return PERMISSION_DEFINITIONS;
  }

  function checkPermission({ actionType, uiMode = 'enterprise', hasApproval = false, isTrusted = false, isReservedAction = false } = {}) {
    const perm = getPermission(actionType);
    if (!perm) return { allow: false, reason: `Unknown action type: ${actionType}`, permissionId: null, riskLevel: 'unknown' };
    const reservedActions = new Set(['abw.bridge.reserved', 'git.commit', 'git.push']);
    if (isReservedAction || reservedActions.has(actionType)) return { allow: false, reason: `Action ${actionType} is reserved or not yet supported.`, permissionId: perm.permissionId, riskLevel: perm.riskLevel };
    if (perm.modeAllowed === 'ide' && uiMode !== 'ide') return { allow: false, reason: `Action ${actionType} requires IDE mode. Currently in ${uiMode} mode.`, permissionId: perm.permissionId, riskLevel: perm.riskLevel };
    if (perm.modeAllowed === 'enterprise-readonly' && uiMode === 'ide') return { allow: false, reason: `Action ${actionType} is reserved/read-only and not executable in IDE mode.`, permissionId: perm.permissionId, riskLevel: perm.riskLevel };
    if (perm.requiresApproval && !hasApproval) return { allow: false, reason: `Action ${actionType} requires X-Agent-Approved=true.`, permissionId: perm.permissionId, riskLevel: perm.riskLevel };
    if (perm.requiresTrustedWorkspace && !isTrusted) return { allow: false, reason: `Action ${actionType} requires a trusted workspace.`, permissionId: perm.permissionId, riskLevel: perm.riskLevel };
    return { allow: true, reason: `${actionType} is allowed.`, permissionId: perm.permissionId, riskLevel: perm.riskLevel, requiresConfirmation: perm.requiresConfirmation || false };
  }

  function enforcePermission(reqOrOptions, actionType, { extraReturn = false } = {}) {
    const options = (typeof reqOrOptions === 'object' && reqOrOptions !== null) ? reqOrOptions : {};
    const uiMode = options.uiMode || 'enterprise';
    const hasApproval = options.hasApproval === true;
    const isTrusted = options.isTrusted === true;
    const result = checkPermission({ actionType, uiMode, hasApproval, isTrusted });
    if (!result.allow) {
      const err = new Error(result.reason);
      Object.assign(err, { permissionId: result.permissionId, riskLevel: result.riskLevel, allow: false, reason: result.reason });
      throw err;
    }
    if (extraReturn) return result;
    return true;
  }

  return {
    setWorkspace, getWorkspace, truncate, redactSecrets, toolResult, isPathInside,
    resolveWorkspacePath, isLikelyTextFile, shouldSkipDir, getFilesFlat, getFileTree,
    isWorkspaceTrusted, setWorkspaceTrust, getWorkspaceTrustStatus,
    fileHash, makeUnifiedDiff, makeLineHunks, readFileTool, readFilePagedTool, listDirTool, searchFiles,
    projectIndexerTool, semanticIndexTool, indexStatusTool, buildIndexCache, refreshIndexCache, searchIndexCache, gitContextTool,
    gitStatusTool, gitDiffTool, gitFileDiffTool, gitLogTool,
    gitStageTool, gitUnstageTool, gitDiscardTool, gitCommitMessageDraftTool,
    createPendingEdit, applyPatchTool, applyPendingEditTool, discardPendingEditTool,
    listPendingEditsTool, executeCommandTool, startCommandJobTool, commandJobStatusTool,
    cancelCommandJobTool, callTool,
    PERMISSION_DEFINITIONS, getPermission, getAllPermissions, checkPermission, enforcePermission
  };
}
