type SandboxStatus = {state?:'missing_iso'|'stopped'|'starting'|'running'|'saved'|'error';available?:boolean;error?:string;vmId?:string;iso?:string;checkpoint?:boolean;selected?:boolean;setupIncomplete?:boolean;screen?:{width:number;height:number};ok?:boolean};
type SandboxApi = {sandboxStatus?:()=>Promise<SandboxStatus>;sandboxChooseISO?:()=>Promise<any>;sandboxCreate?:()=>Promise<any>;sandboxStart?:()=>Promise<any>;sandboxStop?:()=>Promise<any>;sandboxReset?:()=>Promise<any>;sandboxCheckpoint?:()=>Promise<any>;sandboxUseHost?:()=>Promise<any>;sandboxFrame?:()=>Promise<any>;sandboxInput?:(value:any)=>Promise<any>};
function create(options:{api?:SandboxApi;busy?:()=>boolean}={}) {
  const api=options.api || (window as any).muse || {};
  const node=(tag:string,id:string,cls='',text?:string)=>{const n=document.createElement(tag);if(id)n.id=id;if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const button=(id:string,text:string)=>{const n=node('button',id,'',text) as HTMLButtonElement;n.type='button';return n;};
  const toolbar=button('sandbox-toolbar-open','Sandbox');toolbar.setAttribute('aria-haspopup','dialog');toolbar.setAttribute('aria-expanded','false');toolbar.setAttribute('aria-controls','sandbox-panel');toolbar.title='Open your Ubuntu sandbox';
  document.querySelector?.('.composer-model-control')?.append(toolbar);
  const backdrop=node('div','sandbox-backdrop');backdrop.hidden=true;
  const panel=node('section','sandbox-panel');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','sandbox-title');
  const heading=node('div','','sandbox-heading'),emblem=node('span','','sandbox-emblem','▱');emblem.setAttribute('aria-hidden','true');
  const title=node('div','','sandbox-title-group');title.append(node('h2','sandbox-title','','Ubuntu sandbox'),node('p','','','A separate desktop inside Muse. Your existing WSL environments stay separate.'));
  const closeButton=button('sandbox-close','Close');heading.append(emblem,title,closeButton);
  const overview=node('div','','sandbox-overview'),badge=node('span','sandbox-status','sandbox-state','Checking availability…');badge.setAttribute('role','status');
  const targetBadge=node('span','sandbox-target','sandbox-target','Agent: host');targetBadge.setAttribute('role','status');
  const detail=node('p','sandbox-detail');overview.append(badge,targetBadge,detail);
  const actions=node('div','','sandbox-actions'),refreshButton=button('sandbox-refresh','Refresh status'),startButton=button('sandbox-start','Start'),stopButton=button('sandbox-stop','Stop & save'),checkpointButton=button('sandbox-checkpoint','Save clean desktop'),resetButton=button('sandbox-reset','Reset to clean'),hostButton=button('sandbox-use-host','Use host tools');actions.append(startButton,stopButton,checkpointButton,resetButton,hostButton,refreshButton);
  const error=node('p','sandbox-error');error.setAttribute('role','alert');
  const setup=node('section','sandbox-setup','sandbox-setup');setup.append(node('h3','','','Choose your Ubuntu desktop'));
  const setupText=node('p','','','Choose a local Ubuntu desktop ISO, then create the virtual machine. Start it and choose Try Ubuntu for a live desktop, or install Ubuntu yourself. If you install it, choose your own guest username and password.');
  const iso=node('p','sandbox-iso','sandbox-iso','No ISO selected');
  const setupActions=node('div','','sandbox-actions'),chooseButton=button('sandbox-choose-iso','Choose Ubuntu ISO'),createButton=button('sandbox-create','Create VM');setupActions.append(chooseButton,createButton);setup.append(setupText,iso,setupActions);
  const confirm=node('div','sandbox-reset-prompt','sandbox-reset-prompt');confirm.hidden=true;confirm.setAttribute('role','group');confirm.setAttribute('aria-label','Confirm sandbox reset');
  const confirmText=node('p','','','Reset to the clean snapshot? Changes made inside the guest since that snapshot will be discarded. Host files are not changed.');
  const confirmActions=node('div','','sandbox-actions'),confirmButton=button('sandbox-reset-confirm','Discard guest changes & reset'),cancelButton=button('sandbox-reset-cancel','Keep current desktop');confirmActions.append(cancelButton,confirmButton);confirm.append(confirmText,confirmActions);
  const baseline=node('p','sandbox-baseline-note','sandbox-baseline-note','Save a clean desktop snapshot before using Reset.');
  const screen=node('div','sandbox-screen','sandbox-screen');screen.tabIndex=0;screen.setAttribute('role','group');screen.setAttribute('aria-label','Ubuntu guest screen. Click to focus keyboard input.');
  const image=node('img','sandbox-frame') as HTMLImageElement;image.hidden=true;image.alt='Current screen of your Ubuntu sandbox';image.draggable=false;
  const empty=node('p','sandbox-screen-empty','','The guest screen will appear here when the sandbox is running.');screen.append(image,empty);
  const frameNote=node('p','sandbox-frame-note','sandbox-frame-note','Preview stays local. A screen is sent to the model only when a screenshot tool is used.');
  const taskHint=node('p','sandbox-task-hint','sandbox-task-hint','To open an app, ask Muse in the chat box, for example: “Open the file manager in Ubuntu.” The field below types literal text into the guest; it does not give Muse a task.');
  const inputRow=node('div','','sandbox-input-row'),input=node('input','sandbox-text') as HTMLInputElement;input.type='text';input.maxLength=4000;input.placeholder='Type literal text into the focused guest app';input.setAttribute('aria-label','Literal text to type into the focused Ubuntu guest app, not an instruction to Muse');
  const sendButton=button('sandbox-send-text','Type in guest');inputRow.append(input,sendButton);
  const guidance=node('p','','sandbox-guidance','For a chat task, select Sandbox and use a vision-capable model so Muse can inspect the screen and click visible controls. To type here, first click a guest text field. Use the guest screen for Enter, Tab and arrow keys; press F6 to return to Muse controls.');
  panel.append(heading,overview,actions,error,setup,baseline,confirm,screen,frameNote,taskHint,inputRow,guidance);backdrop.append(panel);document.body.append(backdrop);
  let value:SandboxStatus={},pending='',opened=false,destroyed=false,returnFocus:HTMLElement|null=null;
  let generation=0,statusVersion=0,timer:ReturnType<typeof setTimeout>|undefined,frameInFlight=false,inputPending=false,inputChain=Promise.resolve(),queuedKeys=0;
  let dimensions={width:0,height:0},inputGeneration=0;
  const busy=()=>!!options.busy?.();
  const ready=()=>value.state==='running' && !pending && !busy();
  const hasVM=()=>!!value.vmId || ['stopped','starting','running','saved'].includes(value.state || '');
  function message(text:unknown){error.textContent=String(text || '').slice(0,600);}
  function clearFrame(){image.onerror=null;image.hidden=true;image.removeAttribute('src');empty.hidden=false;dimensions={width:0,height:0};}
  function stopPolling(){generation++;if(timer!==undefined)clearTimeout(timer);timer=undefined;}
  function render(){
    const labels:Record<string,string>={missing_iso:'Choose Ubuntu ISO',stopped:'Stopped',starting:'Starting…',running:'Running',saved:'Saved',error:'Needs attention'};
    badge.textContent=pending || labels[value.state || ''] || 'Checking availability…';badge.setAttribute('data-state',value.state || 'unknown');toolbar.setAttribute('data-state',value.state || 'unknown');
    targetBadge.textContent=value.selected?'Agent: sandbox':'Agent: host';targetBadge.setAttribute('data-selected',String(!!value.selected));toolbar.title=`Ubuntu sandbox · ${value.selected?'Agent targets sandbox':'Agent targets host'}`;
    detail.textContent=value.available===false?'Virtual machine support is not available. Follow the setup requirement shown below.':value.state==='running'?'Your guest desktop is running independently of your Windows desktop.':value.state==='saved'?'The guest state is saved. Resume to continue where you stopped.':hasVM()?'Start the guest to use your separate Ubuntu desktop.':'Choose an Ubuntu ISO to create your sandbox.';
    iso.textContent=value.iso?`Selected ISO: ${value.iso}`:'No ISO selected';
    const running=value.state==='running' || value.state==='starting';
    setup.hidden=hasVM() && value.state!=='missing_iso' && !value.setupIncomplete;
    setupText.textContent=value.setupIncomplete?'VM setup did not finish. Retry setup to continue configuring this same Muse sandbox. Your existing virtual disk is preserved.':'Choose a local Ubuntu desktop ISO, then create the virtual machine. Start it and choose Try Ubuntu for a live desktop, or install Ubuntu yourself. If you install it, choose your own guest username and password.';
    chooseButton.disabled=!!pending || busy() || running || !!value.vmId || !api.sandboxChooseISO;
    createButton.textContent=value.setupIncomplete?'Retry VM setup':'Create VM';
    createButton.disabled=!!pending || busy() || running || value.available===false || !value.iso || !api.sandboxCreate;createButton.hidden=hasVM() && !value.setupIncomplete;
    startButton.hidden=!hasVM();startButton.textContent=value.state==='running' && !value.selected?'Use sandbox':value.state==='saved'?'Resume':'Start';startButton.disabled=!!pending || busy() || !!value.setupIncomplete || value.state==='starting' || value.state==='running' && !!value.selected || value.available===false || !api.sandboxStart;
    stopButton.disabled=!!pending || !running || !api.sandboxStop;
    checkpointButton.disabled=!!pending || busy() || value.state!=='running' || !api.sandboxCheckpoint;
    resetButton.disabled=!!pending || busy() || !value.checkpoint || !hasVM() || !api.sandboxReset;
    hostButton.disabled=!!pending || busy() || !value.selected || !api.sandboxUseHost;
    confirmButton.disabled=!!pending || busy();cancelButton.disabled=!!pending;refreshButton.disabled=!!pending;
    baseline.textContent=value.checkpoint?'Clean desktop saved. Reset restores this snapshot and discards later guest changes.':'Once Ubuntu is ready, choose Save clean desktop to create the baseline used by Reset.';
    input.disabled=!ready() || inputPending;sendButton.disabled=!ready() || inputPending || !input.value;
    screen.setAttribute('aria-disabled',String(!ready()));panel.setAttribute('aria-busy',String(!!pending));
    if(value.state!=='running'){clearFrame();empty.textContent=value.state==='starting'?'Waiting for the Ubuntu guest to start…':'The guest screen will appear here when the sandbox is running.';}
  }
  function status(next:SandboxStatus){const changed=value.vmId!==next.vmId;if(changed || value.state==='running' && next.state!=='running')inputGeneration++;value={...next};if(changed)clearFrame();if(next.error)message(next.error);render();}
  async function readStatus(){
    if(!api.sandboxStatus){message('Sandbox controls are unavailable. Restart the updated Muse app.');return;}
    const version=++statusVersion;
    const result=await api.sandboxStatus();if(version!==statusVersion || destroyed)return;
    if(result?.ok===false)throw Error(result.error || 'Could not check the sandbox.');status(result);
  }
  function showFrame(result:any){
    if(['SANDBOX_BUSY','SANDBOX_FRAME_CHANGED'].includes(result?.code))return;
    if(result?.ok===false)throw Error(result.error || 'Could not read the guest screen.');
    const data=typeof result?.data==='string'?result.data.replace(/^data:image\/png;base64,/,''):'';
    if(!data || data.length>16*1024*1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw Error('The guest returned an invalid screen image.');
    const width=Number(result.width),height=Number(result.height);
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1||width>16384||height>16384)throw Error('The guest screen dimensions are unavailable.');
    dimensions={width,height};image.onerror=()=>{clearFrame();message('The screen image could not be displayed. Try refreshing the sandbox.');};
    image.src=`data:image/png;base64,${data}`;image.hidden=false;empty.hidden=true;
    frameNote.textContent='Live guest preview · refreshes about once a second while this panel is open. It is sent to the model only by a screenshot tool.';
  }
  async function tick(epoch:number){
    if(epoch!==generation || !opened || destroyed || pending)return;
    try{
      if(value.state==='starting'){await readStatus();}
      else if(value.state==='running' && api.sandboxFrame && !frameInFlight && !document.hidden){
        frameInFlight=true;try{const frame=await api.sandboxFrame();if(epoch===generation && opened && value.state==='running')showFrame(frame);}finally{frameInFlight=false;}
      }
    }catch(caught){if(epoch===generation){clearFrame();empty.textContent='Waiting for a fresh guest screen…';message((caught as Error).message || 'Could not refresh the guest screen.');try{await readStatus();}catch{}}}
    finally{if(epoch===generation && opened && !destroyed && !pending && ['running','starting'].includes(value.state || ''))timer=setTimeout(()=>void tick(epoch),1000);}
  }
  function startPolling(){stopPolling();if(opened && !pending && ['running','starting'].includes(value.state || '')){const epoch=generation;timer=setTimeout(()=>void tick(epoch),0);}}
  async function refresh(){if(pending)return;message('');try{await readStatus();}catch(caught){message((caught as Error).message || 'Could not check the sandbox.');}startPolling();}
  async function action(name:'sandboxChooseISO'|'sandboxCreate'|'sandboxStart'|'sandboxStop'|'sandboxReset'|'sandboxCheckpoint'|'sandboxUseHost',label:string){
    if(pending || name!=='sandboxStop' && busy())return;const operation=api[name];if(!operation)return;
    pending=label;statusVersion++;inputGeneration++;stopPolling();message('');render();
    try{
      const result=await operation.call(api);if(result?.ok===false)throw Error(result.error || `${label} failed.`);
      if(result?.state)status(result);else if(name==='sandboxChooseISO' && result?.iso){value={...value,iso:result.iso};render();}
      else await readStatus();
      if(name==='sandboxReset')confirm.hidden=true;
    }catch(caught){message((caught as Error).message || 'Sandbox action failed. Try refreshing.');}
    finally{pending='';render();startPolling();}
  }
  async function send(value:any){if(!ready() || !api.sandboxInput)return;const result=await api.sandboxInput(value);if(result?.ok===false)throw Error(result.error || 'Guest input failed.');}
  function queue(value:any){
    if(!ready())return;if(queuedKeys>=32){message('Guest input is catching up. Use Send text for longer input.');return;}queuedKeys++;const epoch=inputGeneration;
    inputChain=inputChain.then(()=>{if(epoch===inputGeneration)return send(value);}).catch(()=>message('Guest input could not be sent. Refresh status and try again.')).finally(()=>{queuedKeys--;});
  }
  function key(event:KeyboardEvent){
    if(event.key==='F6'){event.preventDefault();event.stopPropagation();closeButton.focus();return;}
    if(!ready() || event.isComposing || event.metaKey)return;
    const map:Record<string,string>={Enter:'ENTER',Tab:'TAB',Escape:'ESCAPE',Backspace:'BACKSPACE',Delete:'DELETE',' ':'SPACE',Home:'HOME',End:'END',ArrowLeft:'LEFT',ArrowRight:'RIGHT',ArrowUp:'UP',ArrowDown:'DOWN',PageUp:'PAGEUP',PageDown:'PAGEDOWN'};
    const token=map[event.key] || (/^[a-z0-9]$/i.test(event.key)?event.key.toUpperCase():'');
    if(token){event.preventDefault();event.stopPropagation();const modifiers=[event.ctrlKey?'CTRL':'',event.altKey?'ALT':'',event.shiftKey?'SHIFT':''].filter(Boolean);queue({kind:'key',key:[...modifiers,token].join('+')});}
    else if(event.key.length===1 && /^[\x20-\x7e]$/.test(event.key) && !event.ctrlKey && !event.altKey){event.preventDefault();event.stopPropagation();queue({kind:'text',text:event.key});}
  }
  function click(event:MouseEvent,button:'left'|'right'){
    if(!ready() || image.hidden || !dimensions.width)return;screen.focus();
    const bounds=image.getBoundingClientRect(),scale=Math.min(bounds.width/dimensions.width,bounds.height/dimensions.height);
    if(!scale)return;const x=(event.clientX-bounds.left-(bounds.width-dimensions.width*scale)/2)/scale,y=(event.clientY-bounds.top-(bounds.height-dimensions.height*scale)/2)/scale;
    if(x<0||y<0||x>=dimensions.width||y>=dimensions.height)return;
    event.preventDefault();queue({kind:'click',x:Math.min(dimensions.width-1,Math.floor(x)),y:Math.min(dimensions.height-1,Math.floor(y)),button});
  }
  screen.addEventListener('keydown',key);image.addEventListener('click',event=>click(event,'left'));image.addEventListener('contextmenu',event=>{event.preventDefault();click(event,'right');});
  input.addEventListener('input',render);input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();sendButton.click();}});sendButton.addEventListener('click',async()=>{
    if(!ready() || inputPending || !input.value)return;const text=input.value;
    if(text.length>4000 || /[^\x20-\x7e]/.test(text)){message('Type 1–4,000 printable ASCII characters here. This field enters text only; use the guest screen for Enter and new lines.');return;}
    const epoch=inputGeneration;inputPending=true;render();try{await inputChain;if(epoch!==inputGeneration || !ready())throw Error('Guest input changed');await send({kind:'text',text});if(input.value===text)input.value='';}
    catch{message('Text could not be sent. Refresh the sandbox and try again.');}finally{inputPending=false;render();}
  });
  chooseButton.addEventListener('click',()=>void action('sandboxChooseISO','Choosing ISO…'));createButton.addEventListener('click',()=>void action('sandboxCreate','Creating VM…'));
  startButton.addEventListener('click',()=>void action('sandboxStart','Starting…'));stopButton.addEventListener('click',()=>void action('sandboxStop','Saving guest state…'));checkpointButton.addEventListener('click',()=>void action('sandboxCheckpoint','Saving clean desktop…'));
  hostButton.addEventListener('click',()=>void action('sandboxUseHost','Switching to host tools…'));
  resetButton.addEventListener('click',()=>{if(pending || busy() || !value.checkpoint)return;confirm.hidden=false;cancelButton.focus();});cancelButton.addEventListener('click',()=>{confirm.hidden=true;resetButton.focus();});confirmButton.addEventListener('click',()=>void action('sandboxReset','Restoring clean desktop…'));refreshButton.addEventListener('click',()=>void refresh());
  function close(){opened=false;inputGeneration++;backdrop.hidden=true;toolbar.setAttribute('aria-expanded','false');stopPolling();returnFocus?.focus();}
  function open(){if(!opened)returnFocus=document.activeElement as HTMLElement|null;opened=true;backdrop.hidden=false;toolbar.setAttribute('aria-expanded','true');closeButton.focus();void refresh();}
  toolbar.addEventListener('click',open);closeButton.addEventListener('click',close);backdrop.addEventListener('click',event=>{if(event.target===backdrop)close();});
  backdrop.addEventListener('keydown',event=>{
    if(event.key==='Escape' && (document.activeElement!==screen || !ready())){event.preventDefault();event.stopPropagation();close();}
    if(event.key==='Tab' && document.activeElement!==screen){const controls=Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')).filter(item=>!item.hidden&&item.getClientRects().length);if(!controls.length)return;if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1)!.focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}}
  });
  function event(value:any){if(typeof value?.name!=='string'||!value.name.startsWith('sandbox_'))return false;if(value.type==='tool_result'){if(value.result?.state)status(value.result);else if(!pending)void refresh();}return true;}
  render();return {open,close,refresh,event,busyChanged(){if(busy())inputGeneration++;render();},destroy(){destroyed=true;inputGeneration++;stopPolling();backdrop.remove();toolbar.remove();}};
}
(window as any).MuseSandbox={create};
