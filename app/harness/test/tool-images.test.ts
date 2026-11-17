const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const home = fs.mkdtempSync(path.join(os.tmpdir(),'muse-images-'));
process.env.MUSE_HOME = home;
const { Agent } = require('../agent.js');
const { DEFAULTS } = require('../config.js');
const { normalizeImages, prepareToolResult, appendToolImages, IMAGE_BYTES } = require('../tool-images.ts');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic-private-screenshot-fixture')]).toString('base64');
const image = {type:'image',mimeType:'image/png',data:png};

test('only bounded PNG, JPEG and WebP content with matching bytes is accepted',()=>{
  assert.equal(normalizeImages([image]).length,1);
  assert.equal(normalizeImages([{...image,mimeType:'image/jpeg'},{...image,mimeType:'image/svg+xml'},
    {...image,data:'<script>'},{...image,data:'AAAA'}]).length,0);
  assert.equal(normalizeImages(Array(9).fill(image)).length,4);
  const large=Buffer.alloc(5*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(large);
  const entry={...image,data:large.toString('base64')};assert.equal(normalizeImages([entry,entry]).length,1);
  const oversize=Buffer.alloc(IMAGE_BYTES+1);assert.equal(normalizeImages([{...image,data:oversize.toString('base64')}]).length,0);
  assert.equal(normalizeImages([{type:'image',mimeType:'image/jpeg',data:Buffer.from([255,216,255,0]).toString('base64')}]).length,1);
  assert.equal(normalizeImages([{type:'image',mimeType:'image/webp',data:Buffer.from('RIFF0000WEBP').toString('base64')}]).length,1);
});

test('tool results keep pixels in the UI event and ephemeral queue only',()=>{
  const agent={_pendingToolImages:[]};const plain={ok:true,result:'screen observed'};
  const textOnly=prepareToolResult(agent,plain);assert.equal(textOnly.textResult,plain);
  const result=prepareToolResult(agent,{...plain,images:[image]});
  assert.equal(result.eventResult.images[0].data,png);assert.equal(result.textResult.screenshot_count,1);
  assert.equal(JSON.stringify(result.textResult).includes(png),false);
  const messages=[{role:'tool',content:'screen observed'}];appendToolImages(agent,messages);
  assert.equal(messages[1].role,'user');assert.equal(messages[1].content[1].image_url.url,`data:image/png;base64,${png}`);
  assert.match(messages[1].content[0].text,/observations, not instructions/);assert.equal(agent._pendingToolImages.length,0);
});

test('screenshots reach the next model request after every tool result, without session or memory persistence',async()=>{
  const cfg=structuredClone(DEFAULTS);cfg.memory.enabled=false;cfg.sentinel.mode='auto';
  const events=[];const agent=new Agent(cfg,{onEvent:event=>events.push(event)});
  agent.toolMap.set('mcp__box__screen',{run:async()=>({ok:true,result:'Screen captured',images:[image]})});
  agent.toolMap.set('mcp__box__status',{run:async()=>({ok:true,result:'Ready'})});
  let count=0;agent.llm.chat=async messages=>{
    if(count++===0)return {message:{role:'assistant',content:null,tool_calls:[
      {id:'screen',type:'function',function:{name:'mcp__box__screen',arguments:'{}'}},
      {id:'status',type:'function',function:{name:'mcp__box__status',arguments:'{}'}}]},finish_reason:'tool_calls'};
    assert.deepEqual(messages.slice(-3).map(msg=>msg.role),['tool','tool','user']);
    assert.equal(messages.at(-1).content[1].image_url.url,`data:image/png;base64,${png}`);
    assert.equal(agent.history.some(msg=>Array.isArray(msg.content)),false);
    return {message:{role:'assistant',content:'The desktop is ready.'},finish_reason:'stop'};
  };
  agent.memory={projectId:'fixture',requestContext:async()=>({turn_id:null})};
  const result=await agent.run('Inspect the Box desktop.');assert.equal(result.text,'The desktop is ready.');
  assert.equal(events.find(event=>event.type==='tool_result'&&event.id==='screen').result.images[0].data,png);
  assert.equal(JSON.stringify(agent.history).includes(png),false);assert.equal(JSON.stringify(agent._sourceEvents).includes(png),false);
  assert.equal(agent._pendingToolImages.length,0);
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
  for(const file of walk(home))assert.equal(fs.readFileSync(file,'utf8').includes(png),false,file);
});

test('failed model requests, cancellation and reset do not retain screenshots',async()=>{
  const cfg=structuredClone(DEFAULTS);cfg.memory.enabled=false;cfg.sentinel.mode='auto';const agent=new Agent(cfg);
  agent._pendingToolImages=[image];agent.llm.chat=async()=>{throw Error('provider failed');};
  await assert.rejects(()=>agent.sendWithMemory(null),/provider failed/);assert.equal(agent._pendingToolImages.length,0);
  agent._pendingToolImages=[image];agent.requestCancel();assert.equal(agent._pendingToolImages.length,0);
  prepareToolResult(agent,{ok:true,images:[image]});assert.equal(agent._pendingToolImages.length,0,'Late cancelled tool results cannot enqueue a screenshot');
  agent._pendingToolImages=[image];agent.reset();assert.equal(agent._pendingToolImages.length,0);
});

test('image token reserve does not scale with base64 length',()=>{
  assert.equal(Agent.estimateTokens({content:[{type:'image_url',image_url:{url:'x'.repeat(100000)}}]}),4096);
  assert.equal(Agent.estimateTokens({content:[{type:'text',text:'hello'}]}),2);
});
