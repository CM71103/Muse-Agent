import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname,'..');
const base = fs.realpathSync.native(os.tmpdir());
const temp = fs.mkdtempSync(path.join(base,'muse-windows-verify-'));
const output = path.join(root,'dist/windows-preview');
fs.mkdirSync(output,{recursive:true});
const electron = require('electron');
const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;
const pause = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const title = `Muse isolated desktop fixture ${randomUUID()}`;
const fixtureReady=path.join(temp,'fixture-ready.json'),typed=path.join(temp,'typed.json');
const fixture=path.join(temp,'fixture.cjs');
let child: ReturnType<typeof spawn> | undefined;

async function nativeCheck() {
  fs.writeFileSync(path.join(temp,'fixture-preload.cjs'),`
const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{changed:value=>ipcRenderer.send('fixture:value',value)});
`);
  const html=`<!doctype html><html><body style="margin:24px;font:18px sans-serif"><h1>Isolated Muse input fixture</h1><p>Disposable verification window. No personal applications are controlled.</p><textarea id="target" autofocus style="display:block;width:90%;height:180px;font:18px sans-serif" oninput="window.fixture.changed(this.value)"></textarea></body></html>`;
  fs.writeFileSync(fixture,`
const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'fixture-profile'));let win;
ipcMain.on('fixture:value',(_event,value)=>fs.writeFileSync(${JSON.stringify(typed)},JSON.stringify({value})));
app.whenReady().then(async()=>{win=new BrowserWindow({title:${JSON.stringify(title)},x:100,y:100,width:680,height:500,show:true,webPreferences:{preload:path.join(__dirname,'fixture-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify(html)}));win.setTitle(${JSON.stringify(title)});win.show();win.focus();
const rect=await win.webContents.executeJavaScript("(()=>{const r=document.getElementById('target').getBoundingClientRect();return {x:r.left+40,y:r.top+40}})()");
const outer=win.getBounds(),content=win.getContentBounds();fs.writeFileSync(${JSON.stringify(fixtureReady)},JSON.stringify({pid:process.pid,title:${JSON.stringify(title)},width:outer.width,height:outer.height,x:content.x-outer.x+rect.x,y:content.y-outer.y+rect.y}));});
setTimeout(()=>{if(win)win.destroy();app.exit(0)},90000).unref();
`);
  child=spawn(electron,[fixture],{cwd:root,env,windowsHide:true,stdio:'ignore'});
  const deadline=Date.now()+15000;while(!fs.existsSync(fixtureReady)&&Date.now()<deadline)await pause(100);
  assert.ok(fs.existsSync(fixtureReady),'Disposable Electron fixture did not initialize');
  const ready=JSON.parse(fs.readFileSync(fixtureReady,'utf8'));
  assert.equal(ready.pid,child.pid,'Fixture identity must match the owned child process');
  // Run the backend as a sibling of the fixture: the production service
  // correctly excludes its own descendants from target enumeration.
  const helper=path.join(temp,'native-check.cjs');
  fs.writeFileSync(helper,`const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const ready=${JSON.stringify(ready)},title=${JSON.stringify(title)},output=${JSON.stringify(output)},typed=${JSON.stringify(typed)};
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const {createWindowsDesktop}=require(${JSON.stringify(path.join(root,'app/main/windows-desktop.ts'))});
    (${checkFixture.toString()})().catch(error=>{console.error(error);process.exitCode=1});`);
  const result=spawnSync(process.execPath,[helper],{cwd:root,env,stdio:'inherit',timeout:60000,windowsHide:true});
  if(result.error||result.status!==0)throw result.error||Error('Native Windows fixture verification failed');
}

async function checkFixture() {
  const desktop=createWindowsDesktop({blockedPids:()=>[process.pid]});
  try {
    const listed=await desktop.list();
    const windows=Array.isArray(listed)?listed:listed.windows;
    const selected=windows.find((item:any)=>item.pid===ready.pid&&item.title===title);
    assert.ok(selected,'The fixture window must be enumerated by its exact PID and unique title');
    await desktop.select(selected.id);
    const shot=await desktop.execute('screenshot',{},new AbortController().signal);
    assert.notEqual(shot.ok,false,shot.error);assert.ok(shot.images?.length,'Selected fixture screenshot must be returned');
    const bytes=Buffer.from(shot.images[0].data,'base64');
    assert.ok(bytes.length>100);fs.writeFileSync(path.join(output,'native-fixture.png'),bytes);
    const x=Math.round(ready.x*((shot.width||selected.width||ready.width)/ready.width));
    const y=Math.round(ready.y*((shot.height||selected.height||ready.height)/ready.height));
    const clicked=await desktop.execute('click',{x,y,button:'left',revision:shot.revision},new AbortController().signal);
    assert.notEqual(clicked.ok,false,clicked.error);
    const fresh=await desktop.execute('screenshot',{},new AbortController().signal);
    const text='Muse verified this isolated window.';
    const result=await desktop.execute('type',{text,revision:fresh.revision},new AbortController().signal);
    assert.notEqual(result.ok,false,result.error);
    const until=Date.now()+8000;let observed='';
    while(Date.now()<until){
      try{observed=JSON.parse(fs.readFileSync(typed,'utf8')).value;}catch{}
      if(observed===text)break;await pause(100);
    }
    assert.equal(observed,text,'Fixture input event must receive all authorized text');
    desktop.release();
    const revoked=await desktop.execute('screenshot',{},new AbortController().signal).catch((error:any)=>({ok:false,error:error.message}));
    assert.equal(revoked.ok,false,'Releasing the window must revoke screenshot access');
    console.log('PASS: native window enumeration, selection, screenshot, click, type and release used only the disposable fixture.');
  } finally {desktop.release();}
}

