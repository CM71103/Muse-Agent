const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSandboxVM } = require('../../main/sandbox-vm.ts');
const { createSandboxService } = require('../../main/sandbox-service.ts');
const { configureSandbox, mkSandboxTools } = require('../sandbox-tools.ts');
const { buildTools } = require('../tools.js');
const { Sentinel } = require('../sentinel.js');
const snapshotUUID = '12345678-1234-4234-9234-123456789abc';

async function fixture(t: any, options: any = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sandbox-test-'));
  t.after(() => { configureSandbox(null); fs.rmSync(directory, { recursive: true, force: true }); });
  const iso = path.join(directory, 'fixture.iso'); fs.writeFileSync(iso, 'isolated fake installation media');
  const calls: string[][] = [], pointers: any[] = [];
  let state = 'poweroff', owner = '', snapshotName = '', rejectOwner = false;
  const run = async (args: string[], signal?: AbortSignal) => {
    calls.push(args);
    if (options.before) await options.before(args, signal);
    if (signal?.aborted) throw Error('fixture cancelled');
    if (args[0] === 'setextradata') owner = args[3];
    if (args[0] === 'getextradata') return rejectOwner ? 'Value: unrelated-owner' : `Value: ${owner}`;
    if (args[0] === 'showvminfo') return `name="fixture"\r\nVMState="${state}"\r\n`;
    if (args[0] === 'startvm') state = 'running';
    if (args[0] === 'discardstate') state = 'poweroff';
    if (args[0] === 'controlvm' && args[2] === 'savestate') state = 'saved';
    if (args[0] === 'controlvm' && args[2] === 'poweroff') state = 'poweroff';
    if (args[0] === 'controlvm' && args[2] === 'screenshotpng') {
      const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1024, 16); png.writeUInt32BE(768, 20);
      fs.writeFileSync(args[3], options.badPNG ? 'not a PNG' : png);
    }
    if (args[0] === 'snapshot' && args[2] === 'take') snapshotName = args[3];
    if (args[0] === 'snapshot' && args[2] === 'list') return `SnapshotName="older"\r\nSnapshotUUID="aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa"\r\nSnapshotName-1="${snapshotName}"\r\nSnapshotUUID-${options.mismatchedSnapshot ? 2 : 1}="${snapshotUUID}"\r\n`;
    return '';
  };
  const vm = createSandboxVM({ directory, run, pointer: async (args: any, signal: AbortSignal) => {
    if (signal?.aborted) throw Error('fixture cancelled'); pointers.push(args); return { ok: true };
  } });
  vm.chooseISO(iso); await vm.create();
  return { vm, calls, pointers, directory, iso, denyOwner: () => { rejectOwner = true; }, setState: (next: string) => { state = next; } };
}

test('selecting host clears sandbox selection and refreshes the agent tools',async()=>{
  let selected=true,refreshes=0;
  const service=createSandboxService({vm:{isSelected:()=>selected,selectHost:async()=>{selected=false;return {ok:true,selected:false};}},
    ipcMain:{handle:()=>{}},requireTrusted:()=>{},busy:()=>false,refreshTools:()=>refreshes++});
  const result=await service.useHost();
  assert.equal(result.selected,false);assert.equal(selected,false);assert.equal(refreshes,1);
  configureSandbox(null);
});

test('sandbox creates a fresh UUID with ownership tag and disables host integration', async t => {
  const f = await fixture(t); const status = await f.vm.status();
  assert.match(status.vmId, /^[0-9a-f-]{36}$/);
  const create = f.calls.find(args => args[0] === 'createvm'); assert.ok(create.includes(status.vmId));
  const tag = f.calls.find(args => args[0] === 'setextradata'); assert.equal(tag[2], 'MuseSandboxOwner'); assert.match(tag[3], /^[0-9a-f-]{36}$/);
  const modify = f.calls.find(args => args[0] === 'modifyvm');
  for (const flag of ['--clipboard-mode', '--clipboard-file-transfers', '--drag-and-drop']) assert.equal(modify[modify.indexOf(flag) + 1], 'disabled');
  assert.equal(modify[modify.indexOf('--nat-localhostreachable1') + 1], 'off');
  assert.equal(f.calls.some(args => args[0] === 'sharedfolder'), false);
  await assert.rejects(() => f.vm.create(), /already/);
});

test('unowned VM cannot be started, captured, reset or sent input', async t => {
  const f = await fixture(t); f.denyOwner(); const mark = f.calls.length;
  await assert.rejects(() => f.vm.start(), /not owned/);
  await assert.rejects(() => f.vm.frame(), /not owned/);
  await assert.rejects(() => f.vm.input({ kind: 'text', text: 'fixture' }), /not owned/);
  assert.equal(f.calls.slice(mark).some(args => ['startvm', 'controlvm'].includes(args[0])), false);
});

