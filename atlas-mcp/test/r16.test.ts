/**
 * Lane X2: every R16 reproduction (sprint-20261007/laneR16-review/probes.mjs, results in
 * probes-results.json) turned into a regression test that asserts the FIXED behaviour, plus
 * the related checks R16 asked for. Handler-level tests drive exposureHandler with in-memory
 * request/response objects (no sockets), so they also run where loopback bind is denied.
 * Synthetic data, synthetic RSA keys, fake hosted transports only; no provider calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {generateKeyPairSync, sign as cryptoSign, createHash} from 'node:crypto';
import {readFileSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, chmodSync, renameSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setup, makeConfig, makeBrain, fakeHosted, BUDGET} from './fixtures.ts';
import {SensitivityPolicy, parseSensitivity, PolicySource} from '../src/sensitivity.ts';
import {assemble} from '../src/server.ts';
import {exposureHandler, assertDeployable, engageKill, listenExposure} from '../src/exposure.ts';
import {parseConfig} from '../src/config.ts';
import {mintEntry, writeRegistry, readRegistry} from '../src/auth.ts';
import {CfAccessVerifier} from '../src/cf-access.ts';
import type {HostedMeeting, Queue} from '../src/hosted.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SHIPPED_BYTES = readFileSync(join(here, '../config/sensitivity.json'));
const shipped = JSON.parse(SHIPPED_BYTES.toString('utf8'));
const SHIPPED_SHA = createHash('sha256').update(SHIPPED_BYTES).digest('hex');
const clone = <T>(x: T): T => structuredClone(x);
function policy(grants: string[] = []) {
  const p = clone(shipped);
  for (const n of ['nat', 'grok_as_nat']) p.principals[n].fullCallClients = grants.map((client: string) => ({client, decisionReference: 'synthetic reviewer grant'}));
  return new SensitivityPolicy(parseSensitivity(p));
}
const C = '01DDDDDDDDDDDDDDDDDDDDDDDD', D = '01EEEEEEEEEEEEEEEEEEEEEEEE';
function item(id: string, title = 'Send checklist', quote = 'Send checklist tomorrow') {
  return {id: 'req-' + id, title, owner: 'nat', due: null, state: 'approved', evidence: {quote, speaker: 'Amy'}, task: {id: 'task-' + id, title, owner: 'nat', client: 'bright', source_quote: quote, work_status: 'todo'}};
}
// The contract-shaped meeting carries the required classification field.
function meeting(id = C, items = [item('clean')], extra: Record<string, unknown> = {classification: 'client_confidential'}): HostedMeeting {
  return {id, title: 'Bright check-in', instant: '2026-10-20T00:00:00Z', state: 'ready', items, ...extra} as HostedMeeting;
}
function world(pol: SensitivityPolicy | PolicySource | null = policy(), over: Parameters<typeof setup>[0] = {}) {
  const s = setup(over, undefined, undefined, pol instanceof PolicySource ? null : pol);
  if (pol instanceof PolicySource) (s.server.deps as {sensitivity: PolicySource}).sensitivity = pol;
  let meetings: HostedMeeting[] = [meeting()];
  s.hosted.list = async (actor: string): Promise<Queue> => ({capability: await s.hosted.capability(actor), meetings: clone(meetings)});
  return Object.assign(s, {set: (x: HostedMeeting[]) => { meetings = x; }});
}
const note = (id: string, title: string, date: string, summary: string) => `---\nfireflies_id: "${id}"\ntitle: "${title}"\ndate: ${date}\nattendees: ["amy@example.test"]\n---\n# ${title}\n\n## Overview\n\n${summary}\n\n## Transcript\n\n**Amy:** Send checklist tomorrow.\n`;

// ---------- R16 #3: sibling-withheld call closes quotes and drafts too ----------

test('R16 #3: a granted call with a withheld sibling releases no quote and no draft, and reads no draft', async () => {
  const s = world(policy(['bright']));
  s.set([meeting(C, [item('clean'), item('hidden', 'Review payroll')])]);
  let reads = 0;
  s.hosted.documentRead = async () => { reads++; return {status: 200, body: {available: true, currentVersion: 1, title: 'Checklist', status: 'generated'}}; };
  s.hosted.documentArtifact = async () => ({status: 200, body: {version: 1, hash: 'f'.repeat(64), content: {title: 'Checklist'}}});
  const q = await s.server.callTool('nat', 'get_task', {id: 'task-clean'}, 'test');
  assert.deepEqual(q.structured.quotes, []);
  const unknown = await s.server.callTool('grok_as_nat', 'get_draft', {task_id: 'task-none'}, 'test');
  assert.deepEqual(await s.server.callTool('grok_as_nat', 'get_draft', {task_id: 'task-clean'}, 'test'), unknown);
  assert.deepEqual(await s.server.callTool('nat', 'get_draft', {task_id: 'task-clean'}, 'test'), unknown);
  assert.equal(reads, 0, 'no documentRead');
  // Same call without the withheld sibling: the one decision now releases quotes and the draft read.
  s.set([meeting(C, [item('clean')])]);
  assert.equal(((await s.server.callTool('nat', 'get_task', {id: 'task-clean'}, 'test')).structured.quotes as unknown[]).length, 1);
  assert.equal((await s.server.callTool('grok_as_nat', 'get_draft', {task_id: 'task-clean'}, 'test')).isError, false);
  assert.ok(reads >= 1);
});

// ---------- R16 #1: path exclusions independent of the search index ----------

test('R16 #1: brain-path exclusions give identical decisions with a populated, empty or stale index', async () => {
  const s = world();
  writeFileSync(join(s.brain, 'staff-review.md'), note(C, 'Bright check-in', '2026-10-20', 'Checklist next steps'));
  s.index.refresh();
  const local = await s.server.callTool('grok_as_nat', 'list_tasks', {}, 'test');
  const cfg = makeConfig(s.brain);
  const a = assemble({config: cfg, budget: BUDGET, hosted: s.hosted, refreshIndex: false, sensitivity: policy()});
  const exposed = await a.server.callTool('grok_as_nat', 'list_tasks', {}, 'exposure');
  assert.equal(local.structured.count, 0);
  assert.equal(exposed.structured.count, 0, 'empty exposure index no longer turns into permission');
  // Stale index: the note is renamed into an excluded path after indexing; no refresh.
  rmSync(join(s.brain, 'staff-review.md'));
  writeFileSync(join(s.brain, 'checkin.md'), note(C, 'Bright check-in', '2026-10-20', 'Checklist next steps'));
  s.index.refresh();
  assert.equal((await s.server.callTool('grok_as_nat', 'list_tasks', {}, 'test')).structured.count, 1, 'clean path: released');
  renameSync(join(s.brain, 'checkin.md'), join(s.brain, 'finance-checkin.md'));
  assert.equal((await s.server.callTool('grok_as_nat', 'list_tasks', {}, 'test')).structured.count, 0, 'stale index: path read from the brain itself');
  assert.equal((await a.server.callTool('grok_as_nat', 'list_tasks', {}, 'exposure')).structured.count, 0);
  // Hosted-only call (no brain note): same decision on every transport.
  rmSync(join(s.brain, 'finance-checkin.md'));
  assert.equal((await s.server.callTool('grok_as_nat', 'list_tasks', {}, 'test')).structured.count, 1);
  assert.equal((await a.server.callTool('grok_as_nat', 'list_tasks', {}, 'exposure')).structured.count, 1);
  // Unreadable brain directory with path rules: nothing is released.
  const b2 = makeBrain(); const cfg2 = makeConfig(b2);
  const a2 = assemble({config: cfg2, budget: BUDGET, hosted: s.hosted, refreshIndex: false, sensitivity: policy()});
  rmSync(b2, {recursive: true});
  assert.equal((await a2.server.callTool('grok_as_nat', 'list_tasks', {}, 'exposure')).structured.count, 0);
  s.index.db.close(); a.index.db.close(); a2.index.db.close();
});

// ---------- R16 #4: eligibility before ranking ----------

test('R16 #4: a withheld search hit never changes visible results (low limits, many hidden hits, filters, hosted fallback)', async () => {
  const s = world(policy(['bright']));
  s.set([meeting(C), meeting(D, [item('second')])]);
  writeFileSync(join(s.brain, 'hidden.md'), note(C, 'Checklist checklist checklist', '2026-10-21', 'Revenue checklist'));
  writeFileSync(join(s.brain, 'visible.md'), note(D, 'Bright check-in', '2026-10-20', 'Checklist next steps'));
  s.index.refresh();
  const before = await s.server.callTool('nat', 'search_calls', {query: 'checklist', limit: 1}, 'test');
  const beforeDated = await s.server.callTool('nat', 'search_calls', {query: 'checklist', limit: 1, from: '2026-10-01', client: 'bright'}, 'test');
  unlinkSync(join(s.brain, 'hidden.md')); s.index.refresh();
  // The hidden call has no brain note now: it is a hosted-only candidate (title has no query term).
  const after = await s.server.callTool('nat', 'search_calls', {query: 'checklist', limit: 1}, 'test');
  assert.equal(before.structured.count, 1);
  assert.deepEqual(before.structured, after.structured);
  assert.deepEqual(beforeDated.structured, (await s.server.callTool('nat', 'search_calls', {query: 'checklist', limit: 1, from: '2026-10-01', client: 'bright'}, 'test')).structured);
  // Many withheld hits with limit 1.
  const ids: HostedMeeting[] = [meeting(D, [item('second')])];
  for (let i = 0; i < 12; i++) {
    const id = `01H${String(i).padStart(23, '0')}`;
    ids.push(meeting(id, [item(`h${i}`)]));
    writeFileSync(join(s.brain, `h${i}.md`), note(id, 'Checklist checklist', '2026-10-22', `Checklist salary ${i}`));
  }
  s.set(ids); s.index.refresh();
  const many = await s.server.callTool('nat', 'search_calls', {query: 'checklist', limit: 1}, 'test');
  assert.deepEqual((many.structured.calls as {callId: string}[]).map(c => c.callId), [D]);
  s.index.db.close();
});

// ---------- R16 #5: current policy at the release boundary ----------

test('R16 #5: deleted, insecure, edited or re-pinned policy is enforced on the next call and at release', async () => {
  const brain = makeBrain(), cfg = makeConfig(brain), hosted = fakeHosted();
  hosted.list = async (actor: string) => ({capability: await hosted.capability(actor), meetings: [meeting()]});
  writeFileSync(cfg.sensitivityFile, JSON.stringify(shipped), {mode: 0o600});
  const a = assemble({config: cfg, budget: BUDGET, hosted, refreshIndex: false});
  assert.equal((await a.server.callTool('nat', 'whoami', {}, 'test')).isError, false);
  unlinkSync(cfg.sensitivityFile);
  assert.equal((await a.server.callTool('nat', 'whoami', {}, 'test')).structured.error, 'not_available', 'deleted policy');
  assert.equal((await a.server.callTool('rhys', 'whoami', {}, 'test')).isError, false, 'owner unaffected');
  writeFileSync(cfg.sensitivityFile, JSON.stringify(shipped), {mode: 0o600});
  chmodSync(cfg.sensitivityFile, 0o644);
  assert.equal((await a.server.callTool('nat', 'whoami', {}, 'test')).structured.error, 'not_available', 'insecure policy');
  chmodSync(cfg.sensitivityFile, 0o600);
  writeFileSync(cfg.sensitivityFile, '{"broken":', {mode: 0o600});
  assert.equal((await a.server.callTool('nat', 'whoami', {}, 'test')).structured.error, 'not_available', 'invalid policy');
  // An exclusion added while running takes effect on the next call.
  writeFileSync(cfg.sensitivityFile, JSON.stringify(shipped), {mode: 0o600});
  assert.equal((await a.server.callTool('nat', 'list_tasks', {}, 'test')).structured.count, 1, 'clean task visible');
  const p2 = clone(shipped); p2.excluded.clientLabels = ['bright'];
  writeFileSync(cfg.sensitivityFile, JSON.stringify(p2), {mode: 0o600});
  assert.equal((await a.server.callTool('nat', 'list_tasks', {}, 'test')).structured.count, 0, 'new exclusion applies on the next call');
  // Pin: a valid file that is not the pinned bytes is refused.
  const pinned = PolicySource.file(cfg.sensitivityFile, SHIPPED_SHA);
  assert.equal(pinned.current(), null);
  writeFileSync(cfg.sensitivityFile, SHIPPED_BYTES, {mode: 0o600});
  assert.equal(pinned.current()?.sha256, SHIPPED_SHA);
  // In flight: the policy changes while the hosted read is running -> nothing released.
  let release: () => void = () => {};
  const list = hosted.list.bind(hosted);
  hosted.list = async (actor: string) => { await new Promise<void>(r => { release = r; }); return list(actor); };
  const pending = a.server.callTool('nat', 'list_tasks', {}, 'test');
  await new Promise(r => setTimeout(r, 20));
  const p3 = clone(shipped); p3.version = 'edited-in-flight';
  writeFileSync(cfg.sensitivityFile, JSON.stringify(p3), {mode: 0o600});
  release();
  assert.equal((await pending).structured.error, 'not_available');
  a.index.db.close();
});

// ---------- exposure handler (no sockets) ----------

const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const KID = 'r16-kid';
const TEAM = 'synthetic.cloudflareaccess.com', AUD = 'a'.repeat(64), CLIENT_ID = 'synthetic-client.access';
const jwk = {...publicKey.export({format: 'jwk'}), kid: KID};
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(extra: Record<string, unknown> = {}, nowMs = Date.now(), key = privateKey) {
  const h = b64({alg: 'RS256', kid: KID});
  const p = b64({aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(nowMs / 1000) + 300, common_name: CLIENT_ID, ...extra});
  return `${h}.${p}.${cryptoSign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}

function exposureWorld(over: Record<string, unknown> = {}, limits: Record<string, number> = {}) {
  const s = world();
  s.set([meeting(C, [item('clean')])]);
  const raw = JSON.parse(readFileSync(join(here, '../config/exposure.example.json'), 'utf8'));
  Object.assign(raw, {stateDir: s.config.stateDir, brainCallsDir: s.brain, tokensFile: s.config.tokensFile, sensitivityFile: s.config.sensitivityFile});
  raw.exposure = {...raw.exposure, publicHostname: 'atlas-mcp.synthetic-test.example', killSwitchFile: join(s.config.stateDir, 'KILLED'),
    cfAccess: {mode: 'jwt', teamDomain: TEAM, aud: AUD, serviceTokenClientIdSha256: createHash('sha256').update(CLIENT_ID).digest('hex')},
    limits: {perMinute: 120, perHour: 2000, perDay: 10000, maxConcurrent: 1, unauthenticatedPerMinute: 2, bearerFailuresPerMinute: 5, ...limits}, ...over};
  const cfg = parseConfig(raw);
  const token = mintEntry('grok_as_nat', 'synthetic', 1);
  writeRegistry(cfg.tokensFile, {tokens: [token.entry]});
  const a = assemble({config: cfg, budget: BUDGET, hosted: s.hosted, refreshIndex: false, sensitivity: policy()});
  return {...s, a, cfg, token};
}
type Res = EventEmitter & {status: number | null; body: string; headersSent: boolean; writableEnded: boolean; destroyed: boolean; writeHead(s: number): void; end(t?: string): void};
function fakeRes(): Res {
  const r = new EventEmitter() as Res;
  Object.assign(r, {status: null, body: '', headersSent: false, writableEnded: false, destroyed: false});
  r.writeHead = (st: number) => { r.status = st; r.headersSent = true; };
  r.end = (t?: string) => { r.body = t ?? ''; r.writableEnded = true; r.emit('close'); };
  return r;
}
async function invoke(handler: ReturnType<typeof exposureHandler>, w: ReturnType<typeof exposureWorld>, msg: unknown, headers: Record<string, string | undefined> = {}, res = fakeRes()) {
  const req = Readable.from([Buffer.from(JSON.stringify(msg))]) as Readable & Record<string, unknown>;
  const h: Record<string, string> = {host: w.cfg.exposure!.publicHostname, 'content-type': 'application/json', authorization: 'Bearer ' + w.token.token, 'cf-access-jwt-assertion': jwt()};
  for (const [k, v] of Object.entries(headers)) { if (v === undefined) delete h[k]; else h[k] = v; }
  Object.assign(req, {headers: h, socket: {remoteAddress: '127.0.0.1'}, url: '/mcp', method: 'POST'});
  await handler(req as never, res as never);
  return res;
}
const jwks = async () => ({keys: [jwk]});
const call = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'list_tasks', arguments: {}}};

test('R16 #7: timeout keeps the concurrency slot until upstream work settles; the deadline signal reaches hosted reads', async () => {
  const w = exposureWorld({requestTimeoutMs: 1000});
  let active = 0, peak = 0; const gates: (() => void)[] = []; const signals: AbortSignal[] = [];
  w.hosted.list = async (_actor: string, signal?: AbortSignal) => { if (signal) signals.push(signal); active++; peak = Math.max(peak, active); await new Promise<void>(r => gates.push(r)); active--; return {capability: {actor: 'nat', triage: true, review: false, rhysActor: 'rhys'}, meetings: []}; };
  const handler = exposureHandler(w.a, {jwks});
  const first = await invoke(handler, w, call);
  const second = await invoke(handler, w, call);
  assert.equal(first.status, 504);
  assert.equal(second.status, 429, 'the slot is still held by the unfinished read');
  assert.equal(peak, 1, 'no second hosted read starts');
  assert.ok(signals.length === 1 && signals[0].aborted, 'the hosted read got the aborted deadline signal');
  gates.forEach(r => r()); await new Promise(r => setTimeout(r, 30));
  w.hosted.list = async () => ({capability: {actor: 'nat', triage: true, review: false, rhysActor: 'rhys'}, meetings: []});
  assert.equal((await invoke(handler, w, call)).status, 200, 'released once the work settled');
  w.index.db.close(); w.a.index.db.close();
});

test('R16 #7: a client disconnect aborts the work (no result, no later reads)', async () => {
  const w = exposureWorld();
  const signals: AbortSignal[] = []; let gate: () => void = () => {};
  w.hosted.list = async (_a: string, signal?: AbortSignal) => { if (signal) signals.push(signal); await new Promise<void>(r => { gate = r; }); return {capability: {actor: 'nat', triage: true, review: false, rhysActor: 'rhys'}, meetings: []}; };
  const handler = exposureHandler(w.a, {jwks});
  const res = fakeRes();
  const p = invoke(handler, w, call, {}, res);
  await new Promise(r => setTimeout(r, 30));
  res.destroyed = true; res.emit('close');
  await p;
  assert.ok(signals[0]?.aborted);
  gate();
  w.index.db.close(); w.a.index.db.close();
});

test('R16 #8: Access failures count toward the global unauthenticated limit before any auth work', async () => {
  const w = exposureWorld();
  let fetches = 0;
  const handler = exposureHandler(w.a, {jwks: async () => { fetches++; throw Error('fake'); }});
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await invoke(handler, w, {jsonrpc: '2.0', id: 1, method: 'ping'}, {authorization: 'invalid'})).status);
  assert.deepEqual(statuses, [403, 403, 429, 429, 429]);
  assert.ok(fetches <= 2, 'no JWKS/signature work once limited');
  // Bad Host and wrong path also count.
  const w2 = exposureWorld();
  const h2 = exposureHandler(w2.a, {jwks});
  const st2 = [];
  for (let i = 0; i < 3; i++) st2.push((await invoke(h2, w2, {jsonrpc: '2.0', id: 1, method: 'ping'}, {host: 'evil.example'})).status);
  assert.deepEqual(st2, [421, 421, 429]);
  // Flood audit is bounded: one row per 10 s while limited, carrying the suppressed count.
  const rows = readFileSync(join(w.cfg.stateDir, 'exposure-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.filter(r => r.reason === 'unauth_rate').length, 1);
  for (const x of [w, w2]) { x.index.db.close(); x.a.index.db.close(); }
});

test('R16 #9: no data is released when the HTTP or the tool audit cannot be written', async () => {
  const w = exposureWorld();
  mkdirSync(join(w.cfg.stateDir, 'exposure-audit.jsonl'));
  const r = await invoke(exposureHandler(w.a, {jwks}), w, call);
  assert.equal(r.status, 503);
  assert.ok(!r.body.includes('task-clean'));
  const w2 = exposureWorld();
  mkdirSync(join(w2.cfg.stateDir, 'audit.jsonl'));
  const r2 = await invoke(exposureHandler(w2.a, {jwks}), w2, call);
  assert.equal(r2.status, 500);
  assert.ok(!r2.body.includes('task-clean'));
  // The listener refuses to start without a writable audit sink.
  await assert.rejects(async () => listenExposure(w.a, {jwks}), /EISDIR/);
  for (const x of [w, w2]) { x.index.db.close(); x.a.index.db.close(); }
});

test('R16 #11: every response body is capped; unbounded JSON-RPC ids are refused', async () => {
  const w = exposureWorld({maxResponseBytes: 1024});
  const handler = exposureHandler(w.a, {jwks});
  const r = await invoke(handler, w, {jsonrpc: '2.0', id: 'x'.repeat(2000), method: 'ping'});
  assert.ok(Buffer.byteLength(r.body) <= 1024, String(Buffer.byteLength(r.body)));
  assert.ok(!r.body.includes('xxxx'));
  const big = await invoke(handler, w, {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'capabilities', arguments: {}}});
  assert.ok(Buffer.byteLength(big.body) <= 1024);
  assert.match(big.body, /Response too large/);
  w.index.db.close(); w.a.index.db.close();
});

test('bearer revoked while the request is in flight: result dropped', async () => {
  const w = exposureWorld();
  let gate: () => void = () => {};
  const list = w.hosted.list;
  w.hosted.list = async (a: string, s?: AbortSignal) => { await new Promise<void>(r => { gate = r; }); return list(a, s); };
  const handler = exposureHandler(w.a, {jwks});
  const p = invoke(handler, w, call);
  await new Promise(r => setTimeout(r, 30));
  const reg = readRegistry(w.cfg.tokensFile); reg.tokens[0].revoked = true; writeRegistry(w.cfg.tokensFile, reg);
  gate();
  const r = await p;
  assert.equal(r.status, 401);
  assert.ok(!r.body.includes('task-clean'));
  w.index.db.close(); w.a.index.db.close();
});

test('registry entries with future creation or reversed timestamps are refused', async () => {
  const w = exposureWorld();
  const handler = exposureHandler(w.a, {jwks});
  const future = mintEntry('grok_as_nat', 'future', 1, Date.now() + 3 * 86_400_000);
  const reversed = mintEntry('grok_as_nat', 'reversed', 1); reversed.entry.expires = new Date(Date.parse(reversed.entry.created) - 1000).toISOString();
  writeRegistry(w.cfg.tokensFile, {tokens: [future.entry, reversed.entry]});
  for (const t of [future, reversed]) assert.equal((await invoke(handler, w, call, {authorization: `Bearer ${t.token}`})).status, 401);
  w.index.db.close(); w.a.index.db.close();
});

// ---------- R16 #10: JWKS freshness and claim types ----------

test('R16 #10: stale JWKS stops being trusted; malformed time claims and removed keys are refused', async () => {
  let now = Date.now(), down = false, keys = [jwk];
  const cfg = {mode: 'jwt' as const, teamDomain: TEAM, aud: AUD, serviceTokenClientIdSha256: createHash('sha256').update(CLIENT_ID).digest('hex')};
  const v = new CfAccessVerifier(cfg, async () => { if (down) throw Error('offline'); return {keys}; }, () => now);
  assert.equal(await v.verifyJwt(jwt({}, now)), true);
  down = true; now += 30 * 60_000;
  assert.equal(await v.verifyJwt(jwt({}, now)), true, 'within the 1 h freshness window');
  now += 24 * 3_600_000;
  assert.equal(await v.verifyJwt(jwt({}, now)), false, 'after 24 h with JWKS unreachable');
  down = false; now += 10_000;
  assert.equal(await v.verifyJwt(jwt({}, now)), true, 'recovers when JWKS is reachable again');
  for (const bad of [{iat: 'tomorrow'}, {nbf: 'tomorrow'}, {exp: '9999999999'}, {exp: null}, {iat: Infinity}])
    assert.equal(await v.verifyJwt(jwt(bad, now)), false, JSON.stringify(bad));
  // Key rotation: once a refresh no longer lists the old kid, tokens signed with it fail.
  const other = generateKeyPairSync('rsa', {modulusLength: 2048});
  keys = [{...other.publicKey.export({format: 'jwk'}), kid: 'new-kid'}];
  now += 11 * 60_000; // past the 10-minute refresh point
  assert.equal(await v.verifyJwt(jwt({}, now)), false, 'removed key no longer trusted');
});

// ---------- R16 #2: classification contract ----------

test('R16 #2: the installed queue shape (no classification) releases nothing to scoped callers by default', async () => {
  const s = world();
  // Exactly the current contract: meeting rows without classification, tasks = the 024 public.tasks columns.
  s.set([meeting(C, [item('clean')], {}), meeting(D, [item('two')], {taskOnly: true, clientLabel: 'Bright'})]);
  for (const who of ['nat', 'grok_as_nat']) {
    assert.equal((await s.server.callTool(who, 'list_tasks', {}, 'test')).structured.count, 0, who);
    assert.equal((await s.server.callTool(who, 'get_task', {id: 'task-clean'}, 'test')).structured.error, 'not_found');
  }
  assert.equal((await s.server.callTool('rhys', 'list_tasks', {}, 'test')).structured.count, 2, 'owner unaffected');
  // Contract-shaped projection: classified rows release; client_financial / internal never do.
  s.set([meeting(C, [item('clean')]), meeting(D, [item('fin')], {classification: 'client_financial'}), meeting('01FFFFFFFFFFFFFFFFFFFFFFFF', [item('int')], {classification: 'internal'})]);
  assert.deepEqual(((await s.server.callTool('nat', 'list_tasks', {}, 'test')).structured.tasks as {id: string}[]).map(t => t.id), ['task-clean']);
  // An explicit, recorded decision can allow unclassified rows (default is withhold).
  const raw = {...s.config, classificationEnforcement: {unclassified: 'allow', decisionReference: 'synthetic decision for this test'}};
  const allowCfg = parseConfig(raw);
  assert.equal(allowCfg.classificationEnforcement.unclassified, 'allow');
  assert.throws(() => parseConfig({...s.config, classificationEnforcement: {unclassified: 'allow'}}), /classificationEnforcement/);
  s.index.db.close();
});

// ---------- R16 #6: isolated synthetic acceptance path ----------

test('R16 #6: synthetic hosted source serves only synthetic actors, never production, and gives the expected scope', async () => {
  const state = mkdtempSync(join(tmpdir(), 'atlas-accept-'));
  const raw = JSON.parse(readFileSync(join(here, '../config/exposure-acceptance.example.json'), 'utf8'));
  const brain = join(state, 'empty-brain'); mkdirSync(brain, {mode: 0o700});
  const fixture = join(state, 'acceptance-fixture.json');
  writeFileSync(fixture, readFileSync(join(here, '../config/acceptance-fixture.json')), {mode: 0o600});
  Object.assign(raw, {stateDir: state, brainCallsDir: brain, tokensFile: join(state, 'tokens.json'), sensitivityFile: join(state, 'sensitivity.json')});
  raw.hostedSource.fixtureFile = fixture;
  raw.exposure.killSwitchFile = join(state, 'KILLED');
  writeFileSync(raw.sensitivityFile, SHIPPED_BYTES, {mode: 0o600});
  const cfg = parseConfig(raw);
  assert.equal(cfg.hostedSource.mode, 'synthetic');
  // Loader isolation rules.
  assert.throws(() => parseConfig({...raw, principals: {grok_as_nat: {...raw.principals.grok_as_nat, hostedActor: 'nat'}}}), /non_synthetic_actor/);
  assert.throws(() => parseConfig({...raw, hostedSource: {mode: 'production'}}), /synthetic_actor_in_production/);
  // No hosted override: assemble builds the synthetic source and never reads the transport file.
  const a = assemble({config: cfg, budget: BUDGET, refreshIndex: false});
  const r = await a.server.callTool('grok_as_nat', 'list_tasks', {limit: 100}, 'exposure');
  assert.deepEqual((r.structured.tasks as {id: string}[]).map(t => t.id).sort(), ['req-syn-alpha-2', 'req-syn-taskonly-1', 'task-syn-alpha-1']);
  assert.ok(!/revenue|welcome pack|Delta/i.test(JSON.stringify(r.structured)), 'denylisted, client_financial and unclassified synthetic rows withheld');
  const who = await a.server.callTool('grok_as_nat', 'whoami', {}, 'exposure');
  assert.equal(who.structured.hostedActor, 'synthetic_nat');
  a.index.db.close();
});

// ---------- deployment refusals ----------

test('deployment refusal: placeholders, missing pin or a non-dedicated Access identity never start or resume', () => {
  const raw = JSON.parse(readFileSync(join(here, '../config/exposure.example.json'), 'utf8'));
  assert.throws(() => assertDeployable(parseConfig(raw)), /not_deployable:.*publicHostname.*cfAccess.teamDomain.*cfAccess.aud.*serviceTokenClientIdSha256/);
  const real = clone(raw);
  real.exposure.publicHostname = 'mcp.synthetic-business.example';
  real.exposure.cfAccess = {mode: 'jwt', teamDomain: 'syntheticteam.cloudflareaccess.com', aud: 'c'.repeat(64), serviceTokenClientIdSha256: 'd'.repeat(64)};
  assertDeployable(parseConfig(real));
  const unpinned = clone(real); delete unpinned.sensitivitySha256;
  assert.throws(() => assertDeployable(parseConfig(unpinned)), /sensitivitySha256/);
  assert.equal(raw.sensitivitySha256, SHIPPED_SHA, 'the example pins the approved policy bytes');
});

// ---------- pre-handler failures are audited ----------

test('R16 #9: requests Node rejects before the handler are audited (metadata only)', async t => {
  const w = exposureWorld();
  let srv;
  try { srv = await listenExposure(w.a, {jwks}); } catch (e) {
    const code = (e as {code?: string}).code;
    if (code === 'EPERM' || code === 'EACCES') { t.skip(`loopback bind denied (${code})`); return; }
    throw e;
  }
  const {port} = srv.address() as {port: number};
  const net = await import('node:net');
  const send = (raw: string) => new Promise<string>(resolve => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(raw));
    let out = ''; sock.on('data', d => { out += d; }); sock.on('close', () => resolve(out)); sock.on('error', () => resolve(out));
  });
  const overflow = await send(`POST /mcp HTTP/1.1\r\nHost: x\r\nX-Pad: ${'a'.repeat(20000)}\r\n\r\n`);
  const garbage = await send('NOT-HTTP\r\n\r\n');
  assert.match(overflow, /^HTTP\/1\.1 431/);
  assert.match(garbage, /^HTTP\/1\.1 400/);
  const rows = readFileSync(join(w.cfg.stateDir, 'exposure-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(rows.some(r => r.reason === 'header_overflow') && rows.some(r => r.reason === 'client_parse_error'));
  assert.ok(!readFileSync(join(w.cfg.stateDir, 'exposure-audit.jsonl'), 'utf8').includes('aaaa'));
  await new Promise(r => srv.close(r));
  engageKill(w.cfg.exposure!);
  w.index.db.close(); w.a.index.db.close();
});
