/**
 * Lane X: the exposure (tunnel-origin) HTTP server for Natalie's Grok, principal grok_as_nat.
 * PREPARED ONLY. Nothing starts this except `atlas-mcp.ts exposure-http` with its own config,
 * and the launchd job that runs it is not loaded.
 *
 * A SEPARATE listener from the local Phase A `http` mode, with its own config, token registry
 * (exposable principals only, never the owner) and audit file. Bound to 127.0.0.1; a
 * Cloudflare Tunnel (cloudflared on the Mac) connects to it outbound.
 *
 * Every request, in order, under ONE end-to-end deadline (requestTimeoutMs, from arrival):
 *   1. kill switch (a file): present -> 503, re-checked before replying;
 *   2. global pre-auth failure limit: once unauthenticatedPerMinute failures of ANY kind
 *      (host, origin, path, method, size, Access, bearer) occurred in the last minute, further
 *      requests get 429 before any authentication work (R16 #8);
 *   3. loopback peer; Host exactly the tunnel hostname; any Origin only if allowlisted;
 *      POST /mcp; declared and streamed body cap;
 *   4. Cloudflare Access JWT (mandatory) for the dedicated service token, then optional
 *      service-token header digests;
 *   5. bearer (constant-time digest compare) for an exposed principal, unrevoked, with a sane
 *      created/expires pair no more than tokenMaxAgeDays apart; bearer failures also have
 *      their own limit;
 *   6. per-principal minute/hour/day limits and a concurrency slot that is held until the
 *      upstream work has really finished (R16 #7), not just until the deadline;
 *   7. JSON-RPC ids bounded; tools/list and tools/call capped to the exposed tools; the
 *      deadline's AbortSignal is passed to every hosted read, so nothing new starts after it;
 *   8. before replying: kill switch and bearer re-checked; the response is capped (any body,
 *      including errors, R16 #11); the audit row is written FIRST and, if that write fails,
 *      the response is replaced by a bare 503 (R16 #9).
 * Requests Node rejects before the handler (bad syntax, header overflow, request timeout) are
 * audited from the clientError hook with metadata only. Audit rows never contain a token,
 * header value, body, argument or result text.
 */
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {Socket} from 'node:net';
import type {ExposureConfig, McpConfig, ToolName} from './config.ts';
import {EXPOSED_TOOL_CEILING} from './config.ts';
import {RateLimiter, resolveBearerEntry, type TokenEntry} from './auth.ts';
import {CfAccessVerifier, serviceTokenHeadersOk, type JwksFetcher} from './cf-access.ts';
import {handleMessage} from './protocol.ts';
import type {Assembled} from './server.ts';

const METHODS = ['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized'];
type Reason = 'ok' | 'killed' | 'not_loopback' | 'bad_host' | 'bad_origin' | 'not_found' | 'method' | 'too_large' | 'access_denied' | 'unauthorized'
  | 'unauth_rate' | 'bearer_rate' | 'rate_minute' | 'rate_hour' | 'rate_day' | 'concurrency' | 'media_type' | 'parse' | 'invalid_id' | 'response_too_large'
  | 'timeout' | 'client_closed' | 'revoked_in_flight' | 'internal' | 'notification' | 'audit_unavailable';
const PREAUTH_FAILURES = new Set<Reason>(['not_loopback', 'bad_host', 'bad_origin', 'not_found', 'method', 'too_large', 'access_denied', 'unauthorized']);
const AUDIT_KEYS = ['at', 'kind', 'status', 'reason', 'principal', 'method', 'bytesIn', 'bytesOut', 'ms', 'cfRay', 'suppressed'] as const;

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

/**
 * Deployment refusal (R16 §2): the exposure server will not START or RESUME with
 * placeholders, an unpinned policy, or a non-dedicated Access identity. Tests may use
 * synthetic values; the CLI always calls this.
 */
export function assertDeployable(config: McpConfig): void {
  const e = requireExposure(config);
  const zero = /^0{64}$/;
  const problems: string[] = [];
  if (e.publicHostname.endsWith('.invalid') || e.publicHostname.includes('replace')) problems.push('publicHostname');
  if (e.cfAccess.teamDomain.startsWith('replace')) problems.push('cfAccess.teamDomain');
  if (zero.test(e.cfAccess.aud)) problems.push('cfAccess.aud');
  if (zero.test(e.cfAccess.serviceTokenClientIdSha256)) problems.push('cfAccess.serviceTokenClientIdSha256');
  if (!config.sensitivitySha256) problems.push('sensitivitySha256 (policy pin required)');
  if (problems.length) throw Error(`atlas_mcp_exposure_not_deployable:${problems.join(',')}`);
}

/** Kill switch state: the file's presence (lstat; any error other than "absent" = killed). */
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

