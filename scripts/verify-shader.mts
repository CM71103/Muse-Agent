import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-shader-'));
const output = path.join(root, 'dist/shader-preview');
fs.mkdirSync(output, { recursive: true });
// Isolated mock bridge: render the real UI without loading keys, sessions or the agent.
fs.writeFileSync(path.join(temp, 'preload.cjs'), `
const {contextBridge}=require('electron');
let selected=null;const projects=[{id:'design',name:'Website redesign'},{id:'research',name:'Research notes'}];
const api={getConfig:async()=>({llm:{model:'Shader preview'},sentinel:{mode:'ask'},memory:{enabled:false}}),
getProjectScope:async()=>({ok:true,project:null,projectId:selected}),listProjects:async()=>projects,listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),
createProject:async name=>{const record={id:'preview',name};projects.push(record);return {ok:true,record}},
selectProject:async id=>{selected=id;return {ok:true,name:projects.find(p=>p.id===id)?.name}}};
for(const name of ['onAgentEvent','onApprovalRequest','onApprovalResolved','onApprovalExpired','onSessionReset','onQuestion'])api[name]=()=>()=>{};
contextBridge.exposeInMainWorld('muse',api);
`);
fs.writeFileSync(path.join(temp, 'verify.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=${JSON.stringify(root)},output=${JSON.stringify(output)};
app.setPath('userData',path.join(__dirname,'profile'));
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if(process.env.MUSE_SHADER_REDUCED==='1')app.commandLine.appendSwitch('force-prefers-reduced-motion');
const reduced=process.env.MUSE_SHADER_REDUCED==='1';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let win; const errors=[];
app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({width:1280,height:720,useContentSize:true,show:false,webPreferences:{offscreen:true,
    preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);if(event.level==='error'||event.level==='warning')console.log(event.level,event.message)});
  win.webContents.on('did-fail-load',(_e,code,description,url)=>errors.push(description+' '+url));
  const js=code=>win.webContents.executeJavaScript(code);
  async function until(condition){const end=Date.now()+15000;while(Date.now()<end){if(await js(condition))return;await pause(50)}console.log(await js("JSON.stringify({host:document.getElementById('bg-shader').outerHTML,scripts:[...document.scripts].map(s=>s.src),resources:performance.getEntriesByType('resource').map(r=>r.name)})"));throw Error('Timed out: '+condition)}
  await win.loadFile(path.join(root,'app/renderer/index.html'));
  await until("document.getElementById('bg-shader').dataset.shaderState==='ready'");
  win.webContents.setFrameRate(30);
  win.webContents.startPainting();
  await js("document.getElementById('splash')?.remove()");
  assert.ok(await js("!!document.querySelector('#empty h1')"),'Chat UI did not initialize');
  assert.equal(await js("document.body.dataset.theme"),'dark','Ember theme should initialize consistently');
  assert.equal(await js("[...document.querySelectorAll('.nav-links button')].every(b=>b.getBoundingClientRect().width>0)"),true,'View tabs must remain accessible');
  assert.equal(await js("document.querySelector('.starter:last-child').getBoundingClientRect().bottom<=document.getElementById('mainlog').getBoundingClientRect().bottom"),true,'Starter cards must fit above the composer');
  assert.equal(await js("document.getElementById('btn-settings').getBoundingClientRect().bottom<=document.querySelector('.history').getBoundingClientRect().bottom"),true,'Sidebar settings must remain reachable');
  await js("document.querySelector('.starter').click()");
  assert.ok(await js("document.getElementById('input').value.length>0"),'Starter must still fill the composer');
  await js("document.getElementById('input').value=''");
  const before=await js("document.getElementById('bg-shader').paperShaderMount.getCurrentFrame()");
  if(!reduced)await until("document.getElementById('bg-shader').paperShaderMount.getCurrentFrame()>"+before);
  else await pause(200);
  const after=await js("document.getElementById('bg-shader').paperShaderMount.getCurrentFrame()");
  const state=await js("({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden,width:document.getElementById('bg-shader').clientWidth,height:document.getElementById('bg-shader').clientHeight,speed:document.getElementById('bg-shader').paperShaderMount.speed,currentSpeed:document.getElementById('bg-shader').paperShaderMount.currentSpeed})");
  console.log(JSON.stringify({before,after,state}));
  assert.ok(state.reduced?after===before:after>before,'Animation preference was not respected');
  assert.equal(await js("document.querySelector('#bg-shader canvas').getContext('webgl2').getError()"),0);
  await js("document.getElementById('pref-shader').checked=false;document.getElementById('pref-shader').dispatchEvent(new Event('change'))");
  const stopped=await js("document.getElementById('bg-shader').paperShaderMount.getCurrentFrame()");
  await pause(100);
  assert.equal(await js("document.getElementById('bg-shader').paperShaderMount.getCurrentFrame()"),stopped,'Off toggle kept animating');
  await js("document.getElementById('pref-shader').checked=true;document.getElementById('pref-shader').dispatchEvent(new Event('change'));setTheme('dark');resetTranscript()");
  await pause(1300);
  fs.writeFileSync(path.join(output,reduced?'reduced-motion.png':'dark.png'),(await win.webContents.capturePage()).toPNG());
  if(!reduced){
   await js("document.getElementById('btn-create-project').click();document.getElementById('project-name').value='Launch planning'");
   assert.equal(await js("document.getElementById('project-create').hidden"),false);
   assert.ok(await js("document.getElementById('btn-project-create-save').getBoundingClientRect().width>70"),'Create action must be readable');
   await pause(250);
   fs.writeFileSync(path.join(output,'projects.png'),(await win.webContents.capturePage()).toPNG());
   await js("document.getElementById('project-create').requestSubmit()");
   await until("document.getElementById('project-create').hidden && activeProjectId==='preview'");
   assert.equal(await js("document.querySelector('#project-home h1').textContent"),'Launch planning');
   await js("projectHomeVisible=false;resetTranscript();setBusy(true);handleAgentEvent({type:'subagent_start',subagentId:'review',task:'Review the project structure and identify improvements.'});handleAgentEvent({type:'tool_call',subagent:true,subagentId:'review',name:'read_file'});handleAgentEvent({type:'subagent_start',subagentId:'tests',task:'Check the current tests and suggest coverage gaps.'})");
   await pause(150);
   fs.writeFileSync(path.join(output,'subagents-running.png'),(await win.webContents.capturePage()).toPNG());
   await js("handleAgentEvent({type:'done',subagent:true,subagentId:'review'})");
   assert.equal(await js('busy'),true,'Child completion must not unlock the parent composer');
   await js("handleAgentEvent({type:'subagent_done',subagentId:'review',turns:3,result:'Reviewed the main modules. The project boundaries are clear; two shared helpers can be simplified.'});handleAgentEvent({type:'subagent_done',subagentId:'tests',turns:2,result:'Checked the test suite. Add coverage for cancelling a running task.'});document.querySelector('.subagent-card details').open=true");
   assert.equal(await js("document.querySelectorAll('.subagent-card[data-state=completed]').length"),2);
   assert.equal(await js("document.getElementById('subagent-count').textContent"),'Ready');
   await pause(250);
   fs.writeFileSync(path.join(output,'subagents.png'),(await win.webContents.capturePage()).toPNG());
   await js("setBusy(false)");
   await js("setTheme('light');resetTranscript()");await pause(1300);
   fs.writeFileSync(path.join(output,'light.png'),(await win.webContents.capturePage()).toPNG());
   await js("setTheme('dark');resetTranscript()");
   win.setContentSize(760,600);await pause(1300);
   assert.equal(await js("Math.round(document.getElementById('bg-shader').getBoundingClientRect().width)===innerWidth"),true);
   fs.writeFileSync(path.join(output,'compact.png'),(await win.webContents.capturePage()).toPNG());
   assert.equal(await js("document.getElementById('workbench').classList.contains('collapsed')"),true,'Workbench must collapse on narrow screens');
   assert.equal(await js("[...document.querySelectorAll('.nav-links button')].every(b=>b.getBoundingClientRect().width>0)"),true,'Compact layout must keep view tabs');
   assert.equal(await js("document.querySelector('.starter:last-child').getBoundingClientRect().bottom<=document.getElementById('mainlog').getBoundingClientRect().bottom"),true,'Compact starter cards must fit above the composer');
   await js("addMsg('user','Help me review this project.');addMsg('assistant','I’ll check the structure, trace the important paths, and explain what needs attention.');");
   await pause(450);
   fs.writeFileSync(path.join(output,'conversation.png'),(await win.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(errors,[],'Renderer console/load errors');
  console.log('PASS: DotOrbit '+(reduced?'reduced motion':'animation, toggle, resize, light and dark')+'; screenshots: '+output);
  win.destroy();app.exit(0);
 }catch(error){console.error(error);if(win)win.destroy();app.exit(1)}
});
setTimeout(()=>{console.error('Shader verification timed out');app.exit(1)},25000).unref();
`);
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const reduced of ['0', '1']) {
    const result = spawnSync(require('electron'), [path.join(temp, 'verify.cjs')], {
      cwd: root, env: { ...env, MUSE_SHADER_REDUCED: reduced }, stdio: 'inherit', timeout: 35000, windowsHide: true,
    });
    if (result.error || result.status !== 0) throw result.error || new Error('Shader verification failed');
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
