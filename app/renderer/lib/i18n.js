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
    'nav.chat': 'Chat',
    'nav.projects': 'Projects',
    'nav.activity': 'Activity',
    'nav.boards': 'Boards',
    'nav.pages': 'Pages',
    'rail.commands': 'Commands',
    'rail.appearance': 'Appearance',
    'rail.pinned': 'Pinned',
    'common.retry': 'Try again',
    'boards.title': 'Boards',
    'boards.hint': 'Ask Muse to build one (e.g. “create a board of orders by region”). Each chart is a live SQL query: open a board any time to re-run the numbers.',
    'boards.loading': 'Loading your boards…',
    'boards.loadingOne': 'Running this board’s queries…',
    'boards.listError': 'Could not read your boards. Your files are untouched.',
    'boards.dataError': 'Could not run this board’s queries.',
    'design.ready': 'Design workspace ready',
    'design.readyNoProject': 'Design knowledge ready: no project yet',
    'design.empty': 'No design workspace',
    'design.createFolder': 'Create new folder',
    'design.chooseFolder': 'Choose existing folder',
    'design.projectNamePlaceholder': 'Design project name',
    'design.chooseFolderTitle': 'Choose a design folder',
    'design.folderHint': 'Create a new project folder, or use an existing folder. Existing files are kept.',
    'design.systemLabel': 'Design system',
    'design.skillLabel': 'Skill',
    'design.templateLabel': 'Template',
    'design.craftLabel': 'Craft rules',
    'design.none': 'None',
    'design.registryNote': 'Registries come from this project, your personal design folder, then bundled defaults.',
    'design.filterPlaceholder': 'Filter registries by name',
    'design.filterAria': 'Filter design registry entries',
    'design.previewAria': 'Selected registry entry',
    'design.previewEmpty': 'Choose an entry to read what it does.',
    'design.filesLabel': 'Files',
    'design.readUnavailable': 'Reading registry files is not available here.',
    'design.readFailed': 'Could not read that entry.',
    'design.craftRead': 'Read',
    'design.craftNoMatch': 'No craft rules match that filter.',
    'design.craftEmpty': 'No craft rules yet. Add markdown files to the craft folder of your design registry.',
    'design.save': 'Save selection',
    'design.openPreview': 'Open preview',
    'design.addTemplate': 'Add template files',
    'design.addTemplateHint': 'Copy this template’s starter files into the project folder; existing files are kept',
    'design.chooseTemplateFirst': 'Choose a template first.',
    'design.applyFailed': 'Could not add the template files.',
    'design.errorRetry': 'Try again',
    'design.errorChoose': 'Choose another folder',
    'design.loading': 'Loading…',
    'design.loadingPreview': 'Loading file preview…',
    'design.readFileFailed': 'Could not read this file.',
    'design.previewUnavailable': 'Preview unavailable',
    'design.code': 'Code',
    'design.openFolderForCode': 'Open a project folder to browse its code.',
    'design.scanningFiles': 'Scanning project files…',
    'design.loadFilesFailed': 'Could not load project files.',
    'design.projectFiles': 'project files',
    'design.showingFirst': 'showing first 2,000',
    'design.chooseFolderToBrowse': 'Choose a project folder to browse its files.',
    'design.noFilesMatch': 'No files match that search.',
    'design.noProjectFiles': 'No project files found.',
    'design.requestFailed': 'Design request failed.',
    'design.controlsUnavailable': 'Design controls are unavailable.',
    'design.noArtifact': 'No artifact yet',
    'design.sourcePreviewAria': 'File source preview',
    'design.backToPreview': 'Back to preview',
    'design.guide.progress': 'Step 1 of 6',
    'design.guide.close': 'Save and close',
    'design.guide.title': 'Let’s shape your app',
    'design.guide.answerLabel': 'Your answer',
    'design.guide.back': 'Back',
    'design.guide.next': 'Continue',
    'design.guide.start': 'Start building',
    'design.guide.starting': 'Starting…',
    'design.guide.stepOf': 'Step',
    'design.guide.of': 'of',
    'design.guide.review': 'Review brief',
    'design.guide.reviewTitle': 'Review your brief',
    'design.guide.reviewQuestion': 'Anything else to add before we start?',
    'design.guide.reviewHint': 'Review your answers, add any final details, or go back to change a choice.',
    'design.guide.finalLabel': 'Final additions (optional)',
    'design.guide.finalPlaceholder': 'Add any final instructions, constraints, or ideas here (optional).',
    'design.guide.noDetail': 'No additional detail.',
    'design.guide.q1': 'What are you building?',
    'design.guide.q2': 'Where should it run?',
    'design.guide.q3': 'Who will use it?',
    'design.guide.q4': 'What should it do?',
    'design.guide.q5': 'Which language and feel should the interface have?',
    'design.guide.q6': 'What data, connections, or requirements does it need?',
    'boards.unavailable': 'This board could not be opened.',
    'boards.empty': 'No boards yet. Ask Muse to build one from your data.',
    'boards.remove': 'Remove',
    'boards.removeAria': 'Remove board',
    'pages.title': 'Pages',
    'pages.hint': 'Self-contained HTML pages Muse rendered: diagrams, reviews, recaps. Each lives in its project beside its .src.html source; re-render the source to revise it.',
    'pages.loading': 'Loading your pages…',
    'pages.listError': 'Could not read your pages. Your files are untouched.',
    'pages.empty': 'No pages yet. Ask Muse for a diagram, comparison, or review.',
    'pages.noPreview': 'Preview unavailable — open the page to see it.',
    'pages.folder': 'Show folder',
    'pages.remove': 'Remove',
    'about.checking': 'Checking…',
    'about.upToDate': 'You are up to date.',
    'about.updateReady': 'A newer version is available.',
    'about.checkFailed': 'Could not reach the update server.',
    'about.openFailed': 'Could not open the data folder from here.',
    'settings.scViews': 'Switch view: Chat, Projects, Activity, Memory',
    'sidebar.newSession': 'New session',
    'sidebar.yourSessions': 'Your sessions',
    'sidebar.searchPlaceholder': 'Search history…',
    'sidebar.filterAll': 'All sessions',
    'sidebar.filterCurrent': 'Current session',
    'sidebar.empty': 'No saved sessions yet. Complete a task to keep it here.',
    'sidebar.noMatch': 'No matching sessions.',
    'pips.model': 'Model',
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
    'composer.stopping': 'Stopping…',
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
    'settings.keyHint': 'Stored securely on this device. Leave empty to keep your saved key or use the environment key.',
    'settings.model': 'Model',
    'settings.modelPlaceholder': 'model id',
    'settings.fetchModels': 'Fetch models',
    'settings.fetchHint': 'Fetch queries the base URL above for its live model list.',
    'settings.project': 'Project folder',
    'settings.projectHint': 'Give Muse a working folder for files and project memory. Tool permissions follow your selected mode.',
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