/** A registry entry exposure accepts: expiring, sane timestamps, within the max age. */
export function exposureTokenOk(entry: TokenEntry | null, e: ExposureConfig, now: number): entry is TokenEntry {
  if (!entry || typeof entry.expires !== 'string') return false;
  const created = Date.parse(entry.created), expires = Date.parse(entry.expires);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return false;
  if (created > now + 60_000 || expires <= created) return false;
  return expires - created <= e.tokenMaxAgeDays * 86_400_000 + 60_000;
}

const boundedId = (id: unknown) => (id === undefined || id === null || (typeof id === 'number' && Number.isSafeInteger(id)) || (typeof id === 'string' && id.length <= 128));

export function exposureAuditFile(a: Assembled) { return join(a.config.stateDir, 'exposure-audit.jsonl'); }

/** Throws unless the private audit sink can be appended (owner-only). Used at start and resume. */
export function checkAuditSink(file: string) {
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  appendFileSync(file, '', {mode: 0o600});
  chmodSync(file, 0o600);
}

export function exposureHandler(a: Assembled, deps: ExposureDeps = {}) {
  const e = requireExposure(a.config);
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(now);
  const inflight = new Map<string, number>();
  const cf = new CfAccessVerifier(e.cfAccess, deps.jwks, now);
  const auditFile = exposureAuditFile(a);
  mkdirSync(a.config.stateDir, {recursive: true, mode: 0o700});
  const ceiling: readonly ToolName[] = EXPOSED_TOOL_CEILING;
  let suppressed = 0, lastLimitedAudit = -Infinity;
  const ERROR_TOO_LARGE = JSON.stringify({jsonrpc: '2.0', id: null, error: {code: -32000, message: 'Response too large; narrow the request (for example a smaller limit).'}});

  /** Audit FIRST. Returns false when the row could not be written (then nothing is released). */
  const audit = (row: Record<string, unknown>) => {
    try {
      const r: Record<string, unknown> = {};
      for (const k of AUDIT_KEYS) r[k] = row[k] ?? null;
      appendFileSync(auditFile, JSON.stringify(r) + '\n', {mode: 0o600});
      chmodSync(auditFile, 0o600);
      return true;
    } catch { return false; }
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = now();
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), e.requestTimeoutMs);
    // A client that goes away cancels the work too.
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let principal: string | null = null, method = 'none', bytesIn = 0;
    let work: Promise<unknown> | null = null;
    let held = false;
    const ray = req.headers['cf-ray'];
    const cfRay = typeof ray === 'string' && /^[0-9a-f]{16}-[A-Z]{3}$/.test(ray) ? ray : null;

    const done = (status: number, reason: Reason, body: object | null, extra: Record<string, string> = {}) => {
      if (res.headersSent) return;
      let text = body ? JSON.stringify(body) : '';
      // Final byte ceiling for EVERY body (errors included).
      if (Buffer.byteLength(text) > e.maxResponseBytes) { text = ERROR_TOO_LARGE; reason = 'response_too_large'; }
      if (PREAUTH_FAILURES.has(reason)) limiter.take('preauth_fail', e.limits.unauthenticatedPerMinute * 2, 60_000);
      // Under a failure flood, write one audit row per 10 s carrying the suppressed count.
      let write = true;
      if (reason === 'unauth_rate') {
        if (started - lastLimitedAudit < 10_000) { suppressed++; write = false; }
        else lastLimitedAudit = started;
      }
      let ok = true;
      if (write) {
        ok = audit({at: new Date(started).toISOString(), kind: 'exposure_http', status, reason, principal, method, bytesIn, bytesOut: Buffer.byteLength(text), ms: now() - started, cfRay, suppressed});
        if (ok) suppressed = 0;
      }
      if (!ok) {
        // Required auditing unavailable: release nothing.
        res.writeHead(503, {'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff'});
        res.end(JSON.stringify({error: 'unavailable'}));
        return;
      }
      res.writeHead(status, {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(text ? {'Content-Type': 'application/json'} : {}), ...extra});
      res.end(text || undefined);
    };
    const plain = (status: number, reason: Reason, extra: Record<string, string> = {}) => done(status, reason, {error: reason === 'killed' ? 'unavailable' : reason === 'unauthorized' ? 'unauthorized' : 'refused'}, extra);
    const aborted = new Promise<'aborted'>(r => ac.signal.addEventListener('abort', () => r('aborted'), {once: true}));
    const timed = async <T>(p: Promise<T>): Promise<T | 'aborted'> => Promise.race([p, aborted]);

    try {
      if (killed(e)) return plain(503, 'killed');
      if (limiter.count('preauth_fail', 60_000) >= e.limits.unauthenticatedPerMinute) return plain(429, 'unauth_rate', {'Retry-After': '60'});
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
      // Second layer: Cloudflare Access, before the bearer token, inside the deadline.
      const jwtOk = await timed(cf.verifyJwt(req.headers['cf-access-jwt-assertion'], ac.signal));
      if (jwtOk === 'aborted') return done(504, ac.signal.aborted && res.destroyed ? 'client_closed' : 'timeout', {jsonrpc: '2.0', id: null, error: {code: -32000, message: 'Request timed out.'}});
      if (!jwtOk) return plain(403, 'access_denied');
      if (!serviceTokenHeadersOk(e.serviceTokenHeaders, req.headers['cf-access-client-id'], req.headers['cf-access-client-secret'])) return plain(403, 'access_denied');
      // Bearer.
      const exposed = Object.fromEntries(Object.keys(e.principals).map(k => [k, true]));
      const entry = resolveBearerEntry(a.registry(), req.headers.authorization, exposed, now());
      if (!exposureTokenOk(entry, e, now()) || !a.config.principals[entry.principal]) {
        if (!limiter.take('bearer_fail', e.limits.bearerFailuresPerMinute, 60_000)) return plain(429, 'bearer_rate', {'Retry-After': '60'});
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
      const body = (async () => {
        for await (const c of req) {
          if (ac.signal.aborted) return 'aborted' as const;
          bytesIn += (c as Buffer).length;
          if (bytesIn > e.maxBodyBytes) return 'too_large' as const;
          chunks.push(c as Buffer);
        }
        return 'ok' as const;
      })();
      const b = await timed(body);
      if (b === 'aborted') { req.destroy(); return done(504, res.destroyed ? 'client_closed' : 'timeout', {jsonrpc: '2.0', id: null, error: {code: -32000, message: 'Request timed out.'}}); }
      if (b === 'too_large') { req.destroy(); return plain(413, 'too_large', {Connection: 'close'}); }
      let msg: unknown;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return done(400, 'parse', {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error.'}}); }
      const isObj = msg && typeof msg === 'object' && !Array.isArray(msg);
      const m = isObj ? (msg as {method?: unknown}).method : undefined;
      method = typeof m === 'string' && METHODS.includes(m) ? m : 'other';
      if (isObj && !boundedId((msg as {id?: unknown}).id)) return done(200, 'invalid_id', {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'Invalid id.'}});
      // Only the exposed tools exist for this connection (discovery AND tools/call).
      const tools = e.principals[principal].tools.filter(t => ceiling.includes(t));
      work = handleMessage(a.server, principal, 'exposure', msg, {toolCeiling: tools, signal: ac.signal});
      const out = await timed(work);
      if (out === 'aborted') return done(504, res.destroyed ? 'client_closed' : 'timeout', {jsonrpc: '2.0', id: null, error: {code: -32000, message: 'Request timed out.'}});
      // Kill switch engaged, or this bearer revoked, while the request was in flight: drop it.
      if (killed(e)) return plain(503, 'killed');
      const still = resolveBearerEntry(a.registry(), req.headers.authorization, exposed, now());
      if (!exposureTokenOk(still, e, now()) || still.principal !== principal) return plain(401, 'revoked_in_flight');
      if (!out) return done(202, 'notification', null);
      return done(200, 'ok', out as object);
    } catch {
      return done(500, 'internal', {error: 'internal'});
    } finally {
      clearTimeout(deadline);
      ac.abort();
      if (held && principal) {
        const p = principal;
        const release = () => inflight.set(p, Math.max(0, (inflight.get(p) ?? 1) - 1));
        // The slot is released only when the upstream work has actually settled.
        if (work) work.then(release, release); else release();
      }
    }
  };
}

