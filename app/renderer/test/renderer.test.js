'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../renderer.js'),'utf8');
class Node {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.style={};this.listeners={};this.value='';this._text='';this.disabled=false;this.hidden=false;this.classes=new Set();this.classList={add:(x)=>this.classes.add(x),remove:(x)=>this.classes.delete(x),contains:(x)=>this.classes.has(x),toggle:(x,on)=>{const v=on===undefined?!this.classes.has(x):on;v?this.classes.add(x):this.classes.delete(x);return v;}};const self=this;Object.defineProperty(this,'textContent',{get(){return self.children.length?self.children.map(c=>String(c.textContent??'')).join(''):self._text;},set(v){self._text=String(v);self.children=[];},configurable:true});}
  append(...n){for(const x of n){this.children.push(x);if(typeof x==='object')x.parent=this;}}
  prepend(n){this.children.unshift(n);n.parent=this;}
  replaceChildren(...n){this.children=[];this.append(...n);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  get firstElementChild(){return this.children[0];}
  addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
  setAttribute(k,v){this[k]=v;}
  focus(){this.doc.activeElement=this;}
  click(){for(const fn of this.listeners.click||[])fn({target:this});}
  querySelector(){return this.children.find(n=>n.tagName==='button');}
  querySelectorAll(){return this.descendants();}
  descendants(){const out=[];const walk=(n)=>{for(const c of n.children||[]){out.push(c);walk(c);}};walk(this);return out;}
}
function setup(overrides={}) {
  const nodes=new Map();const document={activeElement:null,createElement:tag=>{const n=new Node(tag);n.doc=document;return n;},createElementNS:(ns,tag)=>{const n=new Node(tag);n.doc=document;n.namespaceURI=ns;return n;},createTextNode:text=>({textContent:text}),getElementById:id=>{if(!nodes.has(id)){const n=document.createElement('div');n.id=id;nodes.set(id,n);}return nodes.get(id);}};
  document.body=document.createElement('body');
  document.querySelectorAll=(sel)=>document.body.querySelectorAll(sel);
  let event, approval, resolved;const muse={onAgentEvent:cb=>event=cb,onApprovalRequest:cb=>approval=cb,onApprovalResolved:cb=>resolved=cb,onSessionReset:()=>{},onQuestion:()=>()=>{},onApprovalExpired:()=>()=>{},cancel:async()=>({ok:true}),answerQuestion:async()=>({ok:true}),getConfig:async()=>({llm:{model:'test'},hands:{enabled:false},sentinel:{mode:'ask'}}),memoryStatus:async()=>({enabled:false}),listSessions:async()=>[],reset:async()=>({ok:true}),...overrides};
  const window={muse,addEventListener:()=>{},confirm:()=>true};
  const c=vm.createContext({document,window,console,setTimeout:()=>{},navigator:{clipboard:{writeText:async()=>{}}},Blob,URL});
  // Match real HTML script order: shared global scope must not redeclare names.
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/i18n.js'),'utf8'),c);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/subagent-cards.js'),'utf8'),c);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/settings-panel.js'),'utf8'),c);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/activity-cards.js'),'utf8'),c);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/model-picker.js'),'utf8'),c);
  vm.runInContext(source,c);
  return {c,muse,nodes,event:ev=>event(ev),approval:req=>approval(req),resolved:result=>resolved(result),run:s=>vm.runInContext(s,c)};
}
test('send rejection clears busy, thinking and disabled controls',async()=>{const t=setup({send:async()=>{throw Error('offline');}});await t.run("input.value='hello'; submit()");assert.equal(t.run('busy'),false);assert.equal(t.run('thinkingEl'),null);assert.equal(t.nodes.get('send').disabled,false);assert.equal(t.run('transcriptMessages[0].text'),'hello');});

const connectionSettings={base_url:'https://models.example/v1',model:'original',has_key:true,embed_key_set:true};
function editSetting(t,id,value){t.nodes.get(id).value=value;for(const fn of t.nodes.get(id).listeners.input||[])fn();}
const saveConnection=t=>t.nodes.get('btn-save').listeners.click[0]();

