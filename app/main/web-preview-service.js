'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const LOG_LIMIT = 12000;
const START_LIMIT_MS = 60000;

function managerFor(root, stopAt) {
  let current = path.resolve(root);
  const boundary = path.resolve(stopAt);
  for (;;) {
    if (fs.existsSync(path.join(current, 'bun.lock')) || fs.existsSync(path.join(current, 'bun.lockb'))) return 'bun';
    if (fs.existsSync(path.join(current, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(current, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(current, 'package-lock.json'))) return 'npm';
    if (current === boundary) return 'npm';
    const parent = path.dirname(current);
    if (parent === current || !parent.toLowerCase().startsWith(boundary.toLowerCase())) return 'npm';
    current = parent;
  }
}

function readProject(root, managerRoot = root) {
  if (!root) return null;
  try {
    const packageFile = path.join(root, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !manifest.scripts || typeof manifest.scripts !== 'object') return readFlutterProject(root);
    const script = ['dev', 'start', 'preview', 'serve'].find(name => typeof manifest.scripts[name] === 'string' && manifest.scripts[name].trim());
    if (!script) return readFlutterProject(root) || { root: path.resolve(root), manifest, script: null, reason: 'No dev, start, preview, or serve script is defined in package.json.' };
    const manager = managerFor(root, managerRoot);
    return { root: path.resolve(root), type: 'node', manifest, script, manager, command: `${manager} run ${script}` };
  } catch (error) {
    return readFlutterProject(root) || { root: path.resolve(root), reason: error.code === 'ENOENT' ? 'No runnable package.json or Flutter web project found.' : `Cannot read package.json: ${error.message}` };
  }
}

function readFlutterProject(root) {
  const manifestFile = path.join(root, 'pubspec.yaml');
  if (!fs.existsSync(manifestFile)) return null;
  const manifestText = fs.readFileSync(manifestFile, 'utf8');
  const name = /^name:\s*([A-Za-z0-9_-]+)/m.exec(manifestText)?.[1] || path.basename(root);
  if (!fs.existsSync(path.join(root, 'web', 'index.html'))) {
    return { root: path.resolve(root), type: 'flutter', manifest: { name }, script: null, manager: 'flutter', reason: 'This Flutter project has no web/index.html web target to preview.' };
  }
  return { root: path.resolve(root), type: 'flutter', manifest: { name }, script: 'Flutter Web', manager: 'flutter', command: 'flutter run -d web-server' };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function serverArgs(project, port) {
  if (project.type === 'flutter') return [];
  const dependencies = { ...project.manifest.dependencies, ...project.manifest.devDependencies };
  let flags = [];
  if (dependencies.vite || /\bvite\b/.test(project.manifest.scripts[project.script])) flags = [`--host=127.0.0.1`, `--port=${port}`, '--strictPort'];
  else if (dependencies.next || /\bnext\s+(dev|start)\b/.test(project.manifest.scripts[project.script])) flags = [`--hostname=127.0.0.1`, `--port=${port}`];
  else if (dependencies['@angular/cli']) flags = [`--host=127.0.0.1`, `--port=${port}`];
  else if (dependencies.astro) flags = [`--host=127.0.0.1`, `--port=${port}`, '--strictPort'];
  else if (dependencies.nuxt || dependencies['@nuxt/kit']) flags = [`--host=127.0.0.1`, `--port=${port}`];
  if (!flags.length) return [];
  if (project.manager === 'npm' || project.manager === 'pnpm') return ['--', ...flags];
  return flags;
}

function probe(port, timeout = 700) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout }, response => {
      response.resume();
      resolve(true);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function mergePreviewStatus(detected, running) {
  const website = { ...detected, ...running, apps: detected.apps || [] };
  if (!running.running && running.status !== 'starting') {
    website.script = detected.script;
    website.packageManager = detected.packageManager;
    website.relativeDir = detected.relativeDir;
    website.command = detected.command;
  }
  return website;
}

function createWebPreviewService(options = {}) {
  const spawnProcess = options.spawn || spawn;
  const getFreePort = options.freePort || freePort;
  const probePort = options.probe || probe;
  let child = null;
  let current = null;
  let stopping = null;

  function inspect(projectDir) {
    if (!projectDir) return { available: false, apps: [], reason: 'Choose a project folder first.' };
    const root = path.resolve(projectDir);
    const directories = [root];
    const skip = new Set(['.git', '.od', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt']);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || skip.has(entry.name.toLowerCase())) continue;
        const directory = path.join(root, entry.name);
        if (fs.existsSync(path.join(directory, 'package.json')) || fs.existsSync(path.join(directory, 'pubspec.yaml'))) directories.push(directory);
        if (['apps', 'packages', 'services'].includes(entry.name.toLowerCase())) {
          for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
            if (child.isDirectory() && !skip.has(child.name.toLowerCase())) {
              const nested = path.join(directory, child.name);
              if (fs.existsSync(path.join(nested, 'package.json')) || fs.existsSync(path.join(nested, 'pubspec.yaml'))) directories.push(nested);
            }
          }
        }
        if (directories.length >= 40) break;
      }
    } catch {}
    const apps = [...new Set(directories)].map(directory => {
      const project = readProject(directory, root);
      if (!project?.script) return null;
      return {
        relativeDir: path.relative(root, directory) || '.',
        name: project.manifest.name || path.basename(directory),
        script: project.script,
        packageManager: project.manager,
        command: project.command,
      };
    }).filter(Boolean);
    const project = apps.find(app => app.relativeDir === '.') || apps[0];
    return {
      available: apps.length > 0,
      script: project?.script,
      packageManager: project?.packageManager,
      relativeDir: project?.relativeDir,
      apps,
      reason: apps.length ? undefined : 'No package.json with a dev, start, preview, or serve script, or Flutter web target was found.',
    };
  }

  function status() {
    const value = current || {};
    return {
      running: !!child && value.status === 'running',
      status: value.status || 'stopped',
      projectDir: value.projectDir || null,
      relativeDir: value.relativeDir || null,
      url: value.url || null,
      port: value.port || null,
      script: value.script || null,
      packageManager: value.packageManager || null,
      command: value.command || null,
      logs: value.logs || '',
      error: value.error || null,
      startedAt: value.startedAt || null,
    };
  }

  function appendLog(chunk) {
    if (!current) return;
    current.logs = `${current.logs || ''}${String(chunk)}`.slice(-LOG_LIMIT);
    const matches = [...current.logs.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})/gi)];
    const port = matches.length ? Number(matches[matches.length - 1][1]) : 0;
    if (port > 0 && port <= 65535) current.outputPort = port;
  }

  async function stop() {
    if (stopping) return stopping;
    if (!child) {
      if (current) current.status = 'stopped';
      return { ok: true, ...status() };
    }
    const processToStop = child;
    const stoppedState = current;
    child = null;
    current.status = 'stopping';
    stopping = new Promise(resolve => {
      let finished = false;
      let timer = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (current === stoppedState) current.status = 'stopped';
        resolve({ ok: true, ...status() });
      };
      if (process.platform === 'win32' && processToStop.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { try { processToStop.kill('SIGTERM'); } catch {} finish(); });
        killer.once('exit', finish);
        timer = setTimeout(() => { try { processToStop.kill('SIGKILL'); } catch {} finish(); }, 5000);
        timer.unref?.();
      } else {
        try { process.kill(-processToStop.pid, 'SIGTERM'); } catch { try { processToStop.kill('SIGTERM'); } catch {} }
        const timer = setTimeout(() => {
          try { process.kill(-processToStop.pid, 'SIGKILL'); } catch {}
          finish();
        }, 4000);
        timer.unref?.();
        processToStop.once('exit', () => { clearTimeout(timer); finish(); });
      }
    }).finally(() => { stopping = null; });
    return stopping;
  }

  async function start(projectDir, relativeDir = '.') {
    if (!projectDir) return { ok: false, error: 'Choose a project folder first.' };
    const root = path.resolve(projectDir);
    const target = path.resolve(root, relativeDir || '.');
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, error: 'The selected website folder must stay inside the project.' };
    const project = readProject(target, root);
    if (!project?.script) return { ok: false, error: project?.reason || 'No runnable package script was found.' };
    await stop();
    const port = await getFreePort();
    const flags = serverArgs(project, port);
    const args = project.type === 'flutter'
      ? ['run', '-d', 'web-server', '--web-hostname', '127.0.0.1', '--web-port', String(port)]
      : project.manager === 'npm' ? ['run', project.script, ...flags]
        : project.manager === 'pnpm' ? ['run', project.script, ...flags]
          : project.manager === 'yarn' ? ['run', project.script, ...flags]
            : ['run', project.script, ...flags];
    const executable = process.platform === 'win32' && project.manager !== 'bun'
      ? project.manager === 'flutter' ? 'flutter.bat' : `${project.manager}.cmd`
      : project.manager;
    current = {
      projectDir: root,
      relativeDir: relative || '.',
      packageDir: project.root,
      script: project.script,
      packageManager: project.manager,
      command: project.command || `${project.manager} run ${project.script}`,
      status: 'starting',
      logs: '',
      error: null,
      startedAt: Date.now(),
      port,
    };
    try {
      child = spawnProcess(executable, args, {
        cwd: project.root,
        env: { ...process.env, HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', PORT: String(port), BROWSER: 'none', VITE_HOST: '127.0.0.1' },
        shell: process.platform === 'win32' && project.manager !== 'bun',
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      current.status = 'error';
      current.error = error.message;
      return { ok: false, ...status(), error: current.error };
    }
    let childError = null;
    child.stdout?.on('data', chunk => appendLog(chunk));
    child.stderr?.on('data', chunk => appendLog(chunk));
    child.once('error', error => { childError = error; appendLog(`\n${error.message}\n`); });
    child.once('exit', (code, signal) => {
      if (current && current.status !== 'stopping') {
        child = null;
        current.status = code === 0 ? 'stopped' : 'error';
        if (code !== 0) current.error = `Preview process exited (${signal || code}).`;
      }
    });

    const startLimitMs = project.type === 'flutter' ? 180000 : START_LIMIT_MS;
    const deadline = Date.now() + startLimitMs;
    while (Date.now() < deadline) {
      if (childError) break;
      if (!child || child.exitCode !== null) break;
      const candidates = [...new Set([port, current.outputPort].filter(Boolean))];
      let readyPort = 0;
      for (const candidate of candidates) {
        if (await probePort(candidate)) { readyPort = candidate; break; }
      }
      if (readyPort) {
        current.status = 'running';
        current.port = readyPort;
        current.url = `http://127.0.0.1:${readyPort}/`;
        return { ok: true, ...status() };
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const logs = current.logs;
    const error = childError ? childError.message
      : current.status === 'error' ? current.error
        : `The ${project.script} script did not open its local preview on port ${port} within ${startLimitMs / 1000} seconds.`;
    await stop();
    current.status = 'error';
    current.error = error;
    current.logs = logs;
    return { ok: false, ...status(), error };
  }

  return { inspect, start, stop, status, close: stop };
}

module.exports = { createWebPreviewService, mergePreviewStatus };
