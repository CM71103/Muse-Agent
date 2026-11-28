const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const approvals = require('../approval-record');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-approval-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-approval-proj-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('signing key is created once, 32 bytes, readable only by the owner', () => {
  const key = approvals.signingKey(home);
  assert.equal(key.length, 32);
  const file = path.join(home, approvals.KEY_FILE);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), key.toString('hex'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(approvals.signingKey(home), key);
});

test('request digest is stable across argument order and changes with the arguments', () => {
  const ctx = { id: 'gate-1', sessionId: 's1', mode: 'ask', timeoutS: 60, projectDir: '/proj', now: 1764000000000 };
  const a = approvals.buildRequest({ tool: 'shell', args: { command: 'ls', cwd: '/proj' } }, { ...ctx, id: 'a' });
  const b = approvals.buildRequest({ tool: 'shell', args: { cwd: '/proj', command: 'ls' } }, { ...ctx, id: 'a' });
  const c = approvals.buildRequest({ tool: 'shell', args: { command: 'rm -rf /', cwd: '/proj' } }, { ...ctx, id: 'a' });
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, c.digest);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.equal(a.short, a.digest.slice(0, 12));
});

test('scope names the project, outside paths, the device, the network and MCP servers', () => {
  const dir = project();
  const inside = path.join(dir, 'src', 'app.js');
  const outside = path.join(os.tmpdir(), 'elsewhere.txt');
  assert.deepEqual(approvals.scopeFor({ tool: 'write_file', resolvedPath: inside }, { projectDir: dir }),
    { kind: 'project', label: 'Your project folder', detail: path.join('src', 'app.js') });
  assert.deepEqual(approvals.scopeFor({ tool: 'write_file', resolvedPath: outside }, { projectDir: dir }),
    { kind: 'outside', label: 'Outside your project', detail: outside });
  assert.equal(approvals.scopeFor({ tool: 'shell', args: { command: 'npm test' } }, { projectDir: dir }).kind, 'device');
  assert.equal(approvals.scopeFor({ tool: 'web_fetch', args: { url: 'https://example.com/x' } }, {}).detail, 'example.com');
  assert.match(approvals.scopeFor({ tool: 'mcp__viking__search' }, {}).label, /viking/);
});

test('exit conditions name the timeout in plain language', () => {
  const lines = approvals.exitConditions({ timeoutS: 3600 });
  assert.deepEqual(lines.map(l => l.when), ['allow', 'deny', 'timeout', 'drift']);
  assert.match(lines[2].then, /1 hour/);
  assert.match(approvals.exitConditions({ timeoutS: 90 })[2].then, /90 seconds/);
});

test('request signature and decision receipt verify, and tampering is caught', () => {
  const key = approvals.signingKey(home);
  const built = approvals.buildRequest(
    { tool: 'shell', args: { command: 'curl https://example.com' }, resolvedPath: null },
    { id: 'gate-2', sessionId: 's1', mode: 'ask', timeoutS: 60, projectDir: '/proj' });
  const pub = approvals.publicRecord(built, key);
  assert.equal(approvals.verify(built.record, pub.sig, key), true);
  assert.equal(pub.action, 'curl https://example.com');

  const receipt = approvals.makeReceipt(built, { decision: 'allow', decidedBy: 'user', key });
  assert.equal(receipt.requestDigest, built.digest);
  assert.equal(approvals.verifyReceipt(receipt, key), true);

  const tampered = { ...receipt, decision: 'allow', decidedBy: 'timeout' };
  assert.equal(approvals.verifyReceipt(tampered, key), false);
  const forged = { ...receipt, requestDigest: 'f'.repeat(64) };
  assert.equal(approvals.verifyReceipt(forged, key), false);
  assert.equal(approvals.verifyReceipt(receipt, approvals.signingKey(home + '-other')), false);
});

test('the public record carries no argument payload', () => {
  const key = approvals.signingKey(home);
  const built = approvals.buildRequest(
    { tool: 'write_file', args: { path: '/proj/a.txt', content: 'secret body' } },
    { id: 'gate-3', mode: 'ask', timeoutS: 60, projectDir: '/proj' });
  const pub = approvals.publicRecord(built, key);
  assert.equal('args' in pub, false);
  assert.equal(JSON.stringify(pub).includes('secret body'), false);
});