test('embedding key is visibly saved after saving, reopening, and a fresh renderer without resending it',async()=>{
 let stored=false;const patches=[];const bridge={getSettings:async()=>({...connectionSettings,embed_key_set:stored}),
 saveSettings:async patch=>{patches.push(patch);if(patch.embed_api_key)stored=true;return {ok:true,model:patch.model};}};
 const t=setup(bridge);await t.run('openSettings()');assert.equal(t.nodes.get('embed-key-state').textContent,'Using chat key');
 editSetting(t,'f-embed-key','synthetic-embedding-key');assert.equal(t.nodes.get('embed-key-state').textContent,'Not saved yet');
 assert.match(t.nodes.get('embed-key-hint').textContent,/Click Save connection/);await saveConnection(t);
 assert.equal(patches[0].embed_api_key,'synthetic-embedding-key');assert.equal(t.nodes.get('f-embed-key').value,'');
 assert.equal(t.nodes.get('embed-key-state').textContent,'Key saved');assert.match(t.nodes.get('f-embed-key').placeholder,/saved key/);
 assert.equal(t.nodes.get('btn-embed-eye').disabled,true);
 t.run('closeSettings()');await t.run('openSettings()');assert.equal(t.nodes.get('embed-key-state').textContent,'Key saved');
 assert.match(t.nodes.get('embed-key-hint').textContent,/do not need to enter it again/);
 editSetting(t,'model-list','another-model');await saveConnection(t);assert.equal(Object.hasOwn(patches[1],'embed_api_key'),false);
 const fresh=setup(bridge);await fresh.run('openSettings()');assert.equal(fresh.nodes.get('embed-key-state').textContent,'Key saved');
 assert.equal(fresh.nodes.get('f-embed-key').value,'');assert.doesNotMatch(fresh.nodes.get('embed-key-hint').textContent,/synthetic-embedding-key/);
});

test('failed embedding-key save is never shown as stored and retains the entry for retry',async()=>{
 const t=setup({getSettings:async()=>({...connectionSettings,embed_key_set:false}),saveSettings:async()=>({ok:false,error:'Could not store key'})});
 await t.run('openSettings()');editSetting(t,'f-embed-key','unsaved-synthetic-key');await saveConnection(t);
 assert.equal(t.nodes.get('embed-key-state').textContent,'Not saved yet');assert.equal(t.nodes.get('f-embed-key').value,'unsaved-synthetic-key');
 assert.equal(t.nodes.get('btn-embed-eye').disabled,false);assert.match(t.nodes.get('settings-err').textContent,/Could not store key/);
});

test('connection save is single-flight, keeps progress visible and clears typed keys after success',async()=>{
 let release,calls=0,patch;const t=setup({getSettings:async()=>connectionSettings,saveSettings:value=>{calls++;patch=value;return new Promise(resolve=>release=resolve);}});
 await t.run('openSettings()');assert.equal(t.nodes.get('btn-save').disabled,true);
 editSetting(t,'model-list','new-model');editSetting(t,'f-key','typed-secret');
 const pending=saveConnection(t);await saveConnection(t);assert.equal(calls,1);
 assert.equal(t.nodes.get('btn-save').textContent,'Saving…');assert.equal(t.nodes.get('btn-cancel').disabled,true);
 t.run('closeSettings()');assert.equal(t.run('settingsOpen'),true);
 assert.equal(Object.hasOwn(patch,'embed_api_key'),false,'blank embedding key preserves the stored credential');
 release({ok:true,model:'new-model'});await pending;
 assert.equal(t.run('settingsOpen'),true);assert.equal(t.nodes.get('btn-save').textContent,'Saved');
 assert.equal(t.nodes.get('btn-save').disabled,true);assert.equal(t.nodes.get('btn-cancel').disabled,false);
 assert.equal(t.nodes.get('f-key').value,'');assert.doesNotMatch(t.nodes.get('settings-model-preview').textContent,/typed-secret/);
 assert.equal(t.nodes.get('settings-endpoint-preview').textContent,'models.example');
});

test('failed connection saves preserve edits and allow retry',async()=>{
 let calls=0;const t=setup({getSettings:async()=>connectionSettings,saveSettings:async()=>{calls++;if(calls===1)throw Error('Disk unavailable');return {ok:true,model:'next'};}});
 await t.run('openSettings()');editSetting(t,'model-list','next');await saveConnection(t);
 assert.match(t.nodes.get('settings-err').textContent,/Disk unavailable/);assert.equal(t.nodes.get('btn-save').disabled,false);
 assert.equal(t.nodes.get('model-list').value,'next');assert.equal(t.nodes.get('btn-save').textContent,'Try again');
 await saveConnection(t);assert.equal(calls,2);assert.equal(t.nodes.get('btn-save').textContent,'Saved');
});

