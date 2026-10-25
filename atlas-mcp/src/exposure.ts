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
import {appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import type {Socket} from 'node:net';
import type {ExposureConfig, McpConfig, ToolName} from './config.ts';
import {EXPOSED_TOOL_CEILING} from './config.ts';
import {RateLimiter, readOwnerOnlyFile, resolveBearerEntry, type TokenEntry} from './auth.ts';
import {PolicySource} from './sensitivity.ts';
import {CfAccessVerifier, serviceTokenHeadersOk, type JwksFetcher} from './cf-access.ts';
import {handleMessage} from './protocol.ts';
import type {Assembled} from './server.ts';

const METHODS = ['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized'];
type Reason = 'ok' | 'killed' | 'not_loopback' | 'bad_host' | 'bad_origin' | 'not_found' | 'method' | 'too_large' | 'access_denied' | 'unauthorized'
  | 'unauth_rate' | 'bearer_rate' | 'rate_minute' | 'rate_hour' | 'rate_day' | 'concurrency' | 'media_type' | 'parse' | 'invalid_id' | 'response_too_large'
  | 'timeout' | 'client_closed' | 'revoked_in_flight' | 'internal' | 'notification' | 'audit_unavailable' | 'auth_timeout' | 'config_changed';
/** Every unauthenticated outcome counts toward the global pre-auth limit (R16b B3). */
const PREAUTH_FAILURES = new Set<Reason>(['not_loopback', 'bad_host', 'bad_origin', 'not_found', 'method', 'too_large', 'access_denied', 'unauthorized', 'bearer_rate', 'auth_timeout']);
/** Flood-type refusals whose audit rows are aggregated (one per reason per 10 s, with a count). */
const AGGREGATED = new Set<string>(['unauth_rate', 'bearer_rate', 'header_overflow', 'request_timeout', 'client_reset', 'client_parse_error']);
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

/**
 * Runtime binding (R16b B2). The running exposure server records WHICH config it runs: the
 * SHA-256 of its config file bytes, its policy path and pin, and its classification setting,
 * in <stateDir>/exposure-runtime.json (owner-only). `exposure-resume` releases the kill
 * switch only if a live exposure-http process owns that binding AND the config file passed to
 * resume is byte-identical to the one the server started with, AND the server's own policy
 * path/pin validate now. Any config change (policy path, pin, classification, anything)
 * therefore requires a restart with the new config before resume. Independently, the running
 * server answers 503 'config_changed' while its config file differs from what it started with.
 */
export type RuntimeBinding = {pid: number; startedAt: string; configFile: string; configSha256: string; sensitivityFile: string; sensitivitySha256: string | null; classificationEnforcement: string};
export const runtimeBindingFile = (config: McpConfig) => join(config.stateDir, 'exposure-runtime.json');
export const fileSha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function writeRuntimeBinding(config: McpConfig, configFile: string, configSha256: string) {
  const b: RuntimeBinding = {pid: process.pid, startedAt: new Date().toISOString(), configFile, configSha256, sensitivityFile: config.sensitivityFile,
    sensitivitySha256: config.sensitivitySha256, classificationEnforcement: config.classificationEnforcement.unclassified};
  const f = runtimeBindingFile(config), tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(b) + '\n', {mode: 0o600, flag: 'w'});
  renameSync(tmp, f);
}
export function clearRuntimeBinding(config: McpConfig) {
  try { const b = JSON.parse(readFileSync(runtimeBindingFile(config), 'utf8')) as RuntimeBinding; if (b.pid === process.pid) unlinkSync(runtimeBindingFile(config)); } catch { /* absent */ }
}

/** Throws (resume refused, kill switch kept) unless the running server is bound to exactly this config. */
export function verifyResumeBinding(config: McpConfig, configFile: string, alive: (pid: number) => boolean): RuntimeBinding {
  let b: RuntimeBinding;
  try { b = JSON.parse(readOwnerOnlyFile(runtimeBindingFile(config), 'runtime_binding')) as RuntimeBinding; } catch { throw Error('atlas_mcp_resume_refused:no_running_server_binding (start exposure-http with this config first)'); }
  if (!Number.isInteger(b.pid) || !alive(b.pid)) throw Error('atlas_mcp_resume_refused:bound_server_not_running (restart exposure-http with this config)');
  if (b.configSha256 !== fileSha256(configFile)) throw Error('atlas_mcp_resume_refused:config_changed_since_server_start (restart exposure-http with the new config, then resume)');
  if (b.sensitivityFile !== config.sensitivityFile || b.sensitivitySha256 !== config.sensitivitySha256 || b.classificationEnforcement !== config.classificationEnforcement.unclassified) throw Error('atlas_mcp_resume_refused:binding_mismatch');
  const st = PolicySource.file(b.sensitivityFile, b.sensitivitySha256).current();
  if (!st || !b.sensitivitySha256) throw Error('atlas_mcp_resume_refused:running_policy_invalid_or_unpinned');
  return b;
}

