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
  let event, approval;const muse={onAgentEvent:cb=>event=cb,onApprovalRequest:cb=>approval=cb,onSessionReset:()=>{},onQuestion:()=>()=>{},onApprovalExpired:()=>()=>{},cancel:async()=>({ok:true}),answerQuestion:async()=>({ok:true}),getConfig:async()=>({llm:{model:'test'},hands:{enabled:false},sentinel:{mode:'ask'}}),memoryStatus:async()=>({enabled:false}),listSessions:async()=>[],reset:async()=>({ok:true}),...overrides};
  const window={muse,addEventListener:()=>{},confirm:()=>true};
  const c=vm.createContext({document,window,console,setTimeout:()=>{},navigator:{clipboard:{writeText:async()=>{}}},Blob,URL});
  // Match real HTML script order: shared global scope must not redeclare names.
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/i18n.js'),'utf8'),c);
  vm.runInContext(source,c);
  return {c,muse,nodes,event:ev=>event(ev),approval:req=>approval(req),run:s=>vm.runInContext(s,c)};
}
test('send rejection clears busy, thinking and disabled controls',async()=>{const t=setup({send:async()=>{throw Error('offline');}});await t.run("input.value='hello'; submit()");assert.equal(t.run('busy'),false);assert.equal(t.run('thinkingEl'),null);assert.equal(t.nodes.get('send').disabled,false);assert.equal(t.run('transcriptMessages[0].text'),'hello');});
test('failed load retains transcript; busy load never invokes backend',async()=>{let calls=0;const t=setup({loadSession:async()=>{calls++;return {ok:false,error:'missing'};}});t.run("addMsg('user','keep')");await t.run("loadSession({id:'x'})");assert.equal(t.run('transcriptMessages[0].text'),'keep');t.run('busy=true');await t.run("loadSession({id:'x'})");assert.equal(calls,1);});
test('load buffers synchronous replay and swaps transcript only on success',async()=>{let t;t=setup({loadSession:async()=>{t.event({type:'restored_user',text:'restored'});assert.equal(t.run('transcriptMessages[0].text'),'old');return {ok:true,title:'Saved'};}});t.run("addMsg('user','old')");await t.run("loadSession({id:'saved'})");assert.equal(t.run('transcriptMessages.length'),1);assert.equal(t.run('transcriptMessages[0].text'),'restored');assert.equal(t.run('activeSessionId'),'saved');});
test('failed approval response retains request and visible approval',async()=>{const t=setup({respondApproval:async()=>({ok:false,error:'retry'})});t.approval({id:'a',tool:'shell',args:{}});await t.run('answerApproval(true)');assert.equal(t.run('currentApproval.id'),'a');assert.equal(t.nodes.get('approval').classList.contains('active'),true);assert.equal(t.nodes.get('btn-deny').disabled,false);});
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
