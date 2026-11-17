function createSandboxService(hooks:any){
  const vm=hooks.vm||require('./sandbox-vm.ts').createSandboxVM({directory:hooks.directory});
  require('../harness/sandbox-tools.ts').configureSandbox(vm);
  const trusted=hooks.requireTrusted;
  const safe=(fn:any)=>async(e:any,...args:any[])=>{trusted(e);try{return await fn(...args);}catch(error:any){return {ok:false,error:String(error.message||error).slice(0,1200),...(['SANDBOX_BUSY','SANDBOX_FRAME_CHANGED'].includes(error.code)?{code:error.code}:{})};}};
  const idle=()=>{if(hooks.busy())throw Error('Wait for the current agent turn to finish.');};
  const on=(name:string,fn:any)=>hooks.ipcMain.handle(`sandbox:${name}`,safe(fn));
  on('status',()=>vm.status());on('frame',()=>vm.frame());
  on('choose-iso',async()=>{idle();const result=await hooks.chooseISO();return result?vm.chooseISO(result):{ok:false,cancelled:true};});
  for(const name of ['create','start','checkpoint','reset'])on(name,async()=>{idle();const result=await vm[name]();hooks.refreshTools();return result;});
  // User can stop/revoke while the agent is running; guest actions then fail closed.
  on('stop',async()=>{hooks.cancelAgent?.();return vm.stop();});
  const useHost=async()=>{idle();const result=await vm.selectHost();hooks.refreshTools();return result;};
  on('host',useHost);
  on('input',async(args:any)=>{idle();return vm.input(args,undefined,true);});
  return {...vm,useHost};
}
module.exports={createSandboxService};
