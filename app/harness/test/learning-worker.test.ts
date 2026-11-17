const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLearningWorker } = require('../../learning/worker.ts');
const { createLearningStore } = require('../../learning/store.ts');
const messages = [{ role: 'user', content: 'synthetic fixture only' }];
const lesson = { text: 'Observed a fixture preference.', kind: 'review', verification: 'observed', source_event_ids: ['fixture-event'], evidence: 'Synthetic fixture preference.' };
function deferred() { let resolve!: (value?: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t: any, options: any = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-learning-worker-test-'));
  let clock = Date.parse('2026-11-09T12:00:00Z'), foreground = false, scope = 'project-a';
  const store = createLearningStore(directory), calls: any[] = [], published: any[] = [];
  const tasks = options.tasks || { run: async (_kind: string, ctx: any) => {
    await ctx.chat(messages, options.output || 100); return { summary: 'Fixture completed.', lessons: [lesson] };
  } };
  const worker = createLearningWorker({ directory, store, now: () => clock, tasks,
    getConfig: () => ({ llm: { model: 'fixture-model', base_url: 'https://provider.invalid/v1', api_key: 'synthetic-only' } }),
    getScope: () => scope, busy: () => foreground, systemIdleSeconds: () => 3600,
    practice: options.practice || { ready: async () => ({ ready: true, detail: 'Fixture ready.' }) },
    client: (cfg: any) => ({ chat: async (sent: any[], tools: any, request: any) => {
      calls.push({ cfg, sent, tools, request });
      assert.equal(tools, null); assert.equal(cfg.llm.retry_attempts, 1); assert.equal(cfg.llm.timeout_s, 45);
      assert.ok(store.used(clock) > 0, 'reservation exists before provider call');
      const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'learning.json'), 'utf8'));
      assert.ok(persisted.usage[new Date(clock).toISOString().slice(0, 10)] > 0, 'reservation is durable before provider call');
      if (options.chat) return options.chat(request, cfg);
      return { message: { content: 'synthetic' }, usage: { total_tokens: 25 } };
    } }),
    publishLessons: async (notes: any[], jobScope: string, check: () => void) => { check(); published.push({ notes, scope: jobScope }); },
  });
  t.after(async () => { await worker.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await worker.save({ enabled: true, review: true, practice: false, research: false, idle_minutes: 1, interval_minutes: 5, daily_token_cap: 2000 });
  return { worker, store, calls, published, directory, advance: (ms = 60000) => { clock += ms; },
    busy: (value: boolean) => { foreground = value; }, scope: (value: string) => { scope = value; }, now: () => clock };
}

test('learning reserves durably before provider execution and settles known token usage', async t => {
  const f = await fixture(t); f.advance(); await f.worker.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.store.used(f.now()), 25);
  assert.equal(f.worker.status().jobs[0].tokens, 25); assert.equal(f.worker.status().jobs[0].status, 'completed');
  assert.equal(f.published[0].scope, 'project-a'); assert.equal(f.published[0].notes[0].scope, 'project-a');
});

test('failed and missing-usage provider requests retain their full durable reservations', async t => {
  for (const fails of [false, true]) {
    const f = await fixture(t, { chat: async () => { if (fails) throw Error('fixture provider rejected'); return { message: { content: 'fixture' } }; } });
    f.advance(); await f.worker.tick();
    const expected = Buffer.byteLength(JSON.stringify(messages)) + 100 + 256;
    assert.equal(f.store.used(f.now()), expected); assert.equal(f.worker.status().jobs[0].tokens, expected);
    assert.equal(f.worker.status().jobs[0].status, fails ? 'failed' : 'completed');
    if (fails) assert.equal(f.published.length, 0);
  }
});

test('daily budget blocks calls before execution and resets on the next UTC day', async t => {
  const f = await fixture(t); f.store.charge(f.now(), 1999); f.advance(); await f.worker.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.published.length, 0);
  f.advance(86400000); await f.worker.tick(); assert.equal(f.calls.length, 1); assert.equal(f.store.used(f.now()), 25);
});

test('queued jobs wait for actual idle and foreground work preempts acceptance', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { chat: async () => { started.resolve(); await release.promise; return { message: { content: 'fixture' } }; } });
  await f.worker.queue('review'); await f.worker.tick(); assert.equal(f.calls.length, 0); assert.equal(f.worker.status().queued_kind, 'review');
  f.advance(); const pending = f.worker.tick(); await started.promise;
  f.busy(true); await f.worker.tick(); assert.equal(f.calls[0].request.signal.aborted, true);
  release.resolve(); await pending;
  assert.equal(f.published.length, 0); assert.equal(f.worker.status().jobs[0].status, 'paused');
  assert.ok(f.store.used(f.now()) > 0, 'cancelled request without usage remains charged');
});

test('scope switches discard in-flight results instead of publishing into either project', async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { chat: async () => { started.resolve(); await release.promise; return { message: { content: 'fixture' }, usage: { total_tokens: 19 } }; } });
  f.advance(); const pending = f.worker.tick(); await started.promise; f.scope('project-b'); release.resolve(); await pending;
  assert.equal(f.published.length, 0); assert.equal(f.worker.status().jobs[0].scope, 'project-a'); assert.equal(f.worker.status().jobs[0].status, 'paused');
});

