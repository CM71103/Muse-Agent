const fieldIds = ['f-base', 'f-key', 'model-list', 'f-embed-base', 'f-embed-model', 'f-embed-key'];
function createSettingsPanel(options: { visibleModels?: () => string[] } = {}) {
  const el = (id: string) => document.getElementById(id)!;
  const input = (id: string) => el(id) as HTMLInputElement;
  let baseline = '', saving = false, fetching = false, loaded = false, state = 'idle', tab = 'connection';
  let savedEmbedKey = false;
  const values = () => JSON.stringify([fieldIds.map(id => input(id).value.trim()), options.visibleModels?.() || []]);
  const dirty = () => loaded && values() !== baseline;
  function render() {
    const changed = dirty();
    el('settings-model-preview').textContent = input('model-list').value.trim() || 'Choose a model';
    let host = 'Your model endpoint';
    try { host = new URL(input('f-base').value).host; } catch {}
    el('settings-endpoint-preview').textContent = host;
    el('connection-state').textContent = saving ? 'Saving' : changed ? 'Unsaved changes' : state === 'saved' ? 'Saved' : 'Current connection';
    el('connection-state').setAttribute('data-state', saving ? 'saving' : changed ? 'dirty' : state);
    const btn = el('btn-save') as HTMLButtonElement;
    btn.disabled = !loaded || saving || (!changed && state !== 'failed');
    btn.textContent = saving ? 'Saving…' : state === 'saved' && !changed ? 'Saved' : state === 'failed' ? 'Try again' : 'Save connection';
    btn.classList.toggle('ok', state === 'saved' && !changed);
    btn.classList.toggle('failed', state === 'failed');
    btn.hidden = tab !== 'connection';
    el('settings-save-note').textContent = tab !== 'connection' ? ({ workspace: 'Workspace preferences apply immediately.', mcp: 'Add or update a server to apply your changes.', shortcuts: 'Your shortcuts are always a keypress away.' }[tab] || '') : saving
      ? 'Applying your connection. Updating memory may take longer.' : changed ? 'You have unsaved connection changes.'
      : state === 'saved' ? 'Connection saved. Ready for your next message.' : 'Connection is saved locally. Fetch models checks your endpoint.';
    (el('btn-cancel') as HTMLButtonElement).disabled = saving;
    for (const id of [...fieldIds, 'btn-fetch', 'btn-eye', 'btn-embed-eye']) (el(id) as HTMLInputElement).disabled = saving || !loaded;
    const pendingEmbedKey = !!input('f-embed-key').value.trim();
    input('f-embed-key').placeholder = savedEmbedKey ? '•••••••• · saved key' : 'Enter a key, or use the chat key';
    (el('btn-embed-eye') as HTMLButtonElement).disabled = saving || !loaded || !pendingEmbedKey;
    el('embed-key-state').textContent = !loaded ? 'Checking…' : pendingEmbedKey ? 'Not saved yet' : savedEmbedKey ? 'Key saved' : 'Using chat key';
    el('embed-key-state').setAttribute('data-state', pendingEmbedKey ? 'pending' : savedEmbedKey ? 'saved' : 'fallback');
    el('embed-key-hint').textContent = pendingEmbedKey
      ? 'Click Save connection to store this key securely and use it next time.'
      : savedEmbedKey ? 'Your embedding key is saved securely and reused automatically. You do not need to enter it again. Type here only to replace it.'
      : 'No separate embedding key is saved. Muse uses your chat API key.';
    el('embed-key-summary').textContent = savedEmbedKey ? 'Key saved · reused automatically' : 'Optional · customize how Muse recalls context';
    (el('btn-fetch') as HTMLButtonElement).disabled = saving || fetching || !loaded;
    el('settings').setAttribute('aria-busy', String(saving || !loaded));
  }
  for (const id of fieldIds) el(id).addEventListener('input', () => {
    if (id === 'f-base' || id === 'f-key') {
      el('models-status').textContent = '';
    }
    state = 'idle'; el('settings-err').textContent = ''; render();
  });
  return {
    isSaving: () => saving,
    isDirty: dirty,
    loading() {
      loaded = false; fetching = false; state = 'idle';
      el('models-status').textContent = ''; el('btn-fetch').textContent = 'Fetch models'; el('btn-fetch').classList.remove('busy'); render();
    },
    loaded(settings: { embed_key_set?: boolean } = {}) { loaded = true; savedEmbedKey = !!settings.embed_key_set; baseline = values(); state = 'idle'; render(); },
    failedLoad() { loaded = false; render(); },
    changed() { state = 'idle'; el('settings-err').textContent = ''; render(); },
    fetching(active: boolean) { fetching = active; render(); },
    setState(next: string) {
      state = next; saving = next === 'saving';
      if (next === 'saved') {
        savedEmbedKey = savedEmbedKey || !!input('f-embed-key').value.trim();
        input('f-key').value = ''; input('f-embed-key').value = ''; baseline = values();
        input('f-key').type = input('f-embed-key').type = 'password';
        el('btn-eye').textContent = el('btn-embed-eye').textContent = 'show';
      }
      render();
    },
    selectTab(name: string) { tab = name; render(); },
    validate() {
      const base = input('f-base').value.trim();
      let url: URL;
      try { url = new URL(base); } catch { input('f-base').focus(); throw Error('Enter a valid endpoint URL.'); }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        input('f-base').focus(); throw Error('Use HTTPS, or HTTP for a local server.');
      }
      if (url.username || url.password) { input('f-base').focus(); throw Error('Put your API key in the key field, not the endpoint URL.'); }
      if (!input('model-list').value.trim()) { input('model-list').focus(); throw Error('Choose or enter a model before saving.'); }
    },
  };
}
(window as any).MuseSettings = { create: createSettingsPanel };
