const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-attach-'));
process.env.MUSE_HOME = home;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-attach-work-'));

const pdfText = require('../pdf-text');
const caps = require('../model-caps');
const attachments = require('../attachments');
const turns = require('../turns');

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

// --- fixtures --------------------------------------------------------------

// A minimal but valid PDF: one page, real text, optionally Flate-compressed.
function makePdf(file: string, lines: string[], compress = false) {
  const content = lines.map((t, i) => `BT /F1 14 Tf 60 ${700 - i * 30} Td (${t}) Tj ET`).join('\n');
  const raw = Buffer.from(content, 'latin1');
  const data = compress ? zlib.deflateSync(raw) : raw;
  const filter = compress ? '/Filter/FlateDecode' : '';
  const objects: [number, Buffer][] = [
    [1, Buffer.from('<</Type/Catalog/Pages 2 0 R>>')],
    [2, Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>')],
    [3, Buffer.from('<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>')],
    [4, Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>')],
    [5, Buffer.concat([
      Buffer.from(`<</Length ${data.length}${filter}>>stream\n`),
      data,
      Buffer.from('\nendstream'),
    ])],
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets = new Map<number, number>();
  let pos = chunks[0].length;
  for (const [num, body] of objects) {
    offsets.set(num, pos);
    const head = Buffer.from(`${num} 0 obj`);
    const tail = Buffer.from('endobj\n');
    chunks.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  }
  const xref = pos;
  let out = Buffer.concat(chunks);
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const [num] of objects) table += `${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`;
  table += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  out = Buffer.concat([out, Buffer.from(table)]);
  fs.writeFileSync(file, out);
  return file;
}

// --- PDF text extraction ---------------------------------------------------

test('digital PDF text is extracted exactly (uncompressed and Flate)', () => {
  const a = makePdf(path.join(work, 'a.pdf'), ['Invoice 4821 total 99.50', 'IBAN DE89 3704 0044']);
  const b = makePdf(path.join(work, 'b.pdf'), ['Report revenue 1,250,000 EUR', 'Second line 7 end'], true);
  for (const f of [a, b]) {
    const res = pdfText.extract(f);
    assert.equal(res.ok, true, 'extraction succeeded');
    assert.equal(res.usable, true, `text layer usable for ${path.basename(f)}`);
    assert.match(res.text, /Invoice 4821 total 99\.50|Report revenue 1,250,000 EUR/);
    assert.match(res.text, /Second line 7 end|IBAN DE89 3704 0044/);
  }
});

test('a non-PDF file is rejected rather than mangled', () => {
  const f = path.join(work, 'not.pdf');
  fs.writeFileSync(f, 'this is not a pdf at all');
  const res = pdfText.extract(f);
  assert.equal(res.ok, false);
  assert.match(res.error, /not a PDF/);
});

test('garbage text layers are not trusted as usable', () => {
  assert.equal(pdfText.looksLikeText(''), false);
  assert.equal(pdfText.looksLikeText('short'), false);
  assert.equal(pdfText.looksLikeText('\u0000\u0001\u0002\u0003\u0004\u0005\u0006 binary noise'), false);
  assert.equal(pdfText.looksLikeText('Invoice 4821 total 99.50 due on Friday'), true);
});

test('PDF string escapes and hex strings decode', () => {
  assert.equal(pdfText.decodeLiteralString('a\\(b\\)c').toString('latin1'), 'a(b)c');
  assert.equal(pdfText.decodeLiteralString('line\\nbreak').toString('latin1'), 'line\nbreak');
  assert.equal(pdfText.decodeHexString('48656C6C6F').toString('latin1'), 'Hello');
});

// --- model capability gate -------------------------------------------------

test('vision capability is detected for known families and denied for text models', () => {
  for (const id of ['gpt-4o', 'gpt-4.1-mini', 'claude-3-5-sonnet', 'gemini-2.0-flash', 'qwen2-vl-7b', 'llama-3.2-11b-vision']) {
    assert.equal(caps.modelIsVisionCapable(id, {}), true, `${id} should be vision-capable`);
  }
  for (const id of ['gpt-3.5-turbo', 'text-embed-3-small', 'Qwen3.8-Flash-Next', 'llama3.1-8b', '']) {
    assert.equal(caps.modelIsVisionCapable(id, {}), false, `${id} should not be vision-capable`);
  }
});

test('config can force or widen vision capability', () => {
  assert.equal(caps.modelIsVisionCapable('my-local-vlm', { llm: { vision_capable: true } }), true);
  assert.equal(caps.modelIsVisionCapable('gpt-4o', { llm: { vision_capable: false } }), false);
  assert.equal(caps.modelIsVisionCapable('my-private-vlm', { llm: { vision_models: ['my-private-vlm'] } }), true);
});

// --- attachment ingestion --------------------------------------------------

test('a PDF attachment is ingested and its text is available', async () => {
  const file = makePdf(path.join(work, 'invoice.pdf'), ['Invoice 4821 total 99.50', 'Refund for order 4821']);
  const res = await attachments.ingestFile(file);
  assert.equal(res.ok, true);
  const meta = res.attachment;
  assert.equal(meta.kind, 'pdf');
  assert.equal(meta.has_text, true);
  assert.equal(meta.text_method, 'text-layer');
  assert.match(meta.preview, /Invoice 4821 total 99\.50/);
  // no filesystem path leaks to the renderer
  assert.equal((meta as any).path, undefined);
  const stored = attachments.loadMeta(meta.id);
  assert.ok(stored, 'meta persisted');
  assert.match(attachments.textFor([meta.id]), /\[attached file: invoice\.pdf/);
});

test('unsupported and oversized files are refused with a reason', async () => {
  const bad = path.join(work, 'notes.txt');
  fs.writeFileSync(bad, 'hello');
  const res = await attachments.ingestFile(bad);
  assert.equal(res.ok, false);
  assert.match(res.error, /unsupported file type/);
});

// --- staging ---------------------------------------------------------------

test('staged attachments are consumed once, per commandId', () => {
  attachments.stage('cmd-1', ['a', 'b', 'a']);
  assert.deepEqual(attachments.takeStaged('cmd-1'), ['a', 'b']);
  assert.deepEqual(attachments.takeStaged('cmd-1'), []);
  attachments.stage('cmd-2', ['c']);
  assert.deepEqual(attachments.takeStaged('cmd-2'), ['c']);
  assert.deepEqual(attachments.takeStaged('cmd-1'), []);
});

// --- turn assembly: the capability gate ------------------------------------

function stubAgent(model: string) {
  const calls: any = { run: null, events: [] as any[] };
  return {
    calls,
    agent: {
      cfg: { llm: { model } },
      lastMemoryTurnId: null,
      run: async (text: string, opts: any) => { calls.run = { text, opts }; return { text: 'ok', turns: 1, memory_turn_id: 'm1' }; },
      ingestUserTurn: async () => {},
      events: (e: any) => calls.events.push(e),
    },
  };
}

test('a vision-capable model receives the image pixels', async () => {
  const file = makePdf(path.join(work, 'doc.pdf'), ['hello']);
  const ing = await attachments.ingestFile(file);
  assert.equal(ing.ok, true);
  // craft an IMAGE attachment descriptor on disk for the pixel path
  const imgDir = path.join(attachments.rootDir(), 'img-fixture');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.writeFileSync(path.join(imgDir, 'shot.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  fs.writeFileSync(path.join(imgDir, 'meta.json'), JSON.stringify({
    id: 'img-fixture', name: 'shot.png', kind: 'image', mime: 'image/png', bytes: 8,
    path: path.join(imgDir, 'shot.png'), created_at: new Date().toISOString(),
    text: 'OCR text of the screenshot', text_method: 'ocr', pages: 1, engine: 'en-GB', error: null,
  }));

  const { agent, calls } = stubAgent('gpt-4o');
  attachments.stage('cmd-v', ['img-fixture']);
  await turns.runTurn({ agent, raw: 'what is in this image?', project: null, commandId: 'cmd-v' });

  const content = calls.run.opts.content;
  assert.ok(Array.isArray(content), 'message carries a content array');
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /what is in this image\?/);
  assert.match(content[0].text, /OCR text of the screenshot/);
  const img = content.find((p: any) => p.type === 'image_url');
  assert.ok(img, 'image part present for a vision model');
  assert.match(img.image_url.url, /^data:image\/png;base64,/);
});

test('a text-only model gets the extracted text and NOT the pixels', async () => {
  const { agent, calls } = stubAgent('text-only-model-7b');
  attachments.stage('cmd-t', ['img-fixture']);
  await turns.runTurn({ agent, raw: 'describe it', project: null, commandId: 'cmd-t' });

  const content = calls.run.opts.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.find((p: any) => p.type === 'image_url'), undefined, 'no pixels for a text-only model');
  assert.match(content[0].text, /describe it/);
  assert.match(content[0].text, /OCR text of the screenshot/);
  const infos = calls.events.filter(e => e.type === 'info');
  assert.ok(infos.some(e => /not sent as pixels/.test(e.text)), 'the user is told why');
});

