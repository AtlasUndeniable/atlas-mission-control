/**
 * Scope isolation: nat and grok_as_nat never see an ungranted client's call or task through
 * any tool — not in results, search snippets, ask_call, get_task or get_draft.
 * Run: node --test atlas-mcp/test/*.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {A, B, HOSTED_ONLY, setup, fakeModel} from './fixtures.ts';

const leak = (v: unknown) => /zenith|zebracorn|01BBBBBB|task-b|req-b|Orbit|01CCCCCC/i.test(JSON.stringify(v));

for (const who of ['nat', 'grok_as_nat']) {
  test(`${who}: search_calls never returns or quotes an ungranted client's call`, async () => {
    const s = setup();
    for (const query of ['zebracorn', 'pricing', 'zenith', 'Rhys', 'orbit']) {
      const r = await s.server.callTool(who, 'search_calls', {query}, 'test');
      assert.equal(r.isError, false);
      assert.ok(!leak(r.structured), `leak for query ${query}`);
      for (const c of (r.structured.calls as {callId: string}[])) assert.equal(c.callId, A);
    }
    const internal = await s.server.callTool(who, 'search_calls', {query: 'pricing page refresh'}, 'test');
    assert.ok(!JSON.stringify(internal.structured).includes('Team Huddle'), 'internal call must not be visible to a granted principal');
  });

  test(`${who}: client filter cannot widen scope`, async () => {
    const s = setup();
    const r = await s.server.callTool(who, 'search_calls', {query: 'pricing', client: 'zenith'}, 'test');
    assert.equal((r.structured.calls as unknown[]).length, 0);
  });

  test(`${who}: ask_call on an ungranted call is refused before any model dispatch`, async () => {
    const model = fakeModel(() => ({supported: true, answer: 'x', quotes: [{turn: 1, text: 'zebracorn pricing is confidential'}]}));
    const s = setup({}, undefined, model);
    for (const id of [B, HOSTED_ONLY, 'note-0000000000000000']) {
      const r = await s.server.callTool(who, 'ask_call', {call_id: id, question: 'What is the pricing?'}, 'test');
      assert.equal(r.isError, true);
      assert.equal(r.structured.error, 'not_found');
      assert.ok(!leak(r.structured));
    }
    assert.equal(model.bodies.length, 0, 'no model call may be made');
    assert.ok(!s.hosted.calls.some(c => c.method === 'context' && c.arg !== A), 'no hosted transcript read for ungranted calls');
  });

  test(`${who}: tasks, get_task and get_draft are limited to granted clients`, async () => {
    const s = setup();
    const list = await s.server.callTool(who, 'list_tasks', {}, 'test');
    assert.deepEqual((list.structured.tasks as {client: string}[]).map(t => t.client), ['acme']);
    assert.ok(!leak(list.structured));
    for (const id of ['task-b', 'req-b']) {
      const g = await s.server.callTool(who, 'get_task', {id}, 'test');
      assert.equal(g.structured.error, 'not_found');
    }
    const d = await s.server.callTool(who, 'get_draft', {task_id: 'task-b'}, 'test');
    assert.equal(d.structured.error, 'not_found');
    const own = await s.server.callTool(who, 'get_draft', {task_id: 'task-a'}, 'test');
    assert.equal(own.isError, false);
    assert.equal(own.structured.available, false, 'nat has no hosted draft grant: hosted 403 is surfaced as unavailable');
    assert.equal(own.structured.draft, null);
  });
}

test('every tool call is authorised against the hosted service with the caller\'s own hosted actor', async () => {
  const s = setup();
  await s.server.callTool('grok_as_nat', 'search_calls', {query: 'pricing'}, 'test');
  await s.server.callTool('rhys', 'whoami', {}, 'test');
  const actors = s.hosted.calls.map(c => `${c.method}:${c.actor}`);
  assert.deepEqual(actors, ['capability:nat', 'list:nat', 'capability:rhys']);
});

test('rhys (owner) sees all calls including internal and hosted-only', async () => {
  const s = setup();
  const r = await s.server.callTool('rhys', 'search_calls', {query: 'pricing'}, 'test');
  const ids = (r.structured.calls as {callId: string}[]).map(c => c.callId);
  assert.ok(ids.includes(A) && ids.includes(B));
  assert.ok(ids.some(id => id.startsWith('note-')), 'internal note without fireflies id is visible to rhys');
  const orbit = await s.server.callTool('rhys', 'search_calls', {query: 'orbit'}, 'test');
  assert.deepEqual((orbit.structured.calls as {callId: string; source: string}[]).map(c => [c.callId, c.source]), [[HOSTED_ONLY, 'hosted']]);
  const tasks = await s.server.callTool('rhys', 'list_tasks', {owner: 'rhys'}, 'test');
  assert.deepEqual((tasks.structured.tasks as {id: string}[]).map(t => t.id), ['task-a']);
  const pending = await s.server.callTool('rhys', 'list_tasks', {status: 'todo', client: 'zen'}, 'test');
  assert.deepEqual((pending.structured.tasks as {id: string}[]).map(t => t.id), ['task-b']);
});

test('owner scope requires hosted confirmation: a misconfigured owner mapped to nat is refused', async () => {
  const s = setup();
  s.config.principals.rhys = {...s.config.principals.rhys, hostedActor: 'nat'};
  const r = await s.server.callTool('rhys', 'search_calls', {query: 'zebracorn'}, 'test');
  assert.equal(r.isError, true);
  assert.equal(r.structured.error, 'forbidden');
});

test('get_task and get_draft return quotes, status, draft and citations for rhys', async () => {
  const s = setup();
  const t = await s.server.callTool('rhys', 'get_task', {id: 'task-a'}, 'test');
  assert.equal(t.isError, false);
  const st = t.structured as {quotes: {timestamp: string}[]; draft: {available: boolean}; sources: {link: string}[]};
  assert.equal(st.quotes[0].timestamp, '00:30');
  assert.equal(st.draft.available, true);
  assert.match(st.sources[0].link, /app\.fireflies\.ai\/view\/01A/);
  const d = await s.server.callTool('rhys', 'get_draft', {task_id: 'task-a'}, 'test');
  assert.equal((d.structured.citations as unknown[]).length, 1);
});
