'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function safeName(value) {
  const name = String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 64);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) throw Error('Enter a valid app name.');
  return name;
}

function validateEntry(value) {
  const entry = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!entry || entry.startsWith('/') || entry.includes(':') || entry.split('/').some(part => !part || part === '.' || part === '..') || !/\.html?$/i.test(entry)) {
    throw Error('The selected website needs a safe HTML entry file, such as index.html.');
  }
  return entry;
}

function localProtocolMain() {
  return `'use strict';
const { app, BrowserWindow, protocol, net, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const config = require('./site.json');
let windowRef;
const siteRoot = path.join(__dirname, 'site');
protocol.registerSchemesAsPrivileged([{ scheme: 'muse-app-site', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

function escapeHtml(value) { return String(value).replace(/[&<>\"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[character]); }

app.whenReady().then(async () => {
  if (config.source.type === 'local') {
    protocol.handle('muse-app-site', async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'local') return new Response('Not found', { status: 404 });
        const relative = decodeURIComponent(url.pathname.replace(/^\\/+/, ''));
        if (!relative || relative.includes('\\\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..')) return new Response('Invalid path', { status: 400 });
        const root = fs.realpathSync(siteRoot);
        const target = fs.realpathSync(path.resolve(root, relative));
        if (!target.startsWith(root + path.sep) || !fs.statSync(target).isFile()) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(target).href, { cache: 'no-store' });
      } catch { return new Response('Website file not found', { status: 404 }); }
    });
  }
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  windowRef = new BrowserWindow({ width: 1200, height: 820, minWidth: 720, minHeight: 500, title: config.name, autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  windowRef.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\\/\\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  windowRef.webContents.on('will-navigate', (event, url) => { let scheme = ''; try { scheme = new URL(url).protocol; } catch {} if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'muse-app-site:') event.preventDefault(); });
  const startUrl = config.source.type === 'remote' ? config.source.url : 'muse-app-site://local/' + config.source.entry.split('/').map(encodeURIComponent).join('/');
  try { await windowRef.loadURL(startUrl); }
  catch (error) {
    const detail = escapeHtml(error && error.message || 'The website could not be loaded.');
    const html = '<!doctype html><meta charset="utf-8"><title>' + escapeHtml(config.name) + '</title><style>body{font:16px system-ui;max-width:760px;margin:12vh auto;padding:24px;line-height:1.6}</style><h1>Could not open this website</h1><p>' + detail + '</p><p>Check the address and try again. Localhost apps need their web server running at the packaged URL.</p>';
    await windowRef.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }
  windowRef.on('closed', () => { windowRef = null; });
});
app.on('window-all-closed', () => app.quit());
`;
}

function skipRuntimePath(sourceRoot, candidate) {
  const relative = path.relative(sourceRoot, candidate);
  const parts = relative.split(path.sep);
  if (parts[0] === 'WebApps' || parts[0] === 'site-apps') return true;
  if (parts[0] === 'resources' && (parts[1] === 'app' || /\.asar(?:\.unpacked)?$/i.test(parts[1] || ''))) return true;
  if (parts.length === 1 && /\.exe$/i.test(parts[0])) return true;
  return false;
}

async function copyRuntime(sourceRoot, stageDir, runtimeExe, outputExeName) {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.name);
    if (skipRuntimePath(sourceRoot, source)) continue;
    await fs.cp(source, path.join(stageDir, entry.name), {
      recursive: true,
      filter: candidate => !skipRuntimePath(sourceRoot, candidate),
    });
  }
  await fs.copyFile(runtimeExe, path.join(stageDir, outputExeName));
}

async function copyWebsite(source, target) {
  const root = await fs.realpath(source.root);
  const entry = validateEntry(source.entry);
  const entryPath = await fs.realpath(path.resolve(root, ...entry.split('/')));
  if (!entryPath.startsWith(root + path.sep) || !(await fs.stat(entryPath)).isFile()) throw Error('The selected website HTML entry could not be found.');
  await fs.cp(root, target, {
    recursive: true,
    filter: candidate => {
      const relative = path.relative(root, candidate);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      const base = parts[parts.length - 1];
      if (parts.some(part => ['.git', '.od', 'node_modules', 'WebApps', 'site-apps'].includes(part))) return false;
      if (/^\.env(?:\.|$)/i.test(base) || base === '.DS_Store') return false;
      return true;
    },
  });
  return entry;
}

async function createSiteApp({ name, outputRoot, runtimeExe, source }) {
  const displayName = safeName(name);
  const runtimePath = await fs.realpath(runtimeExe);
  const runtimeDir = path.dirname(runtimePath);
  const appDir = path.join(outputRoot, displayName);
  await fs.mkdir(outputRoot, { recursive: true });
  try { await fs.access(appDir); throw Error(`An app named “${displayName}” already exists in ${outputRoot}. Rename it or move the existing app first.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stageDir = await fs.mkdtemp(path.join(outputRoot, `.muse-${crypto.randomBytes(5).toString('hex')}-`));
  try {
    await copyRuntime(runtimeDir, stageDir, runtimePath, `${displayName}.exe`);
    const resourcesDir = path.join(stageDir, 'resources');
    const appDirInside = path.join(resourcesDir, 'app');
    await fs.mkdir(appDirInside, { recursive: true });
    let normalizedSource;
    if (source.type === 'remote') {
      let url;
      try { url = new URL(source.url); } catch { throw Error('Enter a valid website URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Only public http:// and https:// URLs can be packaged.');
      normalizedSource = { type: 'remote', url: url.href };
    } else if (source.type === 'local') {
      const websiteDir = path.join(appDirInside, 'site');
      const entry = await copyWebsite(source, websiteDir);
      normalizedSource = { type: 'local', entry };
    } else throw Error('Choose a website URL or a local static website first.');
    const packageName = displayName.toLowerCase().replace(/[^a-z0-9-]+/g, '-') || `muse-site-${crypto.randomBytes(3).toString('hex')}`;
    await fs.writeFile(path.join(appDirInside, 'package.json'), JSON.stringify({ name: packageName, productName: displayName, version: '1.0.0', main: 'main.js' }, null, 2));
    await fs.writeFile(path.join(appDirInside, 'site.json'), JSON.stringify({ name: displayName, source: normalizedSource }, null, 2));
    await fs.writeFile(path.join(appDirInside, 'main.js'), localProtocolMain());
    await fs.rename(stageDir, appDir);
    return { ok: true, name: displayName, appDir, exePath: path.join(appDir, `${displayName}.exe`), source: normalizedSource };
  } catch (error) {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { createSiteApp, safeName, validateEntry, localProtocolMain };
