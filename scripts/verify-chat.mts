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
const harnessCbs={};
for(const name of ['onAgentEvent','onApprovalRequest','onApprovalResolved','onApprovalExpired','onSessionReset','onQuestion','onLearningStatus'])api[name]=(cb)=>{harnessCbs[name]=cb;return ()=>{};};
// the harness can fire the real event handlers, so a screenshot shows the real UI
api.__fire=(name,payload)=>{if(harnessCbs[name]){harnessCbs[name](payload);return true;}return false;};
api.cancel=async()=>({ok:true});
api.antislopSkills=async()=>({ok:true,skills:[{id:'antislop',title:'core filter',chars:53730,available:true}],active:[]});
api.antislopApply=async groups=>({ok:true,groups:['antislop','antislop-ui'],chars:84650,skills:[]});
api.researchBrief=async payload=>{
  const stages=['plan','search','read','draft','critique','revise','done'];
  for(const stage of stages){briefListener({stage,data:{ok:true,count:4,chars:2200,score:8,total:4,read:4,query:'routing memory',found:9}});}
  return {ok:true,score:8,papers:4,briefPath:'C:/Users/chand/.muse-agent/briefs/demo/brief.md',sourcesPath:'C:/Users/chand/.muse-agent/briefs/demo/sources.json',brief:'# Research brief: routing memory -- Long context beats retrieval for coding agents [1]. -- ## References -- [1] A Study.'};
};
api.onResearchStage=cb=>{briefListener=cb;return()=>{briefListener=()=>{}}};
contextBridge.exposeInMainWorld('muse',api);
`);

fs.writeFileSync(path.join(temp, 'verify.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=${JSON.stringify(root)},output=${JSON.stringify(output)};
const messageText=${JSON.stringify(messageText)},toolOutput=${JSON.stringify(toolOutput)};
let briefListener=()=>{};
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
 await js("setTheme('light')");await pause(700);
 await shot('conversation-light');
 await js("setTheme('dark')");
 win.setContentSize(420,780);await pause(250);await shot('narrow');
 win.setContentSize(1280,860);await pause(250);
 await js("document.getElementById('mainlog').scrollTop=document.getElementById('mainlog').scrollHeight");
 // Stop button: a busy turn shows Stop, pressing it acknowledges at once and
 // the button stays disabled until the run really ended.
 await js('setBusy(true)');
 await pause(250);
 assert.equal(await js("document.getElementById('btn-cancel-turn').style.display!=='none'"),true,'the stop button is visible while busy');
 assert.equal(await js("document.getElementById('btn-cancel-turn').textContent.indexOf('Stop')>=0"),true,'the stop button is labelled Stop');
 await js("document.getElementById('btn-cancel-turn').click()");
 await pause(300);
 assert.equal(await js("document.getElementById('btn-cancel-turn').textContent.indexOf('Stopping')>=0"),true,'pressing Stop acknowledges immediately');
 assert.equal(await js("document.getElementById('btn-cancel-turn').disabled"),true,'the stop button stays disabled until the run ends');
 assert.equal(await js("document.body.textContent.indexOf('Stopping')>=0"),true,'the transcript says the turn is stopping');
 await shot('stopping');
 await js("handleAgentEvent({type:'done',reason:'cancelled'})");
 await pause(250);
 assert.equal(await js("document.getElementById('btn-cancel-turn').textContent.indexOf('Stopping')===-1"),true,'the button is restored when the run ends');
 assert.equal(await js("document.getElementById('btn-cancel-turn').disabled"),false,'the stop button is usable for the next turn');
 // the steps of one turn belong together: one block with a count
 await js("addToolRow({id:'t2',name:'read_file',args:{path:'README.md'}})");
 await pause(200);
 await js("addToolRow({id:'t3',name:'list_dir',args:{path:'app'}})");
 await pause(200);
 assert.equal(await js("document.querySelectorAll('.turn-steps').length>=2"),true,'each turn keeps its own step block');
 assert.equal(await js("[...document.querySelectorAll('.turn-steps')].pop().querySelectorAll('.activity-card').length===2"),true,'the steps of one turn share one block');
 assert.equal(await js("([...document.querySelectorAll('.turn-steps-label')].pop().textContent||'').indexOf('2 steps')>=0"),true,'the block counts the steps');
 // the files-changed card
 await js("addUndoChip({runId:'run-1',files:['app/harness/agent.js','app/renderer/renderer.js']})");
 await pause(200);
 assert.equal(await js("document.querySelectorAll('.files-changed').length===1"),true,'the changed files get their own card');
 assert.equal(await js("(document.querySelector('.files-changed .fc-title')?.textContent||'').indexOf('2 files changed')>=0"),true,'the card names the count');
 assert.equal(await js("(document.querySelector('.files-changed .fc-list')?.textContent||'').indexOf('agent.js')>=0"),true,'the card names the files');
 await js("document.getElementById('mainlog').scrollTop=document.getElementById('mainlog').scrollHeight");
 await pause(250);await shot('turn-steps');
 // /antislop puts the rulebook in force for the session
 await js("input.value='/antislop ui'");
 await js("submit('/antislop ui')");
 await pause(400);
 assert.equal(await js("document.body.textContent.indexOf('antislop rules in force')>=0"),true,'the rules are reported as in force');
 assert.equal(await js("document.body.textContent.indexOf('UI / visual')>=0"),true,'the active rulebooks are named');
 await shot('antislop');
 // queue + undo chips (top-level renderer functions) must render with controls
 await js("renderQueueChips([{commandId:'q1',position:1,text:'refactor the parser and update the tests'},{commandId:'q2',position:2,text:'repackage the build'}])");
 await js("addUndoChip({runId:'run-fixture',files:['app/main/index.js','app/renderer/renderer.js']})");
 await pause(300);await shot('chips');
 await js('handleAgentEvent({type:"tool_result",id:"s1",name:"cite_source",result:{ok:true,text:"Recorded sources for retrieval-vs-long-context (3): [arxiv:2005.11401] RAG for Knowledge-Intensive NLP — 2020 — claim: retrieval beats parametric memory."}})');
 await pause(250);
 assert.equal(await js("[...document.querySelectorAll('.action-chip')].some(n=>n.textContent.indexOf('sources recorded: 3')>=0)"),true,'citation chip should show the source count');
 // /research <topic>: the orchestrator runs in main and streams its stages
 await js("input.value='/research routing memory'");
 await js("submit('/research routing memory')");
 await pause(600);
 assert.equal(await js("document.body.textContent.indexOf('selected 4 papers')>=0"),true,'stage lines appear while the brief runs');
 assert.equal(await js("document.body.textContent.indexOf('review score 8/10')>=0"),true,'the critique score is reported');
 assert.equal(await js("[...document.querySelectorAll('.msg')].some(n=>n.textContent.indexOf('Research brief')>=0)"),true,'the brief is shown');
 assert.equal(await js("[...document.querySelectorAll('.action-chip')].some(n=>n.textContent.indexOf('research brief ready')>=0)"),true,'the brief chip appears');
 await js("document.getElementById('mainlog').scrollTop=document.getElementById('mainlog').scrollHeight");
 await pause(250);await shot('research-brief');
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
 await js("setTheme('light')");await pause(700);
 await js("(()=>{const r=document.querySelector('.msg-rate');r.style.opacity=1;})()");
 await pause(200);await shot('rating-light');
 await js("setTheme('dark')");await pause(300);
 await js("setTheme('krishna')");await pause(500);await shot('theme-krishna');
 await js("setTheme('light')");await pause(500);await shot('theme-light');
 await js("setTheme('dark')");await pause(500);await shot('theme-dark');
 await js("setTheme('win7')");await pause(500);await shot('theme-win7');
 await js("setTheme('retro')");await pause(500);await shot('theme-retro');
 await js("setTheme('shiva')");await pause(500);await shot('theme-shiva');
 await js("setTheme('dark')");await pause(300);
 await js("window.muse.__fire('onApprovalRequest',{id:'req-1',tool:'shell',args:{command:'npm run test'}});document.getElementById('mainlog').scrollTop=document.getElementById('mainlog').scrollHeight");await pause(500);await shot('approval');
 await js("window.muse.__fire('onApprovalResolved',{id:'req-1',decision:'allow'})");await pause(300);
 await js("setTheme('dark')");await pause(400);
 // the welcome screen carries the picture, so it is checked per appearance
 await js("document.getElementById('transcript').innerHTML='';renderEmpty()");await pause(400);
 await js("setTheme('shiva')");await pause(500);await shot('empty-shiva');
 await js("setTheme('win7')");await pause(500);await shot('empty-win7');
 await js("setTheme('retro')");await pause(500);await shot('empty-retro');
 await js("setTheme('dark')");await pause(400);
 // the menu bar opens, lists the appearances and closes again
 await js("document.querySelector('.menubar-item[data-menu=view]').click()");await pause(300);await shot('menu-view');
 assert.equal(await js("document.querySelectorAll('#menubar-pop .menubar-entry').length>4"),true,'the View menu must list the appearances');
 assert.equal(await js("document.querySelector('#menubar-pop').hidden"),false,'the menu must open');
 await js("document.querySelector('.menubar-item[data-menu=workspace]').click()");await pause(250);await shot('menu-workspace');
 await js("document.body.click()");await pause(150);
 assert.equal(await js("document.querySelector('#menubar-pop').hidden"),true,'clicking away must close the menu');
 assert.equal(await js("window.muse.getAppearance().then(r=>r.theme)"),'dark','theme choice must reach the persistent store');
 await js("openDashboardView('d1')");await pause(500);await shot('dashboards');
 assert.equal(await js("document.querySelector('[data-nav=dashboards]').getAttribute('aria-pressed')"),'true','nav pill state must follow the Dashboards view');
 assert.equal(await js("document.querySelector('[data-nav=chat]').getAttribute('aria-pressed')"),'false','Chat must not stay marked active');
 await js("document.getElementById('mainlog').scrollTop=1180");await pause(300);await shot('dashboards-lower');
 await js("document.getElementById('mainlog').scrollTop=2200");await pause(300);await shot('dashboards-table');
 assert.deepEqual(errors,[],'Renderer console/load errors');console.log('PASS: chat preview '+output);win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});
setTimeout(()=>app.exit(1),55000).unref();
`);
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(temp, 'verify.cjs')], { cwd: root, env, stdio: 'inherit', timeout: 70000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('Chat verification failed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
