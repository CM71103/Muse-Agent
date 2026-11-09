import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { releaseDirectory } from './build-windows.mts';
import { sourceManifest } from './release-check.mts';
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const supplied = process.argv.slice(2).find(arg=>!arg.startsWith('--'));
const exe = path.resolve(root, supplied || path.join(releaseDirectory(process.env,pkg.version),`MuseAgent-${pkg.version}-portable.exe`));
const expectedApp = Object.fromEntries(Object.entries(sourceManifest(root)).filter(([name])=>name.startsWith('app/')));
const base = fs.realpathSync.native(os.tmpdir());
const temp = fs.mkdtempSync(path.join(base, 'muse-launch-probe-'));
const receipt = path.join(temp,'receipt.json');
const script = path.join(temp,'probe.cjs');
const customTemp = process.argv.includes('--isolated-temp');
let child: ReturnType<typeof spawn> | undefined;
try {
  fs.writeFileSync(script, `
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const dir=path.dirname(process.execPath),archive=path.join(dir,'resources/app.asar');
assert.ok(process.versions.electron,'Probe must run in packaged Electron');
const Database=require(path.join(archive,'node_modules/better-sqlite3'));
const db=new Database(':memory:');assert.equal(db.prepare('SELECT 1 AS n').get().n,1);db.close();
assert.ok(fs.existsSync(path.join(archive,'app/renderer/lib/model-picker.js')));
const expected=${JSON.stringify(expectedApp)};
for(const [name,hash] of Object.entries(expected))assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(archive,name))).digest('hex'),hash,'Outdated packaged file: '+name);
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({ok:true,electron:process.versions.electron,
 checkedFiles:Object.keys(expected).length}));
`);
  const env = {...process.env,ELECTRON_RUN_AS_NODE:'1'};
  if (customTemp) {const dir=path.join(temp,'temp');fs.mkdirSync(dir);Object.assign(env,{TEMP:dir,TMP:dir});}
  child = spawn(exe,[script],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let diagnostics='';child.stderr?.on('data',data=>{diagnostics=(diagnostics+String(data)).slice(-4000);});
  let failed: Error | undefined, exitCode: number | null | undefined;
  child.on('error',error=>failed=error);child.on('exit',code=>exitCode=code);
  const deadline = Date.now()+45000;
  while (!fs.existsSync(receipt) && Date.now()<deadline && !failed && exitCode===undefined) await new Promise(resolve=>setTimeout(resolve,250));
  if (!fs.existsSync(receipt)) {
    if(child.pid) {
      const windows=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true,timeout:5000});
      console.error(windows.stdout.trim());
    }
    if(diagnostics)console.error(diagnostics);
    throw failed || Error(`Portable launcher did not reach packaged Electron (exit=${exitCode ?? 'waiting'}, isolatedTemp=${customTemp})`);
  }
  const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
  if(!result.ok || result.checkedFiles!==Object.keys(expectedApp).length)throw Error('Launched payload differs from the current build');
  const stop=Date.now()+10000;while(exitCode===undefined && Date.now()<stop)await new Promise(resolve=>setTimeout(resolve,100));
  if(exitCode!==0)throw Error(`Launcher did not finish cleanly (exit=${exitCode ?? 'waiting'})`);
  console.log(`PASS: launcher booted Electron ${result.electron}; SQLite, model picker, source files and TEMP writes verified (isolatedTemp=${customTemp}).`);
} finally {
  if(child?.pid && child.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
  if(path.dirname(fs.realpathSync.native(temp)).toLowerCase()!==base.toLowerCase())throw Error('Unsafe probe cleanup target');
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:150});
  fs.rmSync(receipt,{force:true});
}
