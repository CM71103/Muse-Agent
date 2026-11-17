'use strict';
// design.ts - Design workspace authority: content registries (design systems,
// templates, skills, craft), prompt composition, the artifact contract, and
// project file access.
//
// Registry model follows the OpenDesign architecture: listing scans the
// user-writable roots first and the bundled root last, so a user entry can
// shadow a bundled entry with the same id. Every read is bounded to a root.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_DIR = '.od';
const PROJECT_JSON = `${PROJECT_DIR}/project.json`;
const ARTIFACT_MANIFEST = `${PROJECT_DIR}/artifact.json`;
const KINDS = ['design-systems', 'design-templates', 'skills', 'craft'];
const ENTRY_FILE: Record<string, string> = {
  'design-systems': 'DESIGN.md',
  'design-templates': 'TEMPLATE.md',
  skills: 'SKILL.md',
  craft: 'CRAFT.md',
};
const ARTIFACT_KINDS = new Set(['html', 'svg', 'deck', 'markdown', 'react-component', 'mini-app', 'document']);
const ARTIFACT_RENDERERS = new Set(['html', 'markdown', 'svg', 'iframe-url']);
const MAX_FILE = 16000;
const MAX_TOTAL = 32000;
const MAX_REGISTRY_TEXT = 12000;
const PROJECT_FILE_LIMIT = 2000;
const PROJECT_FILE_IGNORES = new Set(['.git', 'node_modules', '.dart_tool', '.idea', '.vscode', 'build', 'dist', 'coverage', '.cache', '.next', '.turbo']);

function safeRead(file: string, limit = MAX_FILE): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > limit * 4) return null;
    return String(fs.readFileSync(file, 'utf8')).slice(0, limit);
  } catch {
    return null;
  }
}

// --- roots -----------------------------------------------------------------

function userDesignRoot(): string {
  try {
    const { configDir } = require('./config');
    return path.join(configDir(), 'design');
  } catch {
    return '';
  }
}

function bundledDesignRoot(): string {
  return path.join(__dirname, '..', 'design');
}

// Priority order, most specific first. A project entry wins over a user entry,
// which wins over the bundled content shipped inside the app.
function registryRoots(projectDir: string | null): { source: string; dir: string }[] {
  const roots: { source: string; dir: string }[] = [];
  if (projectDir) roots.push({ source: 'project', dir: path.resolve(projectDir) });
  const user = userDesignRoot();
  if (user) roots.push({ source: 'user', dir: user });
  roots.push({ source: 'bundled', dir: bundledDesignRoot() });
  return roots.filter(root => { try { return fs.statSync(root.dir).isDirectory(); } catch { return false; } });
}

function ensureUserDesignRoot(): string {
  const root = userDesignRoot();
  if (!root) throw new Error('Design registry directory is unavailable.');
  for (const kind of KINDS) fs.mkdirSync(path.join(root, kind), { recursive: true });
  return root;
}

// --- tiny front matter -----------------------------------------------------
// `key: value` lines above the first heading. Values may be a comma list.

function frontMatter(text: string): { meta: Record<string, any>; body: string } {
  const meta: Record<string, any> = {};
  const lines = String(text || '').split(/\r?\n/);
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index++;
  while (index < lines.length && /^[A-Za-z][\w-]*\s*:/.test(lines[index])) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[index]);
    if (match) {
      const key = match[1].trim();
      const raw = match[2].trim();
      meta[key] = raw.includes(',') ? raw.split(',').map(part => part.trim()).filter(Boolean) : raw;
    }
    index++;
  }
  return { meta, body: lines.slice(index).join('\n').trim() };
}

function titleFrom(text: string, fallback: string): string {
  const heading = /^\s*#\s+(.+)$/m.exec(String(text || ''));
  return heading ? heading[1].trim().slice(0, 160) : fallback;
}

function listDirs(root: string, name: string): string[] {
  const dir = path.join(root, name);
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir)
      .map(n => path.join(dir, n))
      .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  } catch {
    return [];
  }
}

// --- registry --------------------------------------------------------------