test('connection form validates before IPC and tab actions match immediate workspace preferences',async()=>{
 let calls=0;const t=setup({getSettings:async()=>connectionSettings,saveSettings:async()=>{calls++;return {ok:true};}});
 await t.run('openSettings()');editSetting(t,'f-base','invalid');await saveConnection(t);
 assert.equal(calls,0);assert.match(t.nodes.get('settings-err').textContent,/valid endpoint/);
 assert.equal(t.nodes.get('btn-cancel').disabled,false);
 editSetting(t,'f-base','https://models.example/v1');editSetting(t,'model-list','');await saveConnection(t);
 assert.equal(calls,0);assert.match(t.nodes.get('settings-err').textContent,/enter a model/);
 t.nodes.get('tab-workspace').click();assert.equal(t.nodes.get('btn-save').hidden,true);
 t.nodes.get('tab-connection').click();assert.equal(t.nodes.get('btn-save').hidden,false);
});

test('model discovery supplies selectable choices without marking a connection as saved or tested',async()=>{
 const t=setup({getSettings:async()=>connectionSettings,fetchModels:async()=>({ok:true,models:['fast','reasoning']})});
 await t.run('openSettings()');await t.nodes.get('btn-fetch').listeners.click[0]();
 assert.match(t.nodes.get('models-status').textContent,/2 models found/);
 t.nodes.get('model-results-settings').children[1].children[0].click();assert.equal(t.nodes.get('model-list').value,'reasoning');
 assert.equal(t.nodes.get('connection-state').textContent,'Unsaved changes');assert.equal(t.nodes.get('btn-save').disabled,false);
});

test('late model discovery cannot replace choices after an endpoint edit or unlock an active save',async()=>{
 let fetchDone,saveDone;const t=setup({getSettings:async()=>connectionSettings,
 fetchModels:()=>new Promise(resolve=>fetchDone=resolve),saveSettings:()=>new Promise(resolve=>saveDone=resolve)});
 await t.run('openSettings()');const fetching=t.nodes.get('btn-fetch').listeners.click[0]();
 editSetting(t,'f-base','https://other.example/v1');editSetting(t,'model-list','new');
 const saving=saveConnection(t);fetchDone({ok:true,models:['old-endpoint-model']});await fetching;
 assert.doesNotMatch(t.nodes.get('model-results-settings')?.textContent||'',/old-endpoint-model/);assert.equal(t.nodes.get('btn-fetch').disabled,true);
 assert.equal(t.nodes.get('btn-save').disabled,true);saveDone({ok:true,model:'new'});await saving;
 assert.equal(t.nodes.get('btn-fetch').disabled,false);
});

test('settings shortlist checkboxes save chat visibility and survive reopening without a native datalist',async()=>{
 let saved={...connectionSettings,visible_models:['original']};let patch;
 const t=setup({getSettings:async()=>saved,fetchModels:async()=>({ok:true,models:['original','fast']}),
 saveSettings:async value=>{patch=value;saved={...saved,...value};return {ok:true,model:value.model};}});
 await t.run('openSettings()');await t.nodes.get('btn-fetch').listeners.click[0]();
 const check=t.nodes.get('model-results-settings').children[1].children[1].children[0];check.checked=true;check.listeners.change[0]();
 assert.equal(t.nodes.get('btn-save').disabled,false);await saveConnection(t);
 assert.deepEqual(Array.from(patch.visible_models),['original','fast']);assert.equal(t.nodes.get('chat-model-label').textContent,'original');
 t.run('closeSettings()');t.nodes.get('chat-model-trigger').click();
 assert.equal(t.nodes.get('model-results-chat').children.length,2);
 await t.run('openSettings()');assert.equal(t.nodes.get('chat-models-summary').textContent,'2 models visible in chat');
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),/<datalist|list="models-dl"/);
});

