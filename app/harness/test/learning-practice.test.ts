const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPractice } = require('../../learning/practice.ts');
const sourceId = '12345678-1234-4234-9234-123456789abc';
const owner = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
const checkpoint = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const program = 'BEGIN { n=split(input,a," "); sum=0; for(i=1;i<=n;i++) if(a[i]%2==0) sum+=a[i]*a[i]; print sum }';

function fixture(t: any, changes: any = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-practice-test-'));
  fs.writeFileSync(path.join(directory, 'sandbox.json'), JSON.stringify({ id: sourceId, owner, checkpoint, ready: true }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: string[][] = [];
  let clone = '', state = 'saved', tagged = false, tests = 0;
  const controller = new AbortController();
  const run = async (args: string[], signal?: AbortSignal) => {
    calls.push(args);
    if (changes.before) await changes.before(args, controller);
    signal?.throwIfAborted();
    if (args[0] === 'snapshot') return `SnapshotUUID="${checkpoint}"`;
    if (args[0] === 'getextradata') return `Value: ${args[1] === sourceId ? (changes.badOwner ? 'wrong' : owner) : (tagged ? owner : 'wrong')}`;
    if (args[0] === 'showvminfo') return args[1] === sourceId ? `VMState="${changes.sourceState || 'saved'}"` : `VMState="${state}"\nCfgFile="${changes.badPath ? path.join(directory, 'unrelated.vbox') : path.join(directory, 'practice', `MusePractice-${clone}`, 'practice.vbox')}"\nSharedFolderNameMachineMapping1="inherited"`;
    if (args[0] === 'clonevm') { clone = args[args.indexOf('--uuid') + 1]; state = 'saved'; }
    if (args[0] === 'setextradata') tagged = true;
    if (args[0] === 'discardstate') state = 'poweroff';
    if (args[0] === 'startvm') state = 'running';
    if (args[0] === 'controlvm') state = 'poweroff';
    if (args[0] === 'guestcontrol') {
      const input = args.find(item => item.startsWith('input='))!.slice(6);
      if (args.includes('BEGIN { print "MUSE_PRACTICE_READY" }')) return 'MUSE_PRACTICE_READY\n';
      tests++;
      if (changes.wrongOutput) return 'incorrect';
      return String(input.split(/\s+/).filter(Boolean).map(Number).filter(n => n % 2 === 0).reduce((sum, n) => sum + n * n, 0)) + '\n';
    }
    return '';
  };
  const practice = createPractice({ directory, run });
  let chats = 0;
  const ctx = { signal: controller.signal, checkpoint: async () => { controller.signal.throwIfAborted(); }, chat: async () => { chats++; return { message: { content: JSON.stringify({ program }) } }; } };
  return { practice, ctx, calls, directory, controller, get chats() { return chats; }, get tests() { return tests; } };
}

test('practice readiness is read-only and verifies the source checkpoint and ownership', async t => {
  const f = fixture(t);
  assert.equal((await f.practice.ready()).ready, true);
  assert.deepEqual(f.calls.map(args => args[0]), ['getextradata', 'snapshot', 'showvminfo']);
  const bad = fixture(t, { badOwner: true });
  assert.equal((await bad.practice.ready()).ready, false);
  assert.equal(bad.calls.length, 1);
});

test('practice verifies independent guest outputs and deletes only its isolated clone', async t => {
  const f = fixture(t);
  const result = await f.practice.solve(f.ctx);
  assert.equal(result.verified, true); assert.equal(f.chats, 1); assert.equal(f.tests, 12);
  const clone = f.calls.find(args => args[0] === 'clonevm')!;
  assert.equal(clone[1], sourceId); assert.equal(clone[clone.indexOf('--snapshot') + 1], checkpoint);
  assert.equal(clone[clone.indexOf('--options') + 1], 'link');
  const id = clone[clone.indexOf('--uuid') + 1]; assert.notEqual(id, sourceId);
  const modify = f.calls.find(args => args[0] === 'modifyvm')!;
  for (let i = 1; i <= 8; i++) assert.equal(modify[modify.indexOf(`--nic${i}`) + 1], 'none');
  for (const flag of ['--clipboard-mode', '--clipboard-file-transfers', '--drag-and-drop']) assert.equal(modify[modify.indexOf(flag) + 1], 'disabled');
  assert.ok(f.calls.some(args => args[0] === 'sharedfolder' && args[1] === 'remove'));
  assert.equal(f.calls.filter(args => ['modifyvm', 'controlvm', 'startvm', 'unregistervm', 'discardstate', 'guestcontrol'].includes(args[0])).every(args => args[1] === id), true);
  assert.deepEqual(f.calls.filter(args => args[0] === 'unregistervm'), [['unregistervm', id, '--delete']]);
  assert.deepEqual(fs.readdirSync(path.join(f.directory, 'practice')), []);
});

test('wrong guest output receives no verified lesson and still cleans the clone', async t => {
  const f = fixture(t, { wrongOutput: true });
  await assert.rejects(f.practice.solve(f.ctx), /failed an independent/);
  assert.equal(f.tests, 1); assert.equal(f.calls.filter(args => args[0] === 'unregistervm').length, 1);
});

test('cancellation before guest execution powers off and cleans only owned clone', async t => {
  const f = fixture(t, { before: (args: string[], controller: AbortController) => { if (args[0] === 'guestcontrol') controller.abort(Error('idle ended')); } });
  await assert.rejects(f.practice.solve(f.ctx), /idle ended/);
  assert.equal(f.tests, 0); assert.equal(f.calls.filter(args => args[0] === 'unregistervm').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'controlvm')[0][2], 'poweroff');
});

test('cleanup refuses a clone whose configuration path escaped its owned directory', async t => {
  const f = fixture(t, { badPath: true });
  await assert.rejects(f.practice.solve(f.ctx), /cleanup failed/);
  assert.equal(f.calls.some(args => args[0] === 'unregistervm'), false);
  assert.equal(f.calls.some(args => args[0] === 'startvm'), false);
});

test('practice rejects active source VMs and checks guest readiness before requesting a solution', async t => {
  const active = fixture(t, { sourceState: 'running' });
  await assert.rejects(active.practice.solve(active.ctx), /Save or stop/);
  const f = fixture(t);
  f.ctx.chat = async () => ({ message: { content: 'not json' } });
  await assert.rejects(f.practice.solve(f.ctx), /strict JSON/);
  assert.equal(f.tests, 0, 'invalid model output is parsed before guest tests');
  assert.equal(f.calls.some(args => args[0] === 'clonevm'), true, 'guest readiness is checked in an isolated clone first');
  assert.equal(f.calls.some(args => args[0] === 'unregistervm'), true, 'the disposable clone is cleaned after malformed output');
});
