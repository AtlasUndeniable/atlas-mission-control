/**
 * Lane X: the exposure (tunnel-origin) server, against R14's mandatory exposure requirements:
 * per-caller tool allowlist (in tools/call, not only discovery), bearer auth with expiry,
 * optional Cloudflare Access JWT + service-token header checks, strict Host/Origin for the
 * tunnel hostname while still bound to 127.0.0.1, per-principal and unauthenticated rate
 * limits, concurrency, request/response size limits, timeouts, no-content audit, the kill
 * switch (including in-flight requests), rotation and revocation, and no write tools.
 * Synthetic data, a fake hosted service and a test RSA key only; listeners on 127.0.0.1
 * (tests are SKIPPED, not failed, where loopback bind is denied).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync, sign as cryptoSign, createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseConfig, type McpConfig, EXPOSED_TOOL_CEILING} from '../src/config.ts';
import {assemble} from '../src/server.ts';
import {listenExposure, engageKill, releaseKill} from '../src/exposure.ts';
import {mintEntry, readRegistry, writeRegistry, newToken, digest} from '../src/auth.ts';
import {parseSensitivity, SensitivityPolicy} from '../src/sensitivity.ts';
import {CfAccessVerifier} from '../src/cf-access.ts';
import {fakeHosted, makeBrain, fakeModel, BUDGET, TEST_KEY} from './fixtures.ts';
import type {Queue} from '../src/hosted.ts';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '../bin/atlas-mcp.ts');
const HOSTNAME = 'atlas-mcp.test-domain.invalid';
const TEAM = 'testteam.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const SHIPPED = parseSensitivity(JSON.parse(readFileSync(join(here, '../config/sensitivity.json'), 'utf8')));

const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const KID = 'test-kid-1';
const jwk = {...publicKey.export({format: 'jwk'}), kid: KID, alg: 'RS256', use: 'sig'};
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(over: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({alg: 'RS256', kid: KID, typ: 'JWT', ...header});
  const p = b64({aud: [AUD], iss: `https://${TEAM}`, exp: now + 300, iat: now - 5, nbf: now - 5, common_name: 'grok-client-id.access', type: 'app', ...over});
  return `${h}.${p}.${cryptoSign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}

type Over = Partial<{limits: Record<string, number>; maxResponseBytes: number; requestTimeoutMs: number; cfAccess: unknown; serviceTokenHeaders: unknown; allowedOrigins: string[]}>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exposureRaw(state: string, over: Over = {}): any {
  return {
    host: '127.0.0.1', port: 4029, brainCallsDir: makeBrain(), stateDir: state,
    tokensFile: join(state, 'tokens.json'), sensitivityFile: join(state, 'sensitivity.json'), hostedTransportEnvFile: join(state, 'unused.env'),
    principals: {grok_as_nat: {hostedActor: 'nat', scope: 'granted', label: 'Grok acting for Natalie', tools: ['whoami', 'capabilities', 'list_tasks', 'get_task']}},
    rateLimits: {toolCallsPerMinute: 600, askCallsPerHour: 0},
    askCall: {model: 'claude-sonnet-5-5', effort: 'low', maxOutputTokens: 3000, maxPromptCharacters: 300000, timeoutMs: 5000, keyFile: '/nonexistent/k', budgetFile: '/nonexistent/b', decisionReference: 'test'},
    exposure: {
      port: 48000 + Math.floor(Math.random() * 1500), publicHostname: HOSTNAME, allowedOrigins: over.allowedOrigins ?? [],
      principals: {grok_as_nat: {tools: ['whoami', 'capabilities', 'list_tasks', 'get_task']}},
      killSwitchFile: join(state, 'EXPOSURE-DISABLED'), maxBodyBytes: 4096, maxResponseBytes: over.maxResponseBytes ?? 262144, requestTimeoutMs: over.requestTimeoutMs ?? 5000,
      limits: {perMinute: 100, perHour: 1000, perDay: 5000, maxConcurrent: 2, unauthenticatedPerMinute: 100, ...over.limits},
      tokenMaxAgeDays: 30,
      cfAccess: over.cfAccess ?? {mode: 'jwt', teamDomain: TEAM, aud: AUD, serviceTokenClientIdSha256: createHash('sha256').update('grok-client-id.access').digest('hex')},
      serviceTokenHeaders: over.serviceTokenHeaders ?? null,
      decisionReference: 'synthetic exposure test',
    },
  };
}

const CLEAN = '01DDDDDDDDDDDDDDDDDDDDDDDD';
async function start(t: {skip: (m?: string) => void}, over: Over = {}, hostedDelayMs = 0) {
  const state = mkdtempSync(join(tmpdir(), 'atlas-exposure-'));
  const config: McpConfig = parseConfig(exposureRaw(state, over));
  writeFileSync(config.sensitivityFile, readFileSync(join(here, '../config/sensitivity.json')), {mode: 0o600});
  const hosted = fakeHosted();
  const list = hosted.list.bind(hosted);
  hosted.list = async (actor: string): Promise<Queue> => {
    if (hostedDelayMs) await new Promise(r => setTimeout(r, hostedDelayMs));
    const q = await list(actor);
    q.meetings.push({id: CLEAN, title: 'Bright Studio x Rhys', instant: '2026-10-20T01:00:00Z', state: 'ready', items: [{id: 'req-clean', title: 'Send Bright the onboarding checklist', due: null, owner: 'nat', state: 'approved',
      evidence: {quote: 'I will send the onboarding checklist tomorrow', start: 3}, task: {id: 'task-clean', title: 'Send Bright the onboarding checklist', client: 'bright', owner: 'nat', source_quote: 'I will send the onboarding checklist tomorrow'}}]});
    return q;
  };
  const model = fakeModel(() => ({supported: true, answer: 'x', quotes: []}));
  const a = assemble({config, budget: BUDGET, hosted, askKey: TEST_KEY, askTransport: model.transport, refreshIndex: false, sensitivity: new SensitivityPolicy(SHIPPED)});
  const good = mintEntry('grok_as_nat', 'test grok', 30);
  writeRegistry(config.tokensFile, {tokens: [good.entry]});
  let jwksFetches = 0;
  let jwksFail = false;
  let srv;
  try {
    srv = await listenExposure(a, {jwks: async url => { jwksFetches++; assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`); if (jwksFail) throw Error('down'); return {keys: [jwk]}; }});
  } catch (e) {
    const code = (e as {code?: string}).code;
    if (code === 'EPERM' || code === 'EACCES') { t.skip(`loopback bind denied (${code})`); return null; }
    throw e;
  }
  const addr = srv.address() as {address: string; port: number};
  assert.equal(addr.address, '127.0.0.1', 'exposure origin must bind loopback only');
  const auth = {authorization: `Bearer ${good.token}`, 'cf-access-jwt-assertion': jwt()};
  const send = (body: string | null, headers: Record<string, string | undefined> = {}, opts: {method?: string; path?: string; chunks?: string[]} = {}) =>
    new Promise<{status: number; json: () => Record<string, unknown>; text: string}>((resolve, reject) => {
      const h: Record<string, string> = {host: HOSTNAME, 'content-type': 'application/json'};
      for (const [k, v] of Object.entries(headers)) { if (v === undefined) delete h[k]; else h[k] = v; }
      const req = request({host: '127.0.0.1', port: addr.port, path: opts.path ?? '/mcp', method: opts.method ?? 'POST', headers: h}, res => {
        const c: Buffer[] = []; res.on('data', d => c.push(d)); res.on('end', () => { const text = Buffer.concat(c).toString(); resolve({status: res.statusCode ?? 0, text, json: () => JSON.parse(text)}); });
      });
      req.on('error', reject);
      if (opts.chunks) { for (const ch of opts.chunks) req.write(ch); req.end(); } else req.end(body ?? undefined);
    });
  const rpc = (method: string, params: object = {}, id: number | null = 1) => JSON.stringify({jsonrpc: '2.0', ...(id === null ? {} : {id}), method, params});
  const call = (name: string, args: object = {}, headers = auth) => send(rpc('tools/call', {name, arguments: args}), headers);
  return {a, config, srv, hosted, model, good, auth, send, rpc, call, state, get jwksFetches() { return jwksFetches; }, failJwks(v: boolean) { jwksFail = v; },
    close: () => new Promise(r => srv.close(r))};
}
type S = NonNullable<Awaited<ReturnType<typeof start>>>;
async function withS(t: {skip: (m?: string) => void}, over: Over, fn: (s: S) => Promise<void>, delay = 0) {
  const s = await start(t, over, delay);
  if (!s) return;
  try { await fn(s); } finally { await s.close(); }
}

// ---------- configuration ----------

test('config: only granted principals are exposable, tools within the hard ceiling, real hostname, separate port', () => {
  const state = mkdtempSync(join(tmpdir(), 'atlas-exposure-cfg-'));
  const raw = exposureRaw(state);
  assert.deepEqual(parseConfig(raw).exposure!.principals.grok_as_nat.tools.sort(), [...EXPOSED_TOOL_CEILING].sort());
  const mut = (f: (r: ReturnType<typeof exposureRaw>) => void, re: RegExp) => { const r = JSON.parse(JSON.stringify(raw)); f(r); assert.throws(() => parseConfig(r), re); };
  mut(r => { r.principals.rhys = {hostedActor: 'rhys', scope: 'owner', label: 'Rhys', tools: ['whoami']}; }, /not_exposable:rhys/);
  mut(r => { (r.principals as Record<string, unknown>).rhys = {hostedActor: 'rhys', scope: 'owner', label: 'Rhys', tools: ['whoami']}; (r.exposure.principals as Record<string, unknown>).rhys = {tools: ['whoami']}; }, /must_be_granted_scope/);
  for (const tool of ['search_calls', 'ask_call', 'get_draft', 'create_task']) mut(r => { r.principals.grok_as_nat.tools.push(tool); r.exposure.principals.grok_as_nat.tools.push(tool); }, /tools/);
  for (const h of ['127.0.0.1', 'localhost', 'atlas.localhost', '*.example.com', 'Atlas.Example.com', 'example', 'a.example.com:443']) mut(r => { r.exposure.publicHostname = h; }, /publicHostname/);
  mut(r => { r.host = '0.0.0.0'; }, /host_must_be_127/);
  mut(r => { r.exposure.port = r.port; }, /port_must_differ/);
  mut(r => { r.exposure.tokenMaxAgeDays = 365; }, /tokenMaxAgeDays/);
  mut(r => { r.exposure.maxBodyBytes = 10_000_000; }, /maxBodyBytes/);
  mut(r => { r.exposure.cfAccess = {mode: 'jwt', teamDomain: 'evil.example.com', aud: AUD, serviceTokenClientIdSha256: null}; }, /teamDomain/);
  mut(r => { r.exposure.allowedOrigins = ['http://insecure.example.com']; }, /allowedOrigins/);
  // The shipped example parses as-is (placeholders are syntactically valid but unroutable).
  const example = JSON.parse(readFileSync(join(here, '../config/exposure.example.json'), 'utf8'));
  const ex = parseConfig(example);
  assert.deepEqual(Object.keys(ex.principals), ['grok_as_nat']);
  assert.deepEqual(ex.exposure!.principals.grok_as_nat.tools, ['whoami', 'capabilities', 'list_tasks', 'get_task']);
  assert.equal(ex.exposure!.cfAccess.mode, 'jwt');
  // The installed Phase A config shape (no sensitivityFile/exposure keys) still parses.
  const {sensitivityFile: _s, exposure: _e, ...phaseA} = raw; void _s; void _e;
  phaseA.principals = {grok_as_nat: raw.principals.grok_as_nat} as typeof raw.principals;
  assert.equal(parseConfig(phaseA).exposure, null);
});

// ---------- happy path and tool allowlist ----------

test('grok_as_nat: handshake, exactly four task-level tools, sensitivity applied, no write/transcript tools', async t => {
  await withS(t, {}, async s => {
    const init = await s.send(s.rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'grok', version: '1'}}), s.auth);
    assert.equal(init.status, 200);
    assert.equal((init.json().result as {serverInfo: {name: string}}).serverInfo.name, 'atlas-mcp');
    assert.equal((await s.send(s.rpc('notifications/initialized', {}, null), s.auth)).status, 202);
    const list = (await s.send(s.rpc('tools/list'), s.auth)).json();
    assert.deepEqual((list.result as {tools: {name: string}[]}).tools.map(x => x.name).sort(), ['capabilities', 'get_task', 'list_tasks', 'whoami']);
    const tasks = (await s.call('list_tasks')).json().result as {structuredContent: {tasks: {id: string}[]}};
    assert.deepEqual(tasks.structuredContent.tasks.map(x => x.id), ['task-clean'], 'the acme pricing task is withheld');
    const g = (await s.call('get_task', {id: 'task-clean'})).json().result as {structuredContent: {quotes: unknown[]}};
    assert.deepEqual(g.structuredContent.quotes, [], 'no transcript snippets without a full-call grant');
    const who = (await s.call('whoami')).json().result as {structuredContent: {principal: string; tools: string[]}};
    assert.equal(who.structuredContent.principal, 'grok_as_nat');
    assert.deepEqual(who.structuredContent.tools, ['whoami', 'capabilities', 'list_tasks', 'get_task']);
    for (const name of ['search_calls', 'ask_call', 'get_draft', 'create_task', 'approve', 'deliver']) {
      const r = (await s.call(name, name === 'ask_call' ? {call_id: CLEAN, question: 'x'} : name === 'search_calls' ? {query: 'x'} : name === 'get_draft' ? {task_id: 'task-clean'} : {})).json().result as {isError: boolean; structuredContent: {error: string}};
      assert.equal(r.isError, true, name);
      assert.ok(['forbidden', 'unknown_tool'].includes(r.structuredContent.error), name);
    }
    assert.equal(s.model.bodies.length, 0, 'no model call');
    assert.ok(!s.hosted.calls.some(c => c.method === 'context' || c.method === 'documentRead' || c.method === 'documentArtifact'), 'no transcript or draft read');
    assert.ok(s.hosted.calls.every(c => c.actor === 'nat'), 'only nat\'s own hosted credential is used');
  });
});

// ---------- Host, Origin, path, method ----------

test('strict Host (tunnel hostname only), Origin allowlist, POST /mcp only', async t => {
  await withS(t, {}, async s => {
    const port = (s.srv.address() as {port: number}).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'attacker.example', `${HOSTNAME}.attacker.example`, `x${HOSTNAME}`, `${HOSTNAME}:8443`])
      assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, host})).status, 421, host);
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, host: `${HOSTNAME}:443`})).status, 200);
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, host: HOSTNAME.toUpperCase()})).status, 200, 'DNS names are case-insensitive');
    for (const origin of ['https://grok.com', 'https://evil.example', 'null', `https://${HOSTNAME}`]) assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, origin})).status, 403, origin);
    assert.equal((await s.send(null, s.auth, {method: 'GET'})).status, 405);
    assert.equal((await s.send(null, s.auth, {method: 'DELETE'})).status, 405);
    assert.equal((await s.send(s.rpc('tools/list'), s.auth, {path: '/'})).status, 404);
    assert.equal((await s.send(s.rpc('tools/list'), s.auth, {path: '/mcp/../admin'})).status, 404);
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, 'content-type': 'text/plain'})).status, 415);
  });
  await withS(t, {allowedOrigins: ['https://grok.com']}, async s => {
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, origin: 'https://grok.com'})).status, 200);
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, origin: 'https://evil.example'})).status, 403);
  });
});

// ---------- Cloudflare Access ----------

test('Cloudflare Access JWT: required, signature, aud, iss, expiry, service-token identity; fail closed', async t => {
  await withS(t, {}, async s => {
    const bad: [string, string | undefined][] = [
      ['missing', undefined], ['garbage', 'abc'], ['wrong aud', jwt({aud: ['b'.repeat(64)]})], ['wrong iss', jwt({iss: 'https://other.cloudflareaccess.com'})],
      ['expired', jwt({exp: Math.floor(Date.now() / 1000) - 3600})], ['not yet valid', jwt({nbf: Math.floor(Date.now() / 1000) + 3600})],
      ['other service token', jwt({common_name: 'someone-else.access'})], ['user login, not the service token', jwt({common_name: undefined, email: 'nat@example.test'})],
      ['alg none', `${b64({alg: 'none', kid: KID})}.${b64({aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 60})}.`],
      ['HS256', jwt({}, {alg: 'HS256'})], ['unknown kid', jwt({}, {kid: 'other'})],
      ['forged signature', jwt({}, {}, generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey)],
    ];
    for (const [what, value] of bad) assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, 'cf-access-jwt-assertion': value})).status, 403, what);
    assert.equal((await s.send(s.rpc('tools/list'), s.auth)).status, 200);
    assert.ok(s.jwksFetches >= 1 && s.jwksFetches <= 3, 'JWKS fetched once and cached (bounded refetch for unknown kids)');
  });
  // JWKS unavailable on first use: refuse.
  const v = new CfAccessVerifier({mode: 'jwt', teamDomain: TEAM, aud: AUD, serviceTokenClientIdSha256: null}, async () => { throw Error('down'); });
  assert.equal(await v.verifyJwt(jwt()), false);
  // Access check before the bearer: a valid JWT with a bad bearer is still 401, and vice versa 403.
  await withS(t, {}, async s => {
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, authorization: 'Bearer nope'})).status, 401);
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, 'cf-access-jwt-assertion': undefined})).status, 403);
  });
});

test('optional service-token header digests (constant time); off by default', async t => {
  const id = 'client-id-123.access', secret = 'synthetic-secret-value-0123456789';
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  await withS(t, {serviceTokenHeaders: {clientIdSha256: sha(id), clientSecretSha256: sha(secret)}}, async s => {
    assert.equal((await s.send(s.rpc('tools/list'), s.auth)).status, 403, 'headers missing');
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, 'cf-access-client-id': id, 'cf-access-client-secret': 'wrong'})).status, 403);
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, 'cf-access-client-id': id, 'cf-access-client-secret': secret})).status, 200);
  });
  await withS(t, {cfAccess: {mode: 'off'}}, async s => {
    assert.equal((await s.send(s.rpc('tools/list'), {...s.auth, 'cf-access-jwt-assertion': undefined})).status, 200, 'mode off relies on the edge + cloudflared access.required');
  });
});

// ---------- bearer tokens ----------

test('bearer: missing, malformed, unknown, revoked, expired, no-expiry, over-age and non-exposed tokens get 401', async t => {
  await withS(t, {}, async s => {
    const reg = readRegistry(s.config.tokensFile);
    const expired = mintEntry('grok_as_nat', 'expired', 1, Date.now() - 3 * 86_400_000);
    const noExpiry = mintEntry('grok_as_nat', 'no expiry');
    const overAge = mintEntry('grok_as_nat', 'over age', 90);
    const owner = mintEntry('rhys', 'owner token in the wrong registry', 30);
    const revoked = mintEntry('grok_as_nat', 'revoked', 30); revoked.entry.revoked = true;
    reg.tokens.push(expired.entry, noExpiry.entry, overAge.entry, owner.entry, revoked.entry);
    writeRegistry(s.config.tokensFile, reg);
    for (const [what, authz] of [['missing', undefined], ['wrong scheme', `Basic ${s.good.token}`], ['malformed', 'Bearer x'], ['unknown', `Bearer ${newToken()}`],
      ['expired', `Bearer ${expired.token}`], ['no expiry', `Bearer ${noExpiry.token}`], ['over max age', `Bearer ${overAge.token}`], ['owner', `Bearer ${owner.token}`], ['revoked', `Bearer ${revoked.token}`]] as const) {
      const r = await s.send(s.rpc('tools/list'), {...s.auth, authorization: authz});
      assert.equal(r.status, 401, what);
      assert.ok(!r.text.includes('grok') && !r.text.includes('tools'), 'nothing about the server leaks before auth');
    }
    assert.equal((await s.send(s.rpc('tools/list'), s.auth)).status, 200);
  });
});

test('unauthenticated attempts are rate limited globally', async t => {
  await withS(t, {limits: {unauthenticatedPerMinute: 3}}, async s => {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await s.send(s.rpc('tools/list'), {...s.auth, authorization: `Bearer ${newToken()}`})).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  });
});

// ---------- size, rate, concurrency, timeout ----------

test('oversize requests are refused (declared and streamed); oversize responses are refused', async t => {
  await withS(t, {}, async s => {
    const big = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'whoami', arguments: {pad: 'x'.repeat(10_000)}}});
    assert.equal((await s.send(big, s.auth)).status, 413);
    const chunk = 'x'.repeat(1024);
    const r = await s.send(null, {...s.auth, 'transfer-encoding': 'chunked'}, {chunks: ['{"jsonrpc":"2.0","id":1,"method":"ping","params":{"p":"', chunk, chunk, chunk, chunk, chunk, '"}}']}).catch(() => ({status: 413}));
    assert.equal(r.status, 413);
  });
  await withS(t, {maxResponseBytes: 1024}, async s => {
    const r = await s.call('capabilities');
    assert.equal(r.status, 200);
    assert.equal((r.json().error as {code: number}).code, -32000);
    assert.ok(!r.text.includes('safety'), 'the oversize body is not sent');
  });
});

test('per-principal rate limits and concurrency; request timeout; no retries', async t => {
  await withS(t, {limits: {perMinute: 3}}, async s => {
    const st = [];
    for (let i = 0; i < 5; i++) st.push((await s.send(s.rpc('ping'), s.auth)).status);
    assert.deepEqual(st, [200, 200, 200, 429, 429]);
  });
  await withS(t, {limits: {maxConcurrent: 1}}, async s => {
    const [a, b] = await Promise.all([s.call('list_tasks'), new Promise(r => setTimeout(r, 50)).then(() => s.call('list_tasks'))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 429]);
    assert.equal((await s.call('list_tasks')).status, 200, 'the slot is released afterwards');
  }, 300);
  await withS(t, {requestTimeoutMs: 1000}, async s => {
    const listCalls = () => s.hosted.calls.filter(c => c.method === 'list').length;
    const r = await s.call('list_tasks');
    assert.equal(r.status, 504);
    await new Promise(res => setTimeout(res, 800));
    assert.equal(listCalls(), 1, 'the slow hosted read ran once: no retry');
  }, 1500);
});

// ---------- kill switch ----------

test('kill switch: one step refuses ALL external requests at once, including in-flight; resume restores', async t => {
  await withS(t, {}, async s => {
    assert.equal((await s.call('whoami')).status, 200);
    engageKill(s.config.exposure!);
    for (const [body, h] of [[s.rpc('tools/list'), s.auth], [s.rpc('ping'), s.auth], [s.rpc('tools/list'), {}], [s.rpc('tools/list'), {...s.auth, host: 'evil'}]] as const)
      assert.equal((await s.send(body, h)).status, 503);
    releaseKill(s.config.exposure!);
    assert.equal((await s.call('whoami')).status, 200);
  });
  await withS(t, {}, async s => {
    const inflight = s.call('list_tasks');
    await new Promise(r => setTimeout(r, 100));
    engageKill(s.config.exposure!);
    const r = await inflight;
    assert.equal(r.status, 503, 'a result produced after the kill is dropped');
    assert.ok(!r.text.includes('task-clean'));
  }, 400);
});

test('CLI: exposure-kill (with token revocation), exposure-resume, rotate and revoke-principal', async t => {
  await withS(t, {}, async s => {
    const cfg = join(s.state, 'config.json');
    writeFileSync(cfg, JSON.stringify(exposureRaw(s.state)), {mode: 0o600});
    // The listener uses s.config (same files); rewrite the CLI config to point at them exactly.
    const raw = exposureRaw(s.state); raw.exposure.port = s.config.exposure!.port; writeFileSync(cfg, JSON.stringify(raw), {mode: 0o600});
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--no-warnings', BIN, ...args, '--config', cfg], {encoding: 'utf8'}).trim());
    // rotate: new token works, old token refused, output carries no token.
    const out = join(s.state, 'grok-2.token');
    const rot = cli('rotate', '--principal', 'grok_as_nat', '--out', out, '--expires-days', '14');
    assert.equal(rot.revokedPrevious, 1);
    assert.ok(!JSON.stringify(rot).includes('atlas_mcp_'));
    assert.equal((await s.send(s.rpc('ping'), s.auth)).status, 401, 'old token revoked');
    const fresh = readFileSync(out, 'utf8').trim();
    const auth2 = {...s.auth, authorization: `Bearer ${fresh}`};
    assert.equal((await s.send(s.rpc('ping'), auth2)).status, 200);
    assert.throws(() => cli('rotate', '--principal', 'grok_as_nat', '--out', join(s.state, 'x.token'), '--expires-days', '60'), 'over tokenMaxAgeDays');
    assert.throws(() => cli('rotate', '--principal', 'rhys', '--out', join(s.state, 'y.token'), '--expires-days', '5'), 'no owner principal in the exposure config');
    // kill (one command) with revocation
    const k = cli('exposure-kill', '--revoke-tokens');
    assert.deepEqual(k, {killed: true, revokedTokens: 1});
    assert.equal((await s.send(s.rpc('ping'), auth2)).status, 503);
    assert.throws(() => cli('exposure-resume'), 'resume needs --confirm');
    assert.equal(cli('exposure-resume', '--confirm').killed, false);
    assert.equal((await s.send(s.rpc('ping'), auth2)).status, 401, 'tokens stay revoked after resume');
    const st = cli('exposure-status');
    assert.equal(st.killed, false);
    assert.deepEqual(st.principals.grok_as_nat.activeTokens, []);
    // revoke-principal
    const out3 = join(s.state, 'grok-3.token');
    cli('mint-token', '--principal', 'grok_as_nat', '--out', out3, '--expires-days', '7');
    const auth3 = {...s.auth, authorization: `Bearer ${readFileSync(out3, 'utf8').trim()}`};
    assert.equal((await s.send(s.rpc('ping'), auth3)).status, 200);
    assert.throws(() => cli('mint-token', '--principal', 'grok_as_nat', '--out', join(s.state, 'z.token')), 'exposure tokens must expire');
    assert.equal(cli('revoke-principal', '--principal', 'grok_as_nat').revoked, 1);
    assert.equal((await s.send(s.rpc('ping'), auth3)).status, 401);
  });
});

// ---------- audit ----------

test('audit: schema-bound rows for every outcome, no token, JWT, header value, body or result text', async t => {
  await withS(t, {limits: {perMinute: 6}}, async s => {
    const secretArg = 'SENTINEL-PRIVATE-QUESTION-TEXT';
    await s.call('get_task', {id: 'task-clean'});
    await s.call('get_task', {id: secretArg.replace(/[^A-Za-z0-9_-]/g, '')});
    await s.call('list_tasks');
    await s.send(s.rpc('tools/list'), {...s.auth, authorization: `Bearer ${newToken()}`});
    await s.send(s.rpc('tools/list'), {...s.auth, host: 'evil.example'});
    await s.send(JSON.stringify({x: 'y'.repeat(9000)}), s.auth);
    engageKill(s.config.exposure!); await s.send(s.rpc('ping'), s.auth); releaseKill(s.config.exposure!);
    const httpLog = readFileSync(join(s.state, 'exposure-audit.jsonl'), 'utf8');
    const toolLog = readFileSync(join(s.state, 'audit.jsonl'), 'utf8');
    for (const log of [httpLog, toolLog]) {
      assert.ok(!log.includes(s.good.token) && !log.includes('atlas_mcp_'), 'no bearer');
      assert.ok(!log.includes(s.auth['cf-access-jwt-assertion'].slice(0, 40)), 'no JWT');
      assert.ok(!/SENTINEL|onboarding checklist|Bright|evil\.example|yyyy/.test(log), 'no body, header or result text');
    }
    const rows = httpLog.trim().split('\n').map(l => JSON.parse(l));
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['at', 'bytesIn', 'bytesOut', 'cfRay', 'kind', 'method', 'ms', 'principal', 'reason', 'status']);
    assert.deepEqual(rows.map(r => r.reason), ['ok', 'ok', 'ok', 'unauthorized', 'bad_host', 'too_large', 'killed']);
    assert.ok(rows.every(r => ['grok_as_nat', null].includes(r.principal)));
  });
});

test('exposure server refuses to treat the local Phase A config as an exposure config', async () => {
  const {requireExposure} = await import('../src/exposure.ts');
  const state = mkdtempSync(join(tmpdir(), 'atlas-exposure-req-'));
  const raw = exposureRaw(state);
  const {exposure: _e, ...local} = raw; void _e;
  assert.throws(() => requireExposure(parseConfig(local)), /exposure_config_missing/);
  assert.ok(!existsSync(join(state, 'EXPOSURE-DISABLED')));
  assert.equal(digest('x').length, 64);
});
