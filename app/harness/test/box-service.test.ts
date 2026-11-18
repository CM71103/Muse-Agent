const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBoxService}=require('../../main/box-service.ts');
const registry=require('../mcp').registry;
function fixture(options:any={}) {
  const handlers:any={},events:any[]=[],clients:any[]=[];let enabled=false,records:any={},refreshes=0;
  const hooks:any={ipcMain:{handle:(name:string,handler:any)=>handlers[name]=handler},requireTrusted:()=>{},
    vault:()=>({read:()=>({...records}),write:(next:any)=>{records=next;}}),enabled:()=>enabled,setEnabled:(next:boolean)=>{enabled=next;},
    busy:()=>!!options.busy,refreshTools:()=>{refreshes++;},emit:(value:any)=>events.push(value),openExternal:async()=>{},
    createClient:(callbacks:any)=>{const client:any={name:'box',dead:true,tools:[{name:'shell',inputSchema:{type:'object'}}],callbacks,
      connect:async()=>{callbacks.onStatus({state:'awaiting_authorization',tokens:'must-not-leak'});if(options.wait)await options.wait;client.dead=false;},
      disconnect:async()=>{await callbacks.saveAuth(undefined);client.dead=true;},cancelAuth:()=>{},close:()=>{client.dead=true;}};clients.push(client);return client;}};
  const service=createBoxService(hooks);
  return {service,handlers,events,clients,records:()=>records,refreshes:()=>refreshes};
}
test('Box IPC exposes status only and registers discovered tools without local-server restarts',async(t:any)=>{
 const f=fixture();t.after(()=>f.service.close());
 assert.equal(f.events.length,0);await f.service.connect();assert.equal(registry.get('box'),f.clients[0]);
 assert.equal(f.service.getStatus().state,'connected');assert.ok(f.refreshes()>0);
 assert.doesNotMatch(JSON.stringify(f.events),/must-not-leak|tokens/);
 await f.clients[0].callbacks.saveAuth({tokens:{access_token:'fixture-secret'}});
 assert.equal(f.records().box.tokens.access_token,'fixture-secret');
 await f.service.disconnect();assert.equal(registry.get('box'),undefined);assert.equal(f.records().box,undefined);
});
test('cancelling pending auth rejects late callbacks and late tool registration',async(t:any)=>{
 let finish:any;const wait=new Promise(resolve=>finish=resolve);const f=fixture({wait});t.after(()=>f.service.close());
 const pending=f.service.connect();f.service.cancel();f.clients[0].callbacks.onStatus({state:'connected',toolCount:99});
 finish();await pending;assert.equal(f.service.getStatus().state,'disconnected');assert.equal(registry.get('box'),undefined);
});
test('busy work and colliding local Box server names block connection changes',async(t:any)=>{
 const f=fixture({busy:true});t.after(()=>f.service.close());assert.equal((await f.service.connect()).ok,false);assert.equal(f.clients.length,0);
 const g=fixture();t.after(()=>g.service.close());registry.add({name:'box',tools:[],close(){}});
 t.after(()=>registry.clear());assert.equal((await g.service.connect()).ok,false);assert.equal(g.clients.length,0);
});

test('registered Box tools are available without stdio servers and respect Ask, Auto and deny rules',async(t:any)=>{
 const {Agent}=require('../agent');const {deepMerge,DEFAULTS}=require('../config');let calls=0;
 registry.addExternal({name:'box',remote:true,tools:[{name:'shell',description:'Cloud shell',inputSchema:{type:'object'}}],
 call:async()=>{calls++;return {content:[{type:'text',text:'fixture result'}]};}});
 t.after(()=>registry.removeExternal('box'));
 const run=(mode:string,deny_rules:string[]=[])=>{
  const a=new Agent(deepMerge(DEFAULTS,{sentinel:{mode,deny_rules}}),{approver:async()=>false});
  assert.ok(a.toolMap.has('mcp__box__shell'));
  return a.executeToolCall({id:'box-test',name:'mcp__box__shell',arguments:'{}'});
 };
 await run('ask');assert.equal(calls,0);assert.match(await run('auto'),/fixture result/);assert.equal(calls,1);
 await run('auto',['*mcp__box__shell*']);assert.equal(calls,1);
});