test('chat picker switches a saved model once without losing the typed message and retains the old model on failure',async()=>{
 let release,calls=0;const t=setup({getConfig:async()=>({llm:{model:'one',visible_models:['one','two']},sentinel:{mode:'ask'}}),
 selectModel:()=>{calls++;return new Promise(resolve=>release=resolve);}});
 await t.run('refreshStatus()');t.nodes.get('input').value='Keep my draft';t.nodes.get('chat-model-trigger').click();
 const choose=t.nodes.get('model-results-chat').children[1].children[0];const pending=choose.listeners.click[0]();await choose.listeners.click[0]();
 assert.equal(calls,1);assert.equal(t.nodes.get('send').disabled,true);assert.equal(t.nodes.get('chat-model-label').textContent,'one');
 release({ok:false,error:'Could not save model'});await pending;
 assert.equal(t.nodes.get('chat-model-label').textContent,'one');assert.match(t.nodes.get('chat-model-error').textContent,/Could not save/);
 assert.equal(t.nodes.get('send').disabled,false);
 const retry=t.nodes.get('model-results-chat').children[1].children[0].listeners.click[0]();release({ok:true,model:'two'});await retry;
 assert.equal(t.nodes.get('chat-model-label').textContent,'two');assert.equal(t.nodes.get('tag-model').textContent,'two');
 assert.equal(t.nodes.get('input').value,'Keep my draft');assert.equal(t.nodes.get('model-menu-chat').hidden,true);
});

test('chat picker respects empty lists, search, and active agent work',async()=>{
 const t=setup();t.run("modelUI.sync({model:'active-hidden',visible_models:[]})");t.nodes.get('chat-model-trigger').click();
 assert.match(t.nodes.get('model-results-chat').textContent,/Choose models in Settings/);
 t.run("modelUI.sync({model:'one',visible_models:['one','another']})");t.nodes.get('model-close-chat').click();t.nodes.get('chat-model-trigger').click();
 editSetting(t,'model-search-chat','another');assert.equal(t.nodes.get('model-results-chat').children.length,1);
 assert.match(t.nodes.get('model-results-chat').textContent,/another/);
 t.run('setBusy(true)');assert.equal(t.nodes.get('chat-model-trigger').disabled,true);assert.equal(t.nodes.get('model-menu-chat').hidden,true);
});

test('an outdated status refresh cannot undo a newer chat model selection',async()=>{
 const t=setup({selectModel:async()=>({ok:true,model:'two'})});
 await t.run('refreshStatus()');t.run("modelUI.sync({model:'one',visible_models:['one','two']})");
 let release;t.muse.getConfig=()=>new Promise(resolve=>release=resolve);const stale=t.run('refreshStatus()');
 t.nodes.get('chat-model-trigger').click();await t.nodes.get('model-results-chat').children[1].children[0].listeners.click[0]();
 release({llm:{model:'one',visible_models:['one','two']},sentinel:{mode:'ask'}});await stale;
 assert.equal(t.nodes.get('chat-model-label').textContent,'two');assert.equal(t.nodes.get('tag-model').textContent,'two');
});

test('changing the endpoint clears the draft shortlist without changing saved chat choices',async()=>{
 const t=setup({getSettings:async()=>({...connectionSettings,visible_models:['one','two']})});
 await t.run('openSettings()');editSetting(t,'f-base','https://new-provider.example/v1');
 assert.equal(t.nodes.get('chat-models-summary').textContent,'No models selected for chat');
 assert.equal(t.run('modelUI.draftModels().length'),0);assert.equal(t.nodes.get('btn-save').disabled,false);
});

test('subagents have separate cards and child completion never finishes the parent',()=>{
 const t=setup();t.run('setBusy(true)');
 for(const id of ['one','two'])t.event({type:'subagent_start',subagent:true,subagentId:id,task:'Review '+id});
 t.event({type:'message',subagent:true,subagentId:'one',text:'Child reply'});
 t.event({type:'done',subagent:true,subagentId:'one'});
 assert.equal(t.run('busy'),true);assert.equal(t.run('transcriptMessages.length'),0);
 const cards=t.nodes.get('transcript').children.filter(n=>n.className==='subagent-card');
 assert.equal(cards.length,2);assert.match(cards[0].textContent,/Subagent 1.*Review one.*Child reply/);
 assert.doesNotMatch(cards[1].textContent,/Child reply/);assert.equal(t.nodes.get('subagent-count').textContent,'2 running');
 for(let i=0;i<45;i++)t.event({type:'info',subagent:true,subagentId:'one',text:'progress '+i});
 assert.equal(cards[0].descendants().find(n=>n.className==='subagent-log').children.length,40);
 t.event({type:'subagent_done',subagent:true,subagentId:'one',result:'Review complete',turns:2});
 t.event({type:'subagent_done',subagent:true,subagentId:'two',cancelled:true});
 assert.equal(cards[0]['data-state'],'completed');assert.equal(cards[1]['data-state'],'cancelled');
 assert.match(cards[0].textContent,/Review complete/);assert.equal(t.nodes.get('subagent-count').textContent,'Ready');
 assert.equal(t.run('busy'),true);t.event({type:'done'});assert.equal(t.run('busy'),false);
});

