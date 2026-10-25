/**
 * Lane G2: every one of R14's 12 synthetic reproductions (laneR14-review/probes.mjs), turned
 * into a regression test that asserts the FIXED behaviour, plus the related checks R14 asked
 * for (grant revocation between requests, task-only task fields, ledger validation, outcome
 * normalisation, index policy rebuild, hardened token files, ask_call idempotency hint).
 * Synthetic data only; no listener, no real provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, appendFileSync, symlinkSync, mkdtempSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {setup, fakeModel, A, B, BUDGET, TEST_PAN_DIGITS} from './fixtures.ts';
import {parseNote} from '../src/notes.ts';
import {maskText} from '../src/mask.ts';
import {runStdio, readTokenFile} from '../src/server.ts';
import {readRegistry, writeRegistry} from '../src/auth.ts';
import {CallIndex, INDEX_POLICY} from '../src/call-index.ts';
import {TOOL_DEFS} from '../src/tools.ts';
import type {Queue} from '../src/hosted.ts';

/** R14's fixture: a valid-shaped task-only queue row for ungranted call B, visible to nat. */
function withTaskOnlyB(s: ReturnType<typeof setup>) {
  const list = s.hosted.list.bind(s.hosted);
  s.hosted.list = async (actor: string): Promise<Queue> => {
    const q = await list(actor);
    if (actor === 'nat') q.meetings.push({id: B, title: 'Reviewed task context only', instant: '2026-10-05T01:00:00Z', state: 'ready', taskOnly: true, clientLabel: 'Zenith', classification: 'client_confidential',
      items: [{id: 'task-only-request', title: 'Reviewed task only', due: null, owner: 'nat', state: 'approved', task: null, evidence: {quote: 'Reviewed excerpt only.'}}]});
    return q;
  };
  return s;
}

