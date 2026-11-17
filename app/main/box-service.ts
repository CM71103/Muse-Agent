type Hooks = { ipcMain: any; requireTrusted: (e: any) => void; vault: () => any;
  enabled: () => boolean; setEnabled: (value: boolean) => void; busy: () => boolean;
  refreshTools: () => void; emit: (status: any) => void; openExternal: (url: string) => Promise<any>; createClient?: (options: any) => any };
function createBoxService(hooks: Hooks) {
  const registry = require('../harness/mcp').registry;
  let client: any = null, pending: Promise<any> | null = null, generation = 0;
  let status: any = { state:'disconnected', tools:0 };
  function publish(next: any) {
    const state = next.state === 'awaiting_authorization' ? 'authorizing' : next.state;
    status = { state, tools: Number(next.toolCount || next.tools || 0),
      ...(state === 'error' ? {error:'Box could not connect. Please try signing in again.'} : {}) };
    hooks.emit(status);
    if(state==='error') {registry.removeExternal('box');hooks.refreshTools();}
  }
  function getClient() {
    if (client) return client;
    const createdAt = generation;
    const options = {
      loadAuth: () => hooks.vault().read().box,
      saveAuth: (record: any) => { if(createdAt!==generation)return;const vault=hooks.vault(), values=vault.read(); if(record)values.box=record;else delete values.box;vault.write(values); },
      onAuthorize: async (url: string) => {
        const target = new URL(url);
        if (target.protocol !== 'https:' || !['box.simular.ai','mcp.box.simular.ai'].includes(target.hostname)) throw Error('Unexpected Box sign-in URL');
        await hooks.openExternal(target.href);
      },
      onStatus: (next: any)=>{if(createdAt===generation)publish(next);},
    };
    client = hooks.createClient ? hooks.createClient(options) : new (require('../harness/box-client.ts').BoxClient)(options);
    client.remote = true;
    return client;
  }
  function connect(interactive = true) {
    if (pending) return pending;
    if (status.state==='connected' && client && !client.dead) return Promise.resolve({ok:true,...status});
    if (hooks.busy()) return Promise.resolve({ok:false,error:'Wait for the current task or approval before connecting Box.'});
    if (registry._clients.has('box')) return Promise.resolve({ok:false,error:'A local MCP server already uses the name box. Rename it before connecting Box.'});
    const current = ++generation;
    client?.close();client=null;
    pending = (async()=>{
      try {
        if (interactive) hooks.setEnabled(true);
        await getClient().connect({interactive,timeoutMs:interactive?180000:20000});
        if (current !== generation) return {ok:false,error:'Box connection was cancelled.'};
        registry.addExternal(client);hooks.refreshTools();publish({state:'connected',tools:client.tools.length});
        return {ok:true,...status};
      } catch {
        if (current === generation) {client?.close();client=null;registry.removeExternal('box');hooks.refreshTools();publish({state:interactive?'error':'auth_required'});}
        return {ok:false,error:interactive?'Box connection was not completed. Try Connect again.':'Sign in to reconnect Box.'};
      } finally { if(current===generation)pending=null; }
    })();
    return pending;
  }
  async function disconnect() {
    if (hooks.busy()) return {ok:false,error:'Stop the current task before disconnecting Box.'};
    ++generation;pending=null;
    const oldClient=client;client=null;
    try {if(oldClient) {oldClient.cancelAuth();await oldClient.disconnect({forget:true});}}
    finally {const vault=hooks.vault(),values=vault.read();delete values.box;vault.write(values);registry.removeExternal('box');hooks.setEnabled(false);hooks.refreshTools();publish({state:'disconnected'});}
    return {ok:true};
  }
  function cancel() {if(!pending)return {ok:true};++generation;pending=null;client?.cancelAuth();client?.close();client=null;registry.removeExternal('box');hooks.refreshTools();publish({state:'disconnected'});return {ok:true};}
  for (const [channel, handler] of Object.entries({
    'box:status':()=>({...status}), 'box:connect':()=>connect(), 'box:disconnect':disconnect,
    'box:cancel':cancel, 'box:desktop':async()=>{await hooks.openExternal('https://box.simular.ai/box');return {ok:true};},
  })) hooks.ipcMain.handle(channel,async(e: any)=>{hooks.requireTrusted(e);try{return await handler();}catch{return {ok:false,error:'Box request failed. Please try again.'};}});
  return {
    restore: async()=>{if(hooks.enabled())await connect(false);},
    close:()=>{++generation;client?.cancelAuth();client?.close();registry.removeExternal('box');},
    connect,disconnect,cancel,getStatus:()=>({...status}),
  };
}
module.exports = {createBoxService};
