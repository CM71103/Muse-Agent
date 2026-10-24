'use strict';
// configWrite.js - safe TOML config updates. Parses the existing file with the
// same parser used for reading, applies a shallow merge per section, and
// re-serializes deterministically. Comments in the file are NOT preserved
// (documented); values survive round-trip, which is what matters.

const fs = require('fs');
const { parseToml } = require('./config');

// serialize in stable section order; strings escaped, arrays one-per-line
function serializeToml(obj) {
  const out = [];
  const scalars = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') continue;
    scalars.push(`${k} = ${tomlValue(v)}`);
  }
  out.push(...scalars);
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue;
    out.push('', `[${k}]`);
    for (const [k2, v2] of Object.entries(v)) {
      if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) continue; // no nested sections written
      out.push(`${k2} = ${tomlValue(v2)}`);
    }
  }
  return out.join('\n') + '\n';
}

function tomlValue(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (v.length <= 3) return `[${v.map(x => JSON.stringify(x)).join(', ')}]`;
    return '[\n' + v.map(x => `  ${JSON.stringify(x)}`).join(',\n') + ',\n]';
  }
  return JSON.stringify(String(v));
}

// Write full llm + hands + sentinel sections (whole-section replace, not key surgery).
// cfg = the merged config object (from loadConfig), file = target path.
function writeSections(cfg, file) {
  const existing = fs.existsSync(file) ? parseToml(fs.readFileSync(file, 'utf8')) : {};
  const doc = { ...existing };
  doc.llm = {
    provider: cfg.llm.provider,
    base_url: cfg.llm.base_url,
    model: cfg.llm.model,
    api_key_env: cfg.llm.api_key_env,

    temperature: cfg.llm.temperature,
    max_tokens: cfg.llm.max_tokens,
    context_tokens: cfg.llm.context_tokens,
  };
  doc.agent = {
    max_turns: cfg.agent.max_turns,
    approval_timeout_s: cfg.agent.approval_timeout_s,
    always_ask_tools: cfg.agent.always_ask_tools,
    sandbox: cfg.agent.sandbox,
  };
  doc.sentinel = {
    mode: cfg.sentinel.mode,
    deny_rules: cfg.sentinel.deny_rules,
    egress_allowlist: cfg.sentinel.egress_allowlist,
  };
  doc.hands = {
    enabled: !!cfg.hands.enabled,
    host: cfg.hands.host,
    port: cfg.hands.port,
  };
  doc.memory = {...cfg.memory};
  delete doc.memory.embed_api_key;
  doc.log = { level: cfg.log.level };
  fs.writeFileSync(file, serializeToml(doc));
}

module.exports = { writeSections, serializeToml };
