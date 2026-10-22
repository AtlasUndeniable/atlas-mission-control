/**
 * Lane X: the exposure (tunnel-origin) HTTP server for Natalie's Grok, principal grok_as_nat.
 * PREPARED ONLY. Nothing starts this except `atlas-mcp.ts exposure-http` with its own config,
 * and the launchd job that runs it is not loaded.
 *
 * It is a SEPARATE listener from the local Phase A `http` mode, with its own config, token
 * registry (exposable principals only, never the owner) and audit file. Still bound to
 * 127.0.0.1: a Cloudflare Tunnel (cloudflared on the Mac) connects to it outbound.
 *
 * Every request, in order:
 *   1. kill switch (a file): present -> 503 for everything, re-checked before replying;
 *   2. loopback peer only;
 *   3. Host must be exactly the configured tunnel hostname (no loopback names accepted);
 *   4. any Origin must be in an explicit allowlist (empty by default -> any Origin refused);
 *   5. only POST /mcp; declared and streamed body capped (default 16 KiB);
 *   6. optional Cloudflare Access JWT verification and optional service-token header digests;
 *   7. bearer token (constant-time digest compare) for an exposed principal, unrevoked,
 *      WITH an expiry no further than tokenMaxAgeDays from its creation;
 *   8. per-principal limits: per minute, hour, day, concurrent; global unauthenticated limit;
 *   9. tools/list and tools/call capped to the exposed tool list (<= whoami, capabilities,
 *      list_tasks, get_task), then the normal per-principal + sensitivity checks;
 *  10. response size cap and request timeout (no retries anywhere).
 * Audit: one schema-bound row per HTTP request in exposure-audit.jsonl (status, reason enum,
 * principal, JSON-RPC method enum, byte counts, duration). No token, header value, body,
 * argument or result text. Tool calls are additionally audited by tools.ts as usual.
 */
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {ExposureConfig, McpConfig, ToolName} from './config.ts';
import {EXPOSED_TOOL_CEILING} from './config.ts';
import {RateLimiter, resolveBearerEntry} from './auth.ts';
import {CfAccessVerifier, serviceTokenHeadersOk, type JwksFetcher} from './cf-access.ts';
import {handleMessage} from './protocol.ts';
import type {Assembled} from './server.ts';

const METHODS = ['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized'];
type Reason = 'ok' | 'killed' | 'not_loopback' | 'bad_host' | 'bad_origin' | 'not_found' | 'method' | 'too_large' | 'access_denied' | 'unauthorized'
  | 'unauth_rate' | 'rate_minute' | 'rate_hour' | 'rate_day' | 'concurrency' | 'media_type' | 'parse' | 'response_too_large' | 'timeout' | 'internal' | 'notification';

export function requireExposure(config: McpConfig): ExposureConfig {
  const e = config.exposure;
  if (!e) throw Error('atlas_mcp_exposure_config_missing');
  // Defence in depth over the loader: no owner principal, tools within the hard ceiling.
  for (const [name, pc] of Object.entries(config.principals)) {
    if (pc.scope !== 'granted' || !e.principals[name]) throw Error('atlas_mcp_exposure_principal_not_exposable');
    if (e.principals[name].tools.some(t => !(EXPOSED_TOOL_CEILING as readonly string[]).includes(t))) throw Error('atlas_mcp_exposure_tool_ceiling');
  }
  return e;
}

/** Kill switch state: the file's presence (no symlink games: lstat). */
export function killed(e: ExposureConfig): boolean {
  try { lstatSync(e.killSwitchFile); return true; } catch (err) { return (err as {code?: string}).code !== 'ENOENT'; }
}
export function engageKill(e: ExposureConfig, note = 'engaged') {
  mkdirSync(dirname(e.killSwitchFile), {recursive: true, mode: 0o700});
  if (!existsSync(e.killSwitchFile)) writeFileSync(e.killSwitchFile, `${new Date().toISOString()} ${note.replace(/[^\w .:-]/g, '').slice(0, 80)}\n`, {mode: 0o600, flag: 'wx'});
}
export function releaseKill(e: ExposureConfig) {
  try { unlinkSync(e.killSwitchFile); } catch (err) { if ((err as {code?: string}).code !== 'ENOENT') throw err; }
}

export type ExposureDeps = {now?: () => number; jwks?: JwksFetcher};