test('pause persists disabled state and a second store cannot steal the active instance lease', async t => {
  const f = await fixture(t); await f.worker.pause();
  const competing = createLearningStore(f.directory); assert.equal(competing.available(), false); assert.match(competing.error(), /another Muse/);
  competing.close(); assert.equal(fs.existsSync(path.join(f.directory, 'worker.lock')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'learning.json'), 'utf8')).settings.enabled, false);
  await f.worker.close(); const reopened = createLearningStore(f.directory);
  try { assert.equal(reopened.available(), true); assert.equal(reopened.data.settings.enabled, false); } finally { reopened.close(); }
});

test('overlapping ticks execute only one job and enforce a fixed two-model-request cap', async t => {
  const started = deferred(), release = deferred(); let taskCalls = 0;
  const f = await fixture(t, { tasks: { run: async (_kind: string, ctx: any) => {
    taskCalls++; started.resolve(); await release.promise;
    await ctx.chat(messages, 100); await ctx.chat(messages, 100); await ctx.chat(messages, 100);
    return { summary: 'Must not be reached', lessons: [lesson] };
  } } });
  f.advance(); const pending = f.worker.tick(); await started.promise;
  await Promise.all([f.worker.tick(), f.worker.tick()]); release.resolve(); await pending;
  assert.equal(taskCalls, 1); assert.equal(f.calls.length, 2); assert.equal(f.published.length, 0);
  assert.equal(f.worker.status().jobs[0].status, 'failed'); assert.match(f.worker.status().jobs[0].error, /two-request/);
});

test('shutdown aborts the job and waits for asynchronous cleanup before releasing its lease', async t => {
  const started = deferred(), release = deferred(); let cleaned = false;
  const f = await fixture(t, { tasks: { run: async (_kind: string, ctx: any) => {
    started.resolve(); try { await release.promise; ctx.checkpoint(); return { lessons: [] }; } finally { cleaned = true; }
  } } });
  f.advance(); const running = f.worker.tick(); await started.promise;
  let closed = false; const closing = f.worker.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(fs.existsSync(path.join(f.directory, 'worker.lock')), true);
  release.resolve(); await running; await closing;
  assert.equal(cleaned, true); assert.equal(fs.existsSync(path.join(f.directory, 'worker.lock')), false); assert.equal(f.published.length, 0);
});

test('practice readiness gates execution before any model call or lesson acceptance', async t => {
  let taskCalls = 0;
  const f = await fixture(t, { practice: { ready: async () => ({ ready: false, detail: 'Save an authenticated Ubuntu checkpoint.' }) }, tasks: { run: async () => { taskCalls++; return { lessons: [] }; } } });
  await f.worker.save({ review: false, practice: true }); f.advance(); await f.worker.tick();
  assert.equal(taskCalls, 0); assert.equal(f.calls.length, 0); assert.match(f.worker.status().jobs[0].error, /checkpoint/);
});

test('a job history write failure clears active state and prevents any provider execution', async t => {
  const f = await fixture(t), original = f.store.write;
  f.store.write = () => { throw Error('fixture disk unavailable'); };
  f.advance(); await f.worker.tick();
  assert.equal(f.worker.status().active, null); assert.equal(f.calls.length, 0); assert.equal(f.published.length, 0);
  assert.equal(f.worker.status().jobs[0].status, 'failed'); f.store.write = original;
});

test('status exposes scope, schedule summary and resume eligibility', async t => {
  const f = await fixture(t); f.scope('project-a');
  const status = f.worker.status();
  assert.equal(status.scope, 'project-a');
  assert.match(status.schedule_summary, /After 1 minute idle/);
  assert.equal(status.can_resume, false);
});

test('stop aborts the active session without disabling scheduling', async t => {
  const started = deferred(), release = deferred(); let taskDone = false;
  const f = await fixture(t, { tasks: { run: async (_kind: string, ctx: any) => {
    started.resolve();
    await Promise.race([
      release.promise,
      new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(Error('Learning paused for foreground activity.'), { name: 'AbortError' })), { once: true }))
    ]);
    taskDone = true; ctx.checkpoint(); return { lessons: [] };
  } } });
  f.advance(); const running = f.worker.tick(); await started.promise;
  assert.equal(f.worker.status().active?.kind, 'review');
  const stopped = await f.worker.stop();
  assert.equal(stopped.active, null); assert.equal(stopped.settings.enabled, true);
  await running; assert.equal(taskDone, false);
});

test('pause disables scheduling and resume re-enables it', async t => {
  const f = await fixture(t);
  await f.worker.pause();
  assert.equal(f.worker.status().state, 'disabled');
  assert.equal(f.worker.status().can_resume, true);
  const resumed = await f.worker.resume();
  assert.equal(resumed.settings.enabled, true); assert.equal(resumed.can_resume, false); assert.notEqual(resumed.state, 'disabled');
});

test('circuit breaker pauses scheduling after repeated failures', async t => {
  const f = await fixture(t, { chat: async () => { throw Error('fixture provider rejected'); } });
  for (let i = 0; i < 3; i++) { f.advance(i === 0 ? 60000 : 6 * 60000); await f.worker.tick(); }
  assert.equal(f.worker.status().state, 'error');
  assert.equal(f.worker.status().settings.enabled, false);
  assert.equal(f.worker.status().can_resume, false);
  assert.match(f.worker.status().error, /3 consecutive failures/);
});

test('success resets the failure counter', async t => {
  const f = await fixture(t, { chat: async () => { throw Error('fixture provider rejected'); } });
  f.advance(); await f.worker.tick(); assert.equal(f.worker.status().jobs[0].status, 'failed');
  await f.worker.save({ enabled: true });
  const status = f.worker.status(); assert.equal(status.state, 'waiting_for_idle'); assert.equal(status.can_resume, false);
});
