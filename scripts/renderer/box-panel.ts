type BoxState = {state?: string; status?: string; connected?: boolean; tools?: number | any[]; message?: string; error?: string};
type BoxApi = {boxStatus?: () => Promise<BoxState>; boxConnect?: () => Promise<any>; boxDisconnect?: () => Promise<any>;
  boxCancel?: () => Promise<any>; boxOpenDesktop?: () => Promise<any>; onBoxStatus?: (fn: (value: BoxState) => void) => (() => void)};
type Options = {api?: BoxApi; busy?: () => boolean};
const states: Record<string, [string,string]> = {
  disconnected:['Disconnected','Connect your Simular account to give Muse a cloud desktop.'],
  auth_required:['Sign in needed','Connect Box and approve Muse in your browser.'],
  authorizing:['Waiting for sign-in','Finish signing in and approving Muse in the browser.'],
  connecting:['Connecting','Connecting to your cloud desktop and discovering its tools…'],
  connected:['Connected','Your cloud desktop tools are available to Muse.'],
  error:['Connection problem','Box could not connect. Try connecting again.'],
};
function safeText(value: unknown) {
  return String(value || '').replace(/\bBearer\s+\S+/gi,'Bearer [hidden]')
    .replace(/\bcb_[A-Za-z0-9_-]+/g,'[hidden key]')
    .replace(/(["']?(?:access_token|refresh_token|client_secret|authorization)["']?\s*[:=]\s*["']?)[^"'&\s}]+/gi,'$1[hidden]')
    .replace(/([?&](?:code|access_token|refresh_token|token|state)=)[^\s&#]+/gi,'$1[hidden]').slice(0,500);
}
function create(options: Options = {}) {
  const api: BoxApi = options.api || (window as any).muse || {};
  const el = (id: string) => document.getElementById(id)!;
  const button = (id: string) => el(id) as HTMLButtonElement;
  const isBusy = () => !!options.busy?.();
  let value: BoxState = {state:'disconnected'}, localPending = false, opened = false;
  let returnFocus: HTMLElement | null = null;
  const callbacks: (() => void)[] = [];
  function normalized(state: BoxState) {
    const key = state.state || state.status || (state.connected ? 'connected' : 'disconnected');
    return key === 'authenticated' ? 'connected' : key === 'signing_in' || key === 'sign_in_pending' ? 'authorizing'
      : states[key] ? key : 'disconnected';
  }
  function clearPreview() {
    const image = el('box-preview-image') as HTMLImageElement;
    image.onerror = null;
    image.hidden = true; image.removeAttribute('src'); el('box-preview-empty').hidden = false;
    el('box-preview-caption').textContent = 'Screenshots appear here when Box returns one during a task.';
  }
  function render() {
    const state = normalized(value), [label,description] = states[state];
    const pending = localPending || state === 'authorizing' || state === 'connecting';
    const connected = state === 'connected';
    const count = Array.isArray(value.tools) ? value.tools.length : Number.isFinite(value.tools) ? value.tools : 0;
    for (const id of ['box-settings-status','box-panel-status']) {
      el(id).textContent = label; el(id).setAttribute('data-state',state);
    }
    for (const id of ['box-settings-detail','box-panel-detail']) {
      el(id).textContent = connected && count ? `${count} cloud desktop tools ready. Actions follow Muse’s permission mode.` : safeText(value.message) || description;
    }
    for (const prefix of ['box-settings','box-panel']) {
      button(prefix+'-connect').hidden = connected;
      button(prefix+'-connect').disabled = pending || isBusy() || !api.boxConnect;
      button(prefix+'-connect').textContent = pending ? 'Connecting…' : state === 'error' ? 'Try again' : 'Connect Box';
      button(prefix+'-disconnect').hidden = !connected;
      button(prefix+'-disconnect').disabled = pending || isBusy();
      button(prefix+'-open').disabled = !connected || !api.boxOpenDesktop;
    }
    button('box-panel-cancel').hidden = !pending;
    button('box-panel-cancel').disabled = !api.boxCancel;
    button('box-panel-refresh').disabled = localPending;
    el('box-panel-error').textContent = safeText(value.error);
    el('box-panel').setAttribute('aria-busy',String(pending));
    button('box-toolbar-open').setAttribute('data-state',state);
    button('box-toolbar-open').title = `Box · ${label}`;
    if (state === 'disconnected' || state === 'auth_required') clearPreview();
  }
  function status(next: BoxState) {
    const wasConnected = normalized(value) === 'connected';value = {...next};
    if(wasConnected && normalized(value) !== 'connected')el('box-activity-list').replaceChildren();
    render();
  }
  async function refresh() {
    if (!api.boxStatus) {status({state:'error',error:'Box controls are unavailable. Restart the updated Muse app.'});return;}
    try {status(await api.boxStatus());}
    catch {status({state:'error',error:'Could not load Box status. Try refreshing.'});}
  }
  function close() {
    opened = false;el('box-backdrop').hidden = true;button('box-toolbar-open').setAttribute('aria-expanded','false');
    returnFocus?.focus();
  }
  function open() {
    if (!opened) returnFocus = document.activeElement as HTMLElement | null;
    opened = true;el('box-backdrop').hidden = false;button('box-toolbar-open').setAttribute('aria-expanded','true');
    render();button('box-panel-close').focus();void refresh();
  }
  async function perform(name: 'boxConnect'|'boxDisconnect'|'boxCancel'|'boxOpenDesktop') {
    if ((name === 'boxConnect' || name === 'boxDisconnect') && (localPending || isBusy())) return;
    const operation = api[name];if (!operation) return;
    if (name !== 'boxOpenDesktop' && name !== 'boxCancel') localPending = true;
    if (name === 'boxConnect') value = {state:'connecting'};
    value.error = '';render();
    try {
      const response = await operation.call(api);
      if (response?.ok === false) throw Error(response.error || 'Box action failed. Try again.');
      if (name !== 'boxOpenDesktop') {
        if (response?.state || response?.status) status(response);
        else await refresh();
      }
    } catch(error) {
      value = {...value,error:safeText((error as Error).message || 'Box action failed. Try again.')};
      if (name === 'boxConnect') value.state = 'error';
    } finally {if (name !== 'boxCancel') localPending = false;render();}
  }
  for (const prefix of ['box-settings','box-panel']) {
    button(prefix+'-connect').addEventListener('click',()=>void perform('boxConnect'));
    button(prefix+'-disconnect').addEventListener('click',()=>void perform('boxDisconnect'));
    button(prefix+'-open').addEventListener('click',()=>void perform('boxOpenDesktop'));
  }
  button('box-toolbar-open').addEventListener('click',open);
  button('box-panel-close').addEventListener('click',close);
  button('box-panel-cancel').addEventListener('click',()=>void perform('boxCancel'));
  button('box-panel-refresh').addEventListener('click',()=>void refresh());
  el('box-backdrop').addEventListener('click',event=>{if(event.target === el('box-backdrop'))close();});
  el('box-backdrop').addEventListener('keydown',event=>{
    if(event.key === 'Escape'){event.preventDefault();event.stopPropagation();close();}
    if(event.key === 'Tab') {
      const controls = Array.from(el('box-panel').querySelectorAll<HTMLElement>('button:not(:disabled),[href],input:not(:disabled)')).filter(item=>!item.hidden && item.getClientRects().length);
      if(!controls.length)return;
      if(event.shiftKey && document.activeElement === controls[0]){event.preventDefault();controls.at(-1)!.focus();}
      else if(!event.shiftKey && document.activeElement === controls.at(-1)){event.preventDefault();controls[0].focus();}
    }
  });
  if(api.onBoxStatus) callbacks.push(api.onBoxStatus(status));
  function handleImage(content: any) {
    if(normalized(value) !== 'connected')return false;
    if(!content || !['image/png','image/jpeg','image/webp'].includes(content.mimeType) || typeof content.data !== 'string')return false;
    if(content.data.length > 8*1024*1024*4/3 || !content.data.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(content.data))return false;
    const image=el('box-preview-image') as HTMLImageElement;
    image.onerror=()=>{clearPreview();el('box-preview-caption').textContent='This screenshot could not be displayed. Use Open desktop to inspect the live screen.';};
    image.src=`data:${content.mimeType};base64,${content.data}`;image.alt='Latest screenshot returned by your Box cloud desktop';image.hidden=false;
    el('box-preview-empty').hidden=true;el('box-preview-caption').textContent='Latest captured screen · use Open desktop for the live view.';return true;
  }
  function event(ev: any) {
    if(!ev || typeof ev.name !== 'string' || !ev.name.startsWith('mcp__box__'))return false;
    const list=el('box-activity-list');
    const line=document.createElement('li');line.className='box-activity-entry';
    const name=ev.name.slice('mcp__box__'.length).replace(/_/g,' ');
    const action=ev.type === 'tool_call' ? 'Running' : ev.denied ? 'Denied' : ev.result?.ok === false ? 'Failed' : 'Completed';
    line.textContent=`${action} · ${name}`;line.setAttribute('data-state',action.toLowerCase());list.append(line);
    while(list.children.length>30)list.firstElementChild?.remove();
    for(const item of ev.result?.content || [])if(item.type==='image')handleImage(item);
    return true;
  }
  render();
  return {refresh,open,close,status,event,handleImage,busyChanged:render,destroy(){for(const stop of callbacks)stop();}};
}
(window as any).MuseBox={create};
