import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-activity-'));
const output = path.join(root, 'dist/activity-preview');
fs.mkdirSync(output, { recursive: true });
const previewCall = {type:'tool_call',id:'shell-preview',name:'shell',args:{command:'powershell.exe -NoProfile -NonInteractive -Command "Get-ChildItem -Force | Select-Object Mode, Name"',timeout_s:60}};
const previewResult = {type:'tool_result',id:'shell-preview',name:'shell',result:{ok:true,output:'Mode    Name\n----    ----\nd----   app\nd----   scripts\n-a---   package.json'}};
fs.writeFileSync(path.join(temp, 'preload.cjs'), `
const {contextBridge}=require('electron');let approval,question;
const api={getConfig:async()=>({llm:{model:'Preview'},sentinel:{mode:'ask'},memory:{enabled:false}}),
getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[],listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),
respondApproval:async()=>({ok:true}),answerQuestion:async()=>({ok:true}),previewApproval:request=>approval(request),previewQuestion:request=>question(request)};
for(const name of ['onAgentEvent','onApprovalResolved','onApprovalExpired','onSessionReset'])api[name]=()=>()=>{};
api.onApprovalRequest=cb=>{approval=cb};api.onQuestion=cb=>{question=cb};contextBridge.exposeInMainWorld('muse',api);
`);
fs.writeFileSync(path.join(temp, 'verify.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=${JSON.stringify(root)},output=${JSON.stringify(output)},baseline=${process.argv.includes('--baseline')};
app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));const errors=[];let win;
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1280,height:820,useContentSize:true,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error'){errors.push(e.message);console.error(e.message)}});
 const call=${JSON.stringify(previewCall)},result=${JSON.stringify(previewResult)};
 const js=code=>win.webContents.executeJavaScript(code);await win.loadFile(path.join(root,'app/renderer/index.html'));win.webContents.startPainting();
 await js("document.getElementById('splash')?.remove();resetTranscript();addMsg('user','Show me the files in this project.');handleAgentEvent("+JSON.stringify(call)+")");
 const shot=async name=>{await pause(250);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 await shot(baseline?'before-running':'running');
 await js("handleAgentEvent("+JSON.stringify(result)+");document.querySelector('.tool-row details').open=true");
 await shot(baseline?'before-command':'command');
 await js("window.muse.previewApproval("+JSON.stringify({id:'approval-preview',tool:call.name,args:call.args})+")");
 await shot(baseline?'before-approval':'approval');
 if(!baseline){
  assert.equal(await js("document.getElementById('btn-deny')===document.activeElement"),true);
  assert.equal(await js("document.getElementById('approval-action').textContent"),'Run command');
  assert.ok(await js("document.getElementById('approval-args').textContent.includes('Get-ChildItem')"));
  await js("setTheme('light')");await shot('light');
  win.setContentSize(760,600);await pause(100);await shot('compact');
  assert.equal(await js("document.getElementById('btn-allow').getBoundingClientRect().bottom<=innerHeight"),true,'Approval actions must remain accessible');
  assert.equal(await js("document.getElementById('approval').scrollWidth<=document.getElementById('approval').clientWidth"),true);
  win.setContentSize(375,700);await pause(100);await shot('narrow');
  assert.equal(await js("document.getElementById('btn-allow').getBoundingClientRect().bottom<=innerHeight"),true,'Narrow approval actions must remain visible');
  assert.equal(await js("document.getElementById('approval').scrollWidth<=document.getElementById('approval').clientWidth"),true);
  await js('answerApproval(false)');assert.equal(await js('currentApproval'),null);
  win.setContentSize(1280,820);await pause(100);
  await js("setTheme('dark');window.muse.previewQuestion({id:'question-preview',question:'Which folder should I review first?',options:['Application code','Tests and scripts']})");await shot('question');
 }
 assert.deepEqual(errors,[]);console.log('PASS: native command and permission cards '+output);win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});setTimeout(()=>app.exit(1),20000).unref();
`);
try {
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const result=spawnSync(require('electron'),[path.join(temp,'verify.cjs')],{cwd:root,env,stdio:'inherit',timeout:25000,windowsHide:true});
 if(result.error||result.status!==0)throw result.error||new Error('Activity preview failed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