test('invalid persisted UUID cannot become an arbitrary VBox command target', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sandbox-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'sandbox.json'), JSON.stringify({ id: '--settingspwfile', owner: snapshotUUID }));
  assert.throws(() => createSandboxVM({ directory, run: async () => assert.fail('must not run') }), /Invalid sandbox/);
});

test('guest screenshot dimensions, revision and literal argument boundaries are preserved', async t => {
  const f = await fixture(t); await f.vm.start(); const frame = await f.vm.frame();
  assert.equal(frame.width, 1024); assert.equal(frame.height, 768);
  assert.equal(fs.readdirSync(f.directory).some((name: string) => name.startsWith('frame-')), false);
  const text = '--settingspwfile ; $(Write-Output fixture) "quoted"';
  await f.vm.input({ kind: 'text', text, revision: frame.revision });
  const command = f.calls.findLast(args => args[2] === 'keyboardputstring'); assert.equal(command.length, 4); assert.equal(command[3], text);
  await assert.rejects(() => f.vm.input({ kind: 'key', key: 'ENTER', revision: frame.revision }), /changed|fresh/);
  const fresh = await f.vm.frame();
  await assert.rejects(() => f.vm.input({ kind: 'key', key: 'ENTER;host-command', revision: fresh.revision }), /Unsupported/);
});

test('guest clicks are scaled to VirtualBox absolute tablet coordinates across the full screen', async t => {
  const f=await fixture(t);await f.vm.start();const frame=await f.vm.frame();
  await f.vm.input({kind:'click',x:512,y:384,button:'left',revision:frame.revision});
  assert.equal(f.pointers[0].absoluteX,16400);assert.equal(f.pointers[0].absoluteY,16405);
  const fresh=await f.vm.frame();await f.vm.input({kind:'click',x:fresh.width-1,y:fresh.height-1,button:'left',revision:fresh.revision});
  assert.equal(f.pointers[1].absoluteX,32767);assert.equal(f.pointers[1].absoluteY,32767);
});

test('stopped VM fails closed and selecting host never starts any other machine', async t => {
  const f = await fixture(t); await f.vm.start(); await f.vm.frame(); await f.vm.stop();
  const mark = f.calls.length;
  await assert.rejects(() => f.vm.input({ kind: 'text', text: 'fixture' }), /Start/);
  await assert.rejects(() => f.vm.frame(), /Start/);
  assert.equal(f.calls.slice(mark).some(args => args[0] === 'startvm' || args[0] === 'controlvm'), false);
  await f.vm.selectHost(); assert.equal(f.vm.isSelected(), false);
});

test('checkpoint stores verified nested snapshot UUID and reset targets only the owned machine', async t => {
  const f = await fixture(t); await f.vm.start(); await f.vm.checkpoint(); await f.vm.reset();
  const restore = f.calls.find(args => args[0] === 'snapshot' && args[2] === 'restore');
  assert.equal(restore[1], (await f.vm.status()).vmId); assert.equal(restore[3], snapshotUUID);
});

test('invalid screenshot bytes never publish guest dimensions', async t => {
  const f = await fixture(t, { badPNG: true }); await f.vm.start();
  await assert.rejects(() => f.vm.frame(), /Invalid guest/); assert.equal((await f.vm.status()).screen, null);
});

test('sandbox tool registry excludes host files, commands, MCP and subagents including nested agents', t => {
  configureSandbox({ isSelected: () => true }); t.after(() => configureSandbox(null));
  const registry = buildTools({});
  assert.deepEqual([...registry.map.keys()].sort(), ['sandbox_click', 'sandbox_key', 'sandbox_screenshot', 'sandbox_scroll', 'sandbox_type']);
  assert.equal(buildTools({}, { disableSubagent: true }).map.size, 0);
});

test('sandbox tools require selected guest and exact integer revisions before invoking backend', async t => {
  let selected = false, calls = 0;
  configureSandbox({ isSelected: () => selected, input: async () => { calls++; return { ok: true }; } }); t.after(() => configureSandbox(null));
  const click = mkSandboxTools().find((tool: any) => tool.name === 'sandbox_click');
  await assert.rejects(() => click.run({ revision: 1, x: 0, y: 0 }, {}), /not selected/);
  selected = true; await assert.rejects(() => click.run({ x: 0, y: 0 }, {}), /fresh/); assert.equal(calls, 0);
  await click.run({ revision: 1, x: 0, y: 0 }, {}); assert.equal(calls, 1);
});

