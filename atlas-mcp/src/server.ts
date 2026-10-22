/**
 * Assembly plus the two transports.
 *  - Streamable HTTP: POST /mcp, JSON responses, bound to 127.0.0.1 ONLY. Bearer token on
 *    every request; Host and Origin checked against loopback (DNS-rebinding guard).
 *  - stdio: newline-delimited JSON-RPC for Claude Code / Codex on the Mac; the principal
 *    comes from an owner-only token file and is checked against the same registry.
 * Logs go to stderr and carry no transcript text, tokens or arguments.
 */
import {createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';

import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {loadBudget, loadConfig, type McpConfig, type Budget} from './config.ts';
import {hostedClient, loadTransportFromEnvFile, type Hosted} from './hosted.ts';
import {CallIndex} from './call-index.ts';
import {AuditLog, BudgetLedger} from './ledger.ts';
import {RateLimiter, readOwnerOnlyFile, readRegistry, resolveBearer, type TokenRegistry} from './auth.ts';
import {AtlasMcp} from './tools.ts';
import {handleMessage} from './protocol.ts';
import {loadSensitivity, type SensitivityPolicy} from './sensitivity.ts';

export type Assembled = {server: AtlasMcp; config: McpConfig; registry: () => TokenRegistry; index: CallIndex};

/**
 * The sensitivity policy is loaded once at start. If it is missing or invalid, scoped callers
 * (nat, grok_as_nat) are refused on every tool; the owner is unaffected. `sensitivity: null`
 * in opts simulates that; omitting it loads config.sensitivityFile.
 */
export function assemble(opts: {config: McpConfig; budget?: Budget; hosted?: Hosted; askKey?: (s: AbortSignal) => Promise<string>; askTransport?: typeof fetch; refreshIndex?: boolean; sensitivity?: SensitivityPolicy | null}): Assembled {
  const {config} = opts;
  const budget = opts.budget ?? loadBudget(config.askCall.budgetFile);
  const hosted = opts.hosted ?? hostedClient(loadTransportFromEnvFile(config.hostedTransportEnvFile));
  const index = new CallIndex(join(config.stateDir, 'calls-index.sqlite'), config.brainCallsDir);
  if (opts.refreshIndex !== false) index.refresh();
  let sensitivity: SensitivityPolicy | null;
  if (opts.sensitivity !== undefined) sensitivity = opts.sensitivity;
  else { try { sensitivity = loadSensitivity(config.sensitivityFile); } catch { sensitivity = null; } }
  const server = new AtlasMcp({config, budget, hosted, index, audit: new AuditLog(config.stateDir), ledger: new BudgetLedger(config.stateDir, budget), limiter: new RateLimiter(), askKey: opts.askKey, askTransport: opts.askTransport, sensitivity});
  return {server, config, index, registry: () => readRegistry(config.tokensFile)};
}

const MAX_BODY = 256 * 1024;
function send(res: ServerResponse, status: number, body: object | null, extra: Record<string, string> = {}) {
  res.writeHead(status, {'Cache-Control': 'no-store', ...(body ? {'Content-Type': 'application/json'} : {}), ...extra});
  res.end(body ? JSON.stringify(body) : undefined);
}
const loopbackHost = (host: string | undefined, port: number) => !!host && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host.toLowerCase());
const loopbackAddr = (a: string | undefined) => a === '127.0.0.1' || a === '::ffff:127.0.0.1' || a === '::1';

export function httpHandler(a: Assembled) {
  const port = a.config.port;
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!loopbackAddr(req.socket.remoteAddress)) return send(res, 403, {error: 'loopback only'});
      if (!loopbackHost(req.headers.host, port)) return send(res, 421, {error: 'host not allowed'});
      const origin = req.headers.origin;
      if (origin && !loopbackHost(origin.replace(/^https?:\/\//, ''), port)) return send(res, 403, {error: 'origin not allowed'});
      const url = (req.url ?? '').split('?')[0];
      if (url !== '/mcp') return send(res, 404, {error: 'not found'});
      if (req.method !== 'POST') return send(res, 405, {error: 'method not allowed'}, {Allow: 'POST'});
      const principal = resolveBearer(a.registry(), req.headers.authorization, a.config.principals);
      if (!principal) return send(res, 401, {error: 'unauthorized'}, {'WWW-Authenticate': 'Bearer realm="atlas-mcp"'});
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, {error: 'application/json required'});
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) return send(res, 413, {error: 'too large'}); chunks.push(c as Buffer); }
      let msg: unknown;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error.'}}); }
      const out = await handleMessage(a.server, principal, 'http', msg);
      if (!out) return send(res, 202, null);
      return send(res, 200, out);
    } catch {
      if (!res.headersSent) send(res, 500, {error: 'internal'});
    }
  };
}

export function listen(a: Assembled): Promise<Server> {
  // Phase A: the host is fixed to loopback by the config loader; asserted again here.
  if (a.config.host !== '127.0.0.1') throw Error('atlas_mcp_must_bind_loopback');
  const srv = createHttpServer(httpHandler(a));
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(a.config.port, '127.0.0.1', () => resolve(srv)); });
}

export function readTokenFile(file: string) {
  return readOwnerOnlyFile(file, 'token_file').trim();
}

/**
 * stdio session. The token is re-checked against the CURRENT registry before every message,
 * so revoking it (or its principal disappearing from config) refuses the next request and
 * ends the session. Work already dispatched (an in-flight ask_call) can only be interrupted
 * by stopping the process.
 */
export async function runStdio(a: Assembled, token: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
  const principal = resolveBearer(a.registry(), token, a.config.principals);
  if (!principal) throw Error('atlas_mcp_token_rejected');
  const rl = createInterface({input, crlfDelay: Infinity});
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error.'}}) + '\n'); continue; }
    let current: string | null = null;
    try { current = resolveBearer(a.registry(), token, a.config.principals); } catch { current = null; }
    if (current !== principal) {
      const id = msg && typeof msg === 'object' && 'id' in msg ? (msg as {id: unknown}).id : null;
      output.write(JSON.stringify({jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: {code: -32001, message: 'Token revoked or no longer valid; session closed.'}}) + '\n');
      rl.close();
      throw Error('atlas_mcp_token_revoked');
    }
    const out = await handleMessage(a.server, principal, 'stdio', msg);
    if (out) output.write(JSON.stringify(out) + '\n');
  }
}
export const loadAll = (configFile: string) => loadConfig(configFile);