test('subagent errors and approvals identify the child without clearing parent activity',()=>{
 const t=setup();t.run('setBusy(true)');t.event({type:'subagent_start',subagentId:'x',task:'Inspect files'});
 t.approval({id:'a',tool:'shell',args:{},subagent:true,subagentId:'x'});
 assert.equal(t.nodes.get('approval-title').textContent,'Subagent 1 needs approval');
 t.event({type:'subagent_done',subagentId:'x',error:'Provider unavailable'});
 const card=t.nodes.get('transcript').children.find(n=>n.className==='subagent-card');
 assert.equal(card['data-state'],'failed');assert.match(card.textContent,/Provider unavailable/);assert.equal(t.run('busy'),true);
});

test('project form validates names, keeps failures visible, and supports cancel',async()=>{
 let calls=0;const t=setup({createProject:async()=>{calls++;return {ok:false,error:'Please retry'};}});
 t.nodes.get('btn-create-project').click();assert.equal(t.nodes.get('project-create').hidden,false);
 const submit=()=>t.nodes.get('project-create').listeners.submit[0]({preventDefault(){}});
 await submit();assert.equal(calls,0);assert.match(t.nodes.get('project-create-error').textContent,/Enter a project name/);
 t.nodes.get('project-name').value='Design';await submit();assert.equal(calls,1);
 assert.equal(t.nodes.get('project-create').hidden,false);assert.equal(t.nodes.get('project-name').value,'Design');
 assert.equal(t.nodes.get('project-create-error').textContent,'Please retry');assert.equal(t.nodes.get('btn-project-create-save').disabled,false);
 t.nodes.get('btn-project-create-cancel').click();assert.equal(t.nodes.get('project-create').hidden,true);
 assert.equal(t.nodes.get('btn-create-project')['aria-expanded'],'false');
});

test('project form creates once while pending and opens the resulting project',async()=>{
 let release,calls=0,selected;const t=setup({createProject:name=>{calls++;assert.equal(name,'Design');return new Promise(resolve=>release=resolve);},
 selectProject:async id=>{selected=id;return {ok:true,name:'Design'};},getProjectScope:async()=>({ok:true,project:null,projectId:selected}),
 listProjects:async()=>[{id:'new',name:'Design'}]});
 t.nodes.get('btn-create-project').click();t.nodes.get('project-name').value=' Design ';
 const submit=()=>t.nodes.get('project-create').listeners.submit[0]({preventDefault(){}});
 const pending=submit();await submit();assert.equal(calls,1);assert.equal(t.nodes.get('btn-project-create-save').disabled,true);
 release({ok:true,record:{id:'new'}});await pending;
 assert.equal(selected,'new');assert.equal(t.nodes.get('project-create').hidden,true);assert.equal(t.nodes.get('project-name').value,'');
 assert.equal(t.nodes.get('btn-project-create-save').disabled,false);
});
test('failed load retains transcript; busy load never invokes backend',async()=>{let calls=0;const t=setup({loadSession:async()=>{calls++;return {ok:false,error:'missing'};}});t.run("addMsg('user','keep')");await t.run("loadSession({id:'x'})");assert.equal(t.run('transcriptMessages[0].text'),'keep');t.run('busy=true');await t.run("loadSession({id:'x'})");assert.equal(calls,1);});
test('load buffers synchronous replay and swaps transcript only on success',async()=>{let t;t=setup({loadSession:async()=>{t.event({type:'restored_user',text:'restored'});assert.equal(t.run('transcriptMessages[0].text'),'old');return {ok:true,title:'Saved'};}});t.run("addMsg('user','old')");await t.run("loadSession({id:'saved'})");assert.equal(t.run('transcriptMessages.length'),1);assert.equal(t.run('transcriptMessages[0].text'),'restored');assert.equal(t.run('activeSessionId'),'saved');});
test('failed approval response retains request and visible approval',async()=>{const t=setup({respondApproval:async()=>({ok:false,error:'retry'})});t.approval({id:'a',tool:'shell',args:{}});await t.run('answerApproval(true)');assert.equal(t.run('currentApproval.id'),'a');assert.equal(t.nodes.get('approval').classList.contains('active'),true);assert.equal(t.nodes.get('btn-deny').disabled,false);});

