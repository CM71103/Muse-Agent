const fs=require('node:fs');
const path=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function createSandboxVM(options:any) {
  const directory=path.resolve(options.directory),stateFile=path.join(directory,'sandbox.json');
  const executable=options.executable || path.join(process.env.ProgramFiles||'', 'Oracle','VirtualBox','VBoxManage.exe');
  const run=options.run || (async(args:string[],signal?:AbortSignal)=>{
    const result=await exec(executable,args,{windowsHide:true,timeout:90000,maxBuffer:1024*1024,signal});return result.stdout;
  });
  let config:any={},busy=false,selected=false,revision=0,screen:any=null,lastError='',inputAbort:any=null;
  try {config=JSON.parse(fs.readFileSync(stateFile,'utf8'));selected=config.selected===true;}catch{}
  if(config.id && (!UUID.test(config.id)||!UUID.test(config.owner))) throw Error('Invalid sandbox configuration');
  const persist=()=>{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(stateFile+'.tmp',JSON.stringify(config,null,2));fs.renameSync(stateFile+'.tmp',stateFile);};
  const available=()=>options.run?true:fs.existsSync(executable);
  async function own() {
    if(!config.id)throw Error('Create the Ubuntu sandbox first.');
    const owner=await run(['getextradata',config.id,'MuseSandboxOwner']);
    if(String(owner).trim()!==`Value: ${config.owner}`)throw Error('The VM is not owned by this Muse sandbox.');
  }
  async function info() {await own();return String(await run(['showvminfo',config.id,'--machinereadable']));}
  function value(text:string,key:string){return new RegExp(`^${key}="([^"]*)"`,'m').exec(text)?.[1]||'';}
  async function status() {
    let state=available()?(config.id?'stopped':'missing_iso'):'unavailable';
    if(config.id && available())try {state=value(await info(),'VMState')||'error';}catch(error:any){lastError=error.message;state='error';}
    if(state==='poweroff'||state==='aborted')state='stopped';
    return {state:busy&&['stopped','missing_iso'].includes(state)?'starting':state,busy,available:available(),iso:config.iso||null,vmId:config.id||null,
      selected,checkpoint:!!config.checkpoint,setupIncomplete:!!config.id&&!config.ready,error:lastError,screen,revision};
  }
  async function exclusive(fn:any){if(busy)throw Error('A sandbox operation is already running.');busy=true;lastError='';try{return await fn();}catch(error:any){lastError=String(error.message||error).slice(0,1200);throw error;}finally{busy=false;}}
  function chooseISO(iso:string){
    if(config.id)throw Error('The sandbox already has installation media.');
    if(typeof iso!=='string'||!path.isAbsolute(iso)||path.extname(iso).toLowerCase()!=='.iso'||!fs.statSync(iso).isFile())throw Error('Choose an Ubuntu ISO file.');
    config.iso=fs.realpathSync.native(iso);persist();return {ok:true,iso:config.iso};
  }
  async function create(){return exclusive(async()=>{
    if(!available())throw Error('Install Oracle VirtualBox before creating the sandbox.');
    if(config.id&&config.ready)throw Error('A Muse sandbox is already configured.');
    if(!config.iso||!fs.existsSync(config.iso))throw Error('Choose an Ubuntu ISO first.');
    const id=config.id||randomUUID(),owner=config.owner||randomUUID(),folder=path.join(directory,'machines');
    fs.mkdirSync(folder,{recursive:true});
    // Tag immediately and retain the owned UUID on later setup failures.
    if(config.id){
      await own();
      if(value(await info(),'VMState')!=='poweroff')throw Error('Stop the incomplete VM before retrying setup.');
    }else{
      await run(['createvm','--name',`Muse Ubuntu ${id.slice(0,8)}`,'--uuid',id,'--basefolder',folder,'--ostype','Ubuntu_64','--register']);
      await run(['setextradata',id,'MuseSandboxOwner',owner]);
    }
    config={...config,id,owner,selected:true,ready:false};selected=true;persist();
    await run(['modifyvm',id,'--memory','3072','--cpus','2','--ioapic','on','--vram','128','--graphicscontroller','vmsvga',
      '--boot1','dvd','--boot2','disk','--mouse','usbtablet','--usb-ohci','on','--clipboard-mode','disabled',
      '--clipboard-file-transfers','disabled','--drag-and-drop','disabled','--audio-enabled','off','--vrde','off',
      '--nic1','nat','--nat-localhostreachable1','off']);
    const disk=path.join(folder,`muse-${id}.vdi`);
    if(!fs.existsSync(disk))await run(['createmedium','disk','--filename',disk,'--size','24576','--format','VDI']);
    if(!/^storagecontrollername\d+="SATA"/m.test(await info()))await run(['storagectl',id,'--name','SATA','--add','sata','--controller','IntelAhci']);
    await run(['storageattach',id,'--storagectl','SATA','--port','0','--device','0','--type','hdd','--medium',disk]);
    await run(['storageattach',id,'--storagectl','SATA','--port','1','--device','0','--type','dvddrive','--medium',config.iso]);
    config.ready=true;persist();return {ok:true,...await status()};
  });}
  async function start(){return exclusive(async()=>{
    if(!config.ready)throw Error('Sandbox setup is incomplete; check the setup error.');
    const state=value(await info(),'VMState');
    if(!['poweroff','saved','aborted','running'].includes(state))throw Error('The sandbox is transitioning.');
    config.selected=true;selected=true;persist();revision++;screen=null;
    if(state!=='running')await run(['startvm',config.id,'--type','headless']);return {ok:true};
  });}
  async function stop(){
    inputAbort?.abort();
    const deadline=Date.now()+16000;
    while(busy && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
    return exclusive(async()=>{
    const state=value(await info(),'VMState');revision++;screen=null;
    if(state==='running'||state==='paused')await run(['controlvm',config.id,'savestate']);
    return {ok:true};
  });}
  async function checkpoint(){return exclusive(async()=>{
    if(!['running','poweroff','saved'].includes(value(await info(),'VMState')))throw Error('The sandbox is not ready for a checkpoint.');
    const snapshot=randomUUID();
    await run(['snapshot',config.id,'take',`Muse clean ${snapshot}`,'--description','Clean desktop saved explicitly in Muse']);
    const text=String(await run(['snapshot',config.id,'list','--machinereadable']));
    const match=new RegExp(`^SnapshotName((?:-\\d+)*)="Muse clean ${snapshot}"\\r?\\nSnapshotUUID\\1="([^"]+)"`,'m').exec(text);
    if(!match||!UUID.test(match[2]))throw Error('Could not verify the new clean checkpoint.');
    config.checkpoint=match[2];persist();revision++;return {ok:true};
  });}
  async function reset(){return exclusive(async()=>{
    if(!UUID.test(config.checkpoint||''))throw Error('Save a clean desktop before resetting.');
    const state=value(await info(),'VMState');revision++;screen=null;
    if(state==='running'||state==='paused')await run(['controlvm',config.id,'poweroff']);
    else if(state==='saved')await run(['discardstate',config.id]);
    await run(['snapshot',config.id,'restore',config.checkpoint]);
    const restored=value(await info(),'VMState');
    if(restored!=='running')await run(['startvm',config.id,'--type','headless']);
    return {ok:true};
  });}
  async function selectHost(){
    selected=false;config.selected=false;revision++;screen=null;persist();return {ok:true,...await status()};
  }
  let framePending:any=null;
  const frameChanged=()=>Object.assign(Error('Guest screen changed; capture it again.'),{code:'SANDBOX_FRAME_CHANGED'});
  async function forCaller(promise:any,signal?:AbortSignal){
    signal?.throwIfAborted();if(!signal)return promise;
    let abort:any;
    const cancelled=new Promise((_resolve,reject)=>{abort=()=>reject(signal.reason||Error('Guest screenshot cancelled.'));signal.addEventListener('abort',abort,{once:true});});
    try{return await Promise.race([promise,cancelled]);}finally{signal.removeEventListener('abort',abort);}
  }
  async function frame(signal?:AbortSignal):Promise<any>{
    signal?.throwIfAborted();
    if(framePending)return forCaller(framePending,signal);
    const generation=revision;
    framePending=(async()=>{
      if(busy)throw Object.assign(Error('Wait for the sandbox operation to finish.'),{code:'SANDBOX_BUSY'});
      if(value(await info(),'VMState')!=='running')throw Error('Start the Ubuntu sandbox first.');
      signal?.throwIfAborted();
      if(busy||generation!==revision)throw frameChanged();
      const file=path.join(directory,`frame-${randomUUID()}.png`);
      try {
        await run(['controlvm',config.id,'screenshotpng',file],signal);
        const size=fs.statSync(file).size;if(size>8*1024*1024)throw Error('Guest screen exceeds the image limit.');
        const png=fs.readFileSync(file);
        if(png.length<24||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid guest screenshot.');
        const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
        if(width<1||height<1||width>8192||height>8192)throw Error('Unsupported guest screen size.');
        signal?.throwIfAborted();
        if(busy||generation!==revision)throw frameChanged();
        if(screen&&(screen.width!==width||screen.height!==height))revision++;
        screen={width,height};return {ok:true,data:png.toString('base64'),width,height,revision};
      }finally{try{fs.unlinkSync(file);}catch{}}
    })().finally(()=>{framePending=null;});
    return forCaller(framePending,signal);
  }
  function vboxAbsoluteCoordinate(position:number,size:number){
    if(!Number.isSafeInteger(position)||!Number.isSafeInteger(size)||size<1||position<0||position>=size)throw Error('Click inside a fresh guest screen.');
    return Math.max(0,Math.min(32767,Math.round(position*32767/Math.max(1,size-1))));
  }
  const codes:any={ENTER:'1c',TAB:'0f',ESCAPE:'01',BACKSPACE:'0e',DELETE:'e0 53',SPACE:'39',HOME:'e0 47',END:'e0 4f',LEFT:'e0 4b',RIGHT:'e0 4d',UP:'e0 48',DOWN:'e0 50',PAGEUP:'e0 49',PAGEDOWN:'e0 51',CTRL:'1d',ALT:'38',SHIFT:'2a'};
  '1234567890'.split('').forEach((key,i)=>codes[key]=(i+2).toString(16));
  for(const [letters,start] of [['QWERTYUIOP',16],['ASDFGHJKL',30],['ZXCVBNM',44]] as any)letters.split('').forEach((key:string,i:number)=>codes[key]=(start+i).toString(16));
  function scancodes(chord:string){
    if(typeof chord!=='string'||chord.length>60)throw Error('Unsupported guest key.');
    const parts=chord.toUpperCase().split('+');
    if(parts.length>4||parts.some((p,i)=>!codes[p]||(i<parts.length-1&&!['CTRL','ALT','SHIFT'].includes(p))))throw Error('Unsupported guest key.');
    const press=parts.flatMap(p=>codes[p].split(' '));
    return press.concat(parts.toReversed().flatMap(p=>{const tokens=codes[p].split(' ');return tokens.slice(0,-1).concat((parseInt(tokens.at(-1),16)|128).toString(16));}));
  }
  async function pointer(args:any,signal?:AbortSignal){
    signal?.throwIfAborted();
    if(options.pointer)return options.pointer({...args,id:config.id,owner:config.owner},signal);
    const script=fs.readFileSync(path.join(__dirname,'sandbox-input.ps1'),'utf8');
    const binary=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    return new Promise((resolve,reject)=>{
      const child=spawn(binary,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      let output='';const timer=setTimeout(()=>{child.kill();reject(Error('Guest pointer input timed out.'));},15000);
      const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',(chunk:any)=>{output+=chunk;if(output.length>16000)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});
      child.on('error',reject);child.on('close',()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);try{if(signal?.aborted)throw Error('Guest input cancelled.');const result=JSON.parse(output.trim());if(!result.ok)throw Error(result.error);resolve(result);}catch(e){reject(e);}});
      child.stdin.end(JSON.stringify({...args,id:config.id,owner:config.owner}));
      if(signal?.aborted)abort();
    });
  }
  async function input(args:any,signal?:AbortSignal,manual=false){
    const controller=new AbortController();
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    return exclusive(async()=>{
    inputAbort=controller;combined.throwIfAborted();
    if(!args||typeof args!=='object')throw Error('Invalid guest input.');
    if(value(await info(),'VMState')!=='running')throw Error('Start the sandbox first.');
    combined.throwIfAborted();
    if(!manual&&(!selected||!screen||!Number.isSafeInteger(args.revision)||args.revision!==revision))throw Error('Guest screen changed; take a fresh screenshot.');
    if(args.kind==='text'){
      if(typeof args.text!=='string'||args.text.length<1||args.text.length>4000||/[^\x20-\x7e]/.test(args.text))throw Error('Type 1–4,000 printable ASCII characters into the guest. Use the guest key tool for Enter and new lines.');
      await run(['controlvm',config.id,'keyboardputstring',args.text],combined);
    }else if(args.kind==='key')await run(['controlvm',config.id,'keyboardputscancode',...scancodes(args.key)],combined);
    else if(args.kind==='click'||args.kind==='scroll'){
      if(!screen||![args.x,args.y].every(Number.isSafeInteger)||args.x<0||args.y<0||args.x>=screen.width||args.y>=screen.height)throw Error('Click inside a fresh guest screen.');
      if(args.kind==='click'&&!['left','right'].includes(args.button||'left'))throw Error('Invalid guest mouse button.');
      if(args.kind==='scroll'&&(!Number.isSafeInteger(args.delta)||Math.abs(args.delta)>10||args.delta===0))throw Error('Guest wheel delta must be between -10 and 10.');
      await pointer({...args,button:args.button||'left',absoluteX:vboxAbsoluteCoordinate(args.x,screen.width),absoluteY:vboxAbsoluteCoordinate(args.y,screen.height)},combined);
    }else throw Error('Unsupported guest input.');
    revision++;if(!manual)screen=null;return {ok:true,revision};
  }).finally(()=>{if(inputAbort===controller)inputAbort=null;});}
  return {status,chooseISO,create,start,stop,reset,checkpoint,frame,input,selectHost,isSelected:()=>selected,scancodes};
}
module.exports={createSandboxVM};
