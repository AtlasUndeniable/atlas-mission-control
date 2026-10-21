/**
 * ask_call: quote verification, refusal when unsupported, budget refusal before dispatch,
 * unresolved outcomes counted at their bound, rate limits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {A, B, setup, fakeModel, BUDGET} from './fixtures.ts';
import {verifyQuotes, askBody, ASK_SCHEMA} from '../src/ask-call.ts';
import {parseBudget} from '../src/config.ts';

test('request body: claude-sonnet-5-5, effort low, structured output schema', () => {
  const body = JSON.parse(askBody({model: 'claude-sonnet-5-5', effort: 'low', maxOutputTokens: 3000, maxPromptCharacters: 1000, timeoutMs: 1, keyFile: '/k', budgetFile: '/b', decisionReference: 'x'}, 'p'));
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.output_config.effort, 'low');
  assert.deepEqual(body.output_config.format, {type: 'json_schema', schema: ASK_SCHEMA});
  assert.equal(body.max_tokens, 3000);
  assert.equal(body.tools, undefined);
});

test('verifyQuotes keeps exact substrings only and repairs a wrong turn index only when unique', () => {
  const turns = [{speaker: 'A', text: 'the price goes to 997 next month', start: 5}, {speaker: 'B', text: 'ok fine', start: null}];
  const r = verifyQuotes(turns, [
    {turn: 0, text: 'price goes to 997'},
    {turn: 1, text: 'price goes to 997 next'}, // wrong index, unique elsewhere
    {turn: 0, text: 'price goes to 1997'}, // fabricated
    {turn: 0, text: 'short'}, // too short
  ]);
  assert.equal(r.verified.length, 2);
  assert.equal(r.rejected, 2);
  assert.equal(r.verified[0].timestamp, '00:05');
  assert.equal(r.verified[1].turn, 0);
});

test('supported answer with a verified quote is returned with timestamps (hosted transcript)', async () => {
  const model = fakeModel(() => ({supported: true, answer: 'Move the group program to 997.', quotes: [{turn: 2, text: 'move the group program price to nine ninety seven'}, {turn: 1, text: 'invented sentence that is not there'}]}));
  const s = setup({}, undefined, model);
  const r = await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'What did we decide about pricing?'}, 'test');
  assert.equal(r.isError, false);
  const st = r.structured as {supported: boolean; quotes: {timestamp: string; turn: number}[]; rejectedQuotes: number; transcriptSource: string; costUsd: number};
  assert.equal(st.supported, true);
  assert.equal(st.transcriptSource, 'hosted');
  assert.deepEqual(st.quotes.map(q => [q.turn, q.timestamp]), [[2, '00:20']]);
  assert.equal(st.rejectedQuotes, 1);
  assert.equal(st.costUsd, (1200 * 2 + 150 * 10) / 1e6);
  const audit = readFileSync(join(s.config.stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(audit.find(r => r.tool === 'ask_call').costMicros, 1200 * 2 + 150 * 10, 'audit records the cost');
  assert.deepEqual(audit.find(r => r.tool === 'ask_call').resultIds, [A]);
});

test('all quotes fabricated, or supported=false: refused', async () => {
  for (const answer of [{supported: true, answer: 'yes', quotes: [{turn: 0, text: 'this was never said on the call'}]}, {supported: false, answer: 'not covered', quotes: []}]) {
    const s = setup({}, undefined, fakeModel(() => answer));
    const r = await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'Anything about the weather?'}, 'test');
    assert.equal(r.isError, false);
    assert.equal(r.structured.supported, false);
    assert.deepEqual(r.structured.quotes, []);
    assert.ok(!('answer' in r.structured));
  }
});

test('budget: daily cap refuses before dispatch; monthly spend cap refuses before dispatch', async () => {
  const model = fakeModel(() => ({supported: false, answer: '', quotes: []}));
  const s = setup({}, parseBudget({...BUDGET, dailyCalls: 1}), model);
  assert.equal((await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q one?'}, 'test')).isError, false);
  const second = await s.server.callTool('rhys', 'ask_call', {call_id: B, question: 'q two?'}, 'test');
  assert.equal(second.structured.error, 'budget_refused');
  assert.equal(model.bodies.length, 1);

  const m2 = fakeModel(() => ({supported: false, answer: '', quotes: []}));
  const tight = setup({}, parseBudget({...BUDGET, monthlyMicros: 1000}), m2);
  const r = await tight.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q?'}, 'test');
  assert.equal(r.structured.error, 'budget_refused');
  assert.match(String(r.structured.message), /monthly spend cap/);
  assert.equal(m2.bodies.length, 0);
});

test('an unresolved model call counts at its full byte-floor bound and is not retried', async () => {
  const model = fakeModel(() => ({}), {fail: true});
  const s = setup({}, undefined, model);
  const r = await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q?'}, 'test');
  assert.equal(r.structured.supported, false);
  assert.equal(model.bodies.length, 1);
  const bound = Buffer.byteLength(model.bodies[0]) * 2 + 3000 * 10;
  const ledger = readFileSync(join(s.config.stateDir, 'ask-call-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(ledger[0].boundMicros, bound);
  assert.equal(ledger[1].actualMicros, null);
  const who = await s.server.callTool('rhys', 'whoami', {}, 'test');
  assert.equal((who.structured.askCallBudget as {usedThisMonthUsd: number}).usedThisMonthUsd, bound / 1e6);
});

test('per-principal rate limits', async () => {
  const s = setup({toolCallsPerMinute: 3, askCallsPerHour: 1});
  for (let i = 0; i < 3; i++) assert.equal((await s.server.callTool('nat', 'whoami', {}, 'test')).isError, false);
  assert.equal((await s.server.callTool('nat', 'whoami', {}, 'test')).structured.error, 'rate_limited');
  assert.equal((await s.server.callTool('rhys', 'whoami', {}, 'test')).isError, false, 'limits are per principal');
  await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q?'}, 'test');
  assert.equal((await s.server.callTool('rhys', 'ask_call', {call_id: A, question: 'q?'}, 'test')).structured.error, 'rate_limited');
});

test('arguments are validated strictly', async () => {
  const s = setup();
  for (const [tool, args] of [['search_calls', {}], ['search_calls', {query: 'x', extra: 1}], ['search_calls', {query: 'x', from: '2026/10/01'}], ['ask_call', {call_id: '../etc/passwd', question: 'q'}], ['list_tasks', {limit: 1000}]] as const) {
    const r = await s.server.callTool('rhys', tool, args, 'test');
    assert.equal(r.structured.error, 'invalid_arguments', `${tool} ${JSON.stringify(args)}`);
  }
});
