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
const sseDelta = (d, finish) => `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] })}\n\n`;
function sseResponse(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({ read: async () => i >= chunks.length ? { done: true, value: undefined } : { done: false, value: enc.encode(chunks[i++]) } }) },
  };
}

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

test('a stream cut mid-reply is retried even when partial text arrived', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    // First attempt: text arrives, then the connection drops — no finish_reason,
    // reply cut mid-word. Second attempt: the stream completes properly.
    return calls === 1
      ? sseResponse([sseDelta({ content: 'why web isn' })])
      : sseResponse([sseDelta({ content: 'why web is not building' }), sseDelta({}, 'stop')]);
  };
  const client = new LlmClient(cfg);
  const res = await client.chat([{ role: 'user', content: 'hi' }], null, { onDelta: () => {} });
  assert.equal(res.message.content, 'why web is not building');
  assert.equal(calls, 2, 'the truncated stream must be retried');
  assert.notEqual(res.truncated, true);
});

test('if every attempt truncates, the partial reply is kept, not dropped', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return sseResponse([sseDelta({ content: 'partial answer' })]); };
  const client = new LlmClient(cfg);
  const res = await client.chat([{ role: 'user', content: 'hi' }], null, { onDelta: () => {} });
  assert.equal(res.message.content, 'partial answer');
  assert.equal(res.truncated, true);
  assert.equal(calls, 3, 'retries stay bounded');
});
