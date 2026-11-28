const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-approval-ledger-'));
process.env.MUSE_HOME = home;
const session = require('../session');
const approvals = require('../approval-record');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function gate(tool = 'shell', args = { command: 'npm test' }) {
  const built = approvals.buildRequest({ tool, args }, {
    id: 'gate-1', sessionId: 's', mode: 'ask', timeoutS: 3600, projectDir: home, now: 1764000000000,
  });
  return built;
}

test('an approval receipt is written to the session ledger and verifies after reload', () => {
  const key = approvals.signingKey(home);
  const built = gate();
  const id = session.newId();
  session.save({ id, history: [{ role: 'user', content: 'run the tests' }] });
  session.appendReceipt(id, approvals.makeReceipt(built, { decision: 'allow', decidedBy: 'user', key }));

  const stored = session.load(id);
  const receipt = stored.receipts.find(r => r.type === 'approval');
  assert.ok(receipt, 'the gate decision is on disk');
  assert.equal(receipt.requestDigest, built.digest);
  assert.equal(receipt.decision, 'allow');
  assert.equal(receipt.scope.label, 'This device');
  assert.equal(approvals.verifyReceipt(receipt, key), true);
});

test('editing the stored decision breaks the signature', () => {
  const key = approvals.signingKey(home);
  const built = gate('write_file', { path: path.join(home, 'notes.md'), content: 'hello' });
  const id = session.newId();
  session.save({ id, history: [{ role: 'user', content: 'write notes' }] });
  session.appendReceipt(id, approvals.makeReceipt(built, { decision: 'allow', decidedBy: 'user', key }));

  const file = path.join(home, 'sessions', `${id}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const index = lines.findIndex(line => line.includes('"type":"approval"'));
  assert.ok(index >= 0);
  const record = JSON.parse(lines[index]);
  record.decision = 'deny';
  lines[index] = JSON.stringify(record);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const receipt = session.load(id).receipts.find(r => r.type === 'approval');
  assert.equal(receipt.decision, 'deny');
  assert.equal(approvals.verifyReceipt(receipt, key), false);
});
