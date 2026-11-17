import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const supplied=process.argv.find(arg=>arg.startsWith('--archive='))?.slice(10);
const source=supplied?path.resolve(supplied):root;
const directory=path.join(require('../app/harness/config').configDir(),'sandbox');
const base=fs.realpathSync.native(os.tmpdir()),temp=fs.mkdtempSync(path.join(base,'muse-live-sandbox-'));
const output=path.join(root,'dist/sandbox-native');fs.mkdirSync(output,{recursive:true});
try{
  fs.writeFileSync(path.join(temp,'preview.cjs'),`
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const source=${JSON.stringify(source)},output=${JSON.stringify(output)},directory=${JSON.stringify(directory)};
app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
let win;const errors=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
const trusted=e=>{assert.equal(e.sender,win.webContents);assert.ok(!e.senderFrame.parent)};
for(const [channel,handler] of Object.entries({
 'config:get':()=>({llm:{model:'Native guest verification',visible_models:['Native guest verification']},sentinel:{mode:'ask'},memory:{enabled:false}}),
 'project:get':()=>({ok:true,project:null}),'projects:list':()=>[],'sessions:list':()=>[],
 'memory:status':()=>({enabled:false}),'box:status':()=>({state:'disconnected'})
}))ipcMain.handle(channel,e=>{trusted(e);return handler()});
const vm=require(path.join(source,'app/main/sandbox-service.ts')).createSandboxService({directory,ipcMain,requireTrusted:trusted,busy:()=>false,refreshTools:()=>{},chooseISO:()=>null});
app.whenReady().then(async()=>{try{
 assert.equal((await vm.status()).state,'running','The owned Ubuntu guest must already be running');
 win=new BrowserWindow({width:1280,height:860,show:false,webPreferences:{offscreen:true,preload:path.join(source,'app/main/preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 const js=code=>win.webContents.executeJavaScript(code);
 await win.loadFile(path.join(source,'app/renderer/index.html'));win.webContents.startPainting();
 await js("document.getElementById('splash')?.remove();document.getElementById('sandbox-toolbar-open').click()");
 const deadline=Date.now()+15000;while(Date.now()<deadline){if(await js("document.getElementById('sandbox-frame').naturalWidth>0"))break;await pause(250)}
 assert.ok(await js("document.getElementById('sandbox-frame').naturalWidth>0"),'Real guest pixels must arrive through production IPC/preload');
 assert.equal(await js("document.getElementById('sandbox-target').textContent"),'Agent: sandbox');
 await js("(()=>{const img=document.getElementById('sandbox-frame'),r=img.getBoundingClientRect();img.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+2}));})()");
 await pause(2500);assert.equal(await js("document.getElementById('sandbox-error').textContent"),'');
 await js("document.getElementById('sandbox-screen').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");await pause(350);
 fs.writeFileSync(path.join(output,'live-muse.png'),(await win.webContents.capturePage()).toPNG());
 assert.deepEqual(errors,[]);console.log('PASS: actual Ubuntu VM pixels, pointer and keyboard travel through Muse production IPC/preload and renderer.');
 win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});setTimeout(()=>app.exit(1),30000).unref();
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),[path.join(temp,'preview.cjs')],{cwd:root,env,stdio:'inherit',windowsHide:true,timeout:40000});
  if(result.error||result.status!==0)throw result.error||Error('Live sandbox verification failed');
}finally{
  if(path.dirname(fs.realpathSync.native(temp)).toLowerCase()!==base.toLowerCase())throw Error('Unsafe verification cleanup target');
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
