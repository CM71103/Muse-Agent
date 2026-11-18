// Visual verification for the Design Studio workspace (canvas chrome,
// artboard viewports, Preview/Code toggle). Boots the real renderer with a
// stub preload and captures the design workspace into dist/design-preview/.
// Run: bun run verify:design        (node scripts/verify-design.mts also works)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-design-'));
const output = path.join(root, 'dist/design-preview');
fs.mkdirSync(output, { recursive: true });

// Fixture page the preview iframe loads (file:// with a query string; Chromium
// ignores the query for file URLs, so the panel's ?muse-preview= stamp is safe).
fs.writeFileSync(path.join(output, 'fixture.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>
 body{margin:0;font:15px/1.6 -apple-system,'Segoe UI',sans-serif;color:#1c2320;background:#fff;}
 header{display:flex;align-items:center;gap:12px;padding:18px 34px;border-bottom:1px solid #e8eae9;}
 .dot{width:22px;height:22px;border-radius:7px;background:#2f9e44;}
 .hero{padding:64px 34px 40px;max-width:820px;}
 .eyebrow{letter-spacing:.18em;font-size:11px;font-weight:700;color:#8a938e;}
 h1{font-size:44px;line-height:1.12;margin:14px 0 12px;}
 h1 em{font-style:normal;color:#2f9e44;}
 .sub{font-size:17px;color:#5c6660;margin:0 0 22px;}
 .cta{display:inline-block;padding:11px 20px;border-radius:10px;background:#1c2320;color:#fff;font-weight:600;}
 .cards{display:flex;gap:16px;padding:10px 34px 48px;}
 .card{flex:1;border:1px solid #e8eae9;border-radius:14px;padding:20px;}
 .card h3{margin:8px 0 6px;font-size:17px;}
 .card p{margin:0;color:#5c6660;font-size:13px;}
 .tag{font-size:11px;font-weight:700;letter-spacing:.12em;color:#8a938e;}
</style></head>
<body>
<header><div class="dot"></div><strong>Fixture Studio</strong></header>
<section class="hero">
  <div class="eyebrow">NOW AVAILABLE FOR WINDOWS</div>
  <h1>Your personal AI agent.<br><em>Local-first. Fully yours.</em></h1>
  <p class="sub">A fixture page rendered inside the Design Studio artboard so layout, viewport switching and zoom can be checked visually.</p>
  <span class="cta">Get started</span>
</section>
<section class="cards">
  <div class="card"><div class="tag">RECOMMENDED</div><h3>Portable</h3><p>No installation. Drop it anywhere and double-click to run.</p></div>
  <div class="card"><div class="tag">UNDER THE HOOD</div><h3>Local-first by design</h3><p>Electron shell, Node harness, loopback-only services.</p></div>
</section>
</body></html>`);

fs.writeFileSync(path.join(temp, 'preload.cjs'), `
const {contextBridge}=require('electron');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const base=new URLSearchParams(location.search).get('fixture')||'';
let fixture={ok:true,projectDir:'C:/designs/demo',projectBaseDir:'C:/designs/demo',
 projectJson:{name:'Demo',kind:'prototype',design_system_id:'muse-default',template_id:'deck',craft:['design-quality']},
 systems:[{id:'muse-default',name:'Muse default',source:'bundled'},{id:'studio',name:'Studio',source:'project'}],
 skills:[{id:'design-review',name:'Design review',source:'bundled'}],
 templates:[{id:'deck',name:'Deck',source:'bundled'},{id:'dashboard',name:'Dashboard',source:'bundled'}],
 craft:[{id:'design-quality',name:'Design quality bar',source:'bundled'},{id:'web-performance',name:'Web performance craft',source:'user'}],
 roots:[{source:'project',dir:'C:/designs/demo'},{source:'user',dir:'C:/home/.muse-agent/design'},{source:'bundled',dir:'App'}],
 activeDesignSystemId:'muse-default',activeSkillId:'design-review',activeTemplateId:'deck',activeCraft:['design-quality'],
 artifact:null,preview:null,
 webPreview:{available:false,running:false,status:'stopped'}};
const api={
 __fixture:(patch)=>{fixture={...fixture,...patch};return true},
 designStatus:async()=>({...fixture}),
 designListFiles:async()=>({ok:true,files:[{path:'index.html',bytes:2048,modifiedAt:Date.now(),extension:'.html'},{path:'styles.css',bytes:920,modifiedAt:Date.now(),extension:'.css'},{path:'app.js',bytes:1280,modifiedAt:Date.now(),extension:'.js'}]}),
 designReadFile:async p=>({ok:true,path:p,text:'<!doctype html>\\n<html lang="en">\\n  <head>\\n    <meta charset="utf-8">\\n    <title>Demo</title>\\n    <link rel="stylesheet" href="styles.css">\\n  </head>\\n  <body>\\n    <h1>Fixture source preview</h1>\\n  </body>\\n</html>',bytes:2048,modifiedAt:Date.now()}),
 designRegistryList:async()=>({ok:true,entries:[]}),designRegistryRead:async()=>({ok:true,text:''}),
 designApplyTemplate:async()=>({ok:true,written:['index.html'],skipped:[],name:'Deck'}),designUserRegistryDir:async()=>({ok:true,dir:''}),
 designWorkspaceMode:async()=>({ok:true}),designSave:async()=>({ok:true}),designCreateProject:async()=>({ok:true,root:'C:/designs/demo'}),
 designChooseProject:async()=>({ok:true,...fixture}),designOpenPreview:async()=>({ok:true}),
 designWebPreviewStart:async()=>({...fixture,canceled:true}),designWebPreviewStop:async()=>({...fixture}),
 designSiteOpenUrl:async()=>({ok:true,url:base}),designSiteChooseFolder:async()=>({canceled:true}),designSiteChooseHtml:async()=>({canceled:true}),
 designSiteBounds:async()=>({ok:true}),designSiteClose:async()=>({ok:true}),designSitePackage:async()=>({ok:true,name:'Demo',exePath:'C:/demo/Demo.exe'}),
 designCapture:async()=>({ok:true,path:'fixture-shot.png'}),
 onDesignArtifact:()=>()=>{},onProjectChange:()=>()=>{},
 getConfig:async()=>({llm:{base_url:'https://api.example.com/v1',model:'muse-preview',visible_models:['muse-preview']},sentinel:{mode:'auto'},memory:{enabled:false}}),
 getProjectScope:async()=>({ok:true,project:null}),listProjects:async()=>[],listSessions:async()=>[],memoryStatus:async()=>({enabled:false}),
 getSettings:async()=>({base_url:'https://api.example.com/v1',model:'muse-preview',visible_models:['muse-preview'],embed_key_set:false,has_key:true}),
 saveSettings:async()=>({ok:true}),selectModel:async()=>({ok:true}),fetchModels:async()=>({ok:true,models:['muse-preview','muse-reasoning']}),mcpList:async()=>[],
 boxStatus:async()=>({state:'disconnected',tools:0}),onBoxStatus:()=>()=>{},boxConnect:async()=>({ok:true}),boxDisconnect:async()=>({ok:true}),boxOpenDesktop:async()=>({ok:true}),boxCancel:async()=>({ok:true})};
for(const name of ['onAgentEvent','onApprovalRequest','onApprovalResolved','onApprovalExpired','onSessionReset','onQuestion','onLearningStatus','onBoxStatus'])api[name]=()=>()=>{};
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
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 win.webContents.on('did-fail-load',(_e,code,description)=>errors.push(description));
 const js=async code=>{try{return await win.webContents.executeJavaScript(code)}catch(e){console.error('JS STEP FAILED:',code.slice(0,140));throw e}};
 const fixture=${JSON.stringify(pathToFileURL(path.join(output, 'fixture.html')).href)};
 await win.loadFile(path.join(root,'app/renderer/index.html'),{query:{fixture}});win.webContents.startPainting();
 await js("document.getElementById('splash')?.remove();setTheme('light')");
 await js("document.getElementById('design-open').click()");await pause(500);
 const shot=async name=>{await pause(250);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 await shot('empty');
 assert.equal(await js("document.getElementById('design-panel')!==null"),true,'design panel must mount');
 assert.equal(await js("document.querySelector('.design-preview-surface').classList.contains('has-artifact')"),false);
 // artifact state -> artboard with the fixture page
 await js("window.muse.__fixture({artifact:{entry:'index.html',kind:'html',title:'Demo'},preview:{url:"+JSON.stringify(fixture)+",version:'v1',title:'Demo',entry:'index.html'}})");
 await pause(1500);
 assert.equal(await js("document.getElementById('design-preview-frame').hidden"),false,'preview frame must show');
 await shot('preview-desktop');
 assert.equal(await js("Math.round(document.querySelector('.design-artboard').getBoundingClientRect().width)>760"),true,'desktop artboard should be wide');
 // viewport switching
 await js("var v=document.getElementById('design-viewport');v.value='tablet';v.dispatchEvent(new Event('change',{bubbles:true}))");await shot('preview-tablet');
 assert.equal(await js("Math.round(document.querySelector('.design-artboard').getBoundingClientRect().width)<=840"),true,'tablet artboard must narrow');
 await js("var v=document.getElementById('design-viewport');v.value='mobile';v.dispatchEvent(new Event('change',{bubbles:true}))");await shot('preview-mobile');
 assert.equal(await js("Math.round(document.querySelector('.design-artboard').getBoundingClientRect().width)<=400"),true,'mobile artboard must be phone width');
 await js("var v=document.getElementById('design-viewport');v.value='desktop';v.dispatchEvent(new Event('change',{bubbles:true}))");
 // zoom control
 await js("var z=document.getElementById('design-zoom');z.value='0.5';z.dispatchEvent(new Event('change',{bubbles:true}))");await pause(150);await shot('zoom-50');
 await js("var z=document.getElementById('design-zoom');z.value='fit';z.dispatchEvent(new Event('change',{bubbles:true}))");
 // code view
 await js("document.getElementById('design-mode-code').click()");await pause(350);await shot('code');
 assert.equal(await js("document.querySelector('.design-source-view').hidden"),false,'code view must open');
 assert.equal(await js("document.getElementById('design-preview-frame').hidden"),true,'frame hides in code view');
 assert.equal(await js("document.getElementById('design-mode-code').getAttribute('aria-pressed')"),'true');
 await js("document.getElementById('design-mode-preview').click()");await pause(250);
 assert.equal(await js("document.querySelector('.design-source-view').hidden"),true,'preview mode restores the frame');
 // file tabs: artifact tab + code tab, switching restores the right view
 assert.equal(await js("document.querySelectorAll('.design-canvas-tabs .design-tab').length"),2,'preview + code tabs');
 assert.equal(await js("(document.querySelector('.design-tab.is-active')||{textContent:''}).textContent.includes('index.html')"),true,'code tab is active');
 await js("document.querySelector('.design-tab').click()");await pause(250);await shot('tabs');
 assert.equal(await js("document.getElementById('design-preview-frame').hidden"),false,'preview tab restores the frame');
 // floating tool rail: fit + screenshot
 await js("document.getElementById('design-rail-fit').click()");await pause(150);
 assert.equal(await js("document.getElementById('design-zoom').value"),'fit','rail fit syncs the zoom control');
 await js("document.getElementById('design-rail-screenshot').click()");await pause(250);
 assert.equal(await js("document.getElementById('design-error').textContent"),'','screenshot should succeed silently');
 // dark theme sanity + narrow window
 await js("setTheme('dark')");await shot('preview-dark');
 win.setContentSize(900,700);await pause(250);await shot('narrow');
 assert.equal(await js("document.querySelector('.design-canvas-toolbar').scrollWidth<=document.querySelector('.design-canvas-toolbar').clientWidth+2"),true,'canvas toolbar should not overflow');
 assert.deepEqual(errors,[],'Renderer console/load errors');console.log('PASS: design workspace preview '+output);win.destroy();app.exit(0);
}catch(error){console.error(error);if(win)win.destroy();app.exit(1)}});
setTimeout(()=>app.exit(1),25000).unref();
`);
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(temp, 'verify.cjs')], { cwd: root, env, stdio: 'inherit', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('Design workspace verification failed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
