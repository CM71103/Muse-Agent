// Visual verification for the general chat (transcript, messages, composer).
// Boots the real renderer with a stub preload, simulates a conversation through
// the renderer's own event path, and captures dist/chat-preview/.
// Run: node scripts/verify-chat.mts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-chat-'));
const output = path.join(root, 'dist/chat-preview');
fs.mkdirSync(output, { recursive: true });

// Conversation fixtures joined with real newlines — no escape sequences anywhere.
const NL = String.fromCharCode(10);
const toolOutput = ['packaging complete', 'installer + portable written'].join(NL);
const messageText = [
  'The release build is done. Two artifacts land in the releases folder:',
  '',
  '- **Muse-Agent-Setup-0.1.8.exe** — installer',
  '- MuseAgent-0.1.8-portable.exe — portable',
  '',
  'Run `npm run dist` any time to rebuild both.',
].join(NL);

fs.writeFileSync(path.join(temp, 'preload.cjs'), `
const {contextBridge}=require('electron');
const api={
 getConfig:async()=>({llm:{base_url:'https://api.example.com/v1',model:'muse-preview',visible_models:['muse-preview']},sentinel:{mode:'auto'},memory:{enabled:false}}),
 getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[],listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),
 getSettings:async()=>({base_url:'https://api.example.com/v1',model:'muse-preview',visible_models:['muse-preview'],embed_key_set:false,has_key:true}),
 saveSettings:async()=>({ok:true}),selectModel:async()=>({ok:true}),fetchModels:async()=>({ok:true,models:['muse-preview','muse-reasoning']}),mcpList:async()=>[],
 agentSend:async()=>({ok:true,text:''}),
 boxStatus:async()=>({state:'disconnected',tools:0}),onBoxStatus:()=>()=>{},boxConnect:async()=>({ok:true}),boxDisconnect:async()=>({ok:true}),boxOpenDesktop:async()=>({ok:true}),boxCancel:async()=>({ok:true})};
for(const name of ['onAgentEvent','onApprovalRequest','onApprovalResolved','onApprovalExpired','onSessionReset','onQuestion','onLearningStatus'])api[name]=()=>()=>{};
contextBridge.exposeInMainWorld('muse',api);
`);

fs.writeFileSync(path.join(temp, 'verify.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=${JSON.stringify(root)},output=${JSON.stringify(output)};
const messageText=${JSON.stringify(messageText)},toolOutput=${JSON.stringify(toolOutput)};
app.setPath('userData',path.join(__dirname,'profile'));
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const pause=ms=>new Promise(r=>setTimeout(r,ms));const errors=[];let win;
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1280,height:860,useContentSize:true,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 win.webContents.on('did-fail-load',(_e,code,description)=>errors.push(description));
 const js=async code=>{try{return await win.webContents.executeJavaScript(code)}catch(e){console.error('JS STEP FAILED:',code.slice(0,140));throw e}};
 await win.loadFile(path.join(root,'app/renderer/index.html'));win.webContents.startPainting();
 await js("document.getElementById('splash')?.remove();setTheme('dark')");
 await pause(400);
 const shot=async name=>{await pause(250);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 await shot('empty');
 assert.equal(await js("!!document.querySelector('#empty')"),true,'empty hero should survive system notes');
 // Simulate a realistic exchange through the renderer's own event path.
 await js("addMsg('user','How do I build a release of the app?')");
 await js("handleAgentEvent({type:'turn',turn:0})");
 await js('handleAgentEvent({type:"tool_call",id:"t1",name:"shell",args:{command:"npm run dist"}})');
 await pause(300);
 await js('handleAgentEvent({type:"tool_result",id:"t1",name:"shell",result:{ok:true,output:'+JSON.stringify(toolOutput)+'}})');
 await js('handleAgentEvent({type:"message",text:'+JSON.stringify(messageText)+'})');
 await js("handleAgentEvent({type:'done',reason:'complete'})");
 await pause(400);
 await js("document.getElementById('mainlog').scrollTop=document.getElementById('mainlog').scrollHeight");
 await shot('conversation');
 assert.equal(await js("document.querySelectorAll('.msg').length>=2"),true,'transcript should hold both turns');
 assert.equal(await js("document.querySelectorAll('.activity-card').length>=1"),true,'tool card should render');
 await js("setTheme('light')");await shot('conversation-light');
 await js("setTheme('dark')");
 win.setContentSize(420,780);await pause(250);await shot('narrow');
 assert.deepEqual(errors,[],'Renderer console/load errors');console.log('PASS: chat preview '+output);win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});
setTimeout(()=>app.exit(1),25000).unref();
`);
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(temp, 'verify.cjs')], { cwd: root, env, stdio: 'inherit', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('Chat verification failed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