test('mode-change approval resolution clears matching card without finishing the turn',()=>{
 const t=setup();t.run('setBusy(true)');t.approval({id:'a',tool:'shell',args:{}});
 t.resolved({id:'a',decision:'allow',reason:'mode_changed'});
 assert.equal(t.run('currentApproval'),null);assert.equal(t.nodes.get('approval').classList.contains('active'),false);
 assert.equal(t.nodes.get('composer').style.display,'flex');assert.equal(t.run('busy'),true);
 assert.equal(t.nodes.get('send').disabled,true);assert.match(t.nodes.get('transcript').textContent,/approved by the current policy/);
 assert.doesNotMatch(t.nodes.get('transcript').textContent,/timed out|denied automatically/);
});

test('resolution for another approval leaves the visible request untouched',()=>{
 const t=setup();t.run('setBusy(true)');t.approval({id:'current',tool:'shell',args:{}});
 t.resolved({id:'older',decision:'deny',reason:'mode_changed'});
 assert.equal(t.run('currentApproval.id'),'current');assert.equal(t.nodes.get('approval').classList.contains('active'),true);assert.equal(t.run('busy'),true);
 t.resolved({id:'current',decision:'deny',reason:'mode_changed'});
 assert.equal(t.run('currentApproval'),null);assert.equal(t.run('busy'),true);
 assert.match(t.nodes.get('transcript').textContent,/blocked by the current policy/);
});

test('concurrent mode resolution suppresses stale approval-response errors',async()=>{
 let release;const t=setup({respondApproval:()=>new Promise(resolve=>{release=resolve;})});
 t.approval({id:'a',tool:'shell',args:{}});const response=t.run('answerApproval(true)');
 t.resolved({id:'a',decision:'allow',reason:'mode_changed'});release({ok:false,error:'stale approval'});await response;
 assert.equal(t.run('currentApproval'),null);assert.doesNotMatch(t.nodes.get('transcript').textContent,/stale approval/);
});

function modeHandler({failWrite=false,configFile}={}) {
 const main=fs.readFileSync(path.join(__dirname,'../../main/index.js'),'utf8');
 const match=main.match(/ipcMain\.handle\('sentinel:setMode', async \(e, mode\) => \{([\s\S]*?)\n\}\);/);
 assert.ok(match);const steps=[],messages=[],writes=[],pendingApprovals=new Map();
 const sentinel={setMode:mode=>{steps.push('mode:'+mode);return true;},decide:request=>({decision:request.decision})};
 const context={requireTrusted:()=>{},loadConfig:()=>({sentinel:{mode:'ask'},_configFile:configFile}),agent:{sentinel},pendingApprovals,
  require:()=>({writeSections:(_cfg,file)=>{steps.push('persist');writes.push(file);if(failWrite)throw Error('write failed');}}),ensureConfigFile:()=>'',send:(channel,payload)=>messages.push({channel,payload})};
 const handle=vm.runInNewContext(`(async(e,mode)=>{${match[1]}})`,context);
 return {handle,pendingApprovals,steps,messages,writes};
}

test('persisted mode changes release allowed and denied approvals while retaining asks',async()=>{
 const t=modeHandler();const answers=[];
 for(const decision of ['allow','deny','ask'])t.pendingApprovals.set(decision,{request:{decision},resolve:answer=>answers.push([decision,answer])});
 assert.equal((await t.handle({},'auto')).ok,true);
 assert.deepEqual(t.steps,['persist','mode:auto']);assert.deepEqual(answers,[['allow',true],['deny',false]]);
 assert.deepEqual([...t.pendingApprovals.keys()],['ask']);
 const resolved=t.messages.filter(message=>message.channel==='approval-resolved');
 assert.equal(resolved.length,2);assert.equal(resolved[0].payload.reason,'mode_changed');
});

