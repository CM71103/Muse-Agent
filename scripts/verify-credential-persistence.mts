import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// Native Windows DPAPI probe. Run with Bun; never loads the application entry,
// user config, user sessions, or real credentials, and never opens a window.
if (process.platform !== 'win32') throw new Error('This native credential probe requires Windows');
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const tempBase = fs.realpathSync.native(os.tmpdir());
const temp = fs.mkdtempSync(path.join(tempBase, 'muse-vault-persistence-'));
const resolvedTemp = fs.realpathSync.native(temp);
assert.equal(path.dirname(resolvedTemp).toLowerCase(), tempBase.toLowerCase());
assert.ok(path.basename(resolvedTemp).startsWith('muse-vault-persistence-'));
const syntheticKey = `synthetic-embedding-probe-${randomUUID()}`;
const electron = require('electron');
const probe = path.join(resolvedTemp, 'probe.cjs');

type Receipt = {
  phase: string; pid: number; encrypted: boolean; recovered: boolean;
  ciphertextHash: string;
};

try {
  for (const name of ['profile', 'session', 'crashes']) fs.mkdirSync(path.join(resolvedTemp, name));
  fs.writeFileSync(probe, `
const {app,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {vault}=require(${JSON.stringify(path.join(root, 'app/harness/credentials.js'))});
const syntheticKey=${JSON.stringify(syntheticKey)};
const phase=process.argv[2];
app.setPath('userData',path.join(__dirname,'profile'));
app.setPath('sessionData',path.join(__dirname,'session'));
app.setPath('crashDumps',path.join(__dirname,'crashes'));
app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(async()=>{try{
 assert.equal(safeStorage.isEncryptionAvailable(),true,'Native OS encryption must be available');
 const storage=vault(safeStorage,path.join(__dirname,'vault'));
 if(phase==='write')storage.write({embed:syntheticKey});
 const saved=storage.read();
 assert.equal(saved.embed===syntheticKey,true,'Embedding credential must survive native vault reload');
 const ciphertext=fs.readFileSync(path.join(__dirname,'vault','credentials.enc'));
 assert.equal(ciphertext.includes(Buffer.from(syntheticKey)),false,'Vault must not contain plaintext key bytes');
 assert.equal(fs.existsSync(path.join(__dirname,'vault','credentials.enc.tmp')),false,'Atomic save must leave no temporary vault');
 fs.writeFileSync(path.join(__dirname,phase+'.json'),JSON.stringify({phase,pid:process.pid,encrypted:true,
  recovered:true,ciphertextHash:createHash('sha256').update(ciphertext).digest('hex')}));
 app.quit();
}catch(error){console.error(error.message);app.exit(1)}});
setTimeout(()=>{console.error('Native credential persistence probe timed out');app.exit(1)},15000).unref();
`);
  const env = { ...process.env, MUSE_CONFIG: path.join(resolvedTemp, 'unused-config.toml') };
  delete env.ELECTRON_RUN_AS_NODE;
  const receipts: Receipt[] = [];
  for (const phase of ['write', 'read']) {
    const result = spawnSync(electron, [probe, phase], {
      cwd: resolvedTemp, env, encoding: 'utf8', timeout: 20000,
      windowsHide: true, maxBuffer: 128 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Native credential ${phase} process failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
    }
    receipts.push(JSON.parse(fs.readFileSync(path.join(resolvedTemp, `${phase}.json`), 'utf8')));
  }
  assert.notEqual(receipts[0].pid, receipts[1].pid, 'Credential read must run in a fresh Electron process');
  assert.equal(receipts[0].ciphertextHash, receipts[1].ciphertextHash, 'Second process must recover the unchanged encrypted file');
  assert.ok(receipts.every(receipt => receipt.encrypted && receipt.recovered));
  const encryptedFile = fs.readFileSync(path.join(resolvedTemp, 'vault', 'credentials.enc'));
  assert.equal(encryptedFile.includes(Buffer.from(syntheticKey)), false);
  assert.equal(createHash('sha256').update(encryptedFile).digest('hex'), receipts[0].ciphertextHash);
  console.log(`PASS: Windows encrypted embedding credential persisted across two Electron processes (${receipts.map(receipt => receipt.pid).join(', ')}); sync vault reload succeeded; plaintext absent.`);
} finally {
  // Delete only the exact generated directory, after rechecking its parent
  // and identity. Never pass computed paths to another shell for deletion.
  assert.equal(fs.realpathSync.native(resolvedTemp).toLowerCase(), resolvedTemp.toLowerCase());
  assert.equal(path.dirname(resolvedTemp).toLowerCase(), tempBase.toLowerCase());
  fs.rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
