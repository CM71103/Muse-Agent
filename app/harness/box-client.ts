const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { auth, UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { BoxAuthProvider, BoxAuthRequiredError, BOX_MCP_URL, BOX_ORIGIN } = require('./box-auth.ts');

type Options = {
  loadAuth: () => any | Promise<any>;
  saveAuth: (record: any) => void | Promise<void>;
  onAuthorize: (url: string) => void | Promise<void>;
  onStatus?: (status: any) => void;
  fetch?: typeof fetch;
};
type ConnectOptions = { interactive?: boolean; signal?: AbortSignal; timeoutMs?: number };

class BoxClient {
  name = 'box';
  tools: any[] = [];
  dead = true;
  private state = 'disconnected';
  private error: string | undefined;
  private client: any = null;
  private transport: any = null;
  private lifetime: AbortController | null = null;
  private connecting: Promise<any> | null = null;
  private rawFetch: typeof fetch;
  private options: Options;
  readonly auth: any;

  constructor(options: Options) {
    this.options = options;
    this.rawFetch = options.fetch || fetch;
    this.auth = new BoxAuthProvider({ ...options, onAwaiting: () => this.publish('awaiting_authorization') });
  }
  getStatus() { return { state: this.state, authenticated: this.state === 'connected', toolCount: this.tools.length, ...(this.error ? { error: this.error } : {}) }; }
  private publish(state: string, error?: string) {
    this.state = state; this.error = error;
    try { this.options.onStatus?.(this.getStatus()); } catch {}
  }

  // Restrict both MCP and OAuth discovery/token requests to Box's canonical
  // origin. The injected fetch is only for deterministic local fixtures.
  private request = async (input: any, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin !== BOX_ORIGIN || url.username || url.password) throw new Error('Unexpected Box network destination');
    const controller = new AbortController();
    const signals = [controller.signal, this.lifetime?.signal, init.signal].filter(Boolean) as AbortSignal[];
    const signal = AbortSignal.any(signals);
    const timer = setTimeout(() => controller.abort(), url.pathname === '/mcp' ? 65000 : 20000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const finish = () => clearTimeout(timer);
    try {
      const response = await this.rawFetch(url, { ...init, signal, redirect: 'error' });
      if (!response.body) { finish(); return response; }
      // A GET event stream may remain open while the app is connected; SDK
      // request deadlines still bound individual tool calls.
      if (init.method === 'GET' && response.headers.get('content-type')?.includes('text/event-stream')) finish();
      reader = response.body.getReader();
      let bytes = 0;
      const bounded = new Response(new ReadableStream({
        async pull(stream) {
          try {
            const chunk = await reader!.read();
            if (chunk.done) { finish(); stream.close(); return; }
            bytes += chunk.value.byteLength;
            if (bytes > 8 * 1024 * 1024) throw new Error('Box response exceeded the 8 MiB limit');
            stream.enqueue(chunk.value);
          } catch (error) { finish(); controller.abort(); reader?.cancel().catch(() => {}); stream.error(error); }
        },
        cancel(reason) {
          finish();
          // Node's fetch rejects reader.cancel() if its signal was aborted
          // first, including SDK cleanup of accepted 202 notifications.
          const cancelled = reader!.cancel(reason).catch(() => {});
          controller.abort(); return cancelled;
        },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(bounded, 'url', { value: response.url || url.href });
      return bounded;
    } catch (error) { finish(); throw error; }
  };

  private async open(signal: AbortSignal, timeout: number) {
    const client = new Client({ name: 'muse-agent', version: '0.1.7' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(BOX_MCP_URL), {
      authProvider: this.auth, fetch: this.request,
      reconnectionOptions: { maxRetries: 1, initialReconnectionDelay: 1000, maxReconnectionDelay: 5000, reconnectionDelayGrowFactor: 1.5 },
    });
    this.client = client; this.transport = transport;
    client.onclose = () => {
      if (this.client === client && !this.dead) {
        this.dead = true; this.tools = [];
        this.publish('error', 'Box connection closed. Connect again from Connections.');
      }
    };
    await client.connect(transport, { signal, timeout, maxTotalTimeout: timeout });
    const discovered: any[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    if (client.getServerCapabilities()?.tools) for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout, maxTotalTimeout: timeout });
      for (const tool of result.tools || []) {
        if (!/^[\w.-]{1,128}$/.test(tool.name) || seen.has(tool.name)) throw new Error('Box returned invalid or duplicate tool names');
        seen.add(tool.name);
        discovered.push({ name: tool.name, description: String(tool.description || `Box ${tool.name}`).slice(0, 8000), inputSchema: tool.inputSchema || { type: 'object', properties: {} } });
        if (discovered.length > 500) throw new Error('Box returned too many tools');
      }
      cursor = result.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor) || page === 19) throw new Error('Box tool pagination exceeded its limit');
      cursors.add(cursor);
    }
    this.tools = discovered;
  }

  connect(options: ConnectOptions = {}) {
    if (this.connecting) return this.connecting;
    if (!this.dead && this.state === 'connected') return Promise.resolve(this.tools);
    this.connecting = this.connectInternal(options).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  private async connectInternal(options: ConnectOptions) {
    const interactive = !!options.interactive;
    const timeout = Math.max(100, Math.min(options.timeoutMs || (interactive ? 120000 : 20000), 180000));
    this.lifetime?.abort();
    this.lifetime = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeout);
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
    const abort = () => { this.lifetime?.abort(); this.auth.cancelAuth('Box connection cancelled or timed out'); };
    signal.addEventListener('abort', abort, { once: true });
    this.publish('connecting');
    try {
      await this.auth.prepare(interactive, signal, timeout);
      if (!await this.auth.tokens()) {
        if (!interactive) throw new BoxAuthRequiredError();
        const result = await auth(this.auth, { serverUrl: BOX_MCP_URL,
          resourceMetadataUrl: new URL(`${BOX_ORIGIN}/.well-known/oauth-protected-resource/mcp`), fetchFn: this.request });
        if (result === 'REDIRECT') {
          const code = await this.auth.waitForCode();
          await auth(this.auth, { serverUrl: BOX_MCP_URL, authorizationCode: code, fetchFn: this.request });
        }
      }
      try { await this.open(signal, Math.min(timeout, 20000)); }
      catch (error) {
        if (!(error instanceof UnauthorizedError) || !interactive || this.state !== 'awaiting_authorization') throw error;
        const code = await this.auth.waitForCode();
        await auth(this.auth, { serverUrl: BOX_MCP_URL, authorizationCode: code, fetchFn: this.request });
        await this.client?.close();
        await this.open(signal, Math.min(timeout, 20000));
      }
      if (signal.aborted) throw new Error('Box connection cancelled');
      this.dead = false; this.publish('connected');
      return this.tools;
    } catch (error: any) {
      this.dead = true; this.tools = [];
      await this.client?.close().catch(() => {}); this.client = null; this.transport = null;
      // Never forward raw SDK OAuth error bodies, codes, or token material.
      this.publish('error', error.code === 'BOX_AUTH_REQUIRED' ? error.message : 'Could not connect to Box. Sign in again or retry.');
      throw new Error(this.error);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.auth.end(); }
  }
  initialize() { return this.connect({ interactive: false }); }

  async call(name: string, args: any = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    if (this.dead || !this.client) throw new Error('Box is not connected');
    if (!this.tools.some(tool => tool.name === name)) throw new Error('Unknown Box tool');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 256 * 1024) throw new Error('Invalid or oversized Box tool arguments');
    const timeout = Math.max(100, Math.min(options.timeoutMs || 60000, 120000));
    try {
      return await this.client.callTool({ name, arguments: args }, undefined, { signal: options.signal, timeout, maxTotalTimeout: timeout });
    } catch (error) {
      if (error instanceof UnauthorizedError || (error as any).code === 'BOX_AUTH_REQUIRED') {
        this.dead = true; this.publish('error', 'Box sign-in expired. Connect again from Connections.');
      }
      throw new Error(options.signal?.aborted ? 'Box tool call cancelled' : 'Box tool call failed or timed out. Check the connection and retry.');
    }
  }
  cancelAuth() { this.lifetime?.abort(); this.auth.cancelAuth(); }
  async disconnect(options: { forget?: boolean } = {}) {
    this.lifetime?.abort(); this.auth.end(); this.dead = true; this.tools = [];
    await this.connecting?.catch(() => {});
    await this.client?.close().catch(() => {}); this.client = null; this.transport = null;
    if (options.forget) await this.auth.forget();
    this.publish('disconnected');
  }
  close() { return this.disconnect(); }
}

module.exports = { BoxClient, BoxAuthProvider, BOX_MCP_URL };
