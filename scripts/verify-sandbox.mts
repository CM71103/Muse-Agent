import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

// A native Electron render of the real app, with an entirely disposable VM bridge.
// This script never starts VirtualBox, reads user configuration, or sends host input.
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
const base=fs.realpathSync.native(os.tmpdir()),temp=fs.mkdtempSync(path.join(base,'muse-sandbox-preview-'));
const output=path.join(root,'dist/sandbox-preview');fs.mkdirSync(output,{recursive:true});
const fixture=path.join(root,'dist/windows-preview/native-fixture.png');
const pixels=fs.existsSync(fixture)?fs.readFileSync(fixture).toString('base64'):'';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const composerOnly=process.argv.includes('--composer-only');
fs.writeFileSync(path.join(temp,'preload.cjs'),`
const {contextBridge}=require('electron');
let status={state:'missing_iso',available:true,selected:false,checkpoint:false},calls=[],frame='';
const api={getConfig:async()=>({llm:{model:'Preview',visible_models:['Preview']},sentinel:{mode:'ask'},memory:{enabled:false}}),getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[],listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),boxStatus:async()=>({state:'disconnected'}),windowsStatus:async()=>({state:'unselected',selected:null}),
sandboxStatus:async()=>({...status}),sandboxChooseISO:async()=>{calls.push('choose');status.iso='Ubuntu desktop ISO (verification fixture)';return {ok:true,iso:status.iso}},sandboxCreate:async()=>{calls.push('create');status={...status,state:'stopped',vmId:'isolated-fixture',selected:true};return {...status}},sandboxStart:async()=>{calls.push('start');status={...status,state:'running',selected:true};return {...status}},sandboxStop:async()=>{calls.push('stop');status={...status,state:'saved'};return {...status}},sandboxCheckpoint:async()=>{calls.push('checkpoint');status.checkpoint=true;return {...status}},sandboxReset:async()=>{calls.push('reset');return {...status}},sandboxUseHost:async()=>{calls.push('host');status.selected=false;return {...status}},sandboxFrame:async()=>({ok:true,data:frame,width:680,height:500}),sandboxInput:async value=>{calls.push(value);return {ok:true}}};
for(const name of ['onAgentEvent','onApprovalRequest','onApprovalResolved','onApprovalExpired','onSessionReset','onQuestion','onBoxStatus'])api[name]=()=>()=>{};
contextBridge.exposeInMainWorld('muse',api);contextBridge.exposeInMainWorld('sandboxFixture',{setFrame:value=>{frame=value},calls:()=>calls});
`);
fs.writeFileSync(path.join(temp,'preview.cjs'),`
const {app,BrowserWindow,nativeImage}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=${JSON.stringify(root)},output=${JSON.stringify(output)};let pixels=${JSON.stringify(pixels)};
const composerOnly=${JSON.stringify(composerOnly)};
app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
let win;const errors=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{try{
if(!pixels){const bitmap=Buffer.alloc(680*500*4);for(let i=0;i<bitmap.length;i+=4){bitmap[i]=35;bitmap[i+1]=55;bitmap[i+2]=85;bitmap[i+3]=255}const png=nativeImage.createFromBitmap(bitmap,{width:680,height:500}).toPNG();fs.writeFileSync(path.join(output,'isolated-frame-fixture.png'),png);pixels=png.toString('base64')}
win=new BrowserWindow({width:1280,height:820,useContentSize:true,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});win.webContents.on('did-fail-load',(_event,code,description)=>errors.push(code+': '+description));
const js=code=>win.webContents.executeJavaScript(code),click=async id=>{await js('document.getElementById('+JSON.stringify(id)+').click()');await pause(100)};
const shot=async name=>{await pause(200);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())};
await win.loadFile(path.join(root,'app/renderer/index.html'));win.webContents.startPainting();await js("document.getElementById('splash')?.remove()");await pause(300);
assert.equal(await js("typeof MuseSandbox.create"),'function');
if(!composerOnly){await js('window.sandboxFixture.setFrame('+JSON.stringify(pixels)+')');await click('sandbox-toolbar-open');
assert.equal(await js("document.getElementById('sandbox-backdrop').hidden"),false);assert.equal(await js("document.getElementById('sandbox-create').disabled"),true);await shot('setup-dark');
await click('sandbox-choose-iso');await click('sandbox-create');await click('sandbox-start');await pause(350);
assert.equal(await js("document.getElementById('sandbox-frame').hidden"),false);assert.ok(await js("document.getElementById('sandbox-frame').naturalWidth>0"),'Native PNG must render in the actual image');
await js("(()=>{const image=document.getElementById('sandbox-frame'),r=image.getBoundingClientRect();image.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));const screen=document.getElementById('sandbox-screen');screen.focus();screen.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));screen.dispatchEvent(new KeyboardEvent('keydown',{key:'F6',bubbles:true}));})()");await pause(100);
let calls=await js('sandboxFixture.calls()');const pointer=calls.find(value=>value.kind==='click');assert.ok(pointer);assert.ok(Math.abs(pointer.x-340)<=1&&Math.abs(pointer.y-250)<=1,'Guest click maps to screenshot center');assert.ok(calls.some(value=>value.kind==='key'&&value.key==='ENTER'));assert.equal(await js('document.activeElement.id'),'sandbox-close');
assert.equal(await js("document.getElementById('sandbox-reset').disabled"),true);await click('sandbox-checkpoint');await click('sandbox-reset');assert.equal(await js("document.getElementById('sandbox-reset-prompt').hidden"),false);assert.ok(!(await js('sandboxFixture.calls()')).includes('reset'),'Opening reset prompt must not reset');await click('sandbox-reset-cancel');await click('sandbox-reset');await click('sandbox-reset-confirm');assert.ok((await js('sandboxFixture.calls()')).includes('reset'));await pause(250);
await js("setTheme('dark')");await shot('running-dark');await js("setTheme('light')");await shot('running-light');win.setContentSize(375,700);await pause(200);await shot('running-narrow');
assert.equal(await js("(()=>{const p=document.getElementById('sandbox-panel');return p.getBoundingClientRect().right<=innerWidth&&p.scrollWidth<=p.clientWidth})()"),true,'Narrow panel must fit without horizontal scroll');
await click('sandbox-stop');assert.equal(await js("document.getElementById('sandbox-status').textContent"),'Saved');assert.equal(await js("document.getElementById('sandbox-frame').hidden"),true);await shot('saved-narrow');await click('sandbox-close');}
const composerGeometry=()=>{
 const composer=document.getElementById('composer').getBoundingClientRect(),ids=['chat-model-trigger','box-toolbar-open','sandbox-toolbar-open','windows-toolbar-open','send','btn-cancel-turn'];
 const controls=ids.map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return{id,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,visible:!!e.getClientRects().length&&getComputedStyle(e).display!=='none'}}).filter(e=>e.visible);
 return{composer:{left:composer.left,top:composer.top,right:composer.right,bottom:composer.bottom},controls,viewport:{width:innerWidth,height:innerHeight}};
};
const checkComposer=async(name,busyState)=>{
 await js('setBusy('+busyState+')');await js("document.getElementById('chat-model-label').textContent='nemotron-3-ultra-550b-a55b-reasoning-preview-with-a-very-long-model-name'");await pause(150);const g=await js('('+composerGeometry.toString()+')()');
 assert.equal(g.controls.length,busyState?6:5,name+': required composer controls visible');
 for(const c of g.controls){assert.ok(c.width>0&&c.height>0,name+': '+c.id+' has area');assert.ok(c.left>=g.composer.left-1&&c.right<=g.composer.right+1&&c.top>=g.composer.top-1&&c.bottom<=g.composer.bottom+1,name+': '+c.id+' stays inside composer');assert.ok(c.left>=0&&c.right<=g.viewport.width+1&&c.bottom<=g.viewport.height+1,name+': '+c.id+' stays inside viewport');assert.ok(Math.abs(c.height-34)<=1,name+': '+c.id+' shares the 34px control height');}
 for(const c of g.controls.filter(c=>['box-toolbar-open','sandbox-toolbar-open','windows-toolbar-open'].includes(c.id)))assert.ok(c.scrollWidth<=c.clientWidth,name+': '+c.id+' label is not clipped');
 for(let i=0;i<g.controls.length;i++)for(let j=i+1;j<g.controls.length;j++){const a=g.controls[i],b=g.controls[j];assert.ok(a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1,name+': '+a.id+' does not overlap '+b.id);}
 if(g.viewport.width<=375){const find=id=>g.controls.find(c=>c.id===id),model=find('chat-model-trigger'),box=find('box-toolbar-open'),sandbox=find('sandbox-toolbar-open'),windows=find('windows-toolbar-open'),send=find('send');assert.ok(model.bottom<=box.top,name+': model gets its own narrow row');assert.ok(Math.abs(box.top-sandbox.top)<1&&Math.abs(box.top-windows.top)<1,name+': environments align on one row');assert.ok(windows.bottom<=send.top,name+': send gets the action row');}
 await shot(name);fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(g,null,2));
};
await js("document.body.setAttribute('data-theme','dark');resetTranscript()");
for(const spec of [{width:1280,height:720,name:'composer-short'},{width:1600,height:900,name:'composer-long-model'},{width:375,height:700,name:'composer-narrow'},{width:320,height:700,name:'composer-minimum'}]){
 win.setContentSize(spec.width,spec.height);await js("document.getElementById('chat-model-label').textContent='nemotron-3-ultra-550b-a55b-reasoning-preview-with-a-very-long-model-name'");await pause(150);await checkComposer(spec.name,false);await checkComposer(spec.name+'-busy',true);
}
await js('setBusy(false)');win.setContentSize(1280,720);await js('resetTranscript()');await pause(200);
assert.equal(await js("(()=>{const b=document.getElementById('sandbox-toolbar-open'),r=b.getBoundingClientRect(),p=b.parentElement.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&r.left>=p.left-1&&r.right<=p.right+1})()"),true,'Sandbox composer button must remain visible at 1280×720');
const welcome=await js("(()=>{const e=document.getElementById('empty'),r=e.getBoundingClientRect(),composer=document.querySelector('.composer-model-control').getBoundingClientRect();return {bottom:r.bottom,composerTop:composer.top}})()");assert.ok(welcome.bottom<=welcome.composerTop,'Welcome content must remain above the composer in a short window');
assert.deepEqual(errors,[]);console.log(composerOnly?'PASS: native composer at 1280×720, 1600×900 long model, 375×700 and 320×700; idle/busy controls contained, aligned, labels visible and nonoverlapping.':'PASS: native Sandbox previews/input/reset/Stop and responsive idle/busy composer geometry.');win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});setTimeout(()=>app.exit(1),30000).unref();
`);
try {
  const result=spawnSync(require('electron'),[path.join(temp,'preview.cjs')],{cwd:root,env,stdio:'inherit',windowsHide:true,timeout:35000});
  if(result.error||result.status!==0)throw result.error||Error('Sandbox native UI verification failed');
} finally {
  assert.equal(path.dirname(fs.realpathSync.native(temp)).toLowerCase(),base.toLowerCase());
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:250});
}
