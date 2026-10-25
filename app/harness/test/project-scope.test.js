'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Agent,systemPrompt}=require('../agent');
const {DEFAULTS}=require('../config');
test('selected root drives prompt, relative reads, default listing and survives reset',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'muse-project-'));
 try {
  fs.writeFileSync(path.join(root,'selected.txt'),'SELECTED PROJECT');
  const a=new Agent(structuredClone(DEFAULTS),{approver:async()=>{throw Error('unexpected approval for granted project');}});
  a.setProjectScope(root);
  assert.ok(systemPrompt(a.cfg,'',a.cwdOverride).includes(`Working directory: ${root}.`));
  const call=(name,args)=>a.executeToolCall({id:'p1',function:{name,arguments:JSON.stringify(args)}}).then(JSON.parse);
  const listing=await call('list_dir',{});assert.equal(listing.path,root);assert.ok(listing.entries.some(x=>x.name==='selected.txt'));
  const read=await call('read_file',{path:'selected.txt'});assert.equal(read.content,'SELECTED PROJECT');
  a.history.push({role:'user',content:'old project chat'});const old=a.sessionId;
  a.reset();assert.notEqual(a.sessionId,old);assert.equal(a.history.length,0);assert.equal(a.cwdOverride,root);
  assert.equal((await call('list_dir',{})).path,root);
  a.setProjectScope(null);assert.equal(a.cwdOverride,null);assert.equal(a.sentinel.grants.length,0);
  assert.match(systemPrompt(a.cfg,'',a.cwdOverride),/No project selected/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
