import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-settings-'));
const output = path.join(root, 'dist/settings-preview');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(temp, 'preload.cjs'), `
const {contextBridge}=require('electron');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let current={base_url:'https://api.example.com/v1',model:'muse-preview',visible_models:['muse-preview']};
const api={getConfig:async()=>({llm:{...current},sentinel:{mode:'auto'},memory:{enabled:false}}),
getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[],listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),
getSettings:async()=>({...current,embed_key_set:true,has_key:true}),
saveSettings:async patch=>{await pause(650);current={...current,...patch};return {ok:true,model:patch.model}},
selectModel:async model=>{if(!current.visible_models.includes(model))return {ok:false,error:'Not selected'};current.model=model;return {ok:true,...current}},
fetchModels:async()=>{await pause(300);return {ok:true,models:['muse-preview','muse-reasoning']}},listMcp:async()=>[]};
for(const name of ['onAgentEvent','onApprovalRequest','onApprovalResolved','onApprovalExpired','onSessionReset','onQuestion'])api[name]=()=>()=>{};
contextBridge.exposeInMainWorld('muse',api);
`);
fs.writeFileSync(path.join(temp, 'verify.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=${JSON.stringify(root)},output=${JSON.stringify(output)},baseline=${process.argv.includes('--baseline')};
app.setPath('userData',path.join(__dirname,'profile'));
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const pause=ms=>new Promise(r=>setTimeout(r,ms));const errors=[];let win;
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1280,height:820,useContentSize:true,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 win.webContents.on('did-fail-load',(_e,code,description)=>errors.push(description));
 const js=code=>win.webContents.executeJavaScript(code);
 await win.loadFile(path.join(root,'app/renderer/index.html'));win.webContents.startPainting();
 await js("document.getElementById('splash')?.remove();openSettings()");await pause(450);
 const shot=async name=>{await pause(200);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 await shot(baseline?'before':'connection');
 if(!baseline){
  assert.equal(await js("document.getElementById('settings').getAttribute('aria-busy')"),'false');
  await js("document.getElementById('btn-fetch').click()");await pause(450);
  assert.equal(await js("document.querySelectorAll('#model-results-settings .model-picker-row').length"),2);
  assert.equal(await js("document.getElementById('model-list').hasAttribute('list')"),false,'Native datalist must be replaced');
  await js("document.getElementById('btn-model-options').click();document.querySelectorAll('#model-results-settings input[type=checkbox]')[1].click()");
  assert.equal(await js("document.getElementById('chat-models-summary').textContent"),'2 models visible in chat');await shot('model-library');
  await js("document.getElementById('model-list').value='muse-reasoning';document.getElementById('model-list').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('btn-save').click()");
  assert.equal(await js("document.getElementById('btn-save').disabled"),true);
  assert.equal(await js("document.getElementById('btn-cancel').disabled"),true);
  await shot('saving');await pause(700);
  assert.equal(await js('settingsOpen'),true,'Save confirmation should remain visible');
  assert.equal(await js("document.getElementById('btn-save').textContent"),'Saved');
  assert.equal(await js("document.getElementById('f-key').value"),'');
  await shot('saved');
  await js("closeSettings();document.getElementById('chat-model-trigger').click()");await shot('chat-models');
  assert.equal(await js("document.querySelectorAll('#model-results-chat .model-picker-row').length"),2);
  await js("document.querySelector('#model-results-chat .model-picker-select').click()");await pause(100);
  assert.equal(await js("document.getElementById('chat-model-label').textContent"),'muse-preview');
  await js('openSettings()');await pause(100);
  await js("document.getElementById('tab-workspace').click()");await shot('workspace');
  assert.equal(await js("document.getElementById('btn-save').hidden"),true,'Workspace applies immediately');
  await js("document.getElementById('tab-connection').click();document.getElementById('connection-advanced').open=true;document.getElementById('f-embed-key').scrollIntoView({block:'center'})");await shot('advanced');
  assert.equal(await js("document.getElementById('embed-key-state').textContent"),'Key saved');
  assert.ok(await js("document.getElementById('f-embed-key').placeholder.includes('saved key')"));
  await js("closeSettings();openSettings()");await pause(100);
  assert.equal(await js("document.getElementById('embed-key-state').textContent"),'Key saved','Saved key indicator must survive reopening');
  assert.equal(await js("document.getElementById('f-embed-key').value"),'','Saved key must not be sent to the renderer');
  await js("setTheme('light')");await shot('light');
  win.setContentSize(760,600);await pause(150);await shot('compact');
  assert.equal(await js("document.getElementById('btn-save').getBoundingClientRect().bottom<=innerHeight"),true);
  assert.equal(await js("document.getElementById('settings').scrollWidth<=document.getElementById('settings').clientWidth"),true,'Settings should not scroll horizontally');
  win.setContentSize(375,700);await pause(150);await shot('narrow');
  assert.equal(await js("document.getElementById('btn-save').getBoundingClientRect().bottom<=innerHeight"),true,'Narrow window actions should remain visible');
  assert.equal(await js("document.getElementById('settings').scrollWidth<=document.getElementById('settings').clientWidth"),true,'Narrow settings should not overflow');
  await js("closeSettings();document.getElementById('chat-model-trigger').click()");await shot('narrow-models');
  assert.equal(await js("document.getElementById('model-menu-chat').getBoundingClientRect().right<=innerWidth"),true);
  assert.equal(await js("document.getElementById('model-menu-chat').getBoundingClientRect().top>=0"),true);
 }
 assert.deepEqual(errors,[],'Renderer console/load errors');console.log('PASS: native Settings preview '+output);win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});
setTimeout(()=>app.exit(1),25000).unref();
`);
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(temp, 'verify.cjs')], { cwd: root, env, stdio: 'inherit', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('Settings verification failed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
