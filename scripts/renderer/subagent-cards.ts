type AgentEvent = { type: string; subagent?: boolean; subagentId?: string; task?: string; text?: string;
  name?: string; result?: unknown; error?: string; cancelled?: boolean; denied?: boolean; turn?: number; turns?: number };
type Hooks = { transcript: HTMLElement; clearEmpty: () => void; activity: (text: string) => void; count: (count: number) => void };
type Card = { label: string; state: string; status: HTMLElement; progress: HTMLElement; log: HTMLElement; result: HTMLElement; root: HTMLElement };

function create(hooks: Hooks) {
  const cards = new Map<string, Card>();
  const tools: Record<string, string> = { shell: 'Running a command', read_file: 'Reading a file', write_file: 'Writing a file', list_dir: 'Exploring files', web_fetch: 'Reading a web page' };
  const count = () => hooks.count([...cards.values()].filter(card => card.state === 'running').length);
  function cardFor(id: string, task = 'Delegated task') {
    if (cards.has(id)) return cards.get(id)!;
    hooks.clearEmpty();
    const root = document.createElement('section'); root.className = 'subagent-card'; root.setAttribute('data-state', 'running');
    const header = document.createElement('div'); header.className = 'subagent-heading';
    const title = document.createElement('strong'); title.textContent = `Subagent ${cards.size + 1}`;
    const status = document.createElement('span'); status.className = 'subagent-state'; status.textContent = 'Running'; status.setAttribute('aria-live', 'polite');
    header.append(title, status);
    const description = document.createElement('p'); description.className = 'subagent-task'; description.textContent = task.slice(0, 600);
    const progress = document.createElement('div'); progress.className = 'subagent-progress'; progress.textContent = 'Starting task…';
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'View activity and result';
    const log = document.createElement('div'); log.className = 'subagent-log'; log.setAttribute('role', 'log');
    const result = document.createElement('pre'); result.className = 'subagent-result'; result.hidden = true;
    details.append(summary, log, result); root.append(header, description, progress, details);
    const card = { label: title.textContent, state: 'running', status, progress, log, result, root };
    cards.set(id, card); hooks.transcript.append(root); count();
    return card;
  }
  function append(card: Card, text: string) {
    const line = document.createElement('p'); line.textContent = text.slice(0, 1600);
    card.log.append(line);
    while (card.log.children.length > 40) card.log.firstElementChild?.remove();
  }
  return {
    label: (id?: string) => (id && cards.get(id)?.label) || 'Subagent',
    reset() { cards.clear(); count(); },
    handle(event: AgentEvent) {
      if (!event.subagent && event.type !== 'subagent_start' && event.type !== 'subagent_done') return false;
      const card = cardFor(event.subagentId || 'legacy-child', event.task);
      if (event.type === 'subagent_start') hooks.activity(`${card.label} started`);
      else if (event.type === 'subagent_done') {
        card.state = event.error ? 'failed' : event.cancelled ? 'cancelled' : 'completed';
        card.root.setAttribute('data-state', card.state);
        card.status.textContent = event.error ? 'Failed' : event.cancelled ? 'Cancelled' : 'Completed';
        card.progress.textContent = event.error || (event.cancelled ? 'The delegated task was stopped.' : `Finished in ${event.turns || 0} steps.`);
        card.result.textContent = String(event.result || event.error || '').slice(0, 60000);
        card.result.hidden = !card.result.textContent;
        hooks.activity(`${card.label} ${card.status.textContent.toLowerCase()}`); count();
      } else if (event.type === 'tool_call') {
        card.progress.textContent = tools[event.name || ''] || 'Using a tool';
        append(card, `${card.progress.textContent}: ${event.name || ''}`);
      } else if (event.type === 'tool_result') {
        append(card, event.denied ? `Tool blocked: ${event.name || ''}` : `Tool finished: ${event.name || ''}`);
      } else if (event.type === 'message' || event.type === 'error' || event.type === 'info') {
        if (event.text) append(card, event.text);
        if (event.type === 'error') card.progress.textContent = event.text || 'An error occurred.';
      } else if (event.type === 'turn') card.progress.textContent = `Working · step ${(event.turn || 0) + 1}`;
      // Child 'done' only ends a child model loop. The parent owns the composer/busy state.
      return true;
    },
  };
}
(window as any).MuseSubagents = { create };