/** Live exposure-http process with this pid (ps; command line not logged). */
export function exposureProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {encoding: 'utf8'});
  return r.status === 0 && /atlas-mcp\.ts exposure-http/.test(r.stdout);
}

export type ExposureDeps = {now?: () => number; jwks?: JwksFetcher; configFile?: string; configSha256?: string};
type Handler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {clientError: (reason: string, status: number) => boolean};

export function exposureHandler(a: Assembled, deps: ExposureDeps = {}): Handler {
  const e = requireExposure(a.config);
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(now);
  const inflight = new Map<string, number>();
  const cf = new CfAccessVerifier(e.cfAccess, deps.jwks, now);
  const auditFile = exposureAuditFile(a);
  mkdirSync(a.config.stateDir, {recursive: true, mode: 0o700});
  const ceiling: readonly ToolName[] = EXPOSED_TOOL_CEILING;
  const ERROR_TOO_LARGE = JSON.stringify({jsonrpc: '2.0', id: null, error: {code: -32000, message: 'Response too large; narrow the request (for example a smaller limit).'}});
  const G = e.limits.unauthenticatedPerMinute;
  // Pre-auth work reservations (R16b B3): requests currently doing Access/bearer work.
  let preauthInflight = 0;
  // Aggregated audit for flood-type refusals: one row per reason per 10 s, with a count.
  const lastAgg = new Map<string, number>(), suppressedBy = new Map<string, number>();

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
  /** 'skip' = aggregated (counted, no row now); otherwise the suppressed count to attach. */
  const aggregate = (reason: string, at: number): 'skip' | number => {
    if (!AGGREGATED.has(reason)) return 0;
    if (at - (lastAgg.get(reason) ?? -Infinity) < 10_000) { suppressedBy.set(reason, (suppressedBy.get(reason) ?? 0) + 1); return 'skip'; }
    lastAgg.set(reason, at);
    const n = suppressedBy.get(reason) ?? 0; suppressedBy.set(reason, 0);
    return n;
  };
  const countFailure = (reason: string) => { if (PREAUTH_FAILURES.has(reason as Reason) || AGGREGATED.has(reason)) limiter.take('preauth_fail', G * 2, 60_000); };

  const handler = (async (req: IncomingMessage, res: ServerResponse) => {
    const started = now();
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(), e.requestTimeoutMs);
    // A client that goes away cancels the work too.
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let principal: string | null = null, method = 'none', bytesIn = 0;
    let work: Promise<unknown> | null = null;
    let held = false, reserved = false;
    const unreserve = () => { if (reserved) { reserved = false; preauthInflight--; } };
    const ray = req.headers['cf-ray'];
    const cfRay = typeof ray === 'string' && /^[0-9a-f]{16}-[A-Z]{3}$/.test(ray) ? ray : null;

    const done = (status: number, reason: Reason, body: object | null, extra: Record<string, string> = {}) => {
      if (res.headersSent) return;
      let text = body ? JSON.stringify(body) : '';
      // Final byte ceiling for EVERY body (errors included).
      if (Buffer.byteLength(text) > e.maxResponseBytes) { text = ERROR_TOO_LARGE; reason = 'response_too_large'; }
      countFailure(reason);
      const agg = aggregate(reason, started);
      let ok = true;
      if (agg !== 'skip') ok = audit({at: new Date(started).toISOString(), kind: 'exposure_http', status, reason, principal, method, bytesIn, bytesOut: Buffer.byteLength(text), ms: now() - started, cfRay, suppressed: agg});
      if (!ok) {
        // Required auditing unavailable: release nothing.
        res.writeHead(503, {'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff'});
        res.end(JSON.stringify({error: 'unavailable'}));
        return;
      }
      res.writeHead(status, {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(text ? {'Content-Type': 'application/json'} : {}), ...extra});
      res.end(text || undefined);
    };
    const plain = (status: number, reason: Reason, extra: Record<string, string> = {}) => done(status, reason, {error: reason === 'killed' || reason === 'config_changed' ? 'unavailable' : reason === 'unauthorized' ? 'unauthorized' : 'refused'}, extra);
    const aborted = new Promise<'aborted'>(r => ac.signal.addEventListener('abort', () => r('aborted'), {once: true}));
    const timed = async <T>(p: Promise<T>): Promise<T | 'aborted'> => Promise.race([p, aborted]);
    const timeoutBody = {jsonrpc: '2.0', id: null, error: {code: -32000, message: 'Request timed out.'}};

    try {
      if (killed(e)) return plain(503, 'killed');
      // The running server serves only the config it started with (R16b B2).
      if (deps.configFile && deps.configSha256) {
        let same = false;
        try { same = fileSha256(deps.configFile) === deps.configSha256; } catch { same = false; }
        if (!same) return plain(503, 'config_changed');
      }
      // Global pre-auth bound, BEFORE any parsing or auth work: recent failures plus requests
      // already doing auth work (reservations) may not exceed the limit (R16b B3).
      if (limiter.count('preauth_fail', 60_000) + preauthInflight >= G) return plain(429, 'unauth_rate', {'Retry-After': '60'});
      preauthInflight++; reserved = true;
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
      if (jwtOk === 'aborted') return done(504, res.destroyed ? 'client_closed' : 'auth_timeout', timeoutBody);
      if (!jwtOk) return plain(403, 'access_denied');
      if (!serviceTokenHeadersOk(e.serviceTokenHeaders, req.headers['cf-access-client-id'], req.headers['cf-access-client-secret'])) return plain(403, 'access_denied');
      // Bearer.
      const exposed = Object.fromEntries(Object.keys(e.principals).map(k => [k, true]));
      const entry = resolveBearerEntry(a.registry(), req.headers.authorization, exposed, now());
      if (!exposureTokenOk(entry, e, now()) || !a.config.principals[entry.principal]) {
        // bearer_rate is itself a counted pre-auth failure, so a bad-bearer flood reaches the
        // global limit and is then refused before any further JWT work.
        if (!limiter.take('bearer_fail', e.limits.bearerFailuresPerMinute, 60_000)) return plain(429, 'bearer_rate', {'Retry-After': '60'});
        return plain(401, 'unauthorized', {'WWW-Authenticate': 'Bearer realm="atlas-mcp"'});
      }
      unreserve(); // authenticated: no longer pre-auth work
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
      if (b === 'aborted') { req.destroy(); return done(504, res.destroyed ? 'client_closed' : 'timeout', timeoutBody); }
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
      if (out === 'aborted') return done(504, res.destroyed ? 'client_closed' : 'timeout', timeoutBody);
      // Kill switch engaged, or this bearer revoked, while the request was in flight: drop it.
      if (killed(e)) return plain(503, 'killed');
      const still = resolveBearerEntry(a.registry(), req.headers.authorization, exposed, now());
      if (!exposureTokenOk(still, e, now()) || still.principal !== principal) return plain(401, 'revoked_in_flight');
      if (!out) return done(202, 'notification', null);
      return done(200, 'ok', out as object);
    } catch {
      return done(500, 'internal', {error: 'internal'});
    } finally {
      unreserve();
      clearTimeout(deadline);
      ac.abort();
      if (held && principal) {
        const p = principal;
        const release = () => inflight.set(p, Math.max(0, (inflight.get(p) ?? 1) - 1));
        // The slot is released only when the upstream work has actually settled.
        if (work) work.then(release, release); else release();
      }
    }
  }) as Handler;

  /** Requests Node rejects before the handler: counted and aggregated like other pre-auth failures. */
  handler.clientError = (reason: string, status: number) => {
    countFailure(reason);
    const at = now();
    const agg = aggregate(reason, at);
    if (agg === 'skip') return true;
    return audit({at: new Date(at).toISOString(), kind: 'exposure_http', status, reason, principal: null, method: 'none', bytesIn: 0, bytesOut: 0, ms: 0, cfRay: null, suppressed: agg});
  };
  return handler;
}

