type DesktopWindow = {id:string;title:string;processName?:string;pid?:number;width?:number;height?:number};
type DesktopState = {ok?:boolean;state?:string;selected?:DesktopWindow|null;revision?:number;error?:string};
type DesktopApi = {windowsList?:()=>Promise<any>;windowsStatus?:()=>Promise<DesktopState>;windowsSelect?:(id:string)=>Promise<any>;windowsRelease?:()=>Promise<any>};
function create(options:{api?:DesktopApi;busy?:()=>boolean}={}) {
  const api=options.api || (window as any).muse || {};
  const make=(tag:string,id:string,cls='',text?:string)=>{const el=document.createElement(tag);if(id)el.id=id;if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const control=(id:string,text:string)=>{const el=make('button',id,'',text) as HTMLButtonElement;el.type='button';return el;};
  const toolbar=control('windows-toolbar-open','Windows');toolbar.title='Choose a local window for Muse';toolbar.setAttribute('aria-haspopup','dialog');toolbar.setAttribute('aria-expanded','false');toolbar.setAttribute('aria-controls','windows-desktop-panel');
  document.querySelector?.('.composer-model-control')?.append(toolbar);
  const backdrop=make('div','windows-desktop-backdrop');backdrop.hidden=true;
  const panel=make('section','windows-desktop-panel');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','windows-panel-title');
  const heading=make('div','','windows-panel-heading');
  const emblem=make('span','','windows-desktop-emblem','▱');emblem.setAttribute('aria-hidden','true');
  const title=make('div','','windows-panel-title');title.append(make('h2','windows-panel-title','','Your Windows desktop'),make('p','','','Select one window for Muse to work with.'));
  const closeButton=control('windows-panel-close','Close');heading.append(emblem,title,closeButton);
  const summary=make('div','','windows-panel-summary'),badge=make('span','windows-panel-status','windows-desktop-state','No window selected');badge.setAttribute('role','status');
  const detail=make('p','windows-panel-detail');summary.append(badge,detail);
  const actions=make('div','','windows-desktop-actions'),refreshButton=control('windows-panel-refresh','Refresh windows'),releaseButton=control('windows-panel-release','Release window');actions.append(refreshButton,releaseButton);
  const error=make('p','windows-panel-error');error.setAttribute('role','alert');
  const guidance=make('p','','windows-desktop-guidance','Choose a window, then ask Muse for a specific task, such as “read the page title.” Selecting it switches tools from Ubuntu to Windows but leaves the guest running. The selected model must support images; screenshots may be sent to it.');
  const columns=make('div','','windows-desktop-columns');
  const listSection=make('section','','windows-target-section');listSection.append(make('h3','','','Available windows'));
  const list=make('div','windows-window-list');list.setAttribute('aria-label','Windows available for selection');listSection.append(list);
  const screenSection=make('section','','windows-screen-section');screenSection.append(make('h3','','','Latest screenshot'));
  const preview=make('figure','','windows-desktop-preview'),image=make('img','windows-preview-image') as HTMLImageElement;image.hidden=true;
  const empty=make('p','windows-preview-empty','','No screenshot yet. Ask Muse to inspect the selected window.');
  const caption=make('figcaption','windows-preview-caption','','Only the explicitly selected window is available to desktop tools.');preview.append(image,empty,caption);screenSection.append(preview);
  columns.append(listSection,screenSection);
  const activity=make('ul','windows-activity-list');activity.setAttribute('role','log');activity.setAttribute('aria-label','Windows tool activity');
  panel.append(heading,summary,actions,error,guidance,columns,make('h3','','windows-desktop-activity-title','Desktop activity'),activity);backdrop.append(panel);document.body.append(backdrop);
  let selected:DesktopWindow|null=null,revision:number|undefined,windows:DesktopWindow[]=[],pending=false,loading=false;
  let returnFocus:HTMLElement|null=null,refreshVersion=0;
  const busy=()=>!!options.busy?.();
  function clearImage(){image.onerror=null;image.hidden=true;image.removeAttribute('src');empty.hidden=false;caption.textContent='Only the explicitly selected window is available to desktop tools.';}
  function status(value:DesktopState){
    const next=value?.selected || null;
    if(selected?.id!==next?.id || revision!==value?.revision)clearImage();
    selected=next;revision=value?.revision;render();
  }
  function render(){
    badge.textContent=pending?'Updating selection…':selected?'Window selected':'No window selected';badge.setAttribute('data-state',selected?'selected':'unselected');
    detail.textContent=selected?`${selected.title || 'Untitled window'}${selected.processName ? ' · '+selected.processName : ''}`:'Muse has no local window selected.';
    toolbar.setAttribute('data-state',selected?'selected':'unselected');toolbar.title=selected?`Windows · ${selected.title}`:'Choose a local window for Muse';
    refreshButton.disabled=loading || pending;releaseButton.disabled=!selected || pending;
    panel.setAttribute('aria-busy',String(loading || pending));list.replaceChildren();
    for(const win of windows){
      if(!win || typeof win.id!=='string')continue;
      const choice=control('','');choice.className='windows-window-choice';choice.setAttribute('data-window-id',win.id);choice.setAttribute('aria-pressed',String(selected?.id===win.id));choice.disabled=pending || busy();
      const name=make('strong','','',win.title || 'Untitled window'),meta=make('small','','',win.processName || 'Windows application');choice.append(name,meta);
      choice.addEventListener('click',()=>void selectWindow(win.id));list.append(choice);
    }
    if(!windows.length)list.append(make('p','','windows-window-empty',loading?'Looking for windows…':'No available windows. Open an application and refresh.'));
  }
  function fail(message:string){error.textContent=message.slice(0,500);}
  async function refresh(){
    if(!api.windowsStatus || !api.windowsList){fail('Windows controls are unavailable. Restart the updated Muse app.');return;}
    const version=++refreshVersion;loading=true;error.textContent='';render();
    try {
      const [state,result]=await Promise.all([api.windowsStatus(),api.windowsList()]);
      if(version!==refreshVersion)return;
      if(state?.ok===false || result?.ok===false)throw Error(state.error || result.error || 'Could not list windows.');
      windows=Array.isArray(result)?result:Array.isArray(result?.windows)?result.windows:[];status(state);
    }catch(caught){if(version===refreshVersion)fail((caught as Error).message || 'Could not refresh windows. Try again.');}
    finally{if(version===refreshVersion){loading=false;render();}}
  }
  async function selectWindow(id:string){
    if(pending || busy() || !api.windowsSelect)return;pending=true;refreshVersion++;error.textContent='';render();
    try{const result=await api.windowsSelect(id);if(result?.ok===false)throw Error(result.error || 'Could not select this window.');status(result);}
    catch(caught){fail((caught as Error).message || 'Could not select this window. Try refreshing.');}
    finally{pending=false;loading=false;render();}
  }
  async function release(){
    if(pending || !api.windowsRelease)return;pending=true;refreshVersion++;error.textContent='';render();
    try{const result=await api.windowsRelease();if(result?.ok===false)throw Error(result.error || 'Could not release the window.');status(result);activity.replaceChildren();}
    catch(caught){fail((caught as Error).message || 'Could not release the window. Try again.');}
    finally{pending=false;loading=false;render();}
  }
  function close(){backdrop.hidden=true;toolbar.setAttribute('aria-expanded','false');returnFocus?.focus();}
  function open(){returnFocus=document.activeElement as HTMLElement|null;backdrop.hidden=false;toolbar.setAttribute('aria-expanded','true');closeButton.focus();void refresh();}
  toolbar.addEventListener('click',open);closeButton.addEventListener('click',close);refreshButton.addEventListener('click',()=>void refresh());releaseButton.addEventListener('click',()=>void release());
  backdrop.addEventListener('click',event=>{if(event.target===backdrop)close();});
  backdrop.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
    if(event.key==='Tab'){
      const controls=Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled)')).filter(item=>!item.hidden && item.getClientRects().length);
      if(!controls.length)return;
      if(event.shiftKey && document.activeElement===controls[0]){event.preventDefault();controls.at(-1)!.focus();}
      else if(!event.shiftKey && document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}
    }
  });
  function event(value:any){
    if(typeof value?.name!=='string' || !value.name.startsWith('windows_'))return false;
    const entry=make('li','','windows-activity-entry');
    const state=value.type==='tool_call'?'Running':value.denied?'Denied':value.result?.ok===false?'Failed':'Completed';
    entry.textContent=`${state} · ${value.name.slice(8).replace(/_/g,' ')}`;entry.setAttribute('data-state',state.toLowerCase());activity.append(entry);
    while(activity.children.length>25)activity.firstElementChild?.remove();
    const result=value.result;
    if(selected && result?.ok!==false && Number.isSafeInteger(result?.revision) && result.revision >= (revision ?? 0)){
      revision=result.revision;
      for(const content of result?.images || []){
        if(!['image/png','image/jpeg','image/webp'].includes(content?.mimeType) || typeof content?.data!=='string' || !content.data.length || content.data.length>8*1024*1024*4/3 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content.data))continue;
        image.onerror=()=>{clearImage();caption.textContent='This screenshot could not be displayed. Ask Muse for a fresh screenshot.';};image.src=`data:${content.mimeType};base64,${content.data}`;image.alt=`Latest screenshot of ${selected.title || 'the selected window'}`;image.hidden=false;empty.hidden=true;
        caption.textContent='Latest screenshot returned during a task. It may also be sent to the selected model.';break;
      }
    }
    return true;
  }
  render();return {open,close,refresh,event,busyChanged:render};
}
(window as any).MuseWindows={create};