test('no attachments means no content array (plain text turns unchanged)', async () => {
  const { agent, calls } = stubAgent('gpt-4o');
  await turns.runTurn({ agent, raw: 'plain question', project: null, commandId: 'cmd-p' });
  assert.equal(calls.run.opts.content, undefined);
  assert.equal(calls.run.text, 'plain question');
});

test('the extracted PDF text actually reaches the request the provider receives', async () => {
  const file = makePdf(path.join(work, 'statement.pdf'), ['Statement of account 4821', 'Balance due 99.50 EUR']);
  const ing = await attachments.ingestFile(file);
  assert.equal(ing.ok, true);

  // 1) the turn builds the multimodal user message
  const { agent, calls } = stubAgent('text-only-model');
  attachments.stage('cmd-live', [ing.attachment.id]);
  await turns.runTurn({ agent, raw: 'what does the statement say?', project: null, commandId: 'cmd-live' });
  const content = calls.run.opts.content;
  assert.ok(Array.isArray(content), 'content array built');

  // 2) the REAL send path forwards it (memory-host.sendWithMemory), with a
  //    provider stub that captures the request.
  let sent: any = null;
  const host = require('../memory-host.ts');
  const sending: any = {
    cfg: { llm: { model: 'text-only-model', max_tokens: 1024 }, context_tokens: 200000 },
    history: [{ role: 'user', content }],
    memory: null,
    refreshPermissionMode: () => {},
    toolSchemas: () => [],
    llm: {
      chat: async (messages: any[]) => {
        sent = { messages };
        return { message: { role: 'assistant', content: 'read it' }, canonical: { role: 'assistant', text: 'read it', toolCalls: [], reasoning: '' }, finish_reason: 'stop' };
      },
    },
  };
  await host.sendWithMemory.call(sending, {}, undefined, []);

  assert.ok(sent && sent.messages, 'the provider received a request');
  const userMsg = sent.messages.find((m: any) => m.role === 'user');
  const text = Array.isArray(userMsg.content)
    ? userMsg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
    : String(userMsg.content);
  assert.match(text, /what does the statement say\?/);
  assert.match(text, /Statement of account 4821/);
  assert.match(text, /Balance due 99\.50 EUR/);
  assert.match(text, /\[attached file: statement\.pdf/);
});

test('stored image parts are dropped when the model cannot see images', async () => {
  const host = require('../memory-host.ts');
  let sent: any = null;
  const history = [{ role: 'user', content: [
    { type: 'text', text: 'old turn' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ] }];
  const sending: any = {
    cfg: { llm: { model: 'text-only-model', max_tokens: 1024 }, context_tokens: 200000 },
    history, memory: null, refreshPermissionMode: () => {}, toolSchemas: () => [],
    llm: { chat: async (messages: any[]) => { sent = { messages }; return { message: { role: 'assistant', content: 'ok' } }; } },
  };
  await host.sendWithMemory.call(sending, {}, undefined, []);
  const parts = sent.messages.find((m: any) => m.role === 'user').content;
  assert.equal(parts.find((p: any) => p.type === 'image_url'), undefined, 'pixels dropped for a text-only model');
  assert.match(parts[0].text, /old turn/);
});
