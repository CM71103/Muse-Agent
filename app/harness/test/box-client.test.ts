import type { TestContext } from 'node:test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { BoxClient, BoxAuthProvider, BOX_MCP_URL } = require('../box-client.ts');
const origin = new URL(BOX_MCP_URL).origin;

async function fixture(t: TestContext, options: any = {}) {
  let record = options.auth === false ? undefined : {
    clientInformation: { client_id: 'fixture-client', issuer: origin, redirect_uris: ['http://127.0.0.1:1/oauth/box/callback'] },
    tokens: { access_token: options.expired ? 'expired-fixture' : 'access-fixture', refresh_token: 'refresh-fixture', token_type: 'Bearer', issuer: origin },
  };
  const requests: any[] = [], states: any[] = [], authorizations: URL[] = [];
  let challenge = '', registered: any;
  const json = (response: any, value: any, headers: any = {}) => { response.writeHead(200, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)); };
  const server = http.createServer(async (request: any, response: any) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const route = request.url;
    if (route.startsWith('/.well-known/oauth-protected-resource')) return json(response, { resource: BOX_MCP_URL, authorization_servers: [origin], scopes_supported: ['boxes', 'connect'] });
    if (route === '/.well-known/oauth-authorization-server') return json(response, {
      issuer: origin, authorization_endpoint: `${origin}/cb/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    if (route === '/oauth/register') { registered = JSON.parse(body); return json(response, { ...registered, client_id: 'fixture-client' }); }
    if (route === '/oauth/token') {
      const params = new URLSearchParams(body);
      requests.push({ method: 'oauth-token', grant: params.get('grant_type') });
      if (params.get('grant_type') === 'authorization_code') {
        const verifier = params.get('code_verifier');
        assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
        assert.equal(params.get('code'), 'fixture-code');
        assert.equal(params.get('redirect_uri'), registered.redirect_uris[0]);
      }
      return json(response, { access_token: 'access-fixture', refresh_token: 'refresh-fixture', token_type: 'Bearer', expires_in: 3600 });
    }
    if (route !== '/mcp') { response.writeHead(404); response.end(); return; }
    if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
    if (request.headers.authorization !== 'Bearer access-fixture') {
      response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }); response.end(); return;
    }
    const message = JSON.parse(body); requests.push({ ...message, session: request.headers['mcp-session-id'] });
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') { response.writeHead(202); response.end(); return; }
    if (message.method === 'initialize') return json(response, { jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion, serverInfo: { name: 'Box fixture', version: '1' }, capabilities: { tools: {} },
    } }, { 'mcp-session-id': 'fixture-session' });
    if (message.method === 'tools/list') return json(response, { jsonrpc: '2.0', id: message.id, result: message.params.cursor
      ? options.repeatedCursor ? { tools: [], nextCursor: 'repeat' } : { tools: [{ name: 'screen', description: 'Screen fixture', inputSchema: { type: 'object' } }] }
      : { tools: [{ name: 'shell', description: 'Shell fixture', inputSchema: { type: 'object' } }], nextCursor: options.repeatedCursor ? 'repeat' : 'next' },
    });
    if (message.method === 'tools/call') {
      if (options.holdCall) return;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: options.oversizedResult ? 'x'.repeat(9 * 1024 * 1024) : 'fixture result' }], ...(options.toolError ? { isError: true } : {}),
      } })}\n\n`); return;
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const client = new BoxClient({
    loadAuth: () => structuredClone(record), saveAuth: (value: any) => { record = structuredClone(value); }, onStatus: (status: any) => states.push(status),
    onAuthorize: async (value: string) => {
      const url = new URL(value); authorizations.push(url);
      challenge = url.searchParams.get('code_challenge') || '';
      if (options.noCallback) return;
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('iss', origin);
      assert.equal((await fetch(callback)).status, 200);
    },
    fetch: async (input: any, init: any) => {
      const canonical = new URL(String(input)); const response = await fetch(`${local}${canonical.pathname}${canonical.search}`, init);
      Object.defineProperty(response, 'url', { value: canonical.href }); return response;
    },
  });
  t.after(async () => { await client.disconnect(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(resolve)); });
  return { client, requests, states, authorizations, record: () => record };
}

test('Box Streamable HTTP initializes, paginates tools, preserves session and consumes SSE results', async t => {
  const f = await fixture(t); const tools = await f.client.initialize();
  assert.deepEqual(tools.map((tool: any) => tool.name), ['shell', 'screen']);
  assert.equal(f.requests[0].method, 'initialize'); assert.ok(f.requests.some((request: any) => request.method === 'notifications/initialized'));
  assert.ok(f.requests.filter((request: any) => request.method === 'tools/list').every((request: any) => request.session === 'fixture-session'));
  assert.equal((await f.client.call('shell', { command: 'fixture only' })).content[0].text, 'fixture result');
  assert.equal(f.client.getStatus().state, 'connected'); assert.equal(f.authorizations.length, 0);
  assert.equal(JSON.stringify(f.states).includes('access-fixture'), false);
});

test('Box OAuth uses discovery, dynamic registration, state and PKCE with encrypted-store callbacks', async t => {
  const f = await fixture(t, { auth: false }); await f.client.connect({ interactive: true });
  assert.equal(f.authorizations.length, 1); assert.equal(f.authorizations[0].origin, origin);
  assert.equal(f.authorizations[0].searchParams.get('code_challenge_method'), 'S256');
  assert.ok(f.authorizations[0].searchParams.get('state')!.length >= 32);
  assert.equal(f.record().tokens.issuer, origin); assert.equal(f.record().clientInformation.issuer, origin);
  assert.equal(f.record().tokens.access_token, 'access-fixture');
  assert.equal(f.states.some((state: any) => state.state === 'awaiting_authorization'), true);
});

test('noninteractive missing credentials never open a browser or register a client', async t => {
  const f = await fixture(t, { auth: false }); await assert.rejects(() => f.client.initialize(), /Sign in to Box/);
  assert.equal(f.authorizations.length, 0); assert.equal(f.requests.length, 0);
});

test('401 refreshes issuer-bound credentials without browser prompts', async t => {
  const f = await fixture(t, { expired: true }); await f.client.initialize();
  assert.ok(f.requests.some((request: any) => request.grant === 'refresh_token'));
  assert.equal(f.authorizations.length, 0); assert.equal(f.record().tokens.access_token, 'access-fixture');
});

test('unknown tools and oversized arguments never reach Box', async t => {
  const f = await fixture(t); await f.client.initialize();
  await assert.rejects(() => f.client.call('unregistered', {}), /Unknown Box tool/);
  await assert.rejects(() => f.client.call('shell', { text: 'x'.repeat(300000) }), /oversized/);
  assert.equal(f.requests.filter((request: any) => request.method === 'tools/call').length, 0);
});

test('MCP tool errors are returned faithfully rather than mislabeled as successful execution', async t => {
  const f = await fixture(t, { toolError: true }); await f.client.initialize();
  assert.equal((await f.client.call('shell', {})).isError, true);
});

test('Box tool cancellation and request timeout are bounded', async t => {
  const f = await fixture(t, { holdCall: true }); await f.client.initialize();
  const controller = new AbortController(); const pending = f.client.call('shell', {}, { signal: controller.signal }); controller.abort();
  await assert.rejects(() => pending, /cancelled/);
  await assert.rejects(() => f.client.call('shell', {}, { timeoutMs: 100 }), /timed out/);
});

test('cancelled Box sign-in releases its loopback callback listener', async t => {
  const f = await fixture(t, { auth: false, noCallback: true });
  const started = f.client.connect({ interactive: true });
  for (let i = 0; i < 100 && !f.authorizations.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.authorizations.length, 1); const callback = f.authorizations[0].searchParams.get('redirect_uri')!;
  f.client.cancelAuth(); await assert.rejects(() => started);
  await assert.rejects(() => fetch(callback, { signal: AbortSignal.timeout(500) }));
});

test('disconnect forget clears saved authorization and closes the client', async t => {
  const f = await fixture(t); await f.client.initialize(); await f.client.disconnect({ forget: true });
  assert.equal(f.record(), undefined); assert.equal(f.client.dead, true); assert.equal(f.client.tools.length, 0);
});

test('loopback OAuth callback rejects wrong state without consuming the valid sign-in', async () => {
  const provider = new BoxAuthProvider({ loadAuth: () => undefined, saveAuth: () => {}, onAuthorize: () => {} });
  try {
    await provider.prepare(true); const callback = new URL(provider.redirectUrl);
    callback.searchParams.set('state', 'wrong'); callback.searchParams.set('code', 'fixture');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', provider.state());
    callback.searchParams.set('iss', 'https://unexpected.example');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.delete('iss');
    assert.equal((await fetch(callback)).status, 200);
    assert.equal(await provider.waitForCode(), 'fixture');
  } finally { provider.end(); }
});

test('repeated tool pagination is rejected without exposing a partially connected registry', async t => {
  const f = await fixture(t, { repeatedCursor: true });
  await assert.rejects(() => f.client.initialize(), /Could not connect/);
  assert.equal(f.client.dead, true); assert.deepEqual(f.client.tools, []);
  assert.equal(f.requests.filter((request: any) => request.method === 'tools/list').length, 2);
});

test('oversized streamed tool results fail within the response byte limit', async t => {
  const f = await fixture(t, { oversizedResult: true }); await f.client.initialize();
  await assert.rejects(() => f.client.call('shell', {}, { timeoutMs: 500 }), /failed or timed out/);
});

test('disconnect during credential loading cannot reopen a callback or publish connected', async () => {
  let release!: (value: undefined) => void, opened = 0;
  const client = new BoxClient({
    loadAuth: () => new Promise(resolve => { release = resolve; }), saveAuth: () => {}, onAuthorize: () => { opened++; },
  });
  const pending = client.connect({ interactive: true });
  const rejected = assert.rejects(() => pending);
  const stopped = client.disconnect({ forget: true }); release(undefined);
  await rejected; await stopped;
  assert.equal(opened, 0); assert.equal(client.getStatus().state, 'disconnected');
});

test('OAuth credential persistence retries after an earlier vault write fails', async () => {
  let fail = true, stored: any;
  const provider = new BoxAuthProvider({ loadAuth: () => undefined, saveAuth: (record: any) => {
    if (fail) throw new Error('fixture vault unavailable'); stored = record;
  }, onAuthorize: () => {} });
  await assert.rejects(() => provider.saveTokens({ access_token: 'first-fixture', issuer: origin }));
  fail = false; await provider.saveTokens({ access_token: 'second-fixture', issuer: origin });
  assert.equal(stored.tokens.access_token, 'second-fixture');
  provider.end();
});