async function previewCheck() {
  const pixels=fs.readFileSync(path.join(output,'native-fixture.png')).toString('base64');
  const previewEvent={name:'windows_screenshot',type:'tool_result',result:{ok:true,revision:2,images:[{mimeType:'image/png',data:pixels}]}};
  // The UI bridge below is entirely local, and never enumerates user windows.
  fs.writeFileSync(path.join(temp,'preview-preload.cjs'),`
const {contextBridge}=require('electron');let selected=null;const fixture={id:'fixture',title:'Isolated demo window',processName:'Fixture',pid:123,width:680,height:500};
const api={getConfig:async()=>({llm:{model:'Preview',visible_models:['Preview']},sentinel:{mode:'ask'},memory:{enabled:false}}),getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[],listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),boxStatus:async()=>({state:'disconnected'}),windowsList:async()=>({windows:[fixture]}),windowsStatus:async()=>({state:selected?'selected':'unselected',selected,revision:0}),windowsSelect:async()=>{selected=fixture;return {ok:true,state:'selected',selected,revision:1}},windowsRelease:async()=>{selected=null;return {ok:true,state:'unselected',selected:null,revision:2}}};
for(const name of ['onAgentEvent','onApprovalRequest','onApprovalResolved','onApprovalExpired','onSessionReset','onQuestion','onBoxStatus'])api[name]=()=>()=>{};contextBridge.exposeInMainWorld('muse',api);
`);
  fs.writeFileSync(path.join(temp,'preview.cjs'),`
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=${JSON.stringify(root)},output=${JSON.stringify(output)};app.setPath('userData',path.join(__dirname,'preview-profile'));app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let win;const errors=[];
app.whenReady().then(async()=>{try{win=new BrowserWindow({width:1280,height:820,useContentSize:true,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'preview-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message)}});const js=code=>win.webContents.executeJavaScript(code);
await win.loadFile(path.join(root,'app/renderer/index.html'));win.webContents.startPainting();await js("document.getElementById('splash')?.remove();document.getElementById('windows-toolbar-open').click()");await pause(400);
assert.equal(await js("document.getElementById('windows-desktop-backdrop').hidden"),false);
assert.ok(await js("document.querySelector('.windows-window-choice')"));
await js("document.querySelector('.windows-window-choice').click()");await pause(150);
await js(${JSON.stringify(`windowsUI.event(${JSON.stringify(previewEvent)})`)});await pause(150);
assert.equal(await js("document.getElementById('windows-preview-image').hidden"),false);
assert.ok(await js("document.getElementById('windows-preview-image').naturalWidth>0"),'Latest native screenshot must render');
const shot=async name=>{await pause(200);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())};
await shot('dark');await js("setTheme('light')");await shot('light');win.setContentSize(375,700);await pause(150);await shot('narrow');
assert.equal(await js("document.getElementById('windows-desktop-panel').getBoundingClientRect().right<=innerWidth"),true);
assert.equal(await js("document.getElementById('windows-desktop-panel').scrollWidth<=document.getElementById('windows-desktop-panel').clientWidth"),true);
await js("document.getElementById('windows-panel-release').click()");await pause(100);assert.deepEqual(errors,[]);console.log('PASS: native Windows panel previews in dark/light/narrow layouts.');win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});setTimeout(()=>app.exit(1),25000).unref();
`);
  const result=spawnSync(electron,[path.join(temp,'preview.cjs')],{cwd:root,env,stdio:'inherit',timeout:30000,windowsHide:true});
  if(result.error||result.status!==0)throw result.error||Error('Windows UI preview failed');
}

try {
  if(!process.argv.includes('--ui-only'))await nativeCheck();
  if(!process.argv.includes('--native-only'))await previewCheck();
} catch(error) {console.error('Windows verification failed:',error);process.exitCode=1;
} finally {
  if(child?.pid&&child.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
  if(child)await pause(1500);
  assert.equal(path.dirname(fs.realpathSync.native(temp)).toLowerCase(),base.toLowerCase());
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:250});
}
