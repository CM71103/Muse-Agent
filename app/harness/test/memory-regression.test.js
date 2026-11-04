'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');const os=require('os');const path=require('path');const {spawnSync}=require('child_process');
const {MemoryLayer}=require('../../memory/layer');const {openStore}=require('../../memory/adapters/store');
const {Agent}=require('../agent');const {DEFAULTS,deepMerge}=require('../config');
function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'muse-reg-'));let current;
 t.after(()=>{if(current)current.close();fs.rmSync(dir,{recursive:true,force:true});});
 const cfg=deepMerge(DEFAULTS,{memory:{enabled:true,project_id_strategy:'manual',project_id:'personal',embed_dims:2,embed_model:'test'},llm:{max_tokens:100}});
 const embed=async(c,texts)=>({model:'test',vectors:texts.map(()=>({vector:[1,0]}))});
 return {dir,cfg,open(id='personal'){current=new MemoryLayer(cfg,{dataDir:dir,projectId:id,embed});return current;},close(){current.close();current=null;}};
}
test('two fresh host sessions recall persisted user event after reopen; exact acknowledgement and baseline grades',async t=>{
 const x=setup(t);let m=x.open();const a=new Agent(x.cfg);a.attachMemory(m);
 a.llm.chat=async()=>({message:{content:'stored'},usage:{total_tokens:1},finish_reason:'stop'});
 await a.run('My cat is named Mango.');await a.ingestUserTurn('My cat is named Mango.');
 const firstTask=m.taskId;x.close();m=x.open();const b=new Agent(x.cfg);b.attachMemory(m);assert.notEqual(firstTask,m.taskId);
 let sent;b.llm.chat=async(messages)=>{sent=messages;return {message:{content:'Mango [c1]'},usage:{total_tokens:2},finish_reason:'stop'};};
 const r=await b.run('What is my cat named?');assert.match(Agent.memorySectionOf(sent),/Mango/);
 const turn=m.store.getTurn(r.memory_turn_id);assert.equal(turn.state,'completed');assert.deepEqual(turn.citation_map,{'1':turn.sent_ids[0]});
 assert.deepEqual(m.parseCitations('Mango [c1]',r.memory_turn_id).citedIds,turn.sent_ids);
 assert.equal(m.grade(r.memory_turn_id,1).applied,false);assert.equal(m.grade(r.memory_turn_id,0).reason,'already_graded');
 assert.deepEqual(m.store.getMemory(turn.sent_ids[0]).evidence,{});assert.equal(b.memorySection(),'');
 assert.equal(sent[0].role,'system');assert.equal(sent.filter(m=>m.role==='system').length,1);
});
test('scope isolation, per-scope idempotency, no auto fallback',async t=>{
 const x=setup(t);let m=x.open();await m.ingest([{source_event_id:'same',text:'personal',provenance:'user'}]);x.close();
 m=x.open('work');await m.ingest([{source_event_id:'same',text:'work',provenance:'user'}]);assert.equal(m.listMemories().length,1);assert.equal(m.listMemories()[0].text,'work');x.close();
 // force git detection failure even when a parent directory is itself a repo
 const prevGitDir=process.env.GIT_DIR;process.env.GIT_DIR='Z:/definitely-not-a-git-dir';
 try {
  assert.throws(()=>new MemoryLayer({...x.cfg,memory:{...x.cfg.memory,project_id_strategy:'auto'}},{dataDir:x.dir,cwd:x.dir}),/MEMORY_SCOPE_REQUIRED/);
 } finally {
  if (prevGitDir===undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR=prevGitDir;
 }
 m=x.open();assert.equal(m.listMemories()[0].text,'personal');
});
test('single owner refused same process and second process; reopen releases owner',t=>{
 const x=setup(t);x.open();assert.throws(()=>openStore(x.dir),/owned/);
 const child=spawnSync(process.execPath,['-e',`try {require(${JSON.stringify(require.resolve('../../memory/adapters/store'))}).openStore(process.argv[1]);process.exit(2)}catch(e){console.log(e.message)}`,x.dir],{encoding:'utf8',timeout:5000});
 assert.equal(child.status,0);assert.match(child.stdout,/owned/);x.close();x.open();
});
test('JSON migration preserves scopes and registry; unfinished turns recover unknown',t=>{
 const x=setup(t);fs.writeFileSync(path.join(x.dir,'memory.json'),JSON.stringify({schema_version:1,memories:{a:{id:'a',project_id:'p',text:'one'},b:{id:'b',project_id:'q',text:'two'}},projects:{root:'p'},turns:{z:{id:'z',state:'sent'}}}));
 let m=x.open('p');assert.equal(m.listMemories()[0].text,'one');assert.equal(m.store.getTurn('z').state,'unknown');assert.equal(m.store.registerProject('root'),'p');x.close();m=x.open('q');assert.equal(m.listMemories()[0].text,'two');assert.ok(fs.existsSync(path.join(x.dir,'memory.json')));
});
test('pre-send deletion refused, unknown acknowledgement refused, restart prepared unknown',async t=>{
 const x=setup(t);let m=x.open();await m.ingest([{source_event_id:'a',text:'fact',provenance:'user'}]);await m.embedPending();let c=await m.requestContext('q');
 m.deleteMemory(c.packed_ids[0]);assert.throws(()=>m.commitPrepared(c),/REPACK/);
 await m.ingest([{source_event_id:'b',text:'next',provenance:'user'}]);await m.embedPending();c=await m.requestContext('q');m.commitPrepared(c);
 assert.throws(()=>m.acknowledgeSent(c.turn_id,null,null,null),/unknown/);assert.equal(m.grade(c.turn_id,1).ok,false);
 c=await m.requestContext('q');m.commitPrepared(c);x.close();m=x.open();assert.equal(m.store.getTurn(c.turn_id).state,'unknown');
});
test('embedding failure visible and leaves pending rows durable',async t=>{
 const x=setup(t);const m=x.open();await m.ingest([{source_event_id:'a',text:'fact',provenance:'user'}]);m.embed=async()=>{throw new Error('offline fixture')};
 await assert.rejects(()=>m.embedPending(),/offline fixture/);assert.match(m.lastError,/offline fixture/);assert.equal(m.listMemories()[0].status,'pending_embed');
});
test('future schema refused without destroying database',t=>{
 const x=setup(t);x.open();x.close();const D=require('better-sqlite3');const d=new D(path.join(x.dir,'agent.db'));d.pragma('user_version=999');d.close();assert.throws(()=>x.open(),/newer/);
});
test('credential vault encrypts and refuses insecure backend; config writer excludes keys',t=>{
 const x=setup(t);const {vault}=require('../credentials');const {writeSections}=require('../configWrite');
 const insecure=vault({isEncryptionAvailable:()=>false},x.dir);assert.throws(()=>insecure.write({llm:'fixture-secret'}),/unavailable/);
 const safe={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).reverse(),decryptString:b=>Buffer.from(b).reverse().toString()};
 const v=vault(safe,x.dir);v.write({llm:'fixture-secret'});assert.equal(v.read().llm,'fixture-secret');assert.equal(fs.readFileSync(path.join(x.dir,'credentials.enc'),'utf8').includes('fixture-secret'),false);
 const file=path.join(x.dir,'config.toml');writeSections(deepMerge(x.cfg,{llm:{api_key:'fixture-secret'},memory:{embed_api_key:'fixture-secret'}}),file);assert.equal(fs.readFileSync(file,'utf8').includes('fixture-secret'),false);
});
// 429 regression: ingestToolResult used to call embedPending() per tool result,
// so a 40-turn tool loop made ~40 HTTP requests to the embeddings endpoint and
// providers rate-limited. Rows must queue and flush in ONE batched call.
test('tool ingest queues without embedding; one flush drains all rows',async t=>{
 const x=setup(t);const m=x.open();const a=new Agent(x.cfg);a.attachMemory(m);
 let embedCalls=0,textsPerCall=[];
 m.embed=async(_c,texts)=>{embedCalls++;textsPerCall.push(texts.length);return {model:'test',vectors:texts.map(()=>({vector:[1,0]}))};};
 for(let i=0;i<12;i++) await a.ingestToolResult('write_file',`result ${i}`,`call-${i}`);
 assert.equal(embedCalls,0,'tool ingest must not hit the network');
 assert.equal(m.listMemories().filter(r=>r.status==='pending_embed').length,12);
 // the single per-turn flush drains every queued row in one batched request
 await a.ingestUserTurn('a user message');
 assert.equal(embedCalls,1);
 assert.deepEqual(textsPerCall,[13],'all rows in ONE request, not one per row');
 assert.equal(m.listMemories().filter(r=>r.status==='pending_embed').length,0);
});
// A deferred flush that fails must not abort retrieval: rows stay durable and
// requestContext still embeds the query rather than throwing out of the turn.
test('requestContext survives a failed pending flush',async t=>{
 const x=setup(t);const m=x.open();
 await m.ingest([{source_event_id:'a',text:'fact one',provenance:'user'}]);
 assert.equal(m.listMemories()[0].status,'pending_embed');
 m.embed=async()=>{throw new Error('429 quota')};
 const c=await m.requestContext('a query',{contextLimit:100000,otherInputTokens:0,outputReserve:1000});
 assert.equal(c.payload,'','degrades to empty context, never throws');
 assert.equal(c.turn_id,null);
 assert.match(String(c.clamp_reason||''),/embed_failed/);
 assert.match(m.lastError,/429 quota/);
 assert.equal(m.listMemories()[0].status,'pending_embed','row survives for a later turn');
 // once the endpoint recovers, the still-pending row flushes normally
 m.embed=async(_c,texts)=>({model:'test',vectors:texts.map(()=>({vector:[1,0]}))});
 assert.equal((await m.embedPending()).embedded,1);
 assert.equal(m.listMemories()[0].status,'active');
});
