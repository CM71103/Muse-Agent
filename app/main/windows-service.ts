'use strict';
function createWindowsService(hooks: any) {
  const desktop = hooks.desktop || require('./windows-desktop.ts').createWindowsDesktop({blockedPids:()=>[process.pid]});
  require('../harness/windows-tools.ts').configureWindowsDesktop(desktop);
  const respond = async (fn: any) => {
    try { return await fn(); } catch(error: any) {return {ok:false,error:String(error.message||error)};}
  };
  hooks.ipcMain.handle('windows:list', async (e: any)=>{hooks.requireTrusted(e);return respond(()=>desktop.list());});
  hooks.ipcMain.handle('windows:status', (e: any)=>{hooks.requireTrusted(e);return desktop.status();});
  hooks.ipcMain.handle('windows:select', async (e: any,id: any)=>{
    hooks.requireTrusted(e);
    if(hooks.busy())return {ok:false,error:'Wait for the current turn before changing the selected window.'};
    if(typeof id!=='string'||id.length>128)return {ok:false,error:'Invalid window identifier.'};
    return respond(async()=>{
      const result=await desktop.select(id);
      if(result?.ok===false)return result;
      // Selecting a local window is an explicit switch away from Ubuntu-only
      // tools. The guest keeps running; its controls can be reselected later.
      await hooks.useHost?.();
      return result;
    });
  });
  // Revoke immediately, including while approval or input is pending.
  hooks.ipcMain.handle('windows:release', (e: any)=>{hooks.requireTrusted(e);return desktop.release();});
  return desktop;
}
module.exports={createWindowsService};
