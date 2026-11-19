const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-voice-'));
process.env.MUSE_HOME = home;
const voice = require('../voice');
const sources = require('../voice-sources');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// Fixtures use a distinctive phrase that must NEVER appear in the guide —
// the privacy contract: style metrics only, no conversation content.
const SECRET = 'kumquat festival planning';

function fixtureTranscript(n = 14) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ message: { role: 'user', content: `how do i fix this ${SECRET} issue?` } }));
    lines.push(JSON.stringify({ message: { role: 'assistant', content: 'Short answer: do this.\n\n- step one\n- step two\n- step three\n\nLet me know if stuck.' } }));
    lines.push(JSON.stringify({ message: { role: 'assistant', content: ['Use `npm run dist`.', 'Then check the output.'].map(t => ({ type: 'text', text: t })) } }));
    lines.push(JSON.stringify({ message: { role: 'user', content: 'ok cool' } }));
  }
  return lines.join('\n');
}

test('analyze measures length, structure, and register', () => {
  const f = voice.analyze([
    ...Array.from({ length: 10 }, () => ({ role: 'user', text: 'how do i do x?' })),
    ...Array.from({ length: 10 }, () => ({ role: 'assistant', text: 'Do this:\n\n- one\n- two\n\nLet me know.' })),
  ]);
  assert.ok(f.assistant.medianWords < 25, 'short answers detected');
  assert.ok(f.assistant.listRate > 0.9, 'list-heavy style detected');
  assert.ok(f.assistant.recapRate > 0.9, 'recap closer detected');
  assert.ok(f.user.questionRate > 0.9, 'question phrasing detected');
});

test('calibrate learns from local sources and the guide is metrics-only', () => {
  const claudeDir = path.join(home, 'fake-claude');
  fs.mkdirSync(path.join(claudeDir, 'proj-a'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'proj-a', 'session.jsonl'), fixtureTranscript(14));
  const res = voice.calibrate({ roots: [{ kind: 'claude-projects', path: claudeDir, confidence: 'high' }] });
  assert.equal(res.ok, true);
  assert.ok(res.messages >= 20);
  assert.match(res.guide, /short and direct/i);
  assert.match(res.guide, /bullet lists/i);
  assert.match(res.guide, /No emoji/);
  // PRIVACY: no content from the transcripts may leak into the guide
  assert.ok(!res.guide.includes(SECRET), 'guide must never quote conversation content');
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'voice.json'), 'utf8'));
  assert.ok(stored.features.assistant.count > 0);
  assert.equal(voice.voiceGuide().includes(SECRET), false);
});

test('reset disables the profile and empties the system-prompt block', () => {
  assert.ok(voice.voiceGuide().length > 0, 'guide active before reset');
  voice.reset();
  assert.equal(voice.voiceGuide(), '');
  assert.equal(voice.isDisabled(), true);
  assert.equal(voice.status().calibrated, false);
});

test('calibrate refuses with too little history', () => {
  const dir = path.join(home, 'tiny');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), JSON.stringify({ message: { role: 'user', content: 'hi' } }) + '\n');
  const res = voice.calibrate({ roots: [{ kind: 'muse-sessions', path: dir, confidence: 'high' }] });
  assert.equal(res.ok, false);
  assert.match(res.error, /not enough/);
});

test('ChatGPT export parsing reads message pairs from mapping trees', () => {
  const file = path.join(home, 'conversations.json');
  fs.writeFileSync(file, JSON.stringify([
    {
      title: 'chat', mapping: {
        a: { message: { author: { role: 'user' }, content: { parts: ['what is 2+2?'] }, create_time: 1 } },
        b: { message: { author: { role: 'assistant' }, content: { parts: ['It is 4.', 'Always.'] }, create_time: 2 } },
        c: { node: 'no message here' },
      },
    },
  ]));
  const msgs = sources.parseChatgptExport(file);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant']);
  assert.equal(msgs[1].text, 'It is 4.\nAlways.');
});

