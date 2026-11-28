import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-instrument-'));
const output = path.join(root, 'dist/instrument-preview');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(temp, 'preload.cjs'), `
const {contextBridge}=require('electron');
const api={getConfig:async()=>({llm:{model:'muse-preview'},sentinel:{mode:'auto'},memory:{enabled:false}}),
getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[],listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),
getSettings:async()=>({base_url:'https://api.example.com/v1',model:'muse-preview',has_key:true,embed_key_set:true,visible_models:['muse-preview']}),
getAppearance:async()=>({ok:true,theme:'instrument',density:'comfortable'}),setAppearance:async()=>({ok:true}),
getWho:async()=>({ok:true}),runsList:async()=>({ok:true,runs:[]}),mcpList:async()=>[],
boxStatus:async()=>({state:'disconnected',tools:0}),researchStatus:async()=>({key_set:false,openalex_key_set:false,openalex_mailto:''})};
for(const name of ['onAgentEvent','onApprovalRequest','onApprovalResolved','onApprovalExpired','onSessionReset','onQuestion','onBoxStatus'])api[name]=()=>()=>{};
contextBridge.exposeInMainWorld('muse',api);
`);
fs.writeFileSync(path.join(temp, 'verify.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=${JSON.stringify(root)},output=${JSON.stringify(output)};
app.setPath('userData',path.join(__dirname,'profile'));
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const pause=ms=>new Promise(r=>setTimeout(r,ms));const errors=[];let win;
const CONTRAST=\`(()=>{const el=document.querySelector('.empty-lead');const fg=getComputedStyle(el).color;
let node=el,bg='rgba(0, 0, 0, 0)';
while(node&&bg==='rgba(0, 0, 0, 0)'){bg=getComputedStyle(node).backgroundColor;node=node.parentElement}
const rgb=s=>s.match(/[\\\\d.]+/g).slice(0,3).map(Number);
const lum=c=>{const [r,g,b]=c.map(v=>v/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b};
const [a,b]=[lum(rgb(fg)),lum(rgb(bg))].sort((x,y)=>y-x);return (a+.05)/(b+.05)})()\`;
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1280,height:820,useContentSize:true,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 win.webContents.on('did-fail-load',(_e,code,description)=>errors.push(description));
 const js=code=>win.webContents.executeJavaScript(code);
 await win.loadFile(path.join(root,'app/renderer/index.html'));win.webContents.startPainting();
 await js("document.getElementById('splash')?.remove()");await pause(350);
 const shot=async name=>{await pause(180);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 const stripBg=()=>js("getComputedStyle(document.querySelector('.status-strip')).backgroundColor");
 const stripH=()=>js("Math.round(document.querySelector('.status-strip').getBoundingClientRect().height)");
 const overflow=()=>js("document.documentElement.scrollWidth<=innerWidth");
 const stripFits=()=>js("(()=>{const s=document.getElementById('status-strip');return s.scrollWidth<=s.clientWidth+1})()");

 // Light, comfortable: the shipped default.
 assert.equal(await js("document.body.getAttribute('data-theme')"),'instrument');
 assert.equal(await js("document.body.getAttribute('data-density')"),'comfortable');
 assert.equal(await stripBg(),'rgb(246, 245, 241)');
 assert.equal(await stripH(),30);
 assert.equal(await js("document.getElementById('instrument-density').hidden"),false,'density control shows for instrument');
 assert.equal(await js("document.querySelector('[data-density-pick=comfortable]').getAttribute('aria-pressed')"),'true');
 await shot('light-1280');

 // Night, comfortable: ink canvas, paper type, lifted signal.
 await js("setTheme('instrument-night')");await pause(650);
 assert.equal(await stripBg(),'rgb(14, 17, 20)');
 assert.equal(await js("getComputedStyle(document.body).colorScheme"),'dark');
 assert.equal(await overflow(),true,'no horizontal page overflow at night 1280');
 assert.equal(await stripFits(),true,'status strip fits its column without clipping at 1280');
 const nightContrast=await js(CONTRAST);
 assert.ok(nightContrast>=7,'night body copy contrast '+nightContrast.toFixed(2));
 assert.equal(await js("document.querySelector('[data-theme-pick=instrument-night]').getAttribute('aria-checked')"),'true');
 await shot('night-1280');
 assert.equal(await js("getComputedStyle(document.querySelector('.inputwrap')).backgroundColor"),'rgb(27, 33, 41)','composer field follows the night palette');
 await js("openSettings('workspace')");await pause(300);await shot('night-settings');
 await js("closeSettings()");await pause(150);

 // Dense: same ink, less air.
 await js("setDensity('dense')");await pause(150);
 assert.equal(await stripH(),24);
 assert.equal(await js("getComputedStyle(document.getElementById('wb-log')).fontSize"),'11px');
 assert.equal(await js("document.querySelector('[data-density-pick=dense]').getAttribute('aria-pressed')"),'true');
 assert.equal(await overflow(),true);
 await shot('night-dense-1280');

 // Narrow and tablet, both palettes.
 win.setContentSize(768,760);await pause(250);
 assert.equal(await overflow(),true);assert.equal(await stripFits(),true,'strip fits at 768');await shot('night-dense-768');
 win.setContentSize(360,720);await pause(250);
 console.log('cells@360:',await js("JSON.stringify((()=>{const s=document.getElementById('status-strip');return {w:s.clientWidth,sw:s.scrollWidth,cells:[...s.querySelectorAll('.status-cell,.status-strip-brand')].filter(e=>e.offsetParent).map(e=>[e.className.includes('brand')?'brand':(e.dataset.live||e.querySelector('.status-k').textContent),Math.round(e.getBoundingClientRect().width),Math.round(e.getBoundingClientRect().left),Math.round(e.getBoundingClientRect().right)])}})())"));
 assert.equal(await overflow(),true);
 assert.equal(await stripFits(),true,'strip fits at 360');
 assert.equal(await js("document.getElementById('settings').getBoundingClientRect().right<=innerWidth"),true);
 await shot('night-dense-360');
 await js("setTheme('instrument')");await pause(650);
 assert.equal(await stripBg(),'rgb(246, 245, 241)');
 const dayContrast=await js(CONTRAST);
 assert.ok(dayContrast>=4.5,'light body copy contrast '+dayContrast.toFixed(2));
 await shot('light-dense-360');
 win.setContentSize(768,760);await pause(200);await shot('light-dense-768');
 win.setContentSize(1280,820);await pause(200);await js("setDensity('comfortable')");await pause(150);
 assert.equal(await stripH(),30);

 // Leaving the family hides the density control and restores the light chrome.
 await js("setTheme('light')");await pause(250);
 assert.equal(await js("document.getElementById('instrument-density').hidden"),true);
 assert.equal(await js("document.body.hasAttribute('data-theme')"),false);
 await shot('other-theme');

 assert.deepEqual(errors,[],'Renderer console/load errors');
 console.log('PASS: instrument variants '+output);win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});
setTimeout(()=>app.exit(1),40000).unref();
`);
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(temp, 'verify.cjs')], { cwd: root, env, stdio: 'inherit', timeout: 60000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('Instrument verification failed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