for (const principal of ['nat', 'grok_as_nat']) {
  test(`R14 #1/#3 ${principal}: a taskOnly queue row never releases brain search text`, async () => {
    const s = withTaskOnlyB(setup());
    for (const query of ['zebracorn', 'confidential', 'pricing', 'launch']) {
      const r = await s.server.callTool(principal, 'search_calls', {query}, 'test');
      assert.equal(r.isError, false);
      assert.ok(!(r.structured.calls as {callId: string}[]).some(c => c.callId === B), `B returned for ${query}`);
      assert.ok(!/zebracorn|confidential|Zenith Fitness/i.test(JSON.stringify(r.structured)), `B text leaked for ${query}`);
    }
    const filtered = await s.server.callTool(principal, 'search_calls', {query: 'pricing', client: 'zenith'}, 'test');
    assert.equal((filtered.structured.calls as unknown[]).length, 0, 'client filter cannot reach a task-only call');
    assert.ok(!s.hosted.calls.some(c => c.method === 'context'), 'no hosted transcript read');
  });

  test(`R14 #2/#4 ${principal}: ask_call on a taskOnly id is refused exactly like an unknown id, before any read or dispatch`, async () => {
    const model = fakeModel(() => ({supported: true, answer: 'x', quotes: [{turn: 1, text: 'zebracorn pricing is confidential'}]}));
    const s = withTaskOnlyB(setup({}, undefined, model));
    const known = await s.server.callTool(principal, 'ask_call', {call_id: B, question: 'What was discussed?'}, 'test');
    const unknown = await s.server.callTool(principal, 'ask_call', {call_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', question: 'What was discussed?'}, 'test');
    assert.deepEqual(known.structured, unknown.structured);
    assert.equal(known.structured.error, 'not_found');
    assert.equal(model.bodies.length, 0);
    assert.ok(!s.hosted.calls.some(c => c.method === 'context'));
  });

  test(`${principal}: task-only access still returns task fields (and only task fields)`, async () => {
    const s = withTaskOnlyB(setup());
    const list = await s.server.callTool(principal, 'list_tasks', {}, 'test');
    const t = (list.structured.tasks as {requestId: string; source: {access: string}; client: string}[]).find(x => x.requestId === 'task-only-request');
    assert.ok(t, 'task-only task is listed');
    assert.equal(t.source.access, 'task_only');
    assert.equal(t.client, 'Zenith');
    const g = await s.server.callTool(principal, 'get_task', {id: 'task-only-request'}, 'test');
    assert.equal(g.isError, false);
    assert.ok(!/zebracorn|confidential/i.test(JSON.stringify(g.structured)));
  });
}

test('grant revocation between requests takes effect on the next call (no caching)', async () => {
  const model = fakeModel(() => ({supported: false, answer: '', quotes: []}));
  const s = setup({}, undefined, model);
  let revoked = false;
  const list = s.hosted.list.bind(s.hosted);
  s.hosted.list = async (actor: string) => { const q = await list(actor); if (revoked && actor === 'nat') q.meetings = []; return q; };
  assert.equal(((await s.server.callTool('nat', 'search_calls', {query: 'pricing'}, 'test')).structured.calls as unknown[]).length, 1);
  revoked = true;
  assert.equal(((await s.server.callTool('nat', 'search_calls', {query: 'pricing'}, 'test')).structured.calls as unknown[]).length, 0);
  assert.equal((await s.server.callTool('nat', 'ask_call', {call_id: A, question: 'q?'}, 'test')).structured.error, 'not_found');
  assert.equal(model.bodies.length, 0);
});

test('owner: a taskOnly row is never used for a hosted transcript read', async () => {
  const s = setup();
  const list = s.hosted.list.bind(s.hosted);
  s.hosted.list = async (actor: string) => { const q = await list(actor); q.meetings = q.meetings.map(m => (m.id === B ? {...m, taskOnly: true} : m)); return q; };
  await s.server.callTool('rhys', 'ask_call', {call_id: B, question: 'q?'}, 'test');
  assert.ok(!s.hosted.calls.some(c => c.method === 'context' && c.arg === B));
});

test('a hosted context refusal is final: not_found, no fallback to the brain copy, no dispatch', async () => {
  const model = fakeModel(() => ({supported: true, answer: 'x', quotes: [{turn: 0, text: 'Good to see you, how has the month been?'}]}));
  const s = setup({}, undefined, model);
  s.hosted.context = async () => { const {HostedRefusal} = await import('../src/hosted.ts'); throw new HostedRefusal(403, 'Hosted service refused the read.'); };
  const r = await s.server.callTool('nat', 'ask_call', {call_id: A, question: 'q?'}, 'test');
  assert.equal(r.structured.error, 'not_found');
  assert.equal(model.bodies.length, 0);
});

test('R14 #5: note attendees are masked by parseNote', () => {
  const raw = `---\nfireflies_id: "01DDDDDDDDDDDDDDDDDDDDDDDD"\ntitle: "Metadata sentinel"\nattendees: ["${TEST_PAN_DIGITS}"]\n---\n## Overview\nMetadata sentinel.\n## Transcript\n**Speaker:** Metadata sentinel.\n`;
  const n = parseNote('/tmp/x.md', raw);
  assert.ok(!JSON.stringify(n).includes(TEST_PAN_DIGITS));
  const bad = parseNote('/tmp/y.md', raw.replace('title:', 'transcript_url: "https://app.fireflies.ai/view/x?card=1"\ntitle:'));
  assert.equal(bad.link, 'https://app.fireflies.ai/view/01DDDDDDDDDDDDDDDDDDDDDDDD', 'non-canonical transcript_url is ignored');
});

test('R14 #6: a card value in attendees reaches neither the index file nor search output', async () => {
  const s = setup();
  writeFileSync(join(s.brain, 'synthetic-metadata.md'), `---\nfireflies_id: "01DDDDDDDDDDDDDDDDDDDDDDDD"\ntitle: "Metadata sentinel"\nattendees: ["${TEST_PAN_DIGITS}"]\n---\n## Overview\nMetadata sentinel.\n## Transcript\n**Speaker:** Metadata sentinel.\n`);
  s.index.refresh();
  const r = await s.server.callTool('rhys', 'search_calls', {query: 'sentinel'}, 'test');
  assert.equal((r.structured.calls as unknown[]).length, 1);
  assert.ok(!JSON.stringify(r).includes(TEST_PAN_DIGITS));
  s.index.db.close();
  assert.ok(!readFileSync(join(s.config.stateDir, 'calls-index.sqlite')).includes(Buffer.from(TEST_PAN_DIGITS)));
});

test('R14 #7: an unknown tool name never enters the audit log (fixed enum + hash)', async () => {
  const s = setup();
  const phrase = `synthetic private transcript sentence ${TEST_PAN_DIGITS}`;
  const r = await s.server.callTool('rhys', phrase, {}, 'test');
  assert.equal(r.structured.error, 'unknown_tool');
  const audit = readFileSync(join(s.config.stateDir, 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes('synthetic private') && !audit.includes(TEST_PAN_DIGITS));
  const row = JSON.parse(audit.trim().split('\n').pop()!);
  assert.equal(row.tool, 'unknown_tool');
  assert.match(row.toolNameSha256, /^[0-9a-f]{64}$/);
  for (const v of Object.values(row)) if (typeof v === 'string') assert.ok(v.length <= 64);
});

test('R14 #8: scoped capabilities and whoami reveal no global corpus or usage totals', async () => {
  const s = setup();
  for (const p of ['nat', 'grok_as_nat']) {
    const caps = await s.server.callTool(p, 'capabilities', {}, 'test');
    assert.ok(!('indexedCalls' in caps.structured));
    const who = await s.server.callTool(p, 'whoami', {}, 'test');
    const b = who.structured.askCallBudget as Record<string, unknown>;
    assert.ok(!('usedThisMonthUsd' in b) && !('callsThisMonth' in b) && !('callsToday' in b));
  }
  assert.equal((await s.server.callTool('rhys', 'capabilities', {}, 'test')).structured.indexedCalls, s.index.count());
});

test('R14 #9 and #10: question digits never reach the model; the full answer is masked before clipping', async () => {
  const answer = 'x'.repeat(1988) + TEST_PAN_DIGITS;
  assert.ok(!maskText(answer).includes(TEST_PAN_DIGITS));
  const model = fakeModel(() => ({supported: true, answer, quotes: [{turn: 2, text: 'move the group program price to nine ninety seven'}]}));
  const s = setup({}, undefined, model);
  const r = await s.server.callTool('rhys', 'ask_call', {call_id: A, question: `Does this call discuss ${TEST_PAN_DIGITS}?`}, 'test');
  assert.ok(!model.bodies[0].includes(TEST_PAN_DIGITS));
  const out = String(r.structured.answer);
  assert.ok(!out.includes(TEST_PAN_DIGITS.slice(0, 12)) && !out.replace(/\D/g, '').includes(TEST_PAN_DIGITS.slice(0, 12)));
  assert.ok(out.length <= 2000);
});

test('R14 #11: negative or oversized usage never credits the ledger; the full reservation is kept', async () => {
  for (const usage of [{input_tokens: -1000000, output_tokens: 1}, {input_tokens: 10, output_tokens: 999999}, {input_tokens: 1.5, output_tokens: 1}]) {
    const model = fakeModel(() => ({supported: false, answer: '', quotes: []}), {usage});
    const s = setup({}, undefined, model);
    await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'Question?'}, 'test');
    const st = s.server.deps.ledger.state();
    const bound = Buffer.byteLength(model.bodies[0]) * 2 + 3000 * 10;
    assert.equal(st.monthMicros, bound, JSON.stringify(usage));
    const rows = readFileSync(s.server.deps.ledger.file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows[1].actualMicros, null);
    assert.equal(rows[1].outcome, 'invalid_usage');
  }
});

test('usage above the byte-floor bound is recorded as-is and halts further dispatch', async () => {
  const model = fakeModel(() => ({supported: false, answer: '', quotes: []}), {usage: {input_tokens: 10_000_000, output_tokens: 1}});
  const s = setup({}, undefined, model);
  await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q?'}, 'test');
  assert.equal(s.server.deps.ledger.state().halted, true);
  const next = await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q2?'}, 'test');
  assert.equal(next.structured.error, 'budget_refused');
  assert.match(String(next.structured.message), /halted/);
  assert.equal(model.bodies.length, 1);
});

test('malformed ledger rows fail closed; provider stop_reason is normalised', async () => {
  const model = fakeModel(() => ({supported: false, answer: '', quotes: []}));
  const s = setup({}, undefined, model);
  await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q?'}, 'test');
  const rows = readFileSync(s.server.deps.ledger.file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows[1].outcome, 'end_turn');
  appendFileSync(s.server.deps.ledger.file, JSON.stringify({id: rows[0].id, at: new Date().toISOString(), kind: 'settle', actualMicros: -5000000, outcome: 'credit'}) + '\n');
  assert.equal(s.server.deps.ledger.state().invalid, true);
  const r = await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q2?'}, 'test');
  assert.equal(r.structured.error, 'budget_refused');
  assert.equal(model.bodies.length, 1);
});

test('R14 #12: revoking a token ends an open stdio session before the next request', async () => {
  const s = setup();
  const input = new PassThrough(), output = new PassThrough();
  const rows: {result?: {isError: boolean}; error?: {code: number}}[] = [];
  output.on('data', b => rows.push(...String(b).trim().split('\n').map(l => JSON.parse(l))));
  const done = runStdio(s, s.tokens.rhys, input, output);
  input.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'whoami', arguments: {}}}) + '\n');
  await new Promise(r => setTimeout(r, 50));
  const reg = readRegistry(s.config.tokensFile);
  reg.tokens.find(t => t.principal === 'rhys')!.revoked = true;
  writeRegistry(s.config.tokensFile, reg);
  input.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'list_tasks', arguments: {}}}) + '\n');
  input.write(JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'list_tasks', arguments: {}}}) + '\n');
  await assert.rejects(done, /token_revoked/);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(rows[0].result?.isError, false, 'first call ran while the token was valid');
  assert.equal(rows[1].error?.code, -32001);
  assert.equal(rows.length, 2, 'nothing served after revocation');
});

