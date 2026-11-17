const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWindowsDesktop } = require('../../main/windows-desktop.ts');

const windowFixture = { id: '12345', pid: 45678, started: '638900000000000000', title: 'Isolated fixture', processName: 'fixture', x: 20, y: 40, width: 800, height: 600 };
function fixture(extra: any = {}) {
  const calls: any[] = [];
  const desktop = createWindowsDesktop({ platform: 'win32', blockedPids: () => [98765],
    nativeRunner: async (request: any, signal: AbortSignal) => {
      calls.push(request);
      if (extra.native) return extra.native(request, signal);
      if (request.action === 'list') return { windows: [windowFixture, { ...windowFixture, id: '5', pid: process.pid }, { ...windowFixture, id: '6', pid: 98765 }] };
      if (request.action === 'screenshot') return { ok: true, window: { ...windowFixture, ...extra.window }, data: extra.data ?? 'iVBORw0KGgo=' };
      return { ok: true };
    },
  });
  return { desktop, calls };
}

test('Windows selection is explicit, filters Muse processes, and pins complete native identity', async () => {
  const f = fixture();
  assert.equal(f.desktop.status().selected, null);
  await assert.rejects(() => f.desktop.execute('screenshot'), /Choose a window/);
  assert.deepEqual((await f.desktop.list()).windows.map((window: any) => window.id), ['12345']);
  await f.desktop.select('12345');
  assert.equal(f.desktop.status().selected.pid, windowFixture.pid);
  assert.deepEqual(f.calls.at(-1).target, windowFixture);
  assert.ok(f.calls.at(-1).blockedPids.includes(process.pid));
  assert.ok(f.calls.at(-1).blockedPids.includes(98765));
  await assert.rejects(() => f.desktop.select('12345; Write-Output bad'), /Invalid/);
  await assert.rejects(() => f.desktop.select('987654'), /unavailable/);
});

test('Windows screenshots return tool images and each input consumes a fresh bounded revision', async () => {
  const f = fixture(); await f.desktop.select('12345');
  await assert.rejects(() => f.desktop.execute('click', { x: 1, y: 1 }), /fresh/);
  const screenshot = await f.desktop.execute('screenshot');
  assert.equal(screenshot.images[0].type, 'image'); assert.equal(screenshot.images[0].mimeType, 'image/png');
  await assert.rejects(() => f.desktop.execute('click', { x: 800, y: 1 }), /inside/);
  await assert.rejects(() => f.desktop.execute('click', { x: 1, y: 1, revision: screenshot.revision - 1 }), /fresh/);
  await f.desktop.execute('click', { x: 4, y: 5, revision: screenshot.revision });
  assert.deepEqual(f.calls.at(-1).args.expectedRect, { x: 20, y: 40, width: 800, height: 600 });
  assert.equal(f.calls.at(-1).args.x, 4);
  await assert.rejects(() => f.desktop.execute('type', { text: 'fixture only' }), /fresh/);
});

test('Windows input rejects global shortcuts, controls, oversized text, and malformed scrolling before native calls', async () => {
  const f = fixture(); await f.desktop.select('12345'); await f.desktop.execute('screenshot');
  const count = f.calls.length;
  for (const key of ['ALT+TAB', 'CTRL+ESCAPE', 'CTRL+SHIFT+ESCAPE', 'WIN+R', 'CTRL+ALT+DELETE', 'SHIFT+ALT+TAB']) {
    await assert.rejects(() => f.desktop.execute('key', { key }), /Unsupported/);
  }
  await assert.rejects(() => f.desktop.execute('type', { text: 'x\n' }), /printable/);
  await assert.rejects(() => f.desktop.execute('type', { text: 'x'.repeat(8001) }), /printable/);
  await assert.rejects(() => f.desktop.execute('scroll', { delta: 1201 }), /Scroll/);
  await assert.rejects(() => f.desktop.execute('click', { button: 'double' }), /button/);
  assert.equal(f.calls.length, count);
  await f.desktop.execute('key', { key: 'CTRL+A' });
  assert.equal(f.calls.at(-1).args.key, 'CTRL+A');
});

test('Windows screenshot rejects reused HWND with a new process identity', async () => {
  const f = fixture({ window: { started: '638900000000000001' } }); await f.desktop.select('12345');
  await assert.rejects(() => f.desktop.execute('screenshot'), /identity changed/);
  await assert.rejects(() => f.desktop.execute('click', { x: 1, y: 1 }), /fresh/);
});

test('Windows screenshot rejects non-PNG, noncanonical base64 and oversized payloads', async () => {
  for (const data of ['aGVsbG8=', 'iVBORw0KGgo=\n', 'iVBORw0KGgo=' + 'A'.repeat(12 * 1024 * 1024)]) {
    const f = fixture({ data }); await f.desktop.select('12345');
    await assert.rejects(() => f.desktop.execute('screenshot'), /Invalid window screenshot/);
    await assert.rejects(() => f.desktop.execute('key', { key: 'ENTER' }), /fresh/);
  }
});

test('release cancels an in-flight native action and cannot resurrect its target', async () => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ native: async (request: any, signal: AbortSignal) => {
    if (request.action === 'list') return { windows: [windowFixture] };
    if (request.action !== 'screenshot') return { ok: true };
    entered();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true }));
  } });
  await f.desktop.select('12345'); const pending = f.desktop.execute('screenshot');
  const rejected = assert.rejects(() => pending, /cancelled/);
  await ready; assert.equal(f.desktop.release().selected, null); await rejected;
  assert.equal(f.desktop.status().selected, null);
});

test('native cancellation and platform boundaries run no unintended action', async () => {
  const f = fixture(); await f.desktop.select('12345'); const count = f.calls.length;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => f.desktop.execute('screenshot', {}, controller.signal), /cancelled/);
  await assert.rejects(() => f.desktop.execute('run', { command: 'not supported' }), /Unknown/);
  assert.equal(f.calls.length, count);
  await assert.rejects(() => createWindowsDesktop({ platform: 'linux' }).list(), /only on Windows/);
});
