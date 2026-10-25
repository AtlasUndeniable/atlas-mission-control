/**
 * Lane X: the "never share with Nat/Grok" sensitivity policy (DECISIONS 19(a)(b)) through
 * EVERY tool, for nat and grok_as_nat, using the SHIPPED policy file (config/sensitivity.json).
 * Withheld items must be indistinguishable from items that do not exist; Rhys is unaffected;
 * without a full-call grant scoped callers get task fields only (no quotes, search, drafts or
 * ask_call). Synthetic data only; no listener, no real provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setup, fakeModel, A} from './fixtures.ts';
import {parseSensitivity, SensitivityPolicy, loadSensitivity, normalize, type SensitivitySpec} from '../src/sensitivity.ts';
import type {Queue, HostedMeeting} from '../src/hosted.ts';
import {HostedRefusal} from '../src/hosted.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SHIPPED_FILE = join(here, '../config/sensitivity.json');
const SHIPPED: SensitivitySpec = parseSensitivity(JSON.parse(readFileSync(SHIPPED_FILE, 'utf8')));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Shipped policy plus Rhys-style id exclusions and optional full-call grants. */
function policy(grants: string[] = []): SensitivityPolicy {
  const s = clone(SHIPPED);
  s.excluded.clientLabels = ['Hidden Co'];
  s.excluded.taskIds = ['task-excl'];
  for (const p of ['nat', 'grok_as_nat']) s.principals[p].fullCallClients = grants.map(client => ({client, decisionReference: 'synthetic Rhys full-call grant'}));
  return new SensitivityPolicy(s);
}

const M = '01DDDDDDDDDDDDDDDDDDDDDDDD'; // Bright Studio (granted to nat in hosted)
const H = '01HHHHHHHHHHHHHHHHHHHHHHHH'; // Hidden Co (excluded client)
const ITEMS: [string, string, string, Record<string, unknown>?][] = [
  ['clean', 'Send Bright the onboarding checklist', 'I will send the onboarding checklist tomorrow'],
  ['rev', 'Review Q3 revenue with Bright', 'we should look at the revenue together'],
  ['pay', 'Sort out team payroll for October', 'payroll runs on the 15th'],
  ['money', 'Chase the $4,500 renewal', 'the renewal is four and a half thousand'],
  ['hr', 'Prepare performance review for Sam', 'Sam is underperforming'],
  ['bank', 'Get the BSB from Bright', 'send me your BSB'],
  ['strat', 'Draft the internal strategy memo', 'keep this internal'],
  ['unden', 'Share our revenue numbers with the coach', 'our numbers look good'],
  ['class', 'Prepare the welcome pack', 'welcome pack next week', {classification: 'client_financial'}],
  ['excl', 'Book the follow-up session', 'book a follow-up'],
  ['card', 'Update the renewal details', 'the card is [REDACTED-CARD]'],
];
const SENTINEL = /revenue|payroll|4,500|performance|BSB|strategy|numbers|welcome pack|Hidden|task-excl|follow-up session|REDACTED|price/i;

