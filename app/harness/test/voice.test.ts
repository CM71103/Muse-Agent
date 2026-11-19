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
