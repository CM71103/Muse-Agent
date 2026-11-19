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
let appearance='krishna';
const api={
 getAppearance:async()=>({ok:true,theme:appearance}),setAppearance:async theme=>{appearance=String(theme);return {ok:true}},
 getConfig:async()=>({llm:{base_url:'https://api.example.com/v1',model:'muse-preview',visible_models:['muse-preview']},sentinel:{mode:'auto'},memory:{enabled:false}}),
 getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[],listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),
 getSettings:async()=>({base_url:'https://api.example.com/v1',model:'muse-preview',visible_models:['muse-preview'],embed_key_set:false,has_key:true}),
 saveSettings:async()=>({ok:true}),selectModel:async()=>({ok:true}),fetchModels:async()=>({ok:true,models:['muse-preview','muse-reasoning']}),mcpList:async()=>[],
 agentSend:async()=>({ok:true,text:''}),
 boxStatus:async()=>({state:'disconnected',tools:0}),onBoxStatus:()=>()=>{},boxConnect:async()=>({ok:true}),boxDisconnect:async()=>({ok:true}),boxOpenDesktop:async()=>({ok:true}),boxCancel:async()=>({ok:true}),
 datasourcesAddSqlite:async()=>({ok:false,cancelled:true}),dashDelete:async()=>({ok:true}),dashList:async()=>[{id:'d1',title:'Sales overview',description:'',charts:5,created:''}],
 dashData:async()=>({ok:true,dashboard:{id:'d1',title:'Sales overview',charts:[
  {id:'c1',title:'Revenue by month',type:'bar',x:'month',y:['revenue']},
  {id:'c2',title:'Trend',type:'area',x:'month',y:['revenue']},
  {id:'c3',title:'Share by region',type:'pie',label:'region',value:'revenue'},
  {id:'c4',title:'Total revenue',type:'stat',value:'revenue',label:'month'},
  {id:'c5',title:'Raw rows',type:'table'}]},charts:[
  {chartId:'c1',columns:['month','revenue'],rows:[{month:'jan',revenue:120},{month:'feb',revenue:180},{month:'mar',revenue:150},{month:'apr',revenue:220},{month:'may',revenue:260},{month:'jun',revenue:240}],truncated:false},
  {chartId:'c2',columns:['month','revenue'],rows:[{month:'jan',revenue:120},{month:'feb',revenue:180},{month:'mar',revenue:150},{month:'apr',revenue:220},{month:'may',revenue:260},{month:'jun',revenue:240}],truncated:false},
  {chartId:'c3',columns:['region','revenue'],rows:[{region:'east',revenue:420},{region:'west',revenue:310},{region:'north',revenue:180},{region:'south',revenue:90}],truncated:false},
  {chartId:'c4',columns:['month','revenue'],rows:[{month:'jun',revenue:240}],truncated:false},
  {chartId:'c5',columns:['month','revenue'],rows:[{month:'jan',revenue:120},{month:'feb',revenue:180},{month:'mar',revenue:150}],truncated:false}]})};
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
 win.setContentSize(1280,860);await pause(250);
 await js("document.getElementById('mainlog').scrollTop=document.getElementById('mainlog').scrollHeight");
 // queue + undo chips (top-level renderer functions) must render with controls
 await js("renderQueueChips([{commandId:'q1',position:1,text:'refactor the parser and update the tests'},{commandId:'q2',position:2,text:'repackage the build'}])");
 await js("addUndoChip({runId:'run-fixture',files:['app/main/index.js','app/renderer/renderer.js']})");
 await pause(300);await shot('chips');
 await js("renderQueueChips([])");
 await js("document.querySelectorAll('.action-chip').forEach(n=>n.remove())");
 await js("setTheme('krishna')");await pause(500);await shot('theme-krishna');
 await js("setTheme('light')");await pause(500);await shot('theme-light');
 await js("setTheme('dark')");await pause(500);await shot('theme-dark');
 assert.equal(await js("window.muse.getAppearance().then(r=>r.theme)"),'dark','theme choice must reach the persistent store');
 await js("openDashboardView('d1')");await pause(500);await shot('dashboards');
 assert.equal(await js("document.querySelector('[data-nav=dashboards]').getAttribute('aria-pressed')"),'true','nav pill state must follow the Dashboards view');
 assert.equal(await js("document.querySelector('[data-nav=chat]').getAttribute('aria-pressed')"),'false','Chat must not stay marked active');
 await js("document.getElementById('mainlog').scrollTop=1180");await pause(300);await shot('dashboards-lower');
 await js("document.getElementById('mainlog').scrollTop=2200");await pause(300);await shot('dashboards-table');
 assert.deepEqual(errors,[],'Renderer console/load errors');console.log('PASS: chat preview '+output);win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});
setTimeout(()=>app.exit(1),25000).unref();
`);
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(temp, 'verify.cjs')], { cwd: root, env, stdio: 'inherit', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('Chat verification failed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
