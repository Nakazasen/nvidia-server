import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import vm from 'vm';
import { createRequire } from 'module';

const OPEN_VSX_API = 'https://open-vsx.org/api';

export function createExtensionHost({
  appDir = process.cwd(),
  workspace = process.cwd(),
  stateDir = path.join(appDir, '.nvidia-agent')
} = {}) {
  let currentWorkspace = path.resolve(workspace);
  const extensionsDir = path.join(stateDir, 'extensions');
  const registryFile = path.join(extensionsDir, 'installed.json');
  const settingsFile = path.join(extensionsDir, 'settings.json');
  const commandRegistry = new Map();
  const activatedExtensions = new Map();
  fs.mkdirSync(extensionsDir, { recursive: true });

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return fallback;
    }
  }

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  }

  function slug(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'extension';
  }

  function readRegistry() {
    const data = readJson(registryFile, { extensions: [] });
    return Array.isArray(data.extensions) ? data.extensions : [];
  }

  function writeRegistry(extensions) {
    writeJson(registryFile, { extensions });
  }

  function findManifestRoot(root) {
    const direct = path.join(root, 'package.json');
    const extension = path.join(root, 'extension', 'package.json');
    if (fs.existsSync(direct)) return root;
    if (fs.existsSync(extension)) return path.join(root, 'extension');
    const children = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const candidate = path.join(root, child.name, 'package.json');
      if (fs.existsSync(candidate)) return path.join(root, child.name);
    }
    throw new Error('No package.json manifest found in extension package.');
  }

  function normalizeManifest(manifest, extensionPath = '') {
    const id = manifest.publisher ? `${manifest.publisher}.${manifest.name}` : manifest.name;
    const commands = manifest.contributes?.commands || [];
    const configuration = manifest.contributes?.configuration || {};
    const agentProviders = manifest.nvidiaAgent?.agentProviders || manifest.contributes?.nvidiaAgent?.agentProviders || [];
    return {
      id,
      name: manifest.displayName || manifest.name || id,
      packageName: manifest.name || id,
      publisher: manifest.publisher || 'local',
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      enabled: true,
      extensionPath,
      main: manifest.main || null,
      activationEvents: manifest.activationEvents || [],
      categories: manifest.categories || [],
      commands: commands.map(cmd => ({
        command: cmd.command,
        title: cmd.title || cmd.command,
        category: cmd.category || manifest.displayName || manifest.name
      })).filter(cmd => cmd.command),
      configuration,
      agentProviders: Array.isArray(agentProviders) ? agentProviders : []
    };
  }

  function readManifest(extensionPath) {
    const manifest = readJson(path.join(extensionPath, 'package.json'), null);
    if (!manifest) throw new Error(`Invalid extension manifest: ${extensionPath}`);
    return normalizeManifest(manifest, extensionPath);
  }

  function listExtensions() {
    const registry = readRegistry();
    return registry.map(item => {
      try {
        const latest = readManifest(item.extensionPath);
        return { ...latest, enabled: item.enabled !== false, installedAt: item.installedAt, source: item.source || 'local' };
      } catch {
        return item;
      }
    });
  }

  function listCommands() {
    return listExtensions()
      .filter(ext => ext.enabled !== false)
      .flatMap(ext => (ext.commands || []).map(cmd => ({
        cmd: `/${cmd.command}`,
        name: cmd.command,
        desc: `${cmd.title} (${ext.name})`,
        extensionId: ext.id,
        source: 'extension'
      })));
  }

  function listSettings() {
    return readJson(settingsFile, {});
  }

  function isPathInside(parentDir, childPath) {
    const rel = path.relative(path.resolve(parentDir), path.resolve(childPath));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function resolveWorkspacePath(inputPath = '.') {
    const resolved = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(currentWorkspace, inputPath));
    if (!isPathInside(currentWorkspace, resolved)) throw new Error(`Extension attempted to access path outside workspace: ${inputPath}`);
    return resolved;
  }

  function normalizeUri(value) {
    if (typeof value === 'string') return value.replace(/^file:\/\//, '');
    if (value?.fsPath) return value.fsPath;
    if (value?.path) return value.path;
    throw new Error('Expected a path string or Uri-like object.');
  }

  function createVscodeApi(extension) {
    const subscriptions = [];
    const api = {
      version: 'nvidia-agent-compat-0.1',
      Uri: {
        file: fsPath => ({ scheme: 'file', fsPath: path.resolve(fsPath), path: path.resolve(fsPath), toString: () => `file://${path.resolve(fsPath)}` })
      },
      Disposable: class Disposable {
        constructor(fn) { this._fn = fn; }
        dispose() { this._fn?.(); }
      },
      commands: {
        registerCommand: (command, callback) => {
          if (typeof callback !== 'function') throw new Error(`Command callback must be a function: ${command}`);
          commandRegistry.set(command, { command, callback, extensionId: extension.id });
          const disposable = { dispose: () => commandRegistry.delete(command) };
          subscriptions.push(disposable);
          return disposable;
        },
        executeCommand: async (command, ...args) => executeCommand(command, args)
      },
      window: {
        showInformationMessage: async (message, ...items) => {
          console.log(`[extension:${extension.id}] ${message}`);
          return items[0];
        },
        showWarningMessage: async (message, ...items) => {
          console.warn(`[extension:${extension.id}] ${message}`);
          return items[0];
        },
        showErrorMessage: async (message, ...items) => {
          console.error(`[extension:${extension.id}] ${message}`);
          return items[0];
        }
      },
      workspace: {
        workspaceFolders: [{ uri: { scheme: 'file', fsPath: currentWorkspace, path: currentWorkspace }, name: path.basename(currentWorkspace), index: 0 }],
        getConfiguration: (section = '') => {
          const settings = listSettings();
          const prefix = section ? `${section}.` : '';
          const properties = extension.configuration?.properties || {};
          return {
            get: (key, defaultValue = undefined) => {
              const fullKey = section && key ? `${section}.${key}` : (key || section);
              return settings[fullKey] ?? settings[key] ?? properties[fullKey]?.default ?? properties[key]?.default ?? defaultValue;
            },
            update: (key, value) => {
              const next = listSettings();
              next[`${prefix}${key}`] = value;
              writeJson(settingsFile, next);
              return Promise.resolve();
            },
            has: key => Object.prototype.hasOwnProperty.call(settings, `${prefix}${key}`)
          };
        },
        fs: {
          readFile: async uri => fs.promises.readFile(resolveWorkspacePath(normalizeUri(uri))),
          writeFile: async (uri, content) => {
            const target = resolveWorkspacePath(normalizeUri(uri));
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.writeFile(target, Buffer.isBuffer(content) ? content : Buffer.from(content));
          },
          stat: async uri => {
            const stat = await fs.promises.stat(resolveWorkspacePath(normalizeUri(uri)));
            return { type: stat.isDirectory() ? 2 : 1, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
          },
          readDirectory: async uri => {
            const items = await fs.promises.readdir(resolveWorkspacePath(normalizeUri(uri)), { withFileTypes: true });
            return items.map(item => [item.name, item.isDirectory() ? 2 : 1]);
          },
          createDirectory: async uri => fs.promises.mkdir(resolveWorkspacePath(normalizeUri(uri)), { recursive: true }),
          delete: async uri => fs.promises.rm(resolveWorkspacePath(normalizeUri(uri)), { recursive: true, force: true }),
          rename: async (oldUri, newUri) => fs.promises.rename(resolveWorkspacePath(normalizeUri(oldUri)), resolveWorkspacePath(normalizeUri(newUri)))
        }
      },
      extensions: {
        getExtension: id => listExtensions().find(ext => ext.id === id) || undefined
      },
      env: {
        appName: 'NVIDIA NIM Agent IDE',
        machineId: 'local',
        sessionId: String(Date.now())
      }
    };
    return { api, context: { subscriptions, extensionPath: extension.extensionPath, globalStorageUri: api.Uri.file(path.join(extensionsDir, 'globalStorage', extension.id)), workspaceState: new Map(), globalState: new Map() } };
  }

  function updateRegistry(entry) {
    const registry = readRegistry().filter(item => item.id !== entry.id);
    registry.push(entry);
    registry.sort((a, b) => a.id.localeCompare(b.id));
    writeRegistry(registry);
    return entry;
  }

  function deactivateExtensionState(id) {
    const state = activatedExtensions.get(id);
    if (!state) return false;
    for (const disposable of state.subscriptions || []) {
      try {
        disposable.dispose?.();
      } catch {
        // Best-effort cleanup for extension-owned subscriptions.
      }
    }
    for (const [command, item] of commandRegistry.entries()) {
      if (item.extensionId === id) commandRegistry.delete(command);
    }
    activatedExtensions.delete(id);
    return true;
  }

  function installFromFolder(sourcePath, source = 'folder') {
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Source folder does not exist.');
    const manifestRoot = findManifestRoot(path.resolve(sourcePath));
    const manifest = readManifest(manifestRoot);
    deactivateExtensionState(manifest.id);
    const targetName = `${slug(manifest.id)}-${slug(manifest.version)}`;
    const targetPath = path.join(extensionsDir, targetName);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.cpSync(manifestRoot, targetPath, { recursive: true });
    const installed = readManifest(targetPath);
    installed.enabled = true;
    installed.installedAt = new Date().toISOString();
    installed.source = source;
    updateRegistry(installed);
    return installed;
  }

  function unzipVsix(vsixPath, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    const zipPath = path.join(os.tmpdir(), `nvidia-agent-${Date.now()}.zip`);
    fs.copyFileSync(vsixPath, zipPath);
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(targetDir)} -Force`
      ], { stdio: 'pipe', windowsHide: true });
    } finally {
      fs.rmSync(zipPath, { force: true });
    }
  }

  function installFromVsix(vsixPath) {
    if (!vsixPath || !fs.existsSync(vsixPath)) throw new Error('VSIX file does not exist.');
    const tmp = path.join(os.tmpdir(), `nvidia-agent-vsix-${Date.now()}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    unzipVsix(path.resolve(vsixPath), tmp);
    try {
      return installFromFolder(tmp, 'vsix');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function searchOpenVsx(query = '', size = 20) {
    const url = `${OPEN_VSX_API}/-/search?query=${encodeURIComponent(query)}&size=${Math.max(1, Math.min(Number(size) || 20, 50))}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`Open VSX search failed: ${res.status}`);
    const data = await res.json();
    return (data.extensions || []).map(item => ({
      id: `${item.namespace}.${item.name}`,
      namespace: item.namespace,
      name: item.name,
      displayName: item.displayName || item.name,
      version: item.version,
      description: item.description || '',
      downloadCount: item.downloadCount || 0,
      averageRating: item.averageRating || 0,
      verified: !!item.verified,
      url: item.url
    }));
  }

  async function installFromOpenVsx({ namespace, extension, name, version, downloadUrl }) {
    const extName = extension || name;
    if (!downloadUrl && (!namespace || !extName)) throw new Error('namespace and extension are required.');
    let meta = null;
    if (!downloadUrl) {
      const apiUrl = version
        ? `${OPEN_VSX_API}/${encodeURIComponent(namespace)}/${encodeURIComponent(extName)}/${encodeURIComponent(version)}`
        : `${OPEN_VSX_API}/${encodeURIComponent(namespace)}/${encodeURIComponent(extName)}`;
      const metaRes = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
      if (!metaRes.ok) throw new Error(`Open VSX metadata failed: ${metaRes.status}`);
      meta = await metaRes.json();
      downloadUrl = meta.files?.download;
    }
    if (!downloadUrl) throw new Error('Open VSX metadata did not include a download URL.');
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`VSIX download failed: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const vsixPath = path.join(os.tmpdir(), `nvidia-agent-${Date.now()}.vsix`);
    fs.writeFileSync(vsixPath, bytes);
    try {
      const installed = installFromVsix(vsixPath);
      installed.source = 'open-vsx';
      installed.openVsx = { namespace, extension: extName, version: version || meta?.version || installed.version, downloadUrl };
      updateRegistry(installed);
      return installed;
    } finally {
      fs.rmSync(vsixPath, { force: true });
    }
  }

  function setEnabled(id, enabled = true) {
    const registry = readRegistry();
    const item = registry.find(ext => ext.id === id);
    if (!item) throw new Error(`Extension not found: ${id}`);
    item.enabled = enabled === true;
    writeRegistry(registry);
    if (item.enabled === false) deactivateExtensionState(id);
    return item;
  }

  function uninstall(id) {
    const registry = readRegistry();
    const item = registry.find(ext => ext.id === id);
    if (!item) throw new Error(`Extension not found: ${id}`);
    deactivateExtensionState(id);
    fs.rmSync(item.extensionPath, { recursive: true, force: true });
    writeRegistry(registry.filter(ext => ext.id !== id));
    return { ok: true, id };
  }

  function executableExists(command) {
    try {
      const checker = process.platform === 'win32' ? 'where.exe' : 'command';
      const args = process.platform === 'win32' ? [command] : ['-v', command];
      execFileSync(checker, args, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  function getAgentProviders() {
    const builtIns = [
      { id: 'codex', name: 'Codex CLI', command: 'codex', runTemplate: 'codex "{prompt}"' },
      { id: 'gemini', name: 'Gemini CLI', command: 'gemini', runTemplate: 'gemini "{prompt}"' },
      { id: 'opencode', name: 'OpenCode', command: 'opencode', runTemplate: 'opencode run "{prompt}"' }
    ].map(provider => ({ ...provider, installed: executableExists(provider.command), source: 'builtin-adapter' }));

    const extensionProviders = listExtensions()
      .filter(ext => ext.enabled !== false)
      .flatMap(ext => (ext.agentProviders || []).map(provider => ({
        ...provider,
        id: provider.id || `${ext.id}.${provider.name || provider.command}`,
        extensionId: ext.id,
        installed: provider.command ? executableExists(provider.command) : true,
        source: 'extension'
      })));

    return [...builtIns, ...extensionProviders];
  }

  function extensionRequire(mainFile, vscodeApi) {
    const localRequire = createRequire(mainFile);
    return specifier => {
      if (specifier === 'vscode') return vscodeApi;
      return localRequire(specifier);
    };
  }

  async function activateExtension(id, activationEvent = '*') {
    const extension = listExtensions().find(ext => ext.id === id);
    if (!extension) throw new Error(`Extension not found: ${id}`);
    if (extension.enabled === false) throw new Error(`Extension is disabled: ${id}`);
    if (activatedExtensions.has(id)) return activatedExtensions.get(id).summary;
    if (!extension.main) {
      const summary = { id, activated: true, activationEvent, exports: {}, message: 'No main entry; manifest commands only.' };
      activatedExtensions.set(id, { summary, subscriptions: [] });
      return summary;
    }

    const mainFile = path.resolve(extension.extensionPath, extension.main);
    if (!isPathInside(extension.extensionPath, mainFile) || !fs.existsSync(mainFile)) {
      throw new Error(`Extension main file not found: ${extension.main}`);
    }

    const { api: vscodeApi, context } = createVscodeApi(extension);
    const subscriptions = context.subscriptions || [];
    const module = { exports: {} };
    const sandbox = {
      exports: module.exports,
      module,
      require: extensionRequire(mainFile, vscodeApi),
      __filename: mainFile,
      __dirname: path.dirname(mainFile),
      console,
      Buffer,
      process: { env: process.env, platform: process.platform, cwd: () => currentWorkspace },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval
    };
    const source = fs.readFileSync(mainFile, 'utf8');
    const script = new vm.Script(`(function(exports, require, module, __filename, __dirname) {\n${source}\n})`, { filename: mainFile });
    const runner = script.runInNewContext(sandbox, { timeout: 1000 });
    runner(module.exports, sandbox.require, module, mainFile, path.dirname(mainFile));

    try {
      if (typeof module.exports.activate === 'function') {
        await module.exports.activate(context);
      }
      const summary = { id, activated: true, activationEvent, exports: Object.keys(module.exports || {}), commands: listRegisteredCommands().filter(cmd => cmd.extensionId === id) };
      activatedExtensions.set(id, { summary, subscriptions });
      return summary;
    } catch (error) {
      for (const disposable of subscriptions) {
        try {
          disposable.dispose?.();
        } catch {
          // Ignore cleanup failures while unwinding activation errors.
        }
      }
      throw error;
    }
  }

  async function activateByEvent(event) {
    const activated = [];
    for (const extension of listExtensions().filter(ext => ext.enabled !== false)) {
      const events = extension.activationEvents || [];
      if (events.includes('*') || events.includes(event)) {
        activated.push(await activateExtension(extension.id, event));
      }
    }
    return activated;
  }

  function listRegisteredCommands() {
    return Array.from(commandRegistry.values()).map(item => ({ command: item.command, extensionId: item.extensionId }));
  }

  async function executeCommand(command, args = []) {
    await activateByEvent(`onCommand:${command}`);
    const registered = commandRegistry.get(command);
    if (!registered) {
      const manifestCommand = listCommands().find(item => item.name === command || item.cmd === `/${command}`);
      if (manifestCommand) {
        return { ok: false, command, extensionId: manifestCommand.extensionId, message: 'Command is declared in manifest but was not registered by extension activate().' };
      }
      throw new Error(`Command not found: ${command}`);
    }
    const extension = listExtensions().find(ext => ext.id === registered.extensionId);
    if (!extension || extension.enabled === false) {
      throw new Error(`Command belongs to a disabled or missing extension: ${registered.extensionId}`);
    }
    const result = await registered.callback(...(Array.isArray(args) ? args : [args]));
    return { ok: true, command, extensionId: registered.extensionId, result };
  }

  return {
    extensionsDir,
    registryFile,
    setWorkspace: nextWorkspace => {
      currentWorkspace = path.resolve(nextWorkspace);
      return currentWorkspace;
    },
    listExtensions,
    listCommands,
    listSettings,
    installFromFolder,
    installFromVsix,
    installFromOpenVsx,
    searchOpenVsx,
    setEnabled,
    uninstall,
    getAgentProviders,
    activateExtension,
    activateByEvent,
    listRegisteredCommands,
    executeCommand
  };
}