test('Sentinel treats guest input as side effects in Ask, Auto, Plan and dynamic deny rules', () => {
  for (const name of ['sandbox_click', 'sandbox_type', 'sandbox_key', 'sandbox_scroll']) {
    const sentinel = new Sentinel({ sentinel: { mode: 'ask' } }); const request = { tool: name, args: { revision: 1 } };
    assert.equal(sentinel.decide(request).decision, 'ask'); sentinel.setMode('auto'); assert.equal(sentinel.decide(request).decision, 'allow');
    sentinel.setMode('plan'); assert.equal(sentinel.decide(request).decision, 'deny');
    sentinel.setMode('auto'); sentinel.denyRules.push(`${name}*`); assert.equal(sentinel.decide(request).decision, 'deny');
  }
});

test('agent input requires a selected fresh screen; only explicit trusted manual input bypasses revisions', async t => {
  const f = await fixture(t); await f.vm.start();
  await assert.rejects(() => f.vm.input({ kind: 'text', text: 'fixture' }), /fresh/);
  await f.vm.input({ kind: 'key', key: 'ENTER' }, undefined, true);
  const screen = await f.vm.frame();
  await assert.rejects(() => f.vm.input({ kind: 'text', text: 'fixture', manual: true }), /fresh/);
  await f.vm.input({ kind: 'text', text: 'fixture', revision: screen.revision });
  await f.vm.frame(); await f.vm.selectHost();
  assert.equal((await f.vm.status()).screen, null);
  await assert.rejects(() => f.vm.input({ kind: 'key', key: 'ENTER', revision: screen.revision }), /fresh/);
});

test('cancelling while ownership validation awaits cannot deliver guest pointer input', async t => {
  let armed = false, release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { before: async (args: string[]) => {
    if (armed && args[0] === 'showvminfo') { armed = false; entered(); await new Promise<void>(resolve => { release = resolve; }); }
  } });
  await f.vm.start(); const frame = await f.vm.frame(); armed = true;
  const controller = new AbortController();
  const pending = f.vm.input({ kind: 'click', x: 10, y: 10, revision: frame.revision }, controller.signal);
  const rejected = assert.rejects(() => pending, /abort|cancel/i);
  await ready; controller.abort(); release(); await rejected; assert.equal(f.pointers.length, 0);
});

test('stopping during an awaited frame poll never publishes or captures a stale guest screen', async t => {
  let armed = false, release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { before: async (args: string[]) => {
    if (armed && args[0] === 'showvminfo') { armed = false; entered(); await new Promise<void>(resolve => { release = resolve; }); }
  } });
  await f.vm.start(); armed = true; const mark = f.calls.length;
  const pending = f.vm.frame(); const rejected = assert.rejects(() => pending, /Start|changed|finish/);
  await ready; await f.vm.stop(); release(); await rejected;
  assert.equal(f.calls.slice(mark).some(args => args[2] === 'screenshotpng'), false);
});

test('snapshot metadata must pair the matching hierarchy suffix before enabling reset', async t => {
  const f = await fixture(t, { mismatchedSnapshot: true }); await f.vm.start();
  await assert.rejects(() => f.vm.checkpoint(), /verify/);
  assert.equal((await f.vm.status()).checkpoint, false);
});

test('cancelled agent can leave a shared UI frame poll without cancelling the producer', async t => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { before: async (args: string[]) => {
    if (args[2] === 'screenshotpng') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
  } });
  await f.vm.start(); const uiFrame = f.vm.frame(); await ready;
  const controller = new AbortController(); const agentFrame = f.vm.frame(controller.signal);
  const rejected = assert.rejects(() => agentFrame, /abort|cancel/i); controller.abort(); await rejected;
  release(); assert.equal((await uiFrame).width, 1024);
  assert.equal(f.calls.filter(args => args[2] === 'screenshotpng').length, 1);
});

test('sandbox screenshot bridge rechecks cancellation before returning image pixels', async t => {
  const controller = new AbortController(); let ended = false;
  configureSandbox({ isSelected: () => true, frame: async () => {
    controller.abort(); return { data: 'fixture', width: 1, height: 1, revision: 1 };
  } }); t.after(() => configureSandbox(null));
  const screenshot = mkSandboxTools().find((tool: any) => tool.name === 'sandbox_screenshot');
  await assert.rejects(() => screenshot.run({}, { agent: { _beginAbort: () => controller, _endAbort: () => { ended = true; } } }), /abort/i);
  assert.equal(ended, true);
});
