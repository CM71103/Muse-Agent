'use strict';
(() => {
/* Muse Studio i18n — Hope Agent blueprint §12 skeleton.
   t(key, fallback) everywhere; DOM strings marked with data-i18n /
   data-i18n-placeholder and applied once at boot.
   The `en` bundle ships inline: the Electron renderer loads over file://,
   where fetch() of sibling JSON is unreliable. The LOCALES map keeps the
   blueprint's lazy-loader shape — a future HTTP host adds entries like
   `zh: () => fetch('lib/locales/zh.json').then(r => r.json())` with no
   call-site changes. */

const DEFAULT_LOCALE = 'en';

const BUNDLES = {
  en: {
    /* nav + brand */
    'nav.studio': 'Studio',
    'nav.memory': 'Memory',
    'nav.find': 'Find',
    'nav.settings': 'Settings',
    'brand.workspace': 'Studio workspace',
    /* sidebar */
    'sidebar.newSession': '＋ New session',
    'sidebar.yourSessions': 'Your sessions',
    'sidebar.searchPlaceholder': 'Search history…',
    'sidebar.filterAll': 'All sessions',
    'sidebar.filterCurrent': 'Current session',
    'sidebar.empty': 'No saved sessions yet. Complete a task to keep it here.',
    'sidebar.noMatch': 'No matching sessions.',
    'sidebar.handsOff': 'Hands off',
    'sidebar.handsOn': 'Hands on',
    'pips.model': 'Model',
    'pips.hands': 'Hands',
    'pips.safety': 'Safety',
    'pips.memory': 'Memory',
    /* header */
    'crumb.new': 'New session',
    'crumb.session': 'Session',
    'crumb.working': 'WORKING…',
    'tag.loadingModel': 'Loading model',
    'tag.safetyAsk': 'Safety: ask',
    'header.focus': 'Focus',
    'header.export': 'Export',
    'header.project': 'Project',
    /* composer + approval */
    'composer.placeholder': 'What would you like to work on?',
    'composer.send': 'Send',
    'approval.title': 'Your approval is required',
    'approval.body': 'Review this tool request before allowing it to run.',
    'approval.deny': 'Deny',
    'approval.allowOnce': 'Allow once',
    'question.title': 'The agent has a question',
    'question.placeholder': 'Type your answer…',
    'question.send': 'Answer',
    'question.skip': 'Skip',
    'composer.stop': 'Stop',
    'meta.safetyNote': 'Tools ask before they act. You stay in control.',
    'meta.sendHintEnter': 'Enter to send · Shift Enter for a new line',
    'meta.sendHintCtrl': 'Ctrl / ⌘ Enter to send',
    /* workbench */
    'wb.activity': 'Activity',
    'wb.memory': 'Memory',
    'wb.details': 'Details',
    'wb.status': 'Status',
    'wb.idle': 'Idle',
    'wb.model': 'Model',
    'wb.safetyMode': 'Safety mode',
    'wb.memLayer': 'Memory layer',
    'wb.memRecords': 'Records in scope',
    'wb.memHint': 'Open the full Memory drawer for records, quarantine review, export and policy flags.',
    'wb.openMemDrawer': 'Open Memory drawer',
    'wb.session': 'Session',
    'wb.new': 'New',
    'wb.messages': 'Messages',
    'wb.toolCalls': 'Tool calls',
    'wb.shortcuts': 'Shortcuts',
    'wb.scCommands': 'Commands',
    'wb.scNew': 'New session',
    'wb.scExport': 'Export',
    'wb.scSettings': 'Settings',
    'wb.working': 'Working…',
    'wb.savedSession': 'Saved session',
    /* memory drawer */
    'memory.title': 'Memory',
    'memory.loading': 'loading…',
    /* settings */
    'settings.title': 'Settings',
    'settings.connection': 'Connection',
    'settings.workspace': 'Workspace',
    'settings.shortcuts': 'Shortcuts',
    'settings.connectTitle': 'Connect your model',
    'settings.connectSub': 'Use any OpenAI-compatible endpoint.',
    'settings.baseUrl': 'Base URL',
    'settings.baseUrlPlaceholder': 'https://api.example.com/v1',
    'settings.apiKey': 'API key',
    'settings.show': 'show',
    'settings.hide': 'hide',
    'settings.keyHint': 'Stored in config.toml on your machine. Leave empty to use the MUSE_LLM_API_KEY env var.',
    'settings.model': 'Model',
    'settings.modelPlaceholder': 'model id',
    'settings.fetchModels': 'Fetch models',
    'settings.fetchHint': 'Fetch queries the base URL above for its live model list.',
    'settings.project': 'Project folder',
    'settings.projectHint': 'Muse can read and list files inside this folder without asking. Reads outside it, writes, and other side effects still ask first.',
    'settings.browse': 'Browse…',
    'settings.clear': 'Clear',
    'settings.workspaceTitle': 'Make room for your work',
    'settings.workspaceSub': 'Session-only preferences. Reset when this window reloads; changes apply immediately.',
    'settings.compact': 'Compact messages',
    'settings.showTools': 'Show tool activity (denials always remain visible)',
    'settings.appearance': 'Appearance',
    'settings.appearanceHint': 'Session-only; resets on reload. Shiva Blue matches the app icon.',
    'settings.enterToSend': 'Enter to send',
    'settings.shortcutsTitle': 'Keep your hands on the keys',
    'settings.saveConnection': 'Save connection',
    /* palette */
    'palette.title': 'Commands',
    'palette.findAction': 'Find an action…',
    'palette.escapeHint': 'Escape to close',
    /* shared */
    'common.close': 'Close',
  },
};

/* Lazy loader map — blueprint §12. `en` resolves to the inline bundle;
   future locales register async loaders here. */
const LOCALES = {
  [DEFAULT_LOCALE]: async () => BUNDLES[DEFAULT_LOCALE],
};

let currentLocale = DEFAULT_LOCALE;
let currentBundle = BUNDLES[DEFAULT_LOCALE];

function lookup(bundle, key) {
  const flat = bundle[String(key)];
  if (typeof flat === 'string') return flat;
  let node = bundle;
  for (const part of String(key).split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function t(key, fallback) {
  const hit = lookup(currentBundle, key);
  if (hit !== undefined) return hit;
  const fromDefault = currentLocale === DEFAULT_LOCALE ? undefined : lookup(BUNDLES[DEFAULT_LOCALE], key);
  return fromDefault !== undefined ? fromDefault : (fallback !== undefined ? fallback : String(key));
}

async function setLocale(code) {
  if (!LOCALES[code]) return false;
  currentBundle = await LOCALES[code]();
  currentLocale = code;
  applyDom();
  return true;
}

/* Apply bundle to static DOM. Existing markup text is the fallback, so a
   missing key degrades to the authored English instead of wiping UI. */
function applyDom(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'), el.textContent);
  }
  for (const el of scope.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder');
    const fallback = el.getAttribute('placeholder') || '';
    el.setAttribute('placeholder', t(key, fallback));
  }
}

window.MuseI18n = {
  t,
  applyDom,
  setLocale,
  get locale() { return currentLocale; },
  get locales() { return Object.keys(LOCALES); },
};
})();