export function listenExposure(a: Assembled, deps: ExposureDeps = {}): Promise<Server> {
  const e = requireExposure(a.config);
  if (a.config.host !== '127.0.0.1') throw Error('atlas_mcp_must_bind_loopback');
  checkAuditSink(exposureAuditFile(a)); // refuse to start without a writable private audit sink
  const handler = exposureHandler(a, deps);
  const srv = createServer({maxHeaderSize: 16 * 1024, requestTimeout: e.requestTimeoutMs + 5000, headersTimeout: Math.min(10_000, e.requestTimeoutMs + 5000), keepAliveTimeout: 5000}, handler);
  // Requests Node rejects before the handler: audit metadata only (aggregated), then a bare status.
  srv.on('clientError', (err: Error & {code?: string}, socket: Socket) => {
    const reason = err.code === 'HPE_HEADER_OVERFLOW' ? 'header_overflow' : err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 'request_timeout' : err.code === 'ECONNRESET' ? 'client_reset' : 'client_parse_error';
    const status = reason === 'header_overflow' ? 431 : reason === 'request_timeout' ? 408 : 400;
    const ok = handler.clientError(reason, status);
    if (socket.writable && reason !== 'client_reset' && ok) socket.end(`HTTP/1.1 ${status} Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(e.port, '127.0.0.1', () => resolve(srv)); });
}
