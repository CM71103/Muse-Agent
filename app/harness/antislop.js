'use strict';
// antislop.js — the design rulebook Muse carries with it.
//
// The rules ship as Design Studio skills (app/design/skills/antislop*/SKILL.md),
// so the Design Studio can activate one like any other skill. This module is
// the chat-side door to the same files: it builds the block that goes into the
// system message when the rules are in force for a session, and it survives a
// restart because the block itself carries the selection.
//
// Upstream: antislop (Anti Slop: Rules for AI Coding Agents) v3.2.32,
// MIT, https://github.com/miqdadbadjuber/anti-slop
const fs = require('node:fs');
const path = require('node:path');

// The core filter always comes along: the extra skills refine it.
const CORE = 'antislop';
const SKILL_IDS = ['antislop', 'antislop-ui', 'antislop-copywriting', 'antislop-human', 'antislop-layoutmobile', 'antislop-code'];
const TITLES = {
  'antislop': 'core filter',
  'antislop-ui': 'UI / visual',
  'antislop-copywriting': 'copy & text',
  'antislop-human': 'people & accessibility',
  'antislop-layoutmobile': 'layout & mobile',
  'antislop-code': 'code comments',
};
const ALIASES = {
  core: 'antislop', filter: 'antislop', all: 'all', ui: 'antislop-ui', visual: 'antislop-ui',
  copy: 'antislop-copywriting', copywriting: 'antislop-copywriting', text: 'antislop-copywriting',
  human: 'antislop-human', a11y: 'antislop-human', accessibility: 'antislop-human',
  people: 'antislop-human', mobile: 'antislop-layoutmobile', layout: 'antislop-layoutmobile',
  responsive: 'antislop-layoutmobile', code: 'antislop-code', comments: 'antislop-code',
};
// The system message carries the whole rulebook. A cap keeps a pathological
// selection from eating the context window; the cut is said out loud rather
// than silently applied.
const MAX_GUIDE_CHARS = 110000;
const GROUP_MARK = '<!-- antislop:groups=';

function skillsRoot() {
  return path.join(__dirname, '..', 'design', 'skills');
}

function skillFile(id) {
  return path.join(skillsRoot(), id, 'SKILL.md');
}

function readSkill(id) {
  try {
    const text = fs.readFileSync(skillFile(id), 'utf8');
    return text && text.trim() ? text : '';
  } catch { return ''; }
}

// Every shipped rulebook, with its size. Used by the renderer to show what
// can be switched on.
function listSkills() {
  return SKILL_IDS.map((id) => {
    const text = readSkill(id);
    return { id, title: TITLES[id] || id, chars: text.length, path: skillFile(id), available: !!text };
  });
}

// Turn a user's word ("ui", "copy", "all") into the selected groups. The core
// filter is always part of the selection.
function resolveGroups(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw || raw === 'off' || raw === 'none' || raw === 'stop') return [];
  if (raw === 'all') return SKILL_IDS.slice();
  const picked = new Set([CORE]);
  for (const word of raw.split(/[\s,/]+/).filter(Boolean)) {
    const id = ALIASES[word] || word;
    if (!SKILL_IDS.includes(id)) continue;
    picked.add(id);
  }
  return SKILL_IDS.filter((id) => picked.has(id));
}

// The block that goes into the system message. Empty when nothing is active.
function guide(groups) {
  const list = (groups || []).filter((id) => SKILL_IDS.includes(id));
  if (!list.length) return '';
  const parts = [];
  let used = 0;
  let truncated = [];
  for (const id of list) {
    const text = readSkill(id);
    if (!text) continue;
    if (used + text.length > MAX_GUIDE_CHARS) {
      truncated.push(id);
      continue;
    }
    used += text.length;
    parts.push(`### antislop: ${id} (${TITLES[id] || id})\n\n${text}`);
  }
  if (!parts.length) return '';
  const head = [
    '# Antislop rules in force for this session',
    `${GROUP_MARK}${list.join(',')} -->`,
    `These rules apply to everything you produce in this session: UI, copy, accessibility and code comments.`,
    `They are a filter, not a style guide: they do not replace the project's own DESIGN.md direction.`,
    `Active rulebooks: ${list.map((id) => `${id} (${TITLES[id] || id})`).join(', ')}.`,
    truncated.length ? `Not included (too large for the context): ${truncated.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  return `${head}\n\n${parts.join('\n\n---\n\n')}`;
}

// Which rulebooks are in force, read back from a system message. A restored
// session has the block but not the runtime state, so the state is recovered
// from the text instead of being lost.
function groupsFromGuide(text) {
  const match = /<!--\s*antislop:groups=([^>]*?)-->/.exec(String(text || ''));
  if (!match) return [];
  return match[1].split(',').map((id) => id.trim()).filter((id) => SKILL_IDS.includes(id));
}

// Find the antislop block in a system message, whatever is around it.
function stripGuide(systemText) {
  const text = String(systemText || '');
  const start = text.indexOf('# Antislop rules in force for this session');
  if (start < 0) return text;
  // The block runs to the end of the message: it is always written last.
  const head = text.slice(0, start).replace(/\s+$/, '');
  return head;
}

module.exports = {
  CORE, SKILL_IDS, TITLES, listSkills, resolveGroups, guide, groupsFromGuide, stripGuide,
  skillFile, skillsRoot, MAX_GUIDE_CHARS,
};