// Craft rules are flat markdown files (craft/<id>.md); other kinds are folders
// holding an entry document plus optional assets.
function entryFiles(kind: string, dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort();
  } catch { return []; }
}

function listRegistry(projectDir: string | null, kind: string) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown design registry: ${kind}`);
  const byId = new Map<string, any>();
  for (const root of registryRoots(projectDir)) {
    const base = path.join(root.dir, kind);
    try { if (!fs.statSync(base).isDirectory()) continue; } catch { continue; }
    const candidates = kind === 'craft'
      ? (() => {
        try {
          return fs.readdirSync(base, { withFileTypes: true })
            .filter(entry => entry.isFile() && /\.md$/i.test(entry.name) && !entry.isSymbolicLink())
            .map(entry => ({ id: entry.name.replace(/\.md$/i, ''), dir: base, file: entry.name }));
        } catch { return []; }
      })()
      : listDirs(root.dir, kind).map(dir => ({ id: path.basename(dir), dir, file: ENTRY_FILE[kind] }));
    for (const candidate of candidates) {
      const entryPath = path.join(candidate.dir, candidate.file);
      if (byId.has(candidate.id)) {
        // Same id in a lower-priority root: keep the first, record the shadow.
        const winner = byId.get(candidate.id);
        if (!winner.shadowedSources) winner.shadowedSources = [];
        winner.shadowedSources.push(root.source);
        continue;
      }
      const text = safeRead(entryPath, MAX_REGISTRY_TEXT);
      if (text === null && kind !== 'craft') continue;
      const { meta } = frontMatter(text || '');
      const id = String(candidate.id).slice(0, 120);
      const files = kind === 'craft' ? [candidate.file] : entryFiles(kind, candidate.dir);
      byId.set(id, {
        id,
        kind,
        source: root.source,
        name: String(meta.name || meta.title || titleFrom(text || '', id)).slice(0, 160),
        description: String(meta.description || meta.summary || '').slice(0, 400),
        entry: path.relative(root.dir, entryPath).split(path.sep).join('/'),
        file: candidate.file,
        root: root.dir,
        dir: candidate.dir,
        files,
        requires: Array.isArray(meta.requires) ? meta.requires.map(String) : (meta.requires ? [String(meta.requires)] : []),
        renderer: typeof meta.renderer === 'string' ? meta.renderer : '',
        shadowedSources: [] as string[],
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function findRegistryEntry(projectDir: string | null, kind: string, id: string): any | null {
  return listRegistry(projectDir, kind).find(entry => entry.id === id) || null;
}

function readRegistryFile(projectDir: string | null, kind: string, id: string, relative = '') {
  const entry = findRegistryEntry(projectDir, kind, id);
  if (!entry) throw new Error(`No ${kind.replace(/-/g, ' ')} named “${id}” in the design registry.`);
  const fallback = kind === 'craft' ? `${id}.md` : ENTRY_FILE[kind];
  const target = path.resolve(entry.dir, relative || entry.file || fallback);
  if (target !== path.resolve(entry.dir) && !target.startsWith(entry.dir + path.sep)) throw new Error('That registry file is outside the entry folder.');
  const text = safeRead(target, MAX_REGISTRY_TEXT * 2);
  if (text === null) throw new Error('That registry file could not be read (missing or too large).');
  return { id, kind, source: entry.source, file: path.relative(entry.dir, target).split(path.sep).join('/'), text };
}

// Back-compat shapes used by designStatus/designContext consumers.
function collectSystems(root: string) {
  const out: { id: string; text: string; rootDesign: boolean; source?: string }[] = [];
  const rootText = safeRead(path.join(root, 'DESIGN.md'));
  if (rootText) out.push({ id: 'root', text: rootText, rootDesign: true, source: 'project' });
  for (const entry of listRegistry(root, 'design-systems')) {
    out.push({ id: entry.id, text: safeRead(path.join(entry.dir, ENTRY_FILE['design-systems'])) || '', rootDesign: false, source: entry.source });
  }
  return out.filter(system => system.text);
}

function collectSkills(root: string) {
  return listRegistry(root, 'skills')
    .map(entry => ({ id: entry.id, text: safeRead(path.join(entry.dir, ENTRY_FILE.skills)) || '', source: entry.source }))
    .filter(skill => skill.text);
}

function readProjectJson(projectDir: string | null): any {
  if (!projectDir) return null;
  try { return JSON.parse(String(fs.readFileSync(path.join(projectDir, PROJECT_JSON), 'utf8'))); } catch { return null; }
}

// A folder counts as a Design Studio project once it carries .od metadata.
function isDesignProject(projectDir: string | null): boolean {
  if (!projectDir) return false;
  try { return !!readProjectJson(projectDir) || fs.statSync(path.join(projectDir, PROJECT_DIR)).isDirectory(); } catch { return false; }
}

// --- artifact contract -----------------------------------------------------

function artifactContract(): string {
  return [
    'Artifact contract: when you produce a design artifact (web page, slide deck, image, SVG, etc.), write a companion manifest at `.od/artifact.json`.',
    'Manifest schema (strict JSON, no comments):',
    '{',
    '  "version": 1,',
    '  "kind": "html",          // html | svg | deck | markdown | react-component | mini-app | document',
    '  "renderer": "html",      // html | markdown | svg | iframe-url',
    '  "entry": "index.html",   // relative path, no "..", no absolute paths',
    '  "exports": ["html"],',
    '  "status": "complete",    // streaming | complete | error',
    '  "primary": true,',
    '  "supportingFiles": [],',
    '  "title": "Artifact title",',
    '  "sourceSkillId": "",',
    '  "sourceDesignSystemId": "",',
    '  "metadata": {}',
    '}',
    'Place the entry file and assets in the project root. All paths must be relative and stay inside the project.',
    'You can write that manifest with the design_artifact tool instead of hand-editing JSON; it validates the entry path for you.',
    'For existing package-based web apps, preserve their framework, package.json, lockfile, and source layout. Prefer the project’s existing dev, start, preview, or serve script; Muse can run it for a live canvas preview. Do not replace a framework app with a standalone HTML page just to satisfy this manifest.',
    'Do not install dependencies automatically. If the app needs packages that are not installed, report the required package-manager install command.',
  ].join('\n');
}

function isSafeRelative(entry: unknown): entry is string {
  return typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 512
    && !entry.includes('\0') && !/^[a-zA-Z]:/.test(entry) && !entry.startsWith('/') && !entry.startsWith('\\')
    && !entry.split(/[\\/]/).includes('..');
}

// Validate a manifest against the project. Returns null when the artifact
// cannot be previewed, so callers can fall back to detection.
function normalizeArtifact(projectDir: string, raw: any) {
  if (!projectDir || !raw || typeof raw !== 'object') return null;
  if (!isSafeRelative(raw.entry)) return null;
  const target = path.resolve(projectDir, raw.entry);
  if (target !== projectDir && !target.startsWith(projectDir + path.sep)) return null;
  let real = target;
  try {
    if (!fs.statSync(target).isFile()) return null;
    real = fs.realpathSync(target);
    if (real !== projectDir && !real.startsWith(projectDir + path.sep)) return null;
  } catch { return null; }
  const kind = ARTIFACT_KINDS.has(raw.kind) ? raw.kind : (path.extname(real).toLowerCase() === '.svg' ? 'svg' : 'html');
  const renderer = ARTIFACT_RENDERERS.has(raw.renderer) ? raw.renderer : (kind === 'markdown' ? 'markdown' : kind === 'svg' ? 'svg' : 'html');
  const supporting = Array.isArray(raw.supportingFiles)
    ? raw.supportingFiles.filter(isSafeRelative).map(String).slice(0, 200) : [];
  return {
    version: 1,
    kind, renderer,
    entry: raw.entry.split('\\').join('/'),
    exports: Array.isArray(raw.exports) ? raw.exports.map(String).slice(0, 10) : [renderer],
    status: ['streaming', 'complete', 'error'].includes(raw.status) ? raw.status : 'complete',
    primary: raw.primary !== false,
    supportingFiles: supporting,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : path.basename(raw.entry),
    sourceSkillId: typeof raw.sourceSkillId === 'string' ? raw.sourceSkillId : '',
    sourceDesignSystemId: typeof raw.sourceDesignSystemId === 'string' ? raw.sourceDesignSystemId : '',
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
  };
}

// Fallback for projects written before the manifest existed, or by an agent
// that ignored the contract: a root-level entry file is still previewable.
function detectArtifact(projectDir: string) {
  if (!projectDir) return null;
  const candidates = ['index.html', 'preview.html', 'design.html', 'README.md', 'index.svg'];
  for (const name of candidates) {
    try {
      if (fs.statSync(path.join(projectDir, name)).isFile()) {
        const kind = name.endsWith('.svg') ? 'svg' : name.endsWith('.md') ? 'markdown' : 'html';
        return normalizeArtifact(projectDir, { kind, renderer: kind === 'markdown' ? 'markdown' : kind === 'svg' ? 'svg' : 'html', entry: name, title: path.basename(projectDir), detected: true });
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

function readArtifact(projectDir: string | null) {
  if (!projectDir) return null;
  const text = safeRead(path.join(projectDir, ARTIFACT_MANIFEST));
  if (text) {
    try {
      const normalized = normalizeArtifact(projectDir, JSON.parse(text));
      if (normalized) return { ...normalized, detected: false };
    } catch { /* fall through to detection */ }
  }
  const detected = detectArtifact(projectDir);
  return detected ? { ...detected, detected: true } : null;
}

function writeArtifact(projectDir: string, raw: any) {
  const root = path.resolve(projectDir);
  const normalized = normalizeArtifact(root, raw);
  if (!normalized) throw new Error('The artifact entry must be an existing file inside the project, with no “..” segments.');
  const manifest = { ...normalized, detected: false, kind: ARTIFACT_KINDS.has(raw?.kind) ? raw.kind : normalized.kind };
  fs.mkdirSync(path.join(root, PROJECT_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, ARTIFACT_MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

// --- text-artifact profile -------------------------------------------------
// Plain-text/BYOK runtimes return the deliverable inline instead of writing
// files. Parse <artifact> blocks and materialize them into the workspace.

const ARTIFACT_BLOCK = /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/gi;

function parseArtifactBlocks(text: string) {
  const out: { identifier: string; title: string; content: string }[] = [];
  if (typeof text !== 'string' || !text.includes('<artifact')) return out;
  let match: RegExpExecArray | null;
  ARTIFACT_BLOCK.lastIndex = 0;
  while ((match = ARTIFACT_BLOCK.exec(text))) {
    const attributes = match[1] || '';
    const attribute = (name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attributes)?.[1] || '';
    let identifier = attribute('identifier') || attribute('filename') || attribute('name') || '';
    const body = match[2] || '';
    if (!identifier) {
      const first = body.split(/\r?\n/).find(line => line.trim());
      identifier = /<html|<!doctype/i.test(first || '') ? 'index.html' : '';
    }
    if (!identifier) continue;
    out.push({ identifier: identifier.trim(), title: attribute('title') || identifier.trim(), content: body.replace(/^\r?\n/, '') });
  }
  return out;
}

function captureArtifacts(projectDir: string, text: string) {
  const blocks = parseArtifactBlocks(text);
  if (!blocks.length || !projectDir) return { written: [], artifact: null as any };
  const root = path.resolve(projectDir);
  const written: string[] = [];
  let primary: { entry: string; title: string; kind: string } | null = null;
  for (const block of blocks) {
    if (!isSafeRelative(block.identifier)) continue;
    const target = path.resolve(root, block.identifier);
    if (!target.startsWith(root + path.sep)) continue;
    const extension = path.extname(target).toLowerCase();
    const kind = extension === '.svg' ? 'svg' : extension === '.md' ? 'markdown' : 'html';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, block.content, 'utf8');
    written.push(block.identifier.split(path.sep).join('/'));
    if (!primary || block.identifier.toLowerCase().endsWith('.html')) primary = { entry: block.identifier, title: block.title, kind };
  }
  let artifact = null as any;
  if (primary) {
    try {
      artifact = writeArtifact(root, {
        kind: primary.kind, entry: primary.entry, title: primary.title,
        status: 'complete', supportingFiles: written.filter(name => name !== primary!.entry),
      });
    } catch { artifact = null; }
  }
  return { written, artifact };
}

// --- prompt composition ----------------------------------------------------

function designContext(projectDir: string | null): { active: boolean; text: string } | null {
  if (!projectDir || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return null;
  const projectJson = readProjectJson(projectDir);
  // Only a Design Studio folder gets design knowledge in its prompt. The
  // bundled registry always exists, so registry presence alone must not
  // activate this for an ordinary code checkout.
  const hasOwn = !!projectJson || fs.existsSync(path.join(projectDir, 'DESIGN.md'))
    || KINDS.some(kind => { try { return fs.statSync(path.join(projectDir, kind)).isDirectory(); } catch { return false; } });
  if (!hasOwn) return null;
  const systems = listRegistry(projectDir, 'design-systems');
  const skills = listRegistry(projectDir, 'skills');
  const templates = listRegistry(projectDir, 'design-templates');
  const craft = listRegistry(projectDir, 'craft');
  const rootDesign = safeRead(path.join(projectDir, 'DESIGN.md'));

  let total = 0;
  const parts: string[] = [];
  const take = (text: string) => { total += text.length; parts.push(text); };

  parts.push('--- Design workspace (Muse Design Studio) ---');
  if (projectJson?.name) parts.push(`Project: ${String(projectJson.name).slice(0, 200)}`);
  if (projectJson?.kind) parts.push(`Kind: ${String(projectJson.kind).slice(0, 200)}`);
  if (projectJson?.template_id) parts.push(`Template in use: ${String(projectJson.template_id).slice(0, 120)}`);

  // Active design system: explicit selection, then project DESIGN.md, then
  // the first registry entry (project > user > bundled).
  let systemText: string | null = null;
  let systemId = '';
  const activeSystemId = projectJson?.design_system_id;
  if (activeSystemId) {
    const entry = systems.find(system => system.id === activeSystemId);
    if (entry) {
      systemText = safeRead(path.join(entry.dir, ENTRY_FILE['design-systems']), MAX_REGISTRY_TEXT);
      systemId = `${entry.id} (${entry.source})`;
    }
  }
  if (!systemText && rootDesign) { systemText = rootDesign; systemId = 'root'; }
  if (!systemText && systems.length) {
    const entry = systems[0];
    systemText = safeRead(path.join(entry.dir, ENTRY_FILE['design-systems']), MAX_REGISTRY_TEXT);
    systemId = `${entry.id} (${entry.source})`;
  }
  if (systemText && total + systemText.length <= MAX_TOTAL) take(`Selected design system (${systemId}):\n${systemText}`);

  // Active skill, or a short list of what is available.
  const activeSkillId = projectJson?.skill_id;
  if (activeSkillId) {
    const entry = skills.find(skill => skill.id === activeSkillId);
    const text = entry ? safeRead(path.join(entry.dir, ENTRY_FILE.skills), MAX_REGISTRY_TEXT) : null;
    if (text && total + text.length <= MAX_TOTAL) take(`Active skill (${entry.id} / ${entry.source}):\n${text}`);
  } else if (skills.length) {
    take(`Available skills: ${skills.slice(0, 24).map(skill => skill.id).join(', ')}. Set one with design_configure to load its instructions.`);
  }

  // Craft rules: brand-agnostic quality bars, opted into per project.
  const wanted: string[] = Array.isArray(projectJson?.craft) ? projectJson.craft.map(String) : [];
  const selected = wanted.length ? craft.filter(entry => wanted.includes(entry.id)) : craft.filter(entry => entry.requires.length === 0);
  for (const entry of selected) {
    const text = safeRead(path.join(entry.dir, entry.file || `${entry.id}.md`), MAX_REGISTRY_TEXT);
    if (!text || total + text.length > MAX_TOTAL) continue;
    take(`Craft rules (${entry.id}):\n${text}`);
  }

  if (templates.length) {
    take(`Design templates available: ${templates.slice(0, 24).map(template => `${template.id}${template.description ? ` — ${template.description}` : ''}`).join(' | ')}. Apply one with design_scaffold before building when the request matches a template.`);
  }

  parts.push(artifactContract());
  parts.push('The design registry is shared: entries may come from the project folder, your personal design folder, or bundled content. Inspect them with design_registry.');

  return { active: true, text: parts.join('\n\n') };
}

function designStatus(projectDir: string | null) {
  const systems = projectDir ? collectSystems(projectDir) : [];
  const skills = projectDir ? collectSkills(projectDir) : [];
  const projectJson = readProjectJson(projectDir);
  const artifact = readArtifact(projectDir);
  const registries: Record<string, any[]> = {};
  for (const kind of KINDS) registries[kind] = projectDir ? listRegistry(projectDir, kind) : [];
  return {
    projectDir,
    projectJson,
    systems,
    skills,
    templates: registries['design-templates'],
    craft: registries.craft,
    roots: registryRoots(projectDir).map(root => ({ source: root.source, dir: root.dir })),
    activeDesignSystemId: projectJson?.design_system_id || '',
    activeSkillId: projectJson?.skill_id || '',
    activeCraft: Array.isArray(projectJson?.craft) ? projectJson.craft : [],
    activeTemplateId: projectJson?.template_id || '',
    artifact,
  };
}

// --- project files ---------------------------------------------------------

function listProjectFiles(projectDir: string | null) {
  if (!projectDir) return { files: [], truncated: false };
  const root = fs.realpathSync(projectDir);
  if (!fs.statSync(root).isDirectory()) throw new Error('Choose a project folder first.');
  const files: { path: string; bytes: number; modifiedAt: number; extension: string }[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (depth > 16 || truncated) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (PROJECT_FILE_IGNORES.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(absolute, depth + 1); if (truncated) return; continue; }
      if (!entry.isFile()) continue;
      if (files.length >= PROJECT_FILE_LIMIT) { truncated = true; return; }
      const stat = fs.statSync(absolute);
      files.push({ path: path.relative(root, absolute).split(path.sep).join('/'), bytes: stat.size, modifiedAt: stat.mtimeMs, extension: path.extname(entry.name).toLowerCase() });
    }
  };
  walk(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

function readProjectFile(projectDir: string | null, relativePath: string) {
  if (!projectDir || typeof relativePath !== 'string' || !relativePath.trim() || relativePath.length > 512) throw new Error('Choose a valid project file.');
  const root = fs.realpathSync(projectDir);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(root + path.sep)) throw new Error('That file is outside the project folder.');
  const realTarget = fs.realpathSync(target);
  if (!realTarget.startsWith(root + path.sep)) throw new Error('That file is outside the project folder.');
  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) throw new Error('Choose a file, not a folder.');
  if (stat.size > 256 * 1024) throw new Error('This file is too large to show in the workspace (limit 256 KB).');
  const buffer = fs.readFileSync(realTarget);
  if (buffer.includes(0)) throw new Error('This is a binary file and cannot be shown as source text.');
  return { path: path.relative(root, realTarget).split(path.sep).join('/'), text: buffer.toString('utf8'), bytes: stat.size, modifiedAt: stat.mtimeMs };
}

function projectRevision(projectDir: string | null) {
  if (!projectDir) return '';
  const { files, truncated } = listProjectFiles(projectDir);
  const signature = files.map(file => `${file.path}:${file.bytes}:${file.modifiedAt}`).join('\n') + `\ntruncated:${truncated}`;
  return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 16);
}

// --- project metadata ------------------------------------------------------

const PATCH_LIMITS: Record<string, number> = { name: 120, kind: 40, design_system_id: 120, skill_id: 120, template_id: 120 };

function saveDesignProject(projectDir: string, patch: any) {
  if (!projectDir || typeof projectDir !== 'string') throw new Error('Project directory required.');
  if (!patch || typeof patch !== 'object') throw new Error('Nothing to save.');
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'craft') {
      if (!Array.isArray(value)) throw new Error('craft must be a list of rule ids.');
      clean.craft = value.map(String).map(id => id.trim()).filter(Boolean).slice(0, 16);
      continue;
    }
    if (!(key in PATCH_LIMITS)) continue;           // unknown keys never reach disk
    if (value !== '' && typeof value !== 'string') throw new Error(`${key} must be text.`);
    clean[key] = String(value).trim().slice(0, PATCH_LIMITS[key]);
  }
  const od = path.join(projectDir, PROJECT_DIR);
  fs.mkdirSync(od, { recursive: true });
  const file = path.join(projectDir, PROJECT_JSON);
  const existing = readProjectJson(projectDir) || {};
  const next = { ...existing, ...clean, updatedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

function newProjectJson(name: string) {
  return { id: crypto.randomUUID(), name, kind: 'prototype', design_system_id: '', skill_id: '', template_id: '', craft: [], createdAt: Date.now(), updatedAt: Date.now() };
}

function createDesignProject(root: string, name?: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, PROJECT_DIR), { recursive: true });
  const projectJson = newProjectJson(name || path.basename(root));
  fs.writeFileSync(path.join(root, PROJECT_JSON), JSON.stringify(projectJson, null, 2));
  fs.writeFileSync(path.join(root, 'DESIGN.md'), `# ${projectJson.name}\n\nDescribe the design system here.`);
}