export function exposureHandler(a: Assembled, deps: ExposureDeps = {}) {
  const e = requireExposure(a.config);
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(now);
  const inflight = new Map<string, number>();
  const cf = new CfAccessVerifier(e.cfAccess, deps.jwks, now);
  const auditFile = join(a.config.stateDir, 'exposure-audit.jsonl');
  mkdirSync(a.config.stateDir, {recursive: true, mode: 0o700});
  const ceiling: readonly ToolName[] = EXPOSED_TOOL_CEILING;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = now();
    let principal: string | null = null, method = 'none', bytesIn = 0, bytesOut = 0;
    const done = (status: number, reason: Reason, body: object | null, extra: Record<string, string> = {}) => {
      const text = body ? JSON.stringify(body) : '';
      bytesOut = Buffer.byteLength(text);
      if (!res.headersSent) {
        res.writeHead(status, {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(body ? {'Content-Type': 'application/json'} : {}), ...extra});
        res.end(body ? text : undefined);
      }
      const ray = req.headers['cf-ray'];
      try {
        appendFileSync(auditFile, JSON.stringify({at: new Date(started).toISOString(), kind: 'exposure_http', status, reason, principal, method,
          bytesIn, bytesOut, ms: now() - started, cfRay: typeof ray === 'string' && /^[0-9a-f]{16}-[A-Z]{3}$/.test(ray) ? ray : null}) + '\n', {mode: 0o600});
        chmodSync(auditFile, 0o600);
      } catch { /* audit failure never leaks to the caller */ }
    };
    const plain = (status: number, reason: Reason, extra: Record<string, string> = {}) => done(status, reason, {error: reason === 'killed' ? 'unavailable' : reason === 'unauthorized' ? 'unauthorized' : 'refused'}, extra);
    let held = false;
    try {
      if (killed(e)) return plain(503, 'killed');
      const ra = req.socket.remoteAddress;
      if (!(ra === '127.0.0.1' || ra === '::ffff:127.0.0.1' || ra === '::1')) return plain(403, 'not_loopback');
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== e.publicHostname && host !== `${e.publicHostname}:443`) return plain(421, 'bad_host');
      const origin = req.headers.origin;
      if (origin !== undefined && !e.allowedOrigins.includes(String(origin).toLowerCase())) return plain(403, 'bad_origin');
      if ((req.url ?? '').split('?')[0] !== '/mcp') return plain(404, 'not_found');
      if (req.method !== 'POST') return plain(405, 'method', {Allow: 'POST'});
      const declared = Number(req.headers['content-length'] ?? 0);
      if (!Number.isFinite(declared) || declared > e.maxBodyBytes) return plain(413, 'too_large', {Connection: 'close'});
      // Second layer: Cloudflare Access (if configured), checked before the bearer token.
      if (!(await cf.verifyJwt(req.headers['cf-access-jwt-assertion']))) return plain(403, 'access_denied');
      if (!serviceTokenHeadersOk(e.serviceTokenHeaders, req.headers['cf-access-client-id'], req.headers['cf-access-client-secret'])) return plain(403, 'access_denied');
      // Bearer. Failed attempts are globally rate limited (429 once over the limit).
      const exposed = Object.fromEntries(Object.keys(e.principals).map(k => [k, true]));
      const entry = resolveBearerEntry(a.registry(), req.headers.authorization, exposed, now());
      const maxAge = e.tokenMaxAgeDays * 86_400_000;
      const fresh = !!entry && typeof entry.expires === 'string' && Date.parse(entry.expires) - Date.parse(entry.created) <= maxAge + 60_000;
      if (!entry || !fresh || !a.config.principals[entry.principal]) {
        if (!limiter.take('unauth', e.limits.unauthenticatedPerMinute, 60_000)) return plain(429, 'unauth_rate', {'Retry-After': '60'});
        return plain(401, 'unauthorized', {'WWW-Authenticate': 'Bearer realm="atlas-mcp"'});
      }
      principal = entry.principal;
      const l = e.limits;
      if (!limiter.take(`m:${principal}`, l.perMinute, 60_000)) return plain(429, 'rate_minute', {'Retry-After': '60'});
      if (!limiter.take(`h:${principal}`, l.perHour, 3_600_000)) return plain(429, 'rate_hour', {'Retry-After': '600'});
      if (!limiter.take(`d:${principal}`, l.perDay, 86_400_000)) return plain(429, 'rate_day', {'Retry-After': '3600'});
      if ((inflight.get(principal) ?? 0) >= l.maxConcurrent) return plain(429, 'concurrency', {'Retry-After': '5'});
      inflight.set(principal, (inflight.get(principal) ?? 0) + 1); held = true;
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return plain(415, 'media_type');
      const chunks: Buffer[] = [];
      for await (const c of req) {
        bytesIn += (c as Buffer).length;
        if (bytesIn > e.maxBodyBytes) { req.destroy(); return plain(413, 'too_large', {Connection: 'close'}); }
        chunks.push(c as Buffer);
      }
      let msg: unknown;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return done(400, 'parse', {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error.'}}); }
      const m = msg && typeof msg === 'object' && !Array.isArray(msg) ? (msg as {method?: unknown}).method : undefined;
      method = typeof m === 'string' && METHODS.includes(m) ? m : 'other';
      // Only the exposed tools exist for this connection (discovery AND tools/call).
      const tools = e.principals[principal].tools.filter(t => ceiling.includes(t));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), e.requestTimeoutMs); });
      const out = await Promise.race([handleMessage(a.server, principal, 'exposure', msg, {toolCeiling: tools}), timeout]).finally(() => clearTimeout(timer));
      if (out === 'timeout') return done(504, 'timeout', {jsonrpc: '2.0', id: null, error: {code: -32000, message: 'Request timed out.'}});
      // Kill switch engaged while the request was in flight: the result is dropped.
      if (killed(e)) return plain(503, 'killed');
      if (!out) return done(202, 'notification', null);
      if (Buffer.byteLength(JSON.stringify(out)) > e.maxResponseBytes) {
        const id = (out as {id?: unknown}).id ?? null;
        return done(200, 'response_too_large', {jsonrpc: '2.0', id, error: {code: -32000, message: 'Response too large; narrow the request (for example a smaller limit).'}});
      }
      return done(200, 'ok', out);
    } catch {
      return done(500, 'internal', {error: 'internal'});
    } finally {
      if (held && principal) inflight.set(principal, Math.max(0, (inflight.get(principal) ?? 1) - 1));
    }
  };
}

export function listenExposure(a: Assembled, deps: ExposureDeps = {}): Promise<Server> {
  const e = requireExposure(a.config);
  if (a.config.host !== '127.0.0.1') throw Error('atlas_mcp_must_bind_loopback');
  const srv = createServer({maxHeaderSize: 16 * 1024, requestTimeout: e.requestTimeoutMs + 5000, headersTimeout: Math.min(10_000, e.requestTimeoutMs + 5000), keepAliveTimeout: 5000}, exposureHandler(a, deps));
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(e.port, '127.0.0.1', () => resolve(srv)); });
}
