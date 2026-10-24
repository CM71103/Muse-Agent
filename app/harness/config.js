'use strict';
// config.js - TOML-ish config loader (minimal, no deps). Mirrors nanoMuse's config.example.toml
// Config path: ~/.muse-agent/config.toml (or MUSE_CONFIG env). Missing file -> defaults.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  llm: {
    provider: 'openai-compat',        // openai-compat | anthropic (v2)
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    // api_key: read from env MUSE_LLM_API_KEY or config value; never logged
    api_key_env: 'MUSE_LLM_API_KEY',
    temperature: 0.3,
    max_tokens: 8192,
    // compaction threshold (tokens). Compact when history estimate crosses ~85% of this.
    context_tokens: 200000,
  },
  agent: {
    max_turns: 40,                    // hard cap on tool loop
    approval_timeout_s: 3600,         // auto-deny after this (nanoMuse default)
    always_ask_tools: ['shell'],      // tools that require approval every call
    sandbox: 'none',                  // none (Windows reality) | bubblewrap (Linux only, v2)
  },
  sentinel: {
    mode: 'ask',                      // ask | auto  (NEVER recommend auto)
    deny_rules: [
      '*rm -rf*',
      '*del /s*',
      '*format *',
      '*Remove-Item -Recurse*',
      '*shutdown*',
      '*reg delete*',
    ],
    // allowlist applied after agent reads private files (taint-lite)
    egress_allowlist: ['duckduckgo.com', 'wikipedia.org', 'github.com', 'pypi.org'],
  },
  hands: {
    enabled: false,                   // OFF by default, like nanoMuse
    host: '127.0.0.1',
    port: 8788,
    // token file: ~/.muse-agent/hands_token ; generated on first start
  },
  log: {
    level: 'info',                    // debug | info | warn | error
    dir: '',                          // default ~/.muse-agent/logs
  },
  memory: {
    enabled: false,                   // OFF by default — opt-in (writes user data)
    budget_tokens: 1200,              // fixed Phase-0 memory allowance per turn
    score_cutoff: 0.20,               // retrieval gate
    project_id: '',                  // explicit personal/manual ID, never inferred
    project_id_strategy: 'auto',      // auto | manual | _default
    // EMBED_* default per spec §3 (Depth 1): text-embedding-3-small, 1536d.
    // If unset, embeddings ride the chat endpoint + key.
    embed_base_url: '',
    embed_model: 'text-embedding-3-small',
    embed_dims: 1536,
    daily_token_cap: 200000,          // layer embeddings+LLM tokens per UTC day; <=0 disables
    // Adaptive-policy flags (spec §9): all default false. Enabling any starts a
    // new policy/evidence version; de-promotion restores baseline serving.
    adaptive_ranking: false,          // posterior replaces cosine; /good updates evidence
    adaptive_budget: false,           // ×1.5 ladder grows next budget on eligible /bad
    query_clustering: false,          // frozen centroids; unfamiliar queries abstain
    cluster_floor: 0.35,              // similarity floor below which a query abstains
    // Session-end extraction LLM (defaults to the chat endpoint/model when unset).
    llm_base_url: '',
    llm_model: '',
  },
};

// Minimal TOML subset parser: [section] headers, key = "value" / number / true/false,
// arrays of strings on one line ["a", "b"], # comments.
function parseToml(text) {
  const out = {};
  let section = out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[([\w.-]+)\]$/);
    if (sec) {
      const parts = sec[1].split('.');
      section = out;
      for (const p of parts) section = (section[p] = section[p] || {});
      continue;
    }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    let valStr = kv[2].trim();
    // multi-line array: consume lines until brackets balance
    if (valStr.startsWith('[') && !valStr.endsWith(']')) {
      let depth = 0;
      for (const ch of valStr) { if (ch === '[') depth++; else if (ch === ']') depth--; }
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        const next = lines[i].replace(/#.*$/, '').trim();
        valStr += ' ' + next;
        for (const ch of next) { if (ch === '[') depth++; else if (ch === ']') depth--; }
      }
    }
    section[key] = parseValue(valStr);
  }
  return out;
}

function parseValue(s) {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s.startsWith('[')) {
    // inline/multi-line array of strings/numbers; trailing commas allowed
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',')
      .map(p => p.trim())
      .filter(p => p !== '')
      .map(p => parseValue(p));
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s; // bare string fallback
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function configDir() {
  return process.env.MUSE_HOME || path.join(os.homedir(), '.muse-agent');
}

// Single source of truth for the *user-editable* config file (settings toggle
// writes here, Help menu opens this folder). Same resolution rules as loadConfig.
function userConfigFile() {
  if (process.env.MUSE_CONFIG) return process.env.MUSE_CONFIG;
  const home = path.join(configDir(), 'config.toml');
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    // packaged: settings always live in home (seeded from template on first run)
    return home;
  }
  // dev: project-local config.toml wins if present (that's what loadConfig reads)
  const projectLocal = path.join(__dirname, '..', '..', 'config.toml');
  return fs.existsSync(projectLocal) ? projectLocal : home;
}

function loadConfig(explicitPath) {
  // packaged (electron asar): seed ~/.muse-agent/config.toml from bundled
  // resources/template.toml on first run, then always read from home.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    const template = path.join(process.resourcesPath, 'template.toml');
    const home = path.join(configDir(), 'config.toml');
    if (!fs.existsSync(home) && fs.existsSync(template)) {
      try {
        fs.mkdirSync(configDir(), { recursive: true });
        fs.copyFileSync(template, home);
      } catch { /* read-only seed failure -> fall through to template read */ }
    }
    if (explicitPath || process.env.MUSE_CONFIG) {
      // explicit/env override still wins
    } else if (fs.existsSync(home)) {
      const user = parseToml(fs.readFileSync(home, 'utf8'));
      const cfg = deepMerge(DEFAULTS, user);
      cfg._configFile = home;
      return cfg;
    } else if (fs.existsSync(template)) {
      const user = parseToml(fs.readFileSync(template, 'utf8'));
      const cfg = deepMerge(DEFAULTS, user);
      cfg._configFile = template;
      return cfg;
    }
  }
  // dev: explicit path > $MUSE_CONFIG > project-local config.toml > ~/.muse-agent/config.toml
  const projectLocal = path.join(__dirname, '..', '..', 'config.toml');
  const file = explicitPath
    || process.env.MUSE_CONFIG
    || (fs.existsSync(projectLocal) ? projectLocal : path.join(configDir(), 'config.toml'));
  let user = {};
  if (fs.existsSync(file)) user = parseToml(fs.readFileSync(file, 'utf8'));
  const cfg = deepMerge(DEFAULTS, user);
  cfg._configFile = file;
  return cfg;
}

function apiKey(cfg) {
  const direct = cfg.llm.api_key;
  if (direct) return direct;
  return process.env[cfg.llm.api_key_env || 'MUSE_LLM_API_KEY'] || '';
}

module.exports = { loadConfig, parseToml, deepMerge, configDir, userConfigFile, apiKey, DEFAULTS };