function ensureDesignProject(root: string) {
  const resolved = path.resolve(root);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Choose an existing folder.');
  const projectFile = path.join(resolved, PROJECT_JSON);
  const projectFileExists = fs.existsSync(projectFile);
  const existing = readProjectJson(resolved);
  if (projectFileExists && !existing) throw new Error('This folder has an invalid .od/project.json file.');
  const projectJson = existing || newProjectJson(path.basename(resolved));
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  if (!existing) fs.writeFileSync(projectFile, JSON.stringify(projectJson, null, 2));
  const designFile = path.join(resolved, 'DESIGN.md');
  if (!fs.existsSync(designFile)) fs.writeFileSync(designFile, `# ${projectJson.name || path.basename(resolved)}\n\nDescribe the design system here.`);
  return projectJson;
}

// --- templates -------------------------------------------------------------

// Materialize a design template into the project. Existing files are never
// overwritten unless `force` is set, so a template can top up a live project.
function applyTemplate(projectDir: string, templateId: string, options: { force?: boolean } = {}) {
  const root = path.resolve(projectDir);
  const entry = findRegistryEntry(root, 'design-templates', templateId);
  if (!entry) throw new Error(`No design template named “${templateId}”.`);
  const written: string[] = [];
  const skipped: string[] = [];
  const walk = (dir: string, prefix = '') => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const absolute = path.join(dir, item.name);
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) { walk(absolute, relative); continue; }
      if (!item.isFile() || relative === ENTRY_FILE['design-templates']) continue;
      const target = path.resolve(root, relative);
      if (!target.startsWith(root + path.sep)) continue;
      if (fs.existsSync(target) && !options.force) { skipped.push(relative); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(absolute, target);
      written.push(relative);
    }
  };
  walk(entry.dir);
  const projectJson = saveDesignProject(root, { template_id: entry.id });
  const manifest = written.includes('index.html')
    ? writeArtifact(root, { kind: 'html', renderer: 'html', entry: 'index.html', title: entry.name, sourceDesignSystemId: projectJson.design_system_id || '' })
    : readArtifact(root);
  return { id: entry.id, source: entry.source, name: entry.name, written, skipped, artifact: manifest };
}

module.exports = {
  designContext, designStatus, listProjectFiles, readProjectFile, projectRevision,
  saveDesignProject, createDesignProject, ensureDesignProject, isDesignProject, readProjectJson,
  listRegistry, findRegistryEntry, readRegistryFile, registryRoots, ensureUserDesignRoot,
  readArtifact, writeArtifact, normalizeArtifact, detectArtifact, parseArtifactBlocks, captureArtifacts,
  applyTemplate, KINDS, ARTIFACT_KINDS, ARTIFACT_RENDERERS,
};