function item(key: string, title: string, quote: string, client: string, extra: Record<string, unknown> = {}) {
  const id = key === 'excl' ? 'task-excl' : `task-${key}`;
  return {
    id: `req-${key}`, title, due: '2026-11-01', owner: 'nat', state: 'approved', deferred: false,
    evidence: {quote, speaker: 'Rhys Livingstone', start: 42, end: 47, kind: 'commitment', provenance: 'meeting'},
    task: {id, title, client, owner: 'nat', executor: 'nat', next_reviewer: 'rhys', work_status: 'todo', due: '2026-11-01', source_quote: quote, kind: 'action', origin: 'meeting', execution_gate: 'none', created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', sent_back_reason: null, declined_reason: null, ...extra},
  };
}
const NOTE = (id: string, title: string, overview: string, turns: [string, string][]) => `---
fireflies_id: ${JSON.stringify(id)}
title: ${JSON.stringify(title)}
date: 2026-10-20
duration_min: 30
organizer_email: "rhys@example.test"
attendees: ["amy@bright.test", "rhys@example.test"]
transcript_url: "https://app.fireflies.ai/view/${id}"
---# ${title}

## Overview

${overview}

## Transcript

${turns.map(([s, t]) => `**${s}:** ${t}`).join('\n\n')}
`;

/** Adds Bright (granted) and Hidden Co meetings to the fake hosted service for nat AND rhys. */
function world(sensitivity: SensitivityPolicy | null, model = fakeModel(() => ({supported: false, answer: '', quotes: []}))) {
  const s = setup({}, undefined, model, sensitivity);
  const extra: HostedMeeting[] = [
    {id: M, title: 'Bright Studio x Rhys', instant: '2026-10-20T01:00:00Z', state: 'ready', classification: 'client_confidential', items: ITEMS.filter(([k]) => k !== 'excl').map(([k, t, q, x]) => item(k, t, q, 'bright', x))},
    {id: H, title: 'Weekly check-in', instant: '2026-10-21T01:00:00Z', state: 'ready', classification: 'client_confidential', items: [item('excl', 'Book the follow-up session', 'book a follow-up', 'Hidden Co')]},
  ];
  const list = s.hosted.list.bind(s.hosted);
  s.hosted.list = async (actor: string): Promise<Queue> => { const q = await list(actor); q.meetings.push(...clone(extra)); return q; };
  const context = s.hosted.context.bind(s.hosted);
  s.hosted.context = async (actor: string, id: string) => {
    if (id === M || id === H) { s.hosted.calls.push({method: 'context', actor, arg: id}); return {source: {id, title: 'Bright Studio x Rhys', instant: '2026-10-20T01:00:00Z', passages: [
      {speaker: 'Amy Bright', text: 'I will send the onboarding checklist tomorrow.', start: 10, end: 15},
      {speaker: 'Rhys Livingstone', text: 'Great, and the kickoff is on Monday.', start: 16, end: 20}]}}; }
    return context(actor, id);
  };
  // Brain notes: a clean Bright call, plus a granted-client call stored under a finance path.
  writeFileSync(join(s.brain, '2026-10-20-Bright-x-Rhys.md'), NOTE(M, 'Bright Studio x Rhys', '- **Onboarding:** checklist and kickoff timing.', [['Amy Bright', 'I will send the onboarding checklist tomorrow.'], ['Rhys Livingstone', 'Great, kickoff is Monday.']]));
  s.index.refresh();
  return s;
}
const ids = (r: {structured: Record<string, unknown>}) => ((r.structured.tasks ?? []) as {id: string}[]).map(t => t.id).sort();

test('shipped policy parses and covers every required topic and classification', () => {
  assert.equal(SHIPPED.principals.grok_as_nat.posture, 'task_fields_only');
  assert.deepEqual(SHIPPED.principals.grok_as_nat.fullCallClients, [], 'no full-call grants exist today');
  assert.deepEqual(SHIPPED.principals.nat.fullCallClients, []);
  for (const c of ['client_financial', 'internal']) assert.ok(SHIPPED.classifications.includes(c));
  const p = new SensitivityPolicy(SHIPPED);
  for (const t of ['Q3 revenue', 'team payroll', 'salary review', 'the pricing page', '$4,500', '5k deposit', 'performance review', 'BSB please', 'internal strategy', 'our revenue numbers', 'card number', '[REDACTED-CARD]', '12% margin', '062000 123456'])
    assert.ok(p.textHits(t), `must hit: ${t}`);
  for (const t of ['Send the onboarding checklist', 'Book the kickoff for Monday', '2026-10-30', 'Follow up acme', 'task-a', 'Natalie'])
    assert.ok(!p.textHits(t), `must not hit: ${t}`);
  assert.equal(normalize('P&L Review!'), ' p&l review ');
});

test('policy loader is strict and fails closed', () => {
  const bad = (mut: (s: Record<string, unknown>) => void, re: RegExp) => {
    const s = clone(JSON.parse(readFileSync(SHIPPED_FILE, 'utf8')));
    mut(s);
    assert.throws(() => parseSensitivity(s), re);
  };
  bad(s => { (s.topics as {id: string}[]).splice((s.topics as {id: string}[]).findIndex(t => t.id === 'payroll_team_pay'), 1); }, /missing:payroll_team_pay/);
  bad(s => { s.classifications = ['internal']; }, /missing:client_financial/);
  bad(s => { s.patterns = ['(a+)+$']; }, /patterns/);
  bad(s => { (s.topics as {terms: string[]}[])[0].terms.push('(.*)'); }, /terms/);
  bad(s => { (s.principals as Record<string, {posture: string}>).grok_as_nat.posture = 'full'; }, /posture/);
  bad(s => { delete (s.principals as Record<string, unknown>).grok_as_nat; }, /missing:grok_as_nat/);
  bad(s => { s.extra = 1; }, /root:keys/);
  bad(s => { (s.principals as Record<string, {fullCallClients: unknown[]}>).nat.fullCallClients.push({client: 'bright'}); }, /grant/);
  // The file must be owner-only, like the token registry.
  const dir = mkdtempSync(join(tmpdir(), 'atlas-sens-'));
  const f = join(dir, 'sensitivity.json');
  writeFileSync(f, readFileSync(SHIPPED_FILE));
  chmodSync(f, 0o644);
  assert.throws(() => loadSensitivity(f), /unreadable/);
  chmodSync(f, 0o600);
  assert.equal(loadSensitivity(f).spec.version, SHIPPED.version);
});

for (const who of ['nat', 'grok_as_nat']) {
  test(`${who}: list_tasks withholds every denylisted task; only clean task-level fields remain`, async () => {
    const s = world(policy());
    const r = await s.server.callTool(who, 'list_tasks', {limit: 100}, 'test');
    assert.equal(r.isError, false);
    assert.deepEqual(ids(r), ['task-clean'], 'acme (pricing quote) and all sensitive Bright tasks withheld');
    assert.equal(r.structured.totalMatching, 1, 'withheld items are not counted');
    assert.ok(!SENTINEL.test(JSON.stringify(r.structured)));
    assert.ok(typeof r.structured.sharingPolicy === 'string');
    for (const f of [{client: 'Hidden'}, {status: 'todo'}, {owner: 'nat'}]) assert.ok(!SENTINEL.test(JSON.stringify((await s.server.callTool(who, 'list_tasks', f, 'test')).structured)));
  });

  test(`${who}: get_task on a withheld task is identical to an unknown id`, async () => {
    const s = world(policy());
    const unknown = await s.server.callTool(who, 'get_task', {id: 'task-does-not-exist'}, 'test');
    for (const [k] of ITEMS) {
      if (k === 'clean') continue;
      for (const id of [k === 'excl' ? 'task-excl' : `task-${k}`, `req-${k}`]) {
        const r = await s.server.callTool(who, 'get_task', {id}, 'test');
        assert.deepEqual(r, unknown, `${id} must look like it does not exist`);
      }
    }
    assert.deepEqual(await s.server.callTool(who, 'get_task', {id: 'task-a'}, 'test'), unknown, 'acme pricing task withheld');
  });

  test(`${who}: posture task_fields_only, no grant: no quotes, no draft read, no search, no ask_call`, async () => {
    const model = fakeModel(() => ({supported: true, answer: 'The checklist is coming tomorrow.', quotes: [{turn: 0, text: 'I will send the onboarding checklist tomorrow.'}]}));
    const s = world(policy(), model);
    const g = await s.server.callTool(who, 'get_task', {id: 'task-clean'}, 'test');
    assert.equal(g.isError, false);
    assert.deepEqual(g.structured.quotes, []);
    assert.equal((g.structured.draft as {available: boolean}).available, false);
    assert.ok(!JSON.stringify(g.structured).includes('tomorrow'), 'no transcript snippet');
    assert.ok(!s.hosted.calls.some(c => c.method === 'documentRead'), 'no draft read without a grant');
    const unknownDraft = await s.server.callTool(who, 'get_draft', {task_id: 'task-nope'}, 'test');
    assert.deepEqual(await s.server.callTool(who, 'get_draft', {task_id: 'task-clean'}, 'test'), unknownDraft);
    const nothing = await s.server.callTool(who, 'search_calls', {query: 'zzzz'}, 'test');
    for (const query of ['onboarding', 'checklist', 'Bright', 'pricing']) assert.deepEqual((await s.server.callTool(who, 'search_calls', {query}, 'test')).structured, nothing.structured);
    const unknownAsk = await s.server.callTool(who, 'ask_call', {call_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', question: 'What was agreed?'}, 'test');
    for (const call_id of [M, A]) assert.deepEqual(await s.server.callTool(who, 'ask_call', {call_id, question: 'What was agreed?'}, 'test'), unknownAsk);
    assert.equal(model.bodies.length, 0, 'no model dispatch');
    assert.ok(!s.hosted.calls.some(c => c.method === 'context'), 'no hosted transcript read');
  });

  test(`${who}: a full-call grant never releases quotes, drafts, search or ask for a call carrying any withheld task (R16 #3)`, async () => {
    const model = fakeModel(() => ({supported: true, answer: 'The checklist is coming tomorrow.', quotes: [{turn: 0, text: 'I will send the onboarding checklist tomorrow.'}]}));
    const s = world(policy(['bright']), model);
    const g = await s.server.callTool(who, 'get_task', {id: 'task-clean'}, 'test');
    assert.deepEqual(g.structured.quotes, [], 'withheld sibling closes quotes too');
    assert.equal((g.structured.draft as {available: boolean}).available, false);
    const unknownDraft = await s.server.callTool(who, 'get_draft', {task_id: 'task-nope'}, 'test');
    assert.deepEqual(await s.server.callTool(who, 'get_draft', {task_id: 'task-clean'}, 'test'), unknownDraft);
    assert.ok(!s.hosted.calls.some(c => c.method === 'documentRead'), 'no draft read');
    assert.deepEqual(ids(await s.server.callTool(who, 'list_tasks', {limit: 100}, 'test')), ['task-clean'], 'a grant never releases denylisted tasks');
    // The Bright call carries withheld tasks, so its transcript is not searchable or askable.
    const nothing = await s.server.callTool(who, 'search_calls', {query: 'zzzz'}, 'test');
    assert.deepEqual((await s.server.callTool(who, 'search_calls', {query: 'checklist'}, 'test')).structured, nothing.structured);
    const unknown = await s.server.callTool(who, 'ask_call', {call_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', question: 'What was agreed?'}, 'test');
    assert.deepEqual(await s.server.callTool(who, 'ask_call', {call_id: M, question: 'What was agreed?'}, 'test'), unknown);
    assert.equal(model.bodies.length, 0);
  });
}

test('a granted call with any withheld task is excluded from transcript tools; a clean one is not', async () => {
  // Same world but only the clean task on the Bright meeting.
  const model = fakeModel(() => ({supported: true, answer: 'The checklist is coming tomorrow.', quotes: [{turn: 0, text: 'I will send the onboarding checklist tomorrow.'}]}));
  const s = world(policy(['bright']), model);
  const list = s.hosted.list.bind(s.hosted);
  s.hosted.list = async (actor: string) => { const q = await list(actor); for (const m of q.meetings) if (m.id === M) m.items = m.items.filter(i => i.task?.id === 'task-clean'); return q; };
  for (const who of ['nat', 'grok_as_nat']) {
    const hit = await s.server.callTool(who, 'search_calls', {query: 'checklist'}, 'test');
    assert.deepEqual((hit.structured.calls as {callId: string}[]).map(c => c.callId), [M]);
    const empty = await s.server.callTool(who, 'search_calls', {query: 'zzzz'}, 'test');
    for (const query of ['revenue', 'salary', 'BSB', '$500']) assert.deepEqual((await s.server.callTool(who, 'search_calls', {query}, 'test')).structured, empty.structured, `denylisted query ${query}`);
    assert.deepEqual((await s.server.callTool(who, 'search_calls', {query: 'checklist', client: 'Hidden Co'}, 'test')).structured, empty.structured);
    const ok = await s.server.callTool(who, 'ask_call', {call_id: M, question: 'What was agreed?'}, 'test');
    assert.equal(ok.structured.supported, true);
    const unknown = await s.server.callTool(who, 'ask_call', {call_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', question: 'What was agreed?'}, 'test');
    const before = model.bodies.length;
    assert.deepEqual(await s.server.callTool(who, 'ask_call', {call_id: M, question: 'What did they say about pricing?'}, 'test'), unknown);
    assert.equal(model.bodies.length, before, 'a denylisted question never reaches the model');
  }
});

test('an ask_call answer that touches a denylisted topic is withheld (spend kept, audit says withheld, no text)', async () => {
  const model = fakeModel(() => ({supported: true, answer: 'They agreed to send the checklist and mentioned the salary budget.', quotes: [{turn: 0, text: 'I will send the onboarding checklist tomorrow.'}]}));
  const s = world(policy(['bright']), model);
  const list = s.hosted.list.bind(s.hosted);
  s.hosted.list = async (actor: string) => { const q = await list(actor); for (const m of q.meetings) if (m.id === M) m.items = m.items.filter(i => i.task?.id === 'task-clean'); return q; };
  const unknown = await s.server.callTool('grok_as_nat', 'ask_call', {call_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', question: 'What was agreed?'}, 'test');
  const r = await s.server.callTool('grok_as_nat', 'ask_call', {call_id: M, question: 'What was agreed?'}, 'test');
  assert.deepEqual(r, unknown);
  assert.equal(model.bodies.length, 1);
  const audit = readFileSync(s.server.deps.audit.file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const last = audit.at(-1);
  assert.equal(last.reason, 'withheld');
  assert.ok(last.costMicros > 0, 'the spend is still accounted');
  assert.deepEqual(last.resultIds, []);
  assert.ok(!/salary|checklist|budget/i.test(readFileSync(s.server.deps.audit.file, 'utf8')));
});

test('brain path fragments exclude a granted call from search', async () => {
  const s = world(policy(['bright']));
  const list = s.hosted.list.bind(s.hosted);
  s.hosted.list = async (actor: string) => { const q = await list(actor); for (const m of q.meetings) if (m.id === M) m.items = m.items.filter(i => i.task?.id === 'task-clean'); return q; };
  const { renameSync } = await import('node:fs');
  renameSync(join(s.brain, '2026-10-20-Bright-x-Rhys.md'), join(s.brain, '2026-10-20-Bright-finance-review.md'));
  s.index.refresh();
  const r = await s.server.callTool('nat', 'search_calls', {query: 'checklist'}, 'test');
  assert.equal((r.structured.calls as unknown[]).length, 0);
});

test('Rhys (owner) is unaffected by the policy', async () => {
  const model = fakeModel(() => ({supported: true, answer: 'Revenue was discussed.', quotes: [{turn: 2, text: 'Agreed, move the group program price to nine ninety seven from next month.'}]}));
  const s = world(policy(), model);
  const r = await s.server.callTool('rhys', 'list_tasks', {limit: 100}, 'test');
  assert.ok(ids(r).includes('task-rev') && ids(r).includes('task-pay') && ids(r).includes('task-excl') && ids(r).includes('task-a'));
  assert.equal(r.structured.sharingPolicy, undefined);
  assert.equal((await s.server.callTool('rhys', 'get_task', {id: 'task-pay'}, 'test')).isError, false);
  assert.ok(((await s.server.callTool('rhys', 'search_calls', {query: 'pricing'}, 'test')).structured.calls as unknown[]).length >= 1);
  const ask = await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'What did they say about pricing?'}, 'test');
  assert.equal(ask.structured.supported, true);
});

test('without a valid policy, scoped callers get nothing from any tool; Rhys still works', async () => {
  const s = world(null);
  for (const who of ['nat', 'grok_as_nat']) for (const [tool, args] of [['whoami', {}], ['capabilities', {}], ['list_tasks', {}], ['get_task', {id: 'task-clean'}], ['get_draft', {task_id: 'task-clean'}], ['search_calls', {query: 'checklist'}], ['ask_call', {call_id: M, question: 'x'}]] as const) {
    const r = await s.server.callTool(who, tool, args, 'test');
    assert.equal(r.structured.error, 'not_available', `${who} ${tool}`);
  }
  assert.ok(!s.hosted.calls.some(c => c.actor === 'nat'), 'no hosted read for scoped callers at all');
  assert.equal((await s.server.callTool('rhys', 'list_tasks', {}, 'test')).isError, false);
});

test('whoami and capabilities never reveal the policy contents', async () => {
  const s = world(policy());
  for (const tool of ['whoami', 'capabilities']) {
    const r = await s.server.callTool('grok_as_nat', tool, {}, 'test');
    const text = JSON.stringify(r.structured);
    assert.ok(!/payroll|salar|bsb|revenue|Hidden|task-excl|finance/i.test(text), tool);
    assert.ok(typeof r.structured.sharingPolicy === 'string');
  }
});

test('hosted refusal on context stays final for granted calls (no brain fallback)', async () => {
  const s = world(policy(['bright']));
  s.hosted.context = async () => { throw new HostedRefusal(403, 'denied'); };
  const list = s.hosted.list.bind(s.hosted);
  s.hosted.list = async (actor: string) => { const q = await list(actor); for (const m of q.meetings) if (m.id === M) m.items = m.items.filter(i => i.task?.id === 'task-clean'); return q; };
  const r = await s.server.callTool('nat', 'ask_call', {call_id: M, question: 'What was agreed?'}, 'test');
  assert.equal(r.structured.error, 'not_found');
});