test('token files and registry: symlinks and loose permissions are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-tok-'));
  const real = join(dir, 'real.token');
  writeFileSync(real, 'atlas_mcp_' + 'A'.repeat(43), {mode: 0o600});
  assert.equal(readTokenFile(real).length, 53);
  symlinkSync(real, join(dir, 'link.token'));
  assert.throws(() => readTokenFile(join(dir, 'link.token')), /owner_only/);
  chmodSync(real, 0o640);
  assert.throws(() => readTokenFile(real), /owner_only/);
  chmodSync(real, 0o600);
  chmodSync(dir, 0o777);
  assert.throws(() => readTokenFile(real), /owner_only/);
  chmodSync(dir, 0o700);
});

test('index: a masking-policy change wipes and rebuilds the cache (no stale unmasked rows)', () => {
  const s = setup();
  const file = join(s.config.stateDir, 'calls-index.sqlite');
  s.index.db.prepare("update meta set value = 'old-policy' where key = 'policy'").run();
  s.index.db.close();
  const reopened = new CallIndex(file, s.brain);
  assert.equal(reopened.rebuilt, true);
  assert.equal(reopened.count(), 0);
  assert.equal(reopened.refresh().changed, 3);
  assert.equal(String(reopened.db.prepare("select value from meta where key = 'policy'").get()?.value), INDEX_POLICY);
});

test('ask_call is not advertised as idempotent (a repeat can spend again)', () => {
  assert.equal(TOOL_DEFS.find(t => t.name === 'ask_call')!.annotations.idempotentHint, false);
  assert.ok(TOOL_DEFS.filter(t => t.name !== 'ask_call').every(t => t.annotations.idempotentHint === true));
});

test('BUDGET fixture is unchanged policy (US$20, 200/month, 30/day, 2/10 micros)', () => {
  assert.deepEqual([BUDGET.monthlyMicros, BUDGET.monthlyCalls, BUDGET.dailyCalls, BUDGET.inputMicrosPerToken, BUDGET.outputMicrosPerToken], [20_000_000, 200, 30, 2, 10]);
});
