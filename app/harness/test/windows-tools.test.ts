const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Sentinel}=require('../sentinel.js');
const {configureWindowsDesktop,mkWindowsTools}=require('../windows-tools.ts');
const {createWindowsService}=require('../../main/windows-service.ts');
test.after(()=>configureWindowsDesktop(null));
test('desktop permissions respect Auto, Ask, Plan and explicit denials',()=>{
  const sentinel=new Sentinel({sentinel:{mode:'ask'}});
  for(const tool of ['windows_screenshot','windows_click','windows_type','windows_key','windows_scroll']){
    sentinel.setMode('ask');assert.equal(sentinel.decide({tool}).decision,'ask');
    sentinel.setMode('auto');assert.equal(sentinel.decide({tool}).decision,'allow');
    sentinel.setMode('plan');assert.equal(sentinel.decide({tool}).decision,tool==='windows_screenshot'?'allow':'deny');
  }
  sentinel.denyRules=['windows_*'];sentinel.setMode('auto');
  assert.equal(sentinel.decide({tool:'windows_screenshot'}).decision,'deny');
  assert.equal(sentinel.decide({tool:'windows_select'}).decision,'deny');
});
test('Windows tool bridge forwards cancellation, requires image revision and marks private observations',async()=>{
  const calls=[],reads=[];let signal;
  configureWindowsDesktop({execute:async(...args)=>{calls.push(args);return {ok:true};}});
  const tools=mkWindowsTools(),ctx={agent:{_beginAbort:()=>{const ac=new AbortController();signal=ac.signal;return ac;},_endAbort:()=>{}},onPrivateRead:value=>reads.push(value)};
  await assert.rejects(()=>tools.find(t=>t.name==='windows_click').run({x:4,y:5},ctx),/revision/);
  await tools.find(t=>t.name==='windows_screenshot').run({},ctx);
  assert.equal(calls[0][0],'screenshot');assert.equal(calls[0][2],signal);assert.equal(reads.length,1);
  const child=await tools[0].run({},{agent:{isSubagent:true}});assert.equal(child.ok,false);
});
test('desktop IPC trusts only Muse and allows revocation while busy',async()=>{
  const handlers=new Map();let busy=true,released=0;
  const desktop={list:async()=>({windows:[]}),status:()=>({state:'unselected'}),select:async id=>({selected:id}),release:()=>({released:++released})};
  createWindowsService({desktop,ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},busy:()=>busy,requireTrusted:e=>{if(!e.trusted)throw Error('untrusted');}});
  assert.throws(()=>handlers.get('windows:status')({}),/untrusted/);
  assert.equal((await handlers.get('windows:select')({trusted:true},'1')).ok,false);
  assert.equal(handlers.get('windows:release')({trusted:true}).released,1);
  busy=false;assert.equal((await handlers.get('windows:select')({trusted:true},{})).ok,false);
  assert.equal((await handlers.get('windows:select')({trusted:true},'1')).selected,'1');
});

test('choosing a Windows target switches the active tool scope out of Ubuntu first',async()=>{
  const handlers=new Map(),order:any[]=[];
  const desktop={list:async()=>({windows:[]}),status:()=>({state:'unselected'}),select:async id=>{order.push('select:'+id);return {state:'selected',selected:id};},release:()=>({state:'unselected'})};
  createWindowsService({desktop,ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},busy:()=>false,requireTrusted:()=>{},useHost:async()=>{order.push('host');}});
  const result=await handlers.get('windows:select')({trusted:true},'chrome-window');
  assert.equal(result.selected,'chrome-window');assert.deepEqual(order,['select:chrome-window','host']);
});
