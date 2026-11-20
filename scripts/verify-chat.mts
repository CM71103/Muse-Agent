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
 getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[{id:'p1',name:'Muse Agent',folder:'D:/OpenSourceProg/Test/REA/muse-agent'}],listSessions:async()=>[
  {id:'s1',title:'Release build and packaging',created:'2026-01-02T09:00:00Z',updatedAt:Date.now()-120000,turns:9,projectId:'p1'},
  {id:'s2',title:'Vibe calibration from local chats',created:'2026-01-01T09:00:00Z',updatedAt:Date.now()-5400000,turns:14,projectId:'p1'},
  {id:'s3',title:'affectUI clean revamp',created:'2025-12-20T09:00:00Z',updatedAt:Date.now()-3*86400000,turns:22},
  {id:'s4',title:'Old idea about the dashboard',created:'2025-09-01T09:00:00Z',updatedAt:Date.now()-90*86400000,turns:5}],memoryStatus:async()=>({enabled:false}),
 getSettings:async()=>({base_url:'https://api.example.com/v1',model:'muse-preview',visible_models:['muse-preview'],embed_key_set:false,has_key:true}),
 saveSettings:async()=>({ok:true}),selectModel:async()=>({ok:true}),fetchModels:async()=>({ok:true,models:['muse-preview','muse-reasoning']}),mcpList:async()=>[],
 agentSend:async()=>({ok:true,text:''}),
 boxStatus:async()=>({state:'disconnected',tools:0}),onBoxStatus:()=>()=>{},boxConnect:async()=>({ok:true}),boxDisconnect:async()=>({ok:true}),boxOpenDesktop:async()=>({ok:true}),boxCancel:async()=>({ok:true}),
 voiceStatus:async()=>({ok:true,calibrated:true,messages:5767,calibrated_at:new Date().toISOString(),liked:{count:21,rules:['The answers you accept run long (about 100 words) — give the real detail instead of a teaser.']},guide:'Match the answer style. The answers you accept run long (about 100 words).',roots:[{kind:'claude-projects'},{kind:'codex-sessions'},{kind:'cline-sessions'}]}),
 voiceCalibrate:async()=>({ok:true,messages:5767,liked:{count:21,rules:['The answers you accept run long (about 100 words) — give the real detail instead of a teaser.'],note:'21 accepted answers compared with 4370 answers overall'},roots:[{kind:'claude-projects',messages:3654},{kind:'codex-sessions',messages:668},{kind:'cline-sessions',messages:1445}]}),
 voiceReset:async()=>({ok:true}),feedbackSummary:async()=>({total:0,liked:0,disliked:0,markers:[]}),feedbackReset:async()=>({ok:true}),
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
 const js=async code=>{try{return await win.webContents.executeJavaScript(code)}catch(e){console.error('JS STEP FAILED:',code.slice(0,140));console.error('CONSOLE ERRORS:',JSON.stringify(errors.slice(-6),null,1));throw e}};
 await win.loadFile(path.join(root,'app/renderer/index.html'));win.webContents.startPainting();
 await js("document.getElementById('splash')?.remove();setTheme('dark')");
 await pause(400);
 const shot=async name=>{await pause(250);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 await js("sessionCache=[];renderSessions();renderProjects()");await shot('empty');await js('refreshSessions()');
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
 await js("document.querySelector('.project-tree-toggle')?.click()");
 await js("learnMyStyle()");await pause(500);await js("document.getElementById('mainlog').scrollTop=document.getElementById('mainlog').scrollHeight");await pause(300);await shot('learn-style');
 await js("document.querySelector('.project-tree-toggle')?.click()");await shot('sidebar-projects');
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
 await js('handleAgentEvent({type:"tool_result",id:"s1",name:"cite_source",result:{ok:true,text:"Recorded sources for retrieval-vs-long-context (3): [arxiv:2005.11401] RAG for Knowledge-Intensive NLP — 2020 — claim: retrieval beats parametric memory."}})');
 await pause(250);
 assert.equal(await js("[...document.querySelectorAll('.action-chip')].some(n=>n.textContent.indexOf('sources recorded: 3')>=0)"),true,'citation chip should show the source count');
 await js("renderQueueChips([])");
 // the review gate (PaperOrchestra port): a critique result must show up as a
 // compact chip with the score and the fix count
 await js('handleAgentEvent({type:"tool_call",id:"c1",name:"critique",args:{text:"draft"}})');
 await js('handleAgentEvent({type:"tool_result",id:"c1",name:"critique",result:{ok:true,score:7,verdict:"good structure, thin evidence",weaknesses:["claims a result without a source"],fixes:["cite the experiment log","add the missing number"]}})');
 await pause(300);
 await js("document.getElementById('mainlog').scrollTop=document.getElementById('mainlog').scrollHeight");
 await pause(250);await shot('critique');
 assert.equal(await js("[...document.querySelectorAll('.action-chip')].some(n=>n.textContent.indexOf('review 7/10')>=0)"),true,'critique chip should show the score');
 assert.equal(await js("[...document.querySelectorAll('.action-chip')].some(n=>n.textContent.indexOf('2 fixes')>=0)"),true,'critique chip should show the fix count');
 await js("document.querySelectorAll('.action-chip').forEach(n=>n.remove())");
 // attachments: the strip shows what is attached and how its text was obtained
 await js("addAttachments([{id:'a1',name:'invoice-4821.pdf',kind:'pdf',mime:'application/pdf',bytes:182000,pages:3,has_text:true,text_method:'text-layer',preview:'Invoice 4821 total 99.50'},{id:'a2',name:'receipt-photo.png',kind:'image',mime:'image/png',bytes:820000,has_text:true,text_method:'ocr',preview:'Total 99.50'}])");
 await pause(300);await shot('attachments');
 assert.equal(await js("document.querySelectorAll('.attach-chip').length===2"),true,'attachment chips should render');
 await js("attachModelCaps={model:'Qwen3.8-Flash-Next',vision:false};renderAttachmentStrip()");
 await pause(200);await shot('attachments-note');
 await js("pendingAttachments=[];renderAttachmentStrip();attachModelCaps=null;");
 // answer feedback: the rating control under an answer (idle + graded)
 await js("document.querySelectorAll('.msg-rate').forEach(n=>n.style.opacity=1)");
 await pause(200);await shot('rating');
 assert.equal(await js("document.querySelectorAll('.msg-rate .rate-btn').length>=2"),true,'rating controls should render');
 assert.equal(await js("!!document.querySelector('.msg-rate .rate-btn svg')"),true,'rating control uses line icons');
 await js("(()=>{const r=document.querySelector('.msg-rate');r.dataset.rated='1';r.querySelector('.rate-state').textContent='Liked';r.querySelectorAll('.rate-btn')[0].setAttribute('aria-pressed','true');r.style.opacity=1;})()");
 await pause(200);await shot('rating-graded');
 await js("setTheme('light')");await pause(400);
 await js("(()=>{const r=document.querySelector('.msg-rate');r.style.opacity=1;})()");
 await pause(200);await shot('rating-light');
 await js("setTheme('dark')");await pause(300);
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
