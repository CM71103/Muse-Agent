import type { Server } from 'node:http';
const http = require('node:http');
const crypto = require('node:crypto');

const BOX_MCP_URL = 'https://mcp.box.simular.ai/mcp';
const BOX_ORIGIN = new URL(BOX_MCP_URL).origin;
type AuthRecord = { clientInformation?: any; tokens?: any; discovery?: any };
type AuthOptions = {
  loadAuth: () => AuthRecord | undefined | Promise<AuthRecord | undefined>;
  saveAuth: (record: AuthRecord | undefined) => void | Promise<void>;
  onAuthorize: (url: string) => void | Promise<void>;
  onAwaiting?: () => void;
};

class BoxAuthRequiredError extends Error {
  code = 'BOX_AUTH_REQUIRED';
  constructor() { super('Sign in to Box from Connections to continue'); }
}

class BoxAuthProvider {
  private record: AuthRecord = {};
  private loaded: Promise<void> | null = null;
  private saves = Promise.resolve();
  private listener: Server | null = null;
  private redirect = 'http://127.0.0.1:1/oauth/box/callback';
  private nonce = '';
  private verifier = '';
  private pending: { promise: Promise<string>; resolve: (code: string) => void; reject: (error: Error) => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private removeAbort: (() => void) | null = null;
  private options: AuthOptions;
  interactive = false;
  constructor(options: AuthOptions) { this.options = options; }

  async load() {
    this.loaded ||= Promise.resolve(this.options.loadAuth()).then(record => {
      if (record && (typeof record !== 'object' || Array.isArray(record))) throw new Error('Box saved authorization is invalid');
      this.record = structuredClone(record || {});
      const redirect = this.record.clientInformation?.redirect_uris?.[0];
      if (this.isCallback(redirect)) this.redirect = redirect;
    });
    await this.loaded;
  }
  private isCallback(value: unknown) {
    try { const url = new URL(String(value)); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/oauth/box/callback' && !!url.port; }
    catch { return false; }
  }
  private bound(value: any) {
    if (!value) return undefined;
    return !value.issuer || new URL(value.issuer).origin === BOX_ORIGIN ? structuredClone(value) : undefined;
  }
  private async persist() {
    const snapshot = structuredClone(this.record);
    this.saves = this.saves.catch(() => {}).then(() => this.options.saveAuth(snapshot));
    await this.saves;
  }
  get redirectUrl() { return this.redirect; }
  get clientMetadata() {
    if (!this.interactive && !this.record.clientInformation) throw new BoxAuthRequiredError();
    return { client_name: 'Muse Agent', redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'boxes connect' };
  }
  state() { if (!this.interactive || !this.nonce) throw new BoxAuthRequiredError(); return this.nonce; }
  async clientInformation() { await this.load(); return this.bound(this.record.clientInformation); }
  async saveClientInformation(value: any) { await this.load(); this.record.clientInformation = value; await this.persist(); }
  async tokens() { await this.load(); return this.bound(this.record.tokens); }
  async saveTokens(value: any) { await this.load(); this.record.tokens = value; await this.persist(); }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new Error('Box sign-in expired; connect again'); return this.verifier; }
  async discoveryState() { await this.load(); return this.record.discovery; }
  async saveDiscoveryState(value: any) { await this.load(); this.record.discovery = value; await this.persist(); }
  async invalidateCredentials(scope: string) {
    await this.load();
    if (scope === 'all') this.record = {};
    if (scope === 'client') delete this.record.clientInformation;
    if (scope === 'tokens') delete this.record.tokens;
    if (scope === 'discovery') delete this.record.discovery;
    if (scope === 'all' || scope === 'verifier') this.verifier = '';
    await this.persist();
  }
  async validateResourceURL(_server: unknown, resource?: string) {
    if (resource && resource.replace(/\/$/, '') !== BOX_MCP_URL) throw new Error('Box authorization resource does not match the MCP server');
    return new URL(BOX_MCP_URL);
  }
  async redirectToAuthorization(url: URL) {
    if (!this.interactive || !this.pending) throw new BoxAuthRequiredError();
    if (url.origin !== BOX_ORIGIN || url.protocol !== 'https:') throw new Error('Unexpected Box authorization destination');
    this.options.onAwaiting?.();
    await this.options.onAuthorize(url.href);
  }
  async prepare(interactive: boolean, signal?: AbortSignal, timeoutMs = 120000) {
    await this.load();
    this.end();
    if (signal?.aborted) throw new Error('Box sign-in cancelled');
    this.interactive = interactive;
    if (!interactive) return;
    this.nonce = crypto.randomBytes(32).toString('base64url');
    let resolve!: (code: string) => void, reject!: (error: Error) => void;
    const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {}); // Cancellation can precede the transport's wait.
    this.pending = { promise, resolve, reject };
    const server = http.createServer({ maxHeaderSize: 8192 }, (request: any, response: any) => {
      let url: URL;
      try { url = new URL(request.url || '/', this.redirect); }
      catch { response.writeHead(400); response.end('Invalid request'); return; }
      const expectedHost = new URL(this.redirect).host;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'GET' || request.headers.host !== expectedHost || url.pathname !== '/oauth/box/callback') {
        response.writeHead(404); response.end('Not found'); return;
      }
      const supplied = Buffer.from(url.searchParams.get('state') || '');
      const expected = Buffer.from(this.nonce);
      if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        response.writeHead(400); response.end('Invalid sign-in state'); return;
      }
      if (url.searchParams.has('iss') && url.searchParams.get('iss')?.replace(/\/$/, '') !== BOX_ORIGIN) {
        response.writeHead(400); response.end('Invalid sign-in issuer'); return;
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code || code.length > 4096) {
        response.writeHead(400); response.end('Sign-in was not completed. Return to Muse Agent.');
        this.cancelAuth('Box sign-in was declined'); return;
      }
      response.end('Box sign-in received. You can return to Muse Agent.');
      this.pending?.resolve(code);
      this.stopListener();
    });
    this.listener = server;
    const previousRedirect = this.redirect;
    const preferred = this.isCallback(previousRedirect) ? Number(new URL(previousRedirect).port) : 0;
    const listen = (port: number) => new Promise<void>((yes, no) => {
      const failed = (error: Error) => { server.removeListener('listening', ready); no(error); };
      const ready = () => { server.removeListener('error', failed); yes(); };
      server.once('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1');
    });
    try { await listen(preferred === 1 ? 0 : preferred); }
    catch (error: any) { if (error.code !== 'EADDRINUSE') { this.end(); throw error; } await listen(0); }
    if (signal?.aborted) { this.end(); throw new Error('Box sign-in cancelled'); }
    const address = server.address() as { port: number };
    this.redirect = `http://127.0.0.1:${address.port}/oauth/box/callback`;
    if (this.record.clientInformation && this.redirect !== previousRedirect) {
      // A fresh loopback port requires a matching dynamic registration.
      delete this.record.clientInformation; delete this.record.tokens; await this.persist();
    }
    this.timer = setTimeout(() => this.cancelAuth('Box sign-in timed out'), timeoutMs);
    const abort = () => this.cancelAuth('Box sign-in cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    this.removeAbort = () => signal?.removeEventListener('abort', abort);
  }
  waitForCode() { if (!this.pending) throw new BoxAuthRequiredError(); return this.pending.promise; }
  private stopListener() { this.listener?.close(); this.listener = null; }
  cancelAuth(message = 'Box sign-in cancelled') { this.pending?.reject(new Error(message)); this.stopListener(); }
  end() {
    this.cancelAuth(); this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.removeAbort?.(); this.removeAbort = null;
    this.interactive = false; this.nonce = ''; this.verifier = '';
  }
  async forget() { this.end(); await this.load(); await this.saves.catch(() => {}); this.record = {}; await this.options.saveAuth(undefined); }
}

module.exports = { BoxAuthProvider, BoxAuthRequiredError, BOX_MCP_URL, BOX_ORIGIN };
