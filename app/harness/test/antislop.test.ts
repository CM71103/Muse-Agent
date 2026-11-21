import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../agent.js');
const { DEFAULTS } = require('../config.js');
const anti = require('../antislop.js');

function config() {
  const cfg = structuredClone(DEFAULTS);
  cfg.sentinel.mode = 'auto';
  cfg.sentinel.deny_rules = [];
  return cfg;
}

function agentWith(t: TestContext, history: any[] = []) {
  const cfg = config();
  const agent = new Agent(cfg, { approver: async () => true });
  (agent as any)._sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-anti-'));
  t.after(() => { try { fs.rmSync((agent as any)._sessionDir, { recursive: true, force: true }); } catch {} });
  let sent: any[] = [];
  (agent as any).llm.chat = async (messages: any) => { sent.push(structuredClone(messages)); return { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', usage: { total_tokens: 2 } }; };
  if (history.length) (agent as any).history = history;
  return { agent, sent };
}

test('the rulebooks ship with the app', () => {
  const skills = anti.listSkills();
  assert.equal(skills.length, 6);
  for (const skill of skills) {
    assert.equal(skill.available, true, `${skill.id} is present`);
    assert.ok(skill.chars > 1000, `${skill.id} has content`);
    assert.ok(fs.existsSync(skill.path));
  }
});

test('the Design Studio lists the rulebooks like any other skill', () => {
  const { listRegistry, readRegistryFile } = require('../design.ts');
  const skills = listRegistry(null, 'skills');
  const ids = skills.map((s: any) => s.id);
  for (const id of anti.SKILL_IDS) assert.ok(ids.includes(id), `${id} is in the skills registry`);
  const core = skills.find((s: any) => s.id === 'antislop');
  assert.equal(core.source, 'bundled');
  // The whole rulebook has to fit the skill cap, or the agent would read a
  // rulebook with holes in it.
  const text = String(readRegistryFile(null, 'skills', 'antislop').text);
  assert.ok(text.length > 50000, `the core rulebook is complete (${text.length} chars)`);
});

test('a group word resolves to the core filter plus that skill', () => {
  assert.deepEqual(anti.resolveGroups('ui'), ['antislop', 'antislop-ui']);
  assert.deepEqual(anti.resolveGroups('copy'), ['antislop', 'antislop-copywriting']);
  assert.deepEqual(anti.resolveGroups('a11y'), ['antislop', 'antislop-human']);
  assert.deepEqual(anti.resolveGroups('off'), []);
  assert.equal(anti.resolveGroups('all').length, 6);
});

test('the guide carries its selection, so a restored session keeps the rules', () => {
  const guide = anti.guide(['antislop', 'antislop-human']);
  assert.ok(guide.includes('antislop:groups=antislop,antislop-human'));
  assert.deepEqual(anti.groupsFromGuide(guide), ['antislop', 'antislop-human']);
  assert.ok(guide.length > 10000, 'the core rulebook travels whole');
  assert.equal(anti.guide([]), '');
});

test('switching the rules on puts them in the system message', async t => {
  const { agent, sent } = agentWith(t);
  agent.setAntislop(['antislop']);
  await agent.run('Build me a page.');
  const system = sent[0].find((m: any) => m.role === 'system');
  assert.ok(system, 'a system message was sent');
  assert.ok(system.content.includes('# Antislop rules in force for this session'), 'the rules are in the system message');
  assert.ok(system.content.includes('antislop:groups=antislop'), 'the selection is recorded');
});

test('switching the rules off takes them out again', async t => {
  const { agent, sent } = agentWith(t);
  agent.setAntislop(['antislop']);
  await agent.run('One.');
  agent.setAntislop([]);
  await agent.run('Two.');
  const last = sent[sent.length - 1].find((m: any) => m.role === 'system');
  assert.ok(!last.content.includes('# Antislop rules in force'), 'the rules are gone');
});

test('a restored session keeps its rules without any runtime state', async t => {
  const guide = anti.guide(['antislop', 'antislop-ui']);
  const history = [
    { role: 'system', content: `Base prompt.\n\n# Antislop rules in force for this session\n${guide}` },
    { role: 'user', content: 'Earlier' },
    { role: 'assistant', content: 'Earlier answer' },
  ];
  const { agent, sent } = agentWith(t, history);
  assert.deepEqual(agent.antislopGroups, ['antislop', 'antislop-ui'], 'the selection is recovered from the message');
  await agent.run('Continue.');
  const system = sent[0].find((m: any) => m.role === 'system');
  assert.ok(system.content.includes('# Antislop rules in force'), 'the rules survive the restore');
  assert.ok(system.content.includes('antislop:groups=antislop,antislop-ui'));
});