test('failed mode persistence and invalid mode leave live permissions and approvals unchanged',async()=>{
 const t=modeHandler({failWrite:true});let settled=false;t.pendingApprovals.set('a',{request:{decision:'allow'},resolve:()=>{settled=true;}});
 await assert.rejects(()=>t.handle({},'auto'),/write failed/);assert.equal(settled,false);assert.deepEqual(t.steps,['persist']);assert.equal(t.pendingApprovals.size,1);
 const invalid=modeHandler();assert.equal((await invalid.handle({},'unknown')).ok,false);assert.deepEqual(invalid.steps,[]);
});

test('mode updates persist to the config actually loaded by this app',async()=>{
 const t=modeHandler({configFile:'fixture/selected-config.toml'});
 await t.handle({},'auto');assert.deepEqual(t.writes,['fixture/selected-config.toml']);
});

test('Auto status shows approval-free commands instead of the static Ask label',async()=>{
 const t=setup({getConfig:async()=>({llm:{model:'test'},sentinel:{mode:'auto'}})});
 await t.run('refreshStatus()');
 assert.equal(t.nodes.get('stat-permissions').textContent,'Auto');
 assert.match(t.nodes.get('mode-safety-note').textContent,/without approval prompts/);
 assert.doesNotMatch(t.nodes.get('mode-toggle').title,/shell still asks/);
});
test('memory health export and flags report errors without undefined sub',async()=>{const t=setup({memoryExport:async()=>({ok:false,error:'export fail'}),memoryFlags:async()=>({ok:false,error:'flag fail'})});t.run('renderHealth({}); renderFlagToggles({})');const rows=t.nodes.get('mem-rows');const flags=rows.children[0];await flags.children[1].listeners.click[0]();assert.equal(t.nodes.get('mem-status').textContent,'flag fail');const health=rows.children[1];const actions=health.children.at(-1);await actions.children[0].listeners.click[0]();assert.equal(t.nodes.get('mem-status').textContent,'export fail');});
test('command search and session-only preferences remain local',()=>{const t=setup();

t.nodes.get('palette-query').value='export';t.run('renderCommands()');assert.equal(t.nodes.get('palette-results').children.length,1);assert.match(t.nodes.get('palette-results').children[0].textContent,/Export/);assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB/);});
test('new session clears transcript and resets session state',async()=>{let resetCalls=0;const t=setup({send:async()=>{t.event({type:'message',text:'reply'});return {ok:true,text:'reply',turns:1};},reset:async()=>{resetCalls++;return {ok:true};},listSessions:async()=>[{id:'a',title:'old',turns:2}]});t.run("input.value='hi'; submit()");await new Promise(r=>setImmediate(r));assert.equal(t.run('transcriptMessages.length'),2);t.nodes.get('btn-new').click();await new Promise(r=>setImmediate(r));assert.equal(resetCalls,1);assert.equal(t.run('transcriptMessages.length'),0);assert.equal(t.run('activeSessionId'),null);});

test('new project session keeps root; leaving clears root and conversation',async()=>{
 let root='D:\\ChosenProject',resets=0;
 const t=setup({getProjectScope:async()=>({ok:true,project:root}),setProjectScope:async p=>{root=p;return {ok:true,project:p};},reset:async()=>{resets++;return {ok:true};}});
 await t.run('refreshProject()');assert.equal(t.nodes.get('btn-leave-project').hidden,false);
 t.run("addMsg('user','project message')");await t.run('newSession()');
 assert.equal(root,'D:\\ChosenProject');assert.equal(t.run('transcriptMessages.length'),0);
 t.run("addMsg('user','another project message')");await t.run('leaveProject()');
 assert.equal(root,null);assert.equal(resets,2);assert.equal(t.run('transcriptMessages.length'),0);assert.equal(t.nodes.get('btn-leave-project').hidden,true);
});
test('right panel can reopen from header after collapse',()=>{const t=setup();t.nodes.get('wb-close').click();assert.equal(t.nodes.get('workbench').classList.contains('collapsed'),true);assert.equal(t.nodes.get('btn-workbench-toggle')['aria-expanded'],'false');t.nodes.get('btn-workbench-toggle').click();assert.equal(t.nodes.get('workbench').classList.contains('collapsed'),false);assert.equal(t.nodes.get('btn-workbench-toggle')['aria-expanded'],'true');});