export function listenExposure(a: Assembled, deps: ExposureDeps = {}): Promise<Server> {
  const e = requireExposure(a.config);
  if (a.config.host !== '127.0.0.1') throw Error('atlas_mcp_must_bind_loopback');
  const auditFile = exposureAuditFile(a);
  checkAuditSink(auditFile); // refuse to start without a writable private audit sink
  const srv = createServer({maxHeaderSize: 16 * 1024, requestTimeout: e.requestTimeoutMs + 5000, headersTimeout: Math.min(10_000, e.requestTimeoutMs + 5000), keepAliveTimeout: 5000}, exposureHandler(a, deps));
  // Requests Node rejects before the handler: audit metadata only, then a bare status.
  srv.on('clientError', (err: Error & {code?: string}, socket: Socket) => {
    const reason = err.code === 'HPE_HEADER_OVERFLOW' ? 'header_overflow' : err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 'request_timeout' : err.code === 'ECONNRESET' ? 'client_reset' : 'client_parse_error';
    const status = reason === 'header_overflow' ? 431 : reason === 'request_timeout' ? 408 : 400;
    let ok = true;
    try {
      appendFileSync(auditFile, JSON.stringify({at: new Date().toISOString(), kind: 'exposure_http', status, reason, principal: null, method: 'none', bytesIn: 0, bytesOut: 0, ms: 0, cfRay: null, suppressed: 0}) + '\n', {mode: 0o600});
    } catch { ok = false; }
    if (socket.writable && reason !== 'client_reset' && ok) socket.end(`HTTP/1.1 ${status} Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(e.port, '127.0.0.1', () => resolve(srv)); });
}
