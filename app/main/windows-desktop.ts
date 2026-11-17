const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

type NativeWindow = { id: string; pid: number; started: string; title: string; processName: string; width: number; height: number; x: number; y: number };
type Options = {
  blockedPids?: () => number[];
  nativeRunner?: (request: any, signal?: AbortSignal) => Promise<any>;
  platform?: string;
};

// The executable and script are fixed. Only structured data travels on stdin.
function nativeRunner(request: any, signal?: AbortSignal) {
  return new Promise<any>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Windows action cancelled')); return; }
    const script = fs.readFileSync(path.join(__dirname, 'windows-native.ps1'), 'utf8');
    const command = `[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`;
    if (!process.env.SystemRoot) { reject(new Error('Windows system directory is unavailable')); return; }
    const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', bytes = 0, settled = false;
    const finish = (error?: Error, result?: any) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => { child.kill(); finish(new Error('Windows action cancelled')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Windows action timed out')); }, 20000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 24 * 1024 * 1024) { child.kill(); finish(new Error('Windows screenshot exceeded its size limit')); }
      else stdout += chunk.toString('utf8');
    });
    child.stderr.resume(); // Never return native diagnostics or unrelated process details.
    child.on('error', () => finish(new Error('Windows desktop service could not start')));
    child.stdin.on('error', () => {});
    child.on('close', () => {
      if (settled) return;
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (!result.ok) throw new Error(result.error || 'Windows action failed');
        finish(undefined, result);
      } catch (error) { finish(error instanceof Error ? error : new Error('Windows action failed')); }
    });
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) abort();
  });
}