test('execution card pairs call and result into one row with status and duration',async()=>{
 const t=setup();
 t.event({type:'tool_call',id:'c1',name:'shell',args:{cmd:'ls'}});
 t.event({type:'tool_result',id:'c1',name:'shell',result:{ok:true,stdout:'x'}});
 const transcript=t.nodes.get('transcript');
 const cards=transcript.children.filter(n=>String(n.className||'').includes('tool-row'));
 assert.equal(cards.length,1,'call and result must merge into one card');
 const dot=cards[0].descendants().find(n=>String(n.className||'').includes('tr-dot'));
 assert.ok(dot,'card has a status dot');
 assert.ok([...dot.classes].includes('ok'),'dot shows ok');
 const dur=cards[0].descendants().find(n=>String(n.className||'').includes('tr-dur'));
 assert.match(dur.textContent,/s$/,'duration text present');
 assert.equal(t.run('openCards.size'),0,'pairing map drained');
});

test('command cards unwrap output, preserve literal text, and keep user expansion on completion',()=>{
 const t=setup();const command='powershell.exe -Command "Write-Output fixture"';
 t.event({type:'tool_call',id:'literal',name:'shell',args:{command,timeout_s:60}});
 const card=t.nodes.get('transcript').children.find(n=>String(n.className).includes('activity-card'));
 assert.match(card.textContent,/Run command/);assert.match(card.textContent,/PowerShell/);
 const details=card.children[0];details.open=false;
 t.event({type:'tool_result',id:'literal',name:'shell',result:{ok:true,output:'<script>fixture</script>\nactual output'}});
 assert.equal(details.open,false,'Result respects the user collapsing the card');
 const output=card.descendants().find(n=>n.className==='activity-output');
 assert.match(output.textContent,/<script>fixture<\/script>\nactual output/);
 assert.doesNotMatch(output.textContent,/"ok"|"output"/);assert.equal(card['data-state'],'completed');
 assert.equal(output.descendants().filter(n=>n.tagName==='script').length,0);
});

test('failed tool cards retain a visible failure label and never call it a permission denial',()=>{
 const t=setup();t.event({type:'tool_call',id:'failed',name:'shell',args:{command:'test'}});
 t.event({type:'tool_result',id:'failed',name:'shell',result:{ok:false,output:'Process exited with error'}});
 const card=t.nodes.get('transcript').children.find(n=>String(n.className).includes('activity-card'));
 assert.equal(card['data-state'],'failed');assert.match(card.textContent,/Failed/);assert.match(card.textContent,/Process exited with error/);
 assert.equal(card.classList.contains('denied'),false);
});

test('large command output expands fully and copy retains the complete output',async()=>{
 let copied;const t=setup();t.c.navigator.clipboard.writeText=async text=>{copied=text;};const output='x'.repeat(15000)+' tail';
 t.event({type:'tool_result',name:'shell',result:{ok:true,output}});
 const card=t.nodes.get('transcript').children.find(n=>String(n.className).includes('activity-card'));
 const pre=card.descendants().find(n=>n.className==='activity-code');assert.equal(pre.textContent.length,12000);
 const copy=card.descendants().find(n=>n.className==='activity-copy');await copy.listeners.click[0]();assert.equal(copied,output);
 card.descendants().find(n=>n.className==='activity-expand').click();assert.equal(pre.textContent,output);
});

test('permission panel separates exact command from raw request and retains one-time decisions',async()=>{
 let decision;const t=setup({respondApproval:async(id,allow)=>{decision={id,allow};return {ok:true};}});
 const command='powershell.exe -Command "Write-Output fixture"';t.approval({id:'once',tool:'shell',args:{command,timeout_s:60}});
 assert.equal(t.nodes.get('approval-action').textContent,'Run command');assert.equal(t.nodes.get('approval-args').textContent,command);
 assert.equal(JSON.parse(t.nodes.get('approval-raw').textContent).timeout_s,60);
 assert.equal(t.run('document.activeElement.id'),'btn-deny');await t.run('answerApproval(true)');
 assert.deepEqual(decision,{id:'once',allow:true});assert.equal(t.run('currentApproval'),null);
});
test('denied result renders denied card with reason',()=>{
 const t=setup();
 t.event({type:'tool_result',id:'c9',name:'shell',denied:true,reason:'policy'});
 const transcript=t.nodes.get('transcript');
 const card=transcript.children.find(n=>String(n.className||'').includes('tool-row'));
 assert.ok(card,'denied card rendered');
 assert.ok(String(card.className).includes('denied')||[...card.classes].includes('denied'),'card flagged denied');
 assert.match(card.textContent,/denied/,'reason text present');
});