test('Codex rollouts are read from disk, including zstd-compressed ones', () => {
  const root = path.join(home, 'fake-codex', '2026', '06', '13');
  fs.mkdirSync(root, { recursive: true });
  const record = (role: string, text: string, extra: any = {}) => JSON.stringify({
    timestamp: '2026-06-13T00:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra },
  });
  const lines = [
    record('user', '<environment_context>\n  <cwd>C:\\x</cwd>\n</environment_context>'),
    record('developer', 'you are a coding agent'),
    record('user', `how do I ship this ${SECRET} feature?`),
    record('assistant', 'Here is the plan.', { phase: 'final_answer' }),
    record('assistant', '[external_agent_tool_call: Skill]\ninput: {}\n[/external_agent_tool_call]', { phase: 'commentary' }),
    record('user', '[Request interrupted by user for tool use]'),
  ];
  fs.writeFileSync(path.join(root, 'rollout-plain.jsonl'), lines.join('\n'));
  const zlib = require('node:zlib');
  if (typeof zlib.zstdCompressSync === 'function') {
    fs.writeFileSync(path.join(root, 'rollout-zst.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')));
  }
  const msgs = sources.parseCodexSessions(path.join(home, 'fake-codex'));
  const texts = msgs.map(m => m.text);
  assert.ok(texts.includes(`how do I ship this ${SECRET} feature?`), 'the real user turn is kept');
  assert.ok(texts.includes('Here is the plan.'), 'the final answer is kept');
  assert.ok(!texts.some(t => t.includes('environment_context')), 'environment context is not voice');
  assert.ok(!texts.some(t => t.includes('you are a coding agent')), 'developer prompt is not voice');
  assert.ok(!texts.some(t => t.includes('external_agent_tool_call')), 'tool machinery is not voice');
  assert.ok(!texts.some(t => t.includes('Request interrupted')), 'interruption notes are not voice');
  assert.deepEqual(new Set(msgs.map(m => m.role)), new Set(['user', 'assistant']));
});

test('Codex sessions are discovered as a high-confidence source', () => {
  const fakeHome = path.join(home, 'home-with-codex');
  fs.mkdirSync(path.join(fakeHome, '.codex', 'sessions'), { recursive: true });
  const roots = sources.discoverRoots({ home: fakeHome });
  const codex = roots.find((r: any) => r.kind === 'codex-sessions');
  assert.ok(codex, 'codex sessions must be discovered');
  assert.equal(codex.confidence, 'high');
});

test('Cline transcripts are read, with tool traffic and wrappers removed', () => {
  const root = path.join(home, 'fake-cline', 'session-1');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'session-1.messages.json'), JSON.stringify({
    version: 1,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `<user_input mode="plan">please explain ${SECRET}</user_input>` }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal reasoning, not voice' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is the explanation.' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', name: 'shell', content: [{ query: 'y', result: 'z' }] }] },
    ],
  }));
  const msgs = sources.parseClineSessions(path.join(home, 'fake-cline'));
  const texts = msgs.map(m => m.text);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant']);
  assert.ok(texts[0].includes('please explain'), 'the wrapper is stripped');
  assert.ok(!texts[0].includes('user_input'), 'the wrapper tag is gone');
  assert.equal(texts[1], 'Here is the explanation.');
  assert.ok(!texts.some(t => t.includes('internal reasoning')), 'thinking is not voice');
  assert.ok(!texts.some(t => t.includes('tool_use')), 'tool traffic is not voice');
});

test('the Codex corpus feeds calibration without leaking its content', () => {
  const root = path.join(home, 'fake-codex-cal', '2026', '06', '13');
  fs.mkdirSync(root, { recursive: true });
  const lines = [];
  for (let i = 0; i < 12; i++) {
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `fix the ${SECRET} bug` }] } }));
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Short answer:\n\n- step one\n- step two\n\nLet me know.' }] } }));
  }
  fs.writeFileSync(path.join(root, 'rollout-a.jsonl'), lines.join('\n'));
  const res = voice.calibrate({ roots: [{ kind: 'codex-sessions', path: path.join(home, 'fake-codex-cal'), confidence: 'high' }] });
  assert.equal(res.ok, true);
  assert.ok(res.messages >= 20, 'enough messages for calibration');
  assert.ok(!res.guide.includes(SECRET), 'guide must never quote Codex conversations');
  assert.match(res.guide, /short and direct/i);
});
