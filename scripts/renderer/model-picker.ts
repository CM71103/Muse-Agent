type ModelConfig = { model?: string; visible_models?: string[]; base_url?: string };
type Hooks = { changed: () => void; busy: () => boolean; switching: (active: boolean) => void;
  select: (model: string) => Promise<{ok: boolean; error?: string; model?: string; visible_models?: string[]}>; manage: () => void };
function create(hooks: Hooks) {
  const el = (id: string) => document.getElementById(id)!;
  const input = (id: string) => el(id) as HTMLInputElement;
  const button = (id: string) => el(id) as HTMLButtonElement;
  let current = '', saved: string[] = [], draft: string[] = [], available: string[] = [];
  let ready = false, locked = false, switching = false, endpoint = '', opened: 'settings' | 'chat' | null = null;
  const unique = (ids: string[]) => [...new Set(ids.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  const visible = (cfg: ModelConfig) => Array.isArray(cfg.visible_models) ? unique(cfg.visible_models) : cfg.model ? [cfg.model] : [];
  function close(focus = false) {
    if (!opened) return;
    const owner = opened;el(`model-menu-${owner}`).hidden = true;
    button(owner === 'settings' ? 'btn-model-options' : 'chat-model-trigger').setAttribute('aria-expanded','false');
    opened = null;
    if (focus) button(owner === 'settings' ? 'btn-model-options' : 'chat-model-trigger').focus();
  }
  function renderChat() {
    el('chat-model-label').textContent = current || 'Choose model';
    button('chat-model-trigger').disabled = !ready || switching || hooks.busy();
    button('chat-model-trigger').title = current ? `Current model: ${current}` : 'Choose a chat model';
    el('chat-model-status').textContent = switching ? 'Switching model…' : '';
  }
  function position(owner: 'settings' | 'chat') {
    const anchor = owner === 'settings' ? input('model-list') : button('chat-model-trigger');
    if (typeof anchor.getBoundingClientRect !== 'function') return;
    const box = anchor.getBoundingClientRect(), menu = el(`model-menu-${owner}`);
    const width = Math.min(owner === 'settings' ? Math.max(box.width, 410) : 360, window.innerWidth - 24);
    const below = window.innerHeight - box.bottom - 16, above = box.top - 16;
    const useAbove = owner === 'chat' || below < 230 && above > below;
    const height = Math.max(150, Math.min(390, useAbove ? above : below));
    menu.style.width = `${width}px`;menu.style.maxHeight = `${height}px`;
    menu.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`;
    menu.style.top = useAbove ? 'auto' : `${box.bottom + 8}px`;
    menu.style.bottom = useAbove ? `${window.innerHeight - box.top + 8}px` : 'auto';
  }
  function row(model: string, owner: 'settings' | 'chat') {
    const item = document.createElement('div');item.className = 'model-picker-row';
    const select = document.createElement('button');select.type = 'button';select.className = 'model-picker-select';
    select.textContent = model;select.title = model;select.disabled = switching || locked;
    select.setAttribute('aria-label', `Use ${model}`);
    const active = owner === 'chat' ? current : input('model-list').value.trim();
    select.setAttribute('aria-pressed',String(model === active));
    select.addEventListener('click', async () => {
      if (locked || switching || owner === 'chat' && hooks.busy()) return;
      if (owner === 'settings') {
        input('model-list').value = model;hooks.changed();close(true);return;
      }
      if (model === current) {close(true);return;}
      switching = true;hooks.switching(true);el('chat-model-error').textContent = '';renderChat();renderRows('chat');
      try {
        const result = await hooks.select(model);
        if (!result?.ok) throw Error(result?.error || 'Could not switch models. Try again.');
        current = result.model || model;if (result.visible_models) saved = unique(result.visible_models);
        close(true);
      } catch(error) {el('chat-model-error').textContent = (error as Error).message || 'Could not switch models. Try again.';}
      finally {switching = false;hooks.switching(false);renderChat();if (opened === 'chat') renderRows('chat');else button('chat-model-trigger').focus();}
    });
    item.append(select);
    if (owner === 'settings') {
      const label = document.createElement('label');label.className = 'model-picker-pin';label.title = 'Show this model in the chat picker';
      const check = document.createElement('input');check.type = 'checkbox';check.checked = draft.includes(model);check.disabled = locked;
      check.setAttribute('aria-label', `Show ${model} in chat`);
      check.addEventListener('change', () => {
        if (locked) return;
        if (check.checked && !draft.includes(model)) {
          if (draft.length >= 100) { check.checked = false;el('models-status').textContent = 'Choose up to 100 models for chat.';return; }
          draft.push(model);
        } else if (!check.checked) draft = draft.filter(id => id !== model);
        renderSummary();hooks.changed();
      });
      const caption = document.createElement('span');caption.textContent = 'In chat';label.append(check,caption);item.append(label);
    }
    return item;
  }
  function renderSummary() {
    el('chat-models-summary').textContent = draft.length ? `${draft.length} model${draft.length === 1 ? '' : 's'} visible in chat` : 'No models selected for chat';
  }
  function renderRows(owner: 'settings' | 'chat') {
    const host = el(`model-results-${owner}`);host.replaceChildren();
    const query = input(`model-search-${owner}`).value.trim().toLowerCase();
    const ids = owner === 'settings' ? unique([...available,...draft,input('model-list').value.trim()]) : saved;
    const filtered = ids.filter(id => id.toLowerCase().includes(query));
    for (const model of filtered) host.append(row(model,owner));
    if (!filtered.length) {
      const empty = document.createElement('p');empty.className = 'model-picker-empty';
      empty.textContent = query ? 'No matching models.' : owner === 'chat' ? 'Choose models in Settings to show them here.' : 'Fetch models, or enter a model ID above.';host.append(empty);
    }
    if (owner === 'settings') {
      const model = input('model-list').value.trim();
      button('model-add-manual').hidden = !model || draft.includes(model);
      button('model-add-manual').disabled = locked;
      renderSummary();
    }
  }
  function open(owner: 'settings' | 'chat') {
    if (owner === 'chat' && (!ready || switching || hooks.busy()) || owner === 'settings' && locked) return;
    if (opened === owner) {close(true);return;}
    close();opened = owner;el(`model-menu-${owner}`).hidden = false;input(`model-search-${owner}`).value = '';
    button(owner === 'settings' ? 'btn-model-options' : 'chat-model-trigger').setAttribute('aria-expanded','true');
    renderRows(owner);position(owner);input(`model-search-${owner}`).focus();
  }
  button('btn-model-options').addEventListener('click',()=>open('settings'));
  button('chat-model-trigger').addEventListener('click',()=>open('chat'));
  button('model-manage').addEventListener('click',()=>{if (switching) return;close();hooks.manage();});
  button('model-add-manual').addEventListener('click',()=>{
    const model = input('model-list').value.trim();if (!model || locked || draft.includes(model) || draft.length >= 100) return;
    draft.push(model);renderRows('settings');hooks.changed();
  });
  for (const owner of ['settings','chat'] as const) {
    button(`model-close-${owner}`).addEventListener('click',()=>close(true));
    input(`model-search-${owner}`).addEventListener('input',()=>renderRows(owner));
    el(`model-menu-${owner}`).addEventListener('keydown',event=>{
      if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();close(true);return;}
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      const controls = Array.from(el(`model-results-${owner}`).querySelectorAll<HTMLButtonElement>('.model-picker-select:not(:disabled)'));
      if (!controls.length) return;event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : event.key === 'ArrowDown' ? (at + 1) % controls.length : (at <= 0 ? controls.length - 1 : at - 1);
      controls[next].focus();
    });
  }
  input('model-list').addEventListener('keydown',event=>{if (event.key === 'ArrowDown') {event.preventDefault();open('settings');}});
  document.addEventListener?.('pointerdown',event=>{
    if (!opened) return;const trigger = el(opened === 'settings' ? 'btn-model-options' : 'chat-model-trigger');
    if (!el(`model-menu-${opened}`).contains(event.target as Node) && !trigger.contains(event.target as Node)) close();
  });
  window.addEventListener('resize',()=>{if (opened) position(opened);});
  document.addEventListener?.('scroll',()=>{if (opened) position(opened);},true);
  return {
    draftModels:()=>draft.slice(), close,
    sync(cfg: ModelConfig) {current = cfg.model || '';saved = visible(cfg);ready = true;renderChat();},
    load(cfg: ModelConfig) {draft = visible(cfg);available = unique([...(endpoint === (cfg.base_url || '') ? available : []),...draft,cfg.model || '']);endpoint = cfg.base_url || '';close();renderSummary();},
    available(ids: string[]) {available = unique(ids);renderRows('settings');},
    changedEndpoint(base: string) {if (base.trim() !== endpoint.trim()) {available = [];draft = [];renderSummary();close();}},
    setLocked(value: boolean) {locked = value;button('btn-model-options').disabled = value;if(value)close();},
    busyChanged() {renderChat();if(hooks.busy())close();},
    saved() {saved = draft.slice();current = input('model-list').value.trim();renderChat();close();},
    showSettings() {open('settings');},
  };
}
(window as any).MuseModelPicker = {create};
