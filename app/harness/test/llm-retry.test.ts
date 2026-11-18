const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LlmClient } = require('../llm');

const cfg = { llm: { base_url: 'https://provider.invalid/v1', api_key: 'k', model: 'fixture-model', retry_attempts: 3 }, api_key: 'k' };

function jsonResponse(body) {
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => body };
}
const reply = (content, finish = 'stop') => jsonResponse({
  choices: [{ message: { role: 'assistant', content }, finish_reason: finish }], usage: { total_tokens: 3 },
});

test('an early stream cut (empty reply, finish_reason missing) is retried', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    // First attempt: the stream ended before the provider's closing chunk —
    // content empty, finish_reason null. Second attempt: a clean reply.
    return calls === 1 ? reply('', null) : reply('hello');
  };
  const client = new LlmClient(cfg);
  const res = await client.chat([{ role: 'user', content: 'hi' }], null);
  assert.equal(res.message.content, 'hello');
  assert.equal(calls, 2, 'the transient empty must be retried');
});

test('a deliberate empty reply (finish_reason stop) is not retried', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return reply('', 'stop'); };
  const client = new LlmClient(cfg);
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }], null), /empty response/);
  assert.equal(calls, 1, 'a model-decided empty must surface immediately');
});

test('reasoning_content is captured so truncated streams are visible', async () => {
  global.fetch = async () => jsonResponse({
    choices: [{ message: { role: 'assistant', content: 'answer', reasoning_content: 'thinking…' }, finish_reason: 'stop' }],
    usage: { total_tokens: 3 },
  });
  const client = new LlmClient(cfg);
  const res = await client.chat([{ role: 'user', content: 'hi' }], null);
  assert.equal(res.message.reasoning_content, 'thinking…');
  assert.equal(res.message.content, 'answer');
});
