const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

// The Design Studio panel is authored in TypeScript and bundled for the
// renderer; exercise the source against a DOM stub, the same way the other
// panel tests do.
const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../../../scripts/renderer/design-panel.ts'), 'utf8'));

class Element {
  id = ''; tagName = 'div'; hidden = false; disabled = false; checked = false; text = ''; title = ''; selected = false; _value = '';
  src = ''; className = ''; htmlFor = ''; parent: any = null; children: any[] = []; attrs: any = {}; listeners: any = {};
  dataset: any = {}; style: any = {}; classes = new Set<string>(); doc: any;
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on?: boolean) => { const want = on === undefined ? !this.classes.has(name) : on; if (want) this.classes.add(name); else this.classes.delete(name); return want; },
  };
  constructor(tagName = 'div') { this.tagName = tagName; }
  // A real <select> reports the chosen option as its value; the panel reads
  // selections straight back off the element, so mirror that behaviour.
  get value() { if (this.tagName === 'select') { const chosen = this.children.find(node => node.selected) || this.children.find(node => node.value); return chosen ? chosen.value : ''; } return this._value; }
  set value(value: any) {
    this._value = String(value);
    if (this.tagName !== 'select') return;
    let matched = false;
    for (const node of this.children) { node.selected = node.value === this._value; if (node.selected) matched = true; }
    if (!matched && this._value === '') { /* nothing chosen keeps the first blank option */ }
  }
  get textContent() { return this.children.length ? this.children.map(node => String(node.textContent)).join('') : this.text; }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...nodes: any[]) { for (const node of nodes) { if (!node) continue; node.parent = this; this.children.push(node); } }
  insertBefore(node: any, reference: any) { const at = reference ? this.children.indexOf(reference) : -1; node.parent = this; if (at < 0) this.children.push(node); else this.children.splice(at, 0, node); }
  replaceChildren(...nodes: any[]) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  setAttribute(key: string, value: any) { this.attrs[key] = value; if (key === 'hidden') this.hidden = true; }
  getAttribute(key: string) { return key in this.attrs ? String(this.attrs[key]) : (key === 'aria-expanded' ? 'false' : null); }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(key: string, handler: any) { (this.listeners[key] ??= []).push(handler); }
  removeEventListener() { }
  focus() { this.doc.activeElement = this; }
  blur() { }
  closest(selector: string) { let node: any = this; while (node) { if (selector.startsWith('button[') ? node.tagName === 'button' && node.dataset[selector.slice(7, -1)] !== undefined : node === this) return node; node = node.parent; } return null; }
  querySelectorAll(selector: string) { return this.descendants().filter(node => selector.includes('input') ? node.tagName === 'input' : node.tagName === 'button'); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  descendants() { const out: any[] = []; const walk = (node: any) => { for (const child of node.children || []) { out.push(child); walk(child); } }; walk(this); return out; }
  fire(key: string, event: any = {}) { for (const handler of this.listeners[key] || []) handler({ target: this, preventDefault() { }, ...event }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function harness(api: any = {}) {
  const byId = new Map<string, Element>();
  const byClass = new Map<string, Element>();
  const document: any = {
    activeElement: null,
    createElement: (tag: string) => {
      const node = new Element(tag); node.doc = document;
      // The panel assigns element ids as it builds the tree; index them so a
      // test can find its controls the same way getElementById would.
      let internalId = '';
      Object.defineProperty(node, 'id', {
        get: () => internalId,
        set: (value: string) => { internalId = value; if (value) byId.set(value, node); },
        configurable: true,
      });
      return node;
    },
    getElementById: (id: string) => { if (!byId.has(id)) { const node = document.createElement('div'); node.id = id; byId.set(id, node); } return byId.get(id); },
    querySelector: (selector: string) => {
      if (!byClass.has(selector)) { const node = new Element('div'); node.className = selector.replace('.', ''); node.doc = document; byClass.set(selector, node); }
      return byClass.get(selector);
    },
  };
  document.body = new Element('body'); document.body.doc = document;
  const window: any = { muse: api, addEventListener() { }, removeEventListener() { } };
  const context = vm.createContext({
    window, document, console,
    MutationObserver: class { observe() { } disconnect() { } },
    ResizeObserver: class { observe() { } disconnect() { } },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => { },
    setInterval: () => 1, clearInterval: () => { }, clearTimeout: () => { },
    // Real timers let a test flush the panel's async work; the polling
    // interval stays a no-op so nothing keeps the process alive.
    setTimeout: (fn: any, ms: number) => setTimeout(fn, ms),
    URLSearchParams, URL, Blob,
  });
  vm.runInContext(source, context);
  const panel = window.MuseDesign.create({ api, busy: () => false });
  const element = (id: string) => byId.get(id)!;
  const all = (root: Element) => root.descendants();
  const text = (id: string) => element(id)?.textContent ?? '';
  const options = (id: string) => (element(id)?.children || []).map(node => node.value);
  return { panel, element, all, text, options, document, byId };
}

const STATUS = {
  ok: true, projectDir: 'C:/designs/demo', projectBaseDir: 'C:/designs/demo',
  projectJson: { name: 'demo', kind: 'prototype', design_system_id: 'muse-default', template_id: 'deck', craft: ['design-quality'] },
  systems: [{ id: 'muse-default', name: 'Muse default', source: 'bundled' }, { id: 'studio', name: 'Studio', source: 'project' }],
  skills: [{ id: 'design-review', name: 'Design review', source: 'bundled' }],
  templates: [{ id: 'deck', name: 'Deck', source: 'bundled', description: 'slide deck' }, { id: 'dashboard', name: 'Dashboard', source: 'bundled' }],
  craft: [{ id: 'design-quality', name: 'Design quality bar', source: 'bundled' }, { id: 'web-performance', name: 'Web performance craft', source: 'user' }],
  roots: [{ source: 'project', dir: 'C:/designs/demo' }, { source: 'user', dir: 'C:/home/.muse-agent/design' }, { source: 'bundled', dir: 'App' }],
  activeDesignSystemId: 'muse-default', activeSkillId: 'design-review', activeTemplateId: 'deck', activeCraft: ['design-quality'],
  artifact: { entry: 'index.html', kind: 'html', title: 'Deck' },
  preview: { url: 'muse-preview://artifact/index.html', version: 'v1', title: 'Deck', entry: 'index.html' },
  webPreview: { available: false, running: false, status: 'stopped' },
};

test('design panel lists templates and craft rules from every registry root', async () => {
  const h = harness({ designStatus: async () => STATUS });
  await h.panel.refresh();
  assert.deepEqual(h.options('design-template'), ['', 'deck', 'dashboard']);
  const craft = h.byId.get('design-panel') ? null : null;
  const rows = h.all(h.element('design-panel')).filter(node => node.className === 'design-craft-row');
  assert.equal(rows.length, 2, 'one row per craft rule');
  const boxes = rows.map(row => row.children.find(node => node.tagName === 'input'));
  assert.equal(boxes[0].checked, true, 'saved craft rule is ticked');
  assert.equal(boxes[1].checked, false);
  assert.match(h.text('design-state'), /Design workspace ready/);
  assert.match(h.all(h.element('design-panel')).find(node => node.className === 'design-registry-note')!.textContent, /project → user → bundled/);
  // Non-project entries are labelled with their source so shadowing is visible.
  const systemOption = h.element('design-system').children.find(node => node.value === 'muse-default');
  assert.match(systemOption.textContent, /Muse default · bundled/);
});

test('ticking a craft rule and saving sends the whole selection', async () => {
  const saved: any[] = [];
  const h = harness({
    designStatus: async () => STATUS,
    designSave: async (patch: any) => { saved.push(patch); return { ok: true }; },
  });
  await h.panel.refresh();
  const rows = h.all(h.element('design-panel')).filter(node => node.className === 'design-craft-row');
  const second = rows[1].children.find(node => node.tagName === 'input');
  second.checked = true;
  second.fire('change');
  h.element('design-save').fire('click');
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].craft, ['design-quality', 'web-performance']);
  assert.equal(saved[0].design_system_id, 'muse-default');
  assert.equal(saved[0].skill_id, 'design-review');
});

test('adding template files calls the workspace and reports what changed', async () => {
  const applied: any[] = [];
  const h = harness({
    designStatus: async () => STATUS,
    designApplyTemplate: async (id: string, force: boolean) => { applied.push({ id, force }); return { ok: true, written: ['index.html'], skipped: [], name: 'Deck' }; },
  });
  await h.panel.refresh();
  const template = h.element('design-template');
  template.value = 'dashboard';
  template.fire('change');
  const button = h.element('design-apply-template');
  assert.equal(button.disabled, false);
  button.fire('click');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(applied, [{ id: 'dashboard', force: false }]);
  assert.match(h.text('design-artifact'), /Template “Deck”: 1 file added/);
});

test('without a project folder the panel asks for one and locks registry edits', async () => {
  const h = harness({
    designStatus: async () => ({ ...STATUS, projectDir: null, projectJson: null, activeCraft: [], activeDesignSystemId: '', activeSkillId: '', activeTemplateId: '', artifact: null, preview: null }),
  });
  await h.panel.refresh();
  assert.match(h.text('design-state'), /no project yet/i);
  assert.equal(h.element('design-system').disabled, true, 'selection needs a project');
  assert.equal(h.element('design-apply-template').disabled, true);
  const setup = h.all(h.element('design-panel')).find(node => node.className === 'design-setup');
  assert.equal(setup!.hidden, false, 'folder chooser must be visible');
});

test('a failed design request surfaces the message instead of clearing the panel', async () => {
  const h = harness({ designStatus: async () => ({ ok: false, error: 'Disk is unreadable', systems: [], skills: [] }) });
  await h.panel.refresh();
  assert.match(h.text('design-error'), /Disk is unreadable/);
});
