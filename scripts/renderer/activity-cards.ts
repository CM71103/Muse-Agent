type ToolEvent = {id?: string; name: string; args?: any; result?: any; restored?: boolean};
type Hooks = {transcript: HTMLElement; openCards: Map<string, any>; clearEmpty: () => void; scrollDown: () => void; reveal: (el: HTMLElement, distance: number) => void};
const labels: Record<string, [string, string]> = {
  shell: ['Run command', '⌘'], read_file: ['Read file', '↗'], write_file: ['Write file', '✎'],
  list_dir: ['Explore folder', '▱'], web_fetch: ['Read web page', '↗'],
};
function describe(name: string, args: any = {}) {
  const [title, icon] = labels[name] || [name.startsWith('mcp__') ? 'Use connected tool' : 'Use tool', '◇'];
  const input = name === 'shell' ? String(args.command || '') : name === 'write_file'
    ? `${args.path || ''}\n\n${args.content || ''}` : String(args.path || args.url || JSON.stringify(args, null, 2));
  const category = name === 'shell' ? /powershell|pwsh/i.test(input) ? 'PowerShell' : 'Terminal'
    : ['read_file','write_file','list_dir'].includes(name) ? 'Files' : name === 'web_fetch' ? 'Web' : 'Tool';
  return {title, icon, input, category};
}
function outputOf(result: any): string {
  if (typeof result === 'string') return result;
  if (!result) return 'No output returned.';
  if (typeof result.output === 'string') return result.output || 'Completed with no output.';
  if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
    return [result.stdout, result.stderr && `Error output:\n${result.stderr}`].filter(Boolean).join('\n') || 'Completed with no output.';
  }
  if (typeof result.content === 'string') return result.content;
  if (typeof result.error === 'string') return result.error;
  return JSON.stringify(result, null, 2);
}
function node(tag: string, cls: string, text?: string) {
  const el = document.createElement(tag); el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function copyButton(text: string, label: string) {
  const button = node('button', 'activity-copy', 'Copy') as HTMLButtonElement; button.type = 'button';
  button.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
    catch { button.textContent = 'Copy failed'; }
    setTimeout(() => {button.textContent = 'Copy';}, 1500);
  });
  return button;
}
function section(label: string, text: string, raw = false) {
  const box = node('div', 'activity-section' + (raw ? ' activity-raw' : ''));
  const head = node('div', 'activity-section-head');head.append(node('span', '', label), copyButton(text, label));
  const pre = node('pre', 'activity-code', text.slice(0, 12000)); box.append(head, pre);
  if (text.length > 12000) {
    const expand = node('button', 'activity-expand', 'Show full output') as HTMLButtonElement;
    expand.addEventListener('click', () => { pre.textContent = text; expand.remove(); });box.append(expand);
  }
  return box;
}
function create(hooks: Hooks) {
  return {
    add(event: ToolEvent) {
      hooks.clearEmpty();
      if (event.id && hooks.openCards.has(event.id)) {
        const card = hooks.openCards.get(event.id); hooks.openCards.delete(event.id);card.finish(event);return;
      }
      const info = describe(event.name, event.args || {});
      const row = node('div', 'tool-row activity-card');
      const details = document.createElement('details'); details.open = !event.restored;
      const summary = document.createElement('summary');
      const head = node('div', 'tr-head');
      const title = node('div', 'activity-title'); title.append(node('strong', 'tname', info.title), node('span', 'activity-tool-name', `${info.category} · ${event.name}`));
      const dot = node('span', 'tr-dot'); const status = node('span', 'activity-state', 'Running'); status.setAttribute('aria-live', 'polite');
      const duration = node('span', 'tr-dur'); const chevron = node('span', 'activity-chevron', '⌄');chevron.setAttribute('aria-hidden','true');
      head.append(node('span', 'activity-icon', info.icon), title, dot, status, duration, chevron);
      summary.append(head); details.append(summary);
      if (event.args != null) {
        details.append(section(event.name === 'shell' ? 'Command' : 'Request', info.input));
        const raw = document.createElement('details'); raw.className = 'activity-request-details';
        raw.append(node('summary', '', 'Request details'), section('Arguments', JSON.stringify(event.args, null, 2), true)); details.append(raw);
      }
      const output = node('div', 'activity-output');details.append(output);row.append(details);
      const started = Date.now();
      const finish = (resultEvent: ToolEvent) => {
        const failed = resultEvent.result?.ok === false;
        dot.classList.remove('running'); dot.classList.add(failed ? 'fail' : 'ok');
        row.setAttribute('data-state', failed ? 'failed' : event.restored ? 'restored' : 'completed');
        if (failed) row.classList.add('failed');
        status.textContent = failed ? 'Failed' : event.restored ? 'Restored' : 'Completed';
        duration.textContent = event.restored ? '' : ((Date.now() - started) / 1000).toFixed(1) + 's';
        output.replaceChildren(section('Output', outputOf(resultEvent.result)));
        // Preserve the user's expanded/collapsed choice when the result arrives.
        hooks.scrollDown();
      };
      if (event.result !== undefined) finish(event);
      else if (event.restored) {status.textContent = 'Restored';row.setAttribute('data-state','restored');output.append(section('Output','No output recorded in this session.'));}
      else {
        dot.classList.add('running');row.setAttribute('data-state','running');output.append(node('p','activity-waiting','Running · output will appear here when the tool finishes.'));
        if (event.id) hooks.openCards.set(event.id, {finish});
        else {status.textContent = 'Requested';dot.classList.remove('running');}
      }
      hooks.transcript.append(row);hooks.reveal(row, 8);hooks.scrollDown();
    },
    denied(name: string, reason: string) {
      hooks.clearEmpty();
      const info = describe(name); const row = node('div','tool-row activity-card denied');row.setAttribute('data-state','denied');
      const header = node('div','tr-head'); const title=node('div','activity-title');title.append(node('strong','tname',info.title),node('span','activity-tool-name',name));
      header.append(node('span','activity-icon','◇'),title,node('span','activity-state','Denied'));
      row.append(header,node('p','activity-denial',`Request denied — ${reason || 'Permission was not granted.'}`));
      hooks.transcript.append(row);hooks.reveal(row,8);hooks.scrollDown();
    },
  };
}
(window as any).MuseActivity = {create, describe};
