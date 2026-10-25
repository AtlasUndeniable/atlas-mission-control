/**
 * Lane X3: R16b's three open findings (sprint-20261007/laneR16b-review/probes.mjs, results in
 * probes-results.json) as regressions asserting the FIXED behaviour:
 *   B1 search ranking is eligibility-first (no corpus-wide BM25 influence from withheld docs);
 *   B2 resume is bound to the running server's own config/policy path/pin;
 *   B3 the global pre-auth bound covers bearer throttling, concurrent auth work, stalled auth
 *      and parser errors, for both work and audit volume.
 * Synthetic data, synthetic RSA keys and in-process transports; the one end-to-end resume test
 * starts a real exposure-http child on 127.0.0.1 (synthetic hosted source) and is SKIPPED where
 * loopback bind is denied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {spawn, spawnSync} from 'node:child_process';
import {request} from 'node:http';
import {generateKeyPairSync, sign as cryptoSign, createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeConfig, fakeHosted, BUDGET} from './fixtures.ts';
import {assemble} from '../src/server.ts';
import {SensitivityPolicy, parseSensitivity} from '../src/sensitivity.ts';
import {parseConfig} from '../src/config.ts';
import {exposureHandler, verifyResumeBinding, writeRuntimeBinding, engageKill, killed} from '../src/exposure.ts';
import {CfAccessVerifier} from '../src/cf-access.ts';
import {mintEntry, writeRegistry} from '../src/auth.ts';
import type {HostedMeeting} from '../src/hosted.ts';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '../bin/atlas-mcp.ts');
const SHIPPED_BYTES = readFileSync(join(here, '../config/sensitivity.json'));
const SHIPPED_SHA = createHash('sha256').update(SHIPPED_BYTES).digest('hex');
const grantSpec = () => { const s = JSON.parse(SHIPPED_BYTES.toString('utf8')); for (const w of ['nat', 'grok_as_nat']) s.principals[w].fullCallClients = [{client: 'bright', decisionReference: 'synthetic reviewer grant'}]; return s; };
const meeting = (id: string): HostedMeeting => ({id, title: 'Check in', instant: '2026-10-20T00:00:00Z', state: 'ready', classification: 'client_confidential', items: [{id: 'req-' + id, title: 'Send checklist', owner: 'nat', state: 'approved', due: null, task: {id: 'task-' + id, client: 'bright', title: 'Send checklist'}}]} as HostedMeeting);
const note = (id: string, text: string) => `---\nfireflies_id: "${id}"\ntitle: "Check in"\ndate: 2026-10-20\nattendees: ["amy@example.test"]\n---\n# Check in\n\n## Overview\n\n${text}\n\n## Transcript\n\n**Amy:** ${text}\n`;

// ---------- B1 ----------

test('B1: withheld documents cannot change the ranking or content of visible results (multi-term, filters, limits)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'x3-b1-'));
  const brain = join(root, 'brain'); mkdirSync(brain);
  const hosted = fakeHosted();
  const meetings = [meeting('VISIBLE_A'), meeting('VISIBLE_B')];
  hosted.list = async actor => ({capability: await hosted.capability(actor), meetings});
  writeFileSync(join(brain, 'a.md'), note('VISIBLE_A', 'orchard orchard orchard'));
  writeFileSync(join(brain, 'b.md'), note('VISIBLE_B', 'meadow meadow'));
  const a = assemble({config: makeConfig(brain), budget: BUDGET, hosted, sensitivity: new SensitivityPolicy(parseSensitivity(grantSpec()))});
  const queries: Record<string, unknown>[] = [{query: 'orchard meadow', limit: 1}, {query: 'orchard meadow', limit: 2}, {query: 'orchard meadow', limit: 1, client: 'bright', from: '2026-10-01'}, {query: 'meadow orchard check', limit: 5}];
  const run = async () => Promise.all(queries.map(async q => (await a.server.callTool('nat', 'search_calls', q, 'test')).structured));
  const before = await run();
  assert.deepEqual((before[0].calls as {callId: string}[]).map(c => c.callId), ['VISIBLE_A']);
  for (let i = 0; i < 20; i++) {
    const id = 'HIDDEN_' + i; meetings.push(meeting(id));
    writeFileSync(join(brain, `hidden-${i}.md`), note(id, 'revenue orchard orchard orchard'));
  }
  a.index.refresh();
  assert.deepEqual(await run(), before, 'complete results identical with 20 withheld documents in the corpus');
  for (let i = 0; i < 20; i++) unlinkSync(join(brain, `hidden-${i}.md`));
  meetings.splice(2); a.index.refresh();
  assert.deepEqual(await run(), before);
  // Owner search is unaffected by the change (still BM25 over everything it may see).
  assert.ok(((await a.server.callTool('rhys', 'search_calls', {query: 'orchard meadow'}, 'test')).structured.calls as unknown[]).length >= 2);
  a.index.db.close();
});

// ---------- exposure handler helpers ----------

const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const kid = 'x3-kid', client = 'synthetic-client', team = 'synthetic.cloudflareaccess.com', aud = 'a'.repeat(64);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = b64({alg: 'RS256', kid});
const payload = () => b64({iss: 'https://' + team, aud: [aud], common_name: client, exp: Math.floor(Date.now() / 1000) + 300});
const goodJwt = () => { const p = payload(); return `${head}.${p}.${cryptoSign('RSA-SHA256', Buffer.from(`${head}.${p}`), privateKey).toString('base64url')}`; };
const badSigJwt = () => `${head}.${payload()}.${Buffer.alloc(256).toString('base64url')}`;
const jwks = async () => ({keys: [{...publicKey.export({format: 'jwk'}), kid}]});

function world(limits: Record<string, number>, over: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'x3-exp-'));
  const brain = join(root, 'brain'); mkdirSync(brain);
  const hosted = fakeHosted();
  hosted.list = async actor => ({capability: await hosted.capability(actor), meetings: [meeting('VISIBLE_A')]});
  const raw = JSON.parse(readFileSync(join(here, '../config/exposure.example.json'), 'utf8'));
  Object.assign(raw, {stateDir: join(root, 'state'), brainCallsDir: brain, tokensFile: join(root, 'tokens.json'), sensitivityFile: join(root, 'sensitivity.json')});
  writeFileSync(raw.sensitivityFile, SHIPPED_BYTES, {mode: 0o600});
  raw.exposure = {...raw.exposure, publicHostname: 'mcp.synthetic.example', killSwitchFile: join(root, 'KILLED'),
    cfAccess: {mode: 'jwt', teamDomain: team, aud, serviceTokenClientIdSha256: createHash('sha256').update(client).digest('hex')},
    limits: {...raw.exposure.limits, ...limits}, ...over};
  const cfg = parseConfig(raw);
  const tok = mintEntry('grok_as_nat', 'synthetic', 1);
  writeRegistry(cfg.tokensFile, {tokens: [tok.entry]});
  const a = assemble({config: cfg, budget: BUDGET, hosted, refreshIndex: false});
  return {root, raw, cfg, a, tok, hosted};
}
function fakeRes() {
  const r = new EventEmitter() as EventEmitter & {status: number | null; headersSent: boolean; writableEnded: boolean; destroyed: boolean; writeHead(s: number): void; end(t?: string): void; body: string};
  Object.assign(r, {status: null, headersSent: false, writableEnded: false, destroyed: false, body: ''});
  r.writeHead = (s: number) => { r.status = s; r.headersSent = true; };
  r.end = (t?: string) => { r.body = t ?? ''; r.writableEnded = true; r.emit('close'); };
  return r;
}
async function invoke(h: ReturnType<typeof exposureHandler>, w: ReturnType<typeof world>, jwt: string, bearer: string) {
  const req = Readable.from([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}')]);
  Object.assign(req, {headers: {host: w.cfg.exposure!.publicHostname, 'content-type': 'application/json', 'cf-access-jwt-assertion': jwt, authorization: bearer}, socket: {remoteAddress: '127.0.0.1'}, url: '/mcp', method: 'POST'});
  const res = fakeRes();
  await h(req as never, res as never);
  return res.status;
}
const auditRows = (w: ReturnType<typeof world>) => { const f = join(w.cfg.stateDir, 'exposure-audit.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; };
function countVerifies() {
  let n = 0;
  const original = CfAccessVerifier.prototype.verifyJwt;
  CfAccessVerifier.prototype.verifyJwt = function (...args: Parameters<typeof original>) { n++; return original.apply(this, args); };
  return {get n() { return n; }, reset() { n = 0; }, restore() { CfAccessVerifier.prototype.verifyJwt = original; }};
}

// ---------- B3 ----------

test('B3: after the bearer limit trips, a bad-bearer flood stops reaching JWT verification and audit stays bounded', async () => {
  const w = world({unauthenticatedPerMinute: 5, bearerFailuresPerMinute: 2});
  const v = countVerifies();
  try {
    const h = exposureHandler(w.a, {jwks});
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push(await invoke(h, w, goodJwt(), 'Bearer synthetic-invalid'));
    assert.deepEqual(statuses.slice(0, 2), [401, 401]);
    assert.ok(statuses.slice(2).every(s => s === 429));
    assert.ok(v.n <= 5, `JWT verifications bounded by the global limit (got ${v.n}, was 40)`);
    const rows = auditRows(w);
    assert.ok(rows.length <= 6, `audit rows bounded (got ${rows.length}, was 40)`);
    assert.ok(rows.some(r => r.reason === 'unauth_rate'), 'the flood reaches the global limit');
    // A valid request is also limited while the window is full (documented trade-off; the
    // Cloudflare edge stops unauthenticated traffic before it reaches the origin).
    assert.equal(await invoke(h, w, goodJwt(), `Bearer ${w.tok.token}`), 429);
  } finally { v.restore(); w.a.index.db.close(); }
});

test('B3: concurrent invalid signatures reserve pre-auth slots before verification', async () => {
  const w = world({unauthenticatedPerMinute: 5, bearerFailuresPerMinute: 10});
  const v = countVerifies();
  try {
    const h = exposureHandler(w.a, {jwks});
    await invoke(h, w, goodJwt(), 'Bearer synthetic-invalid'); // warm key; one prior failure
    v.reset();
    const burst = await Promise.all(Array.from({length: 20}, () => invoke(h, w, badSigJwt(), 'Bearer synthetic-invalid')));
    assert.ok(v.n <= 4, `at most limit - prior failures enter verification (got ${v.n}, was 20)`);
    assert.equal(burst.filter(s => s === 403).length, v.n);
    assert.equal(burst.filter(s => s === 429).length, 20 - v.n);
  } finally { v.restore(); w.a.index.db.close(); }
});

test('B3: a stalled authentication times out, counts as a failure and releases its reservation', async () => {
  const w = world({unauthenticatedPerMinute: 3, bearerFailuresPerMinute: 10}, {requestTimeoutMs: 1000});
  let stall = true;
  const h = exposureHandler(w.a, {jwks: async (_u, signal) => { if (stall) await new Promise((_r, rej) => signal?.addEventListener('abort', () => rej(Error('aborted')))); return jwks(); }});
  assert.equal(await invoke(h, w, goodJwt(), `Bearer ${w.tok.token}`), 504);
  assert.ok(auditRows(w).some(r => r.reason === 'auth_timeout'));
  stall = false;
  await new Promise(r => setTimeout(r, 5100)); // past the JWKS retry backoff
  assert.equal(await invoke(h, w, goodJwt(), `Bearer ${w.tok.token}`), 200, 'reservation released; one failure < limit');
  w.a.index.db.close();
});

test('B3: parser-level errors count toward the global limit and their audit is aggregated', async () => {
  const w = world({unauthenticatedPerMinute: 5});
  const h = exposureHandler(w.a, {jwks});
  for (let i = 0; i < 50; i++) assert.equal(h.clientError('header_overflow', 431), true);
  const rows = auditRows(w).filter(r => r.reason === 'header_overflow');
  assert.equal(rows.length, 1, 'one row per 10 s');
  assert.equal(await invoke(h, w, goodJwt(), `Bearer ${w.tok.token}`), 429, 'parser floods count toward the global limit');
  w.a.index.db.close();
});

// ---------- B2 ----------

test('B2: resume is bound to the running server config; a changed policy path/pin/classification is refused', async () => {
  const w = world({});
  const shipped = SHIPPED_BYTES.toString('utf8');
  const oldFile = join(w.root, 'old-policy.json'); writeFileSync(oldFile, shipped, {mode: 0o600});
  Object.assign(w.raw, {sensitivityFile: oldFile, sensitivitySha256: SHIPPED_SHA});
  const configFile = join(w.root, 'config.json');
  writeFileSync(configFile, JSON.stringify(w.raw), {mode: 0o600});
  const running = parseConfig(w.raw);
  writeRuntimeBinding(running, configFile, createHash('sha256').update(readFileSync(configFile)).digest('hex'));
  const alive = () => true;
  assert.equal(verifyResumeBinding(running, configFile, alive).sensitivitySha256, SHIPPED_SHA, 'same config: allowed');
  // R16b reproduction: switch the config to policy B (new path + pin + a bright exclusion).
  const updated = JSON.parse(shipped); updated.excluded.clientLabels = ['bright'];
  const newBytes = JSON.stringify(updated), newFile = join(w.root, 'new-policy.json');
  writeFileSync(newFile, newBytes, {mode: 0o600});
  Object.assign(w.raw, {sensitivityFile: newFile, sensitivitySha256: createHash('sha256').update(newBytes).digest('hex')});
  writeFileSync(configFile, JSON.stringify(w.raw), {mode: 0o600});
  assert.throws(() => verifyResumeBinding(parseConfig(w.raw), configFile, alive), /config_changed_since_server_start/);
  // Classification-enforcement change alone is also a config change.
  Object.assign(w.raw, {sensitivityFile: oldFile, sensitivitySha256: SHIPPED_SHA, classificationEnforcement: {unclassified: 'allow', decisionReference: 'synthetic decision reference'}});
  writeFileSync(configFile, JSON.stringify(w.raw), {mode: 0o600});
  assert.throws(() => verifyResumeBinding(parseConfig(w.raw), configFile, alive), /config_changed/);
  // Server not running, or its own policy no longer valid: refused.
  delete (w.raw as Record<string, unknown>).classificationEnforcement;
  writeFileSync(configFile, JSON.stringify(w.raw), {mode: 0o600});
  writeRuntimeBinding(parseConfig(w.raw), configFile, createHash('sha256').update(readFileSync(configFile)).digest('hex'));
  assert.throws(() => verifyResumeBinding(parseConfig(w.raw), configFile, () => false), /not_running/);
  writeFileSync(oldFile, shipped + ' ', {mode: 0o600});
  assert.throws(() => verifyResumeBinding(parseConfig(w.raw), configFile, alive), /running_policy_invalid/);
  // The CLI refuses without a live exposure-http process and keeps the kill switch.
  writeFileSync(oldFile, shipped, {mode: 0o600});
  engageKill(w.cfg.exposure!);
  const r = spawnSync(process.execPath, ['--no-warnings', BIN, 'exposure-resume', '--config', configFile, '--confirm'], {encoding: 'utf8'});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /resume_refused/);
  assert.ok(killed(w.cfg.exposure!));
  w.a.index.db.close();
});

test('B2: the running server answers 503 config_changed while its config file differs from what it started with', async () => {
  const w = world({});
  const configFile = join(w.root, 'config.json'); writeFileSync(configFile, JSON.stringify(w.raw), {mode: 0o600});
  const sha = createHash('sha256').update(readFileSync(configFile)).digest('hex');
  const h = exposureHandler(w.a, {jwks, configFile, configSha256: sha});
  assert.equal(await invoke(h, w, goodJwt(), `Bearer ${w.tok.token}`), 200);
  writeFileSync(configFile, JSON.stringify({...w.raw, sensitivitySha256: 'e'.repeat(64)}), {mode: 0o600});
  assert.equal(await invoke(h, w, goodJwt(), `Bearer ${w.tok.token}`), 503);
  assert.ok(auditRows(w).some(r => r.reason === 'config_changed'));
  w.a.index.db.close();
});

test('B2 end to end: real exposure-http child; resume only for its own config; restart required after a change', async t => {
  const state = mkdtempSync(join(tmpdir(), 'x3-e2e-'));
  const raw = JSON.parse(readFileSync(join(here, '../config/exposure-acceptance.example.json'), 'utf8'));
  const brain = join(state, 'empty-brain'); mkdirSync(brain, {mode: 0o700});
  const fixture = join(state, 'fixture.json'); writeFileSync(fixture, readFileSync(join(here, '../config/acceptance-fixture.json')), {mode: 0o600});
  Object.assign(raw, {stateDir: join(state, 'st'), brainCallsDir: brain, tokensFile: join(state, 'tokens.json'), sensitivityFile: join(state, 'sensitivity.json')});
  writeFileSync(raw.sensitivityFile, SHIPPED_BYTES, {mode: 0o600});
  raw.hostedSource.fixtureFile = fixture;
  raw.exposure = {...raw.exposure, port: 49000 + Math.floor(Math.random() * 900), publicHostname: 'mcp.synthetic.example', killSwitchFile: join(state, 'KILLED'),
    cfAccess: {mode: 'jwt', teamDomain: team, aud, serviceTokenClientIdSha256: createHash('sha256').update(client).digest('hex')}};
  const configFile = join(state, 'config.json'); writeFileSync(configFile, JSON.stringify(raw), {mode: 0o600});
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', BIN, ...args, '--config', configFile], {encoding: 'utf8'});
  assert.equal(cli('exposure-kill').status, 0);
  const startChild = async () => {
    const child = spawn(process.execPath, ['--no-warnings', BIN, 'exposure-http', '--config', configFile], {stdio: ['ignore', 'ignore', 'pipe']});
    let err = '';
    const ok = await new Promise<boolean>(resolve => {
      child.stderr.on('data', d => { err += d; if (err.includes('exposure_listening')) resolve(true); });
      child.on('exit', () => resolve(false));
    });
    return {child, ok, err};
  };
  const stopChild = (c: ReturnType<typeof spawn>) => new Promise(r => { c.on('exit', r); c.kill('SIGTERM'); });
  const first = await startChild();
  if (!first.ok) { if (/EPERM|EACCES/.test(first.err)) { t.skip('loopback bind denied'); return; } assert.fail(first.err.slice(0, 300)); }
  try {
    const r1 = cli('exposure-resume', '--confirm');
    assert.equal(r1.status, 0, r1.stderr.slice(0, 300));
    assert.equal(JSON.parse(r1.stdout).boundPid, first.child.pid);
    // Change the config while the server runs: requests get 503, resume after kill is refused.
    raw.exposure.limits.perMinute = 19; writeFileSync(configFile, JSON.stringify(raw), {mode: 0o600});
    const status = await new Promise<number>((resolve, reject) => {
      const q = request({host: '127.0.0.1', port: raw.exposure.port, path: '/mcp', method: 'POST', headers: {host: 'mcp.synthetic.example', 'content-type': 'application/json'}}, res => { res.resume(); resolve(res.statusCode ?? 0); });
      q.on('error', reject); q.end('{}');
    });
    assert.equal(status, 503);
    assert.equal(cli('exposure-kill').status, 0);
    const r2 = cli('exposure-resume', '--confirm');
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr, /config_changed_since_server_start/);
    assert.ok(existsSync(raw.exposure.killSwitchFile), 'kill kept');
  } finally { await stopChild(first.child); }
  assert.ok(!existsSync(join(raw.stateDir, 'exposure-runtime.json')), 'binding cleared on stop');
  // Verified restart with the new config, then resume works.
  const second = await startChild();
  assert.ok(second.ok, second.err.slice(0, 300));
  try {
    const r3 = cli('exposure-resume', '--confirm');
    assert.equal(r3.status, 0, r3.stderr.slice(0, 300));
    assert.equal(JSON.parse(r3.stdout).boundPid, second.child.pid);
  } finally { await stopChild(second.child); }
});