function createWindowsDesktop(options: Options = {}) {
  let selected: NativeWindow | null = null, revision = 0, snapshot: any = null;
  let running: AbortController | null = null;
  const run = options.nativeRunner || nativeRunner;
  const blocked = () => [...new Set([process.pid, ...(options.blockedPids?.() || [])])].filter(pid => Number.isSafeInteger(pid) && pid > 0);
  const status = () => ({ state: selected ? 'selected' : 'unselected', selected: selected ? { ...selected } : null, revision });
  async function invoke(action: string, args: any, target: NativeWindow | null, signal?: AbortSignal) {
    if ((options.platform || process.platform) !== 'win32') throw new Error('Local Windows control is available only on Windows');
    if (running) throw new Error('A Windows desktop action is already running');
    const controller = new AbortController(); running = controller;
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      if (combined.aborted) throw new Error('Windows action cancelled');
      const result = await run({ action, args, target, blockedPids: blocked() }, combined);
      if (combined.aborted) throw new Error('Windows action cancelled');
      if (!result || result.ok === false) throw new Error('Windows action failed');
      return result;
    } finally { if (running === controller) running = null; }
  }
  function validateWindow(window: any): NativeWindow {
    if (!window || !/^\d{1,20}$/.test(window.id) || !Number.isSafeInteger(window.pid) || window.pid <= 0 || blocked().includes(window.pid)
      || typeof window.started !== 'string' || !/^\d{1,24}$/.test(window.started)
      || ![window.width, window.height, window.x, window.y].every(Number.isSafeInteger) || window.width < 1 || window.height < 1
      || window.width > 16000 || window.height > 16000) throw new Error('Invalid Windows target');
    return { ...window, title: String(window.title || '').slice(0, 1000), processName: String(window.processName || '').slice(0, 260) };
  }
  async function list() {
    const result = await invoke('list', {}, null);
    const windows: NativeWindow[] = [];
    for (const value of (Array.isArray(result.windows) ? result.windows.slice(0, 500) : [])) {
      try { windows.push(validateWindow(value)); } catch {}
    }
    return { windows };
  }
  async function select(id: string) {
    if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw new Error('Invalid Windows target');
    const candidate = (await list()).windows.find(window => window.id === id);
    if (!candidate) throw new Error('The selected window is unavailable');
    await invoke('validate', {}, candidate);
    selected = candidate; snapshot = null; revision++;
    return status();
  }
  function release() { running?.abort(); selected = null; snapshot = null; revision++; return status(); }
  async function execute(action: string, args: any = {}, signal?: AbortSignal) {
    if (!['screenshot', 'click', 'type', 'key', 'scroll'].includes(action)) throw new Error('Unknown Windows action');
    if (!selected) throw new Error('Choose a window using the Windows button before using Windows tools');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid Windows action arguments');
    const target = { ...selected }, current = revision;
    let safe: any = {};
    if (action === 'screenshot') snapshot = null;
    if (action !== 'screenshot') {
      if (!snapshot || (args.revision !== undefined && args.revision !== revision)) throw new Error('Take a fresh window screenshot before input');
      safe.expectedRect = snapshot;
      if (action === 'click' || action === 'scroll') {
        const x = args.x ?? Math.floor(snapshot.width / 2), y = args.y ?? Math.floor(snapshot.height / 2);
        if (![x, y].every(Number.isSafeInteger) || x < 0 || y < 0 || x >= snapshot.width || y >= snapshot.height) throw new Error('Coordinates must be inside the selected window');
        safe.x = x; safe.y = y;
        if (action === 'click') {
          safe.button = args.button || 'left';
          if (!['left', 'right', 'middle'].includes(safe.button)) throw new Error('Invalid mouse button');
        } else {
          safe.delta = args.delta;
          if (!Number.isSafeInteger(safe.delta) || safe.delta === 0 || Math.abs(safe.delta) > 1200) throw new Error('Scroll delta must be a nonzero integer between -1200 and 1200');
        }
      } else if (action === 'type') {
        if (typeof args.text !== 'string' || !args.text.length || args.text.length > 8000 || /[\x00-\x1f\x7f]/.test(args.text)) throw new Error('Text must contain 1–8000 printable characters; use key for Enter or Tab');
        safe.text = args.text;
      } else {
        const key = String(args.key || '').toUpperCase();
        if (!/^(?:(?:CTRL|ALT|SHIFT)\+){0,3}(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ENTER|TAB|ESCAPE|BACKSPACE|DELETE|SPACE|HOME|END|LEFT|RIGHT|UP|DOWN|PAGEUP|PAGEDOWN)$/.test(key)
          || /(?:ALT\+.*(?:TAB|ESCAPE)|CTRL\+.*ESCAPE)/.test(key)
          || (key.includes('CTRL+') && key.includes('ALT+') && key.endsWith('DELETE'))) throw new Error('Unsupported or global keyboard shortcut');
        safe.key = key;
      }
      snapshot = null; revision++;
    }
    const result = await invoke(action, safe, target, signal);
    if (!selected || selected.id !== target.id || (action === 'screenshot' && revision !== current)) throw new Error('Windows target changed during the action');
    if (action === 'screenshot') {
      const window = validateWindow(result.window);
      if (window.id !== target.id || window.pid !== target.pid || window.started !== target.started) throw new Error('Windows target identity changed');
      if (typeof result.data !== 'string' || result.data.length > Math.ceil(8 * 1024 * 1024 / 3) * 4) throw new Error('Invalid window screenshot');
      const png = Buffer.from(result.data, 'base64');
      if (png.length > 8 * 1024 * 1024 || png.toString('base64') !== result.data || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Invalid window screenshot');
      selected = window; snapshot = { x: window.x, y: window.y, width: window.width, height: window.height }; revision++;
      return { ok: true, output: `Selected window screenshot (${window.width}×${window.height}). Revision ${revision}.`, revision,
        width: window.width, height: window.height, images: [{ type: 'image', mimeType: 'image/png', data: result.data }] };
    }
    return { ok: true, output: `Selected window ${action} completed. Take a fresh screenshot before further input.`, revision };
  }
  return { list, select, status, release, execute };
}

module.exports = { createWindowsDesktop };
