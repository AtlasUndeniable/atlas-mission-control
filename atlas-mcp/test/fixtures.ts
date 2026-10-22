/**
 * Synthetic calls, clients and hosted service for the Atlas MCP tests. No real data, no
 * network, no real key. Card values are the public Visa test number and invented values.
 */
import {mkdtempSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseConfig, parseBudget, type McpConfig, type Budget} from '../src/config.ts';
import type {Hosted, Queue, Capability, Context} from '../src/hosted.ts';
import {assemble} from '../src/server.ts';
import {digest, newToken, writeRegistry} from '../src/auth.ts';
import {SensitivityPolicy, REQUIRED_TOPICS} from '../src/sensitivity.ts';

export const A = '01AAAAAAAAAAAAAAAAAAAAAAAA'; // Acme (granted to nat)
export const B = '01BBBBBBBBBBBBBBBBBBBBBBBB'; // Zenith (NOT granted to nat)
export const HOSTED_ONLY = '01CCCCCCCCCCCCCCCCCCCCCCCC'; // in hosted catalog for rhys only, no brain note
export const TEST_PAN = '4111 1111 1111 1111';
export const TEST_PAN_DIGITS = '4111111111111111';

const note = (id: string, title: string, date: string, attendees: string[], overview: string, turns: [string, string][]) => `---
fireflies_id: ${JSON.stringify(id)}
title: ${JSON.stringify(title)}
date: ${date}
duration_min: 30
organizer_email: "rhys@example.test"
attendees: ${JSON.stringify(attendees)}
transcript_url: "https://app.fireflies.ai/view/${id}"
---# ${title}

**Date:** ${date}

## Overview

${overview}

## Transcript

${turns.map(([s, t]) => `**${s}:** ${t}`).join('\n\n')}

---
## Connections
- [[somewhere]]
`;

export const A_TURNS: [string, string][] = [
  ['Rhys Livingstone', 'Good to see you, how has the month been?'],
  ['Jess Acme', 'Busy. I think the pricing at four ninety seven is too low for the group program.'],
  ['Rhys Livingstone', 'Agreed, move the group program price to nine ninety seven from next month.'],
  ['Rhys Livingstone', 'Before we finish, read me the card number for the renewal.'],
  ['Jess Acme', `${TEST_PAN}.`],
  ['Rhys Livingstone', 'And the expiry?'],
  ['Jess Acme', '12/29.'],
  ['Rhys Livingstone', 'And the security code on the back?'],
  ['Jess Acme', '123.'],
  ['Rhys Livingstone', 'Great, all done.'],
];
export const B_TURNS: [string, string][] = [
  ['Rhys Livingstone', 'Tell me about the zebracorn launch.'],
  ['Zed Zenith', 'Our zebracorn pricing is confidential to Zenith; we charge two thousand.'],
];

export function makeBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-mcp-brain-'));
  writeFileSync(join(dir, '2026-10-01-Acme-x-Rhys.md'), note(A, 'Acme Coaching x Rhys', '2026-10-01', ['jess@acme.test', 'rhys@example.test'], '- **Pricing:** group program pricing reviewed.', A_TURNS));
  writeFileSync(join(dir, '2026-10-05-Zenith-x-Rhys.md'), note(B, 'Zenith Fitness x Rhys', '2026-10-05', ['zed@zenith.test', 'rhys@example.test'], '- **Launch:** zebracorn launch plan.', B_TURNS));
  // Older layout: tag-only front matter, no fireflies_id.
  writeFileSync(join(dir, '2025-03-06-Team-Huddle.md'), `---
tags:
  - type/call-transcript
---

# Team Huddle
**Date:** 06/03/2025
**Participants:** rhys@example.test, pat@example.test

---

Internal planning about the pricing page.

## Transcript

**Pat:** The pricing page needs a refresh.

**Rhys Livingstone:** Let us do it next week.
`);
  return dir;
}

const item = (id: string, meetingId: string, client: string, owner: string, quote: string, start: number) => ({
  id: `req-${id}`, title: `Follow up ${client}`, due: '2026-10-30', owner, state: 'approved', deferred: false,
  evidence: {quote, speaker: 'Rhys Livingstone', start, end: start + 5, title: `Follow up ${client}`, kind: 'commitment', provenance: 'meeting'},
  task: {id: `task-${id}`, title: `Follow up ${client}`, client, owner, executor: owner, next_reviewer: 'rhys', work_status: 'todo', due: '2026-10-30', source_quote: quote, kind: 'action', origin: 'meeting', execution_gate: 'none', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', sent_back_reason: null, declined_reason: null},
  meetingId,
});

export type HostedCalls = {method: string; actor: string; arg?: unknown}[];
export function fakeHosted(): Hosted & {calls: HostedCalls} {
  const calls: HostedCalls = [];
  const meetings: Record<string, object> = {
    [A]: {id: A, title: 'Acme Coaching x Rhys', instant: '2026-10-01T01:00:00Z', state: 'ready', items: [item('a', A, 'acme', 'rhys', 'move the group program price to nine ninety seven', 30)]},
    [B]: {id: B, title: 'Zenith Fitness x Rhys', instant: '2026-10-05T01:00:00Z', state: 'ready', items: [item('b', B, 'zenith', 'nat', 'zebracorn pricing is confidential', 12)]},
    [HOSTED_ONLY]: {id: HOSTED_ONLY, title: 'Orbit Strategy x Rhys', instant: '2026-10-19T01:00:00Z', state: 'held', items: []},
  };
  const visible: Record<string, string[]> = {rhys: [A, B, HOSTED_ONLY], nat: [A]};
  const caps: Record<string, Capability> = {rhys: {actor: 'rhys', triage: true, review: true, rhysActor: 'rhys'}, nat: {actor: 'nat', triage: true, review: false, rhysActor: 'rhys'}};
  const passages = (turns: [string, string][]) => turns.map(([speaker, text], i) => ({speaker, text, start: i * 10, end: i * 10 + 9}));
  const ctx: Record<string, Context> = {
    [A]: {source: {id: A, title: 'Acme Coaching x Rhys', instant: '2026-10-01T01:00:00Z', passages: passages(A_TURNS)}},
    [B]: {source: {id: B, title: 'Zenith Fitness x Rhys', instant: '2026-10-05T01:00:00Z', passages: passages(B_TURNS)}},
    [HOSTED_ONLY]: {source: {id: HOSTED_ONLY, title: 'Orbit Strategy x Rhys', instant: '2026-10-19T01:00:00Z', passages: passages([['Rhys Livingstone', 'The orbit retainer renews in March at the same rate.']])}},
  };
  const deny = () => { const e = Object.assign(Error('denied'), {status: 403}); throw e; };
  return {
    calls,
    async capability(actor) { calls.push({method: 'capability', actor}); return caps[actor] ?? deny(); },
    async list(actor): Promise<Queue> {
      calls.push({method: 'list', actor});
      if (!caps[actor]) deny();
      return {capability: caps[actor], meetings: (visible[actor] ?? []).map(id => JSON.parse(JSON.stringify(meetings[id])))};
    },
    async context(actor, sourceId) {
      calls.push({method: 'context', actor, arg: sourceId});
      if (!(visible[actor] ?? []).includes(sourceId)) { const {HostedRefusal} = await import('../src/hosted.ts'); throw new HostedRefusal(403, 'Hosted service refused the read.'); }
      return JSON.parse(JSON.stringify(ctx[sourceId]));
    },
    async documentRead(actor, taskId) {
      calls.push({method: 'documentRead', actor, arg: taskId});
      if (actor !== 'rhys') return {status: 403, body: {code: '42501'}};
      if (taskId !== 'task-a') return {status: 200, body: {available: false, reason: 'Task-specific context, executor, output and generation decisions are not recorded.'}};
      return {status: 200, body: {available: true, title: 'Acme pricing follow-up', status: 'generated', currentVersion: 1, owner: 'rhys', reviewer: 'rhys'}};
    },
    async documentArtifact(actor, taskId, version) {
      calls.push({method: 'documentArtifact', actor, arg: [taskId, version]});
      return {status: 200, body: {version, hash: 'f'.repeat(64), content: {title: 'Acme pricing follow-up', facts: [{text: 'Group program moves to 997', quote: 'move the group program price to nine ninety seven'}]}}};
    },
  };
}

export const BUDGET: Budget = parseBudget({monthlyMicros: 20_000_000, monthlyCalls: 200, dailyCalls: 30, inputMicrosPerToken: 2, outputMicrosPerToken: 10, decisionReference: 'test'});

export function makeConfig(brain: string, over: Partial<{askCallsPerHour: number; toolCallsPerMinute: number}> = {}): McpConfig {
  const state = mkdtempSync(join(tmpdir(), 'atlas-mcp-state-'));
  mkdirSync(state, {recursive: true});
  return parseConfig({
    host: '127.0.0.1', port: 47000 + Math.floor(Math.random() * 1000), brainCallsDir: brain, stateDir: state,
    tokensFile: join(state, 'tokens.json'), hostedTransportEnvFile: join(state, 'unused.env'),
    principals: {
      rhys: {hostedActor: 'rhys', scope: 'owner', tools: ['whoami', 'capabilities', 'list_tasks', 'get_task', 'get_draft', 'search_calls', 'ask_call'], label: 'Rhys'},
      nat: {hostedActor: 'nat', scope: 'granted', tools: ['whoami', 'capabilities', 'list_tasks', 'get_task', 'get_draft', 'search_calls', 'ask_call'], label: 'Natalie'},
      grok_as_nat: {hostedActor: 'nat', scope: 'granted', tools: ['whoami', 'capabilities', 'list_tasks', 'get_task', 'get_draft', 'search_calls', 'ask_call'], label: 'Grok acting for Natalie'},
    },
    rateLimits: {toolCallsPerMinute: over.toolCallsPerMinute ?? 300, askCallsPerHour: over.askCallsPerHour ?? 50},
    askCall: {model: 'claude-sonnet-5-5', effort: 'low', maxOutputTokens: 3000, maxPromptCharacters: 300000, timeoutMs: 5000, keyFile: '/nonexistent/test.key', budgetFile: '/nonexistent/budget.json', decisionReference: 'test'},
  });
}

/** A fake Anthropic transport that records request bodies and returns the given answer. */
export function fakeModel(answer: (prompt: string) => object, opts: {fail?: boolean; usage?: {input_tokens: number; output_tokens: number}} = {}) {
  const bodies: string[] = [];
  const transport = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
    if (opts.fail) throw Error('network down');
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
    return new Response(JSON.stringify({content: [{type: 'text', text: JSON.stringify(answer(prompt))}], usage: opts.usage ?? {input_tokens: 1200, output_tokens: 150}, stop_reason: 'end_turn'}), {status: 200, headers: {'content-type': 'application/json'}});
  }) as typeof fetch;
  return {bodies, transport};
}

export const TEST_KEY = async () => 'sk-ant-' + 'x'.repeat(40);

/**
 * The pre-Lane-X test policy: no topics or patterns match (terms that never occur), and nat /
 * grok_as_nat hold a synthetic full-call grant for client "acme", so every Phase A test keeps
 * exercising the behaviour it was written for. The REAL shipped policy is exercised by
 * sensitivity.test.ts and exposure.test.ts. Built without the strict loader on purpose.
 */
export function permissivePolicy(grants: string[] = ['acme']): SensitivityPolicy {
  const never = 'zzqqxxnevermatches';
  return new SensitivityPolicy({
    version: 'test-permissive', decisionReference: 'synthetic test policy', reviewState: 'synthetic test policy',
    topics: REQUIRED_TOPICS.map(id => ({id, terms: [never]})), patterns: [], classifications: ['client_financial', 'internal'],
    excluded: {clientLabels: [], taskIds: [], callIds: [], brainPathFragments: []},
    principals: Object.fromEntries(['nat', 'grok_as_nat'].map(p => [p, {posture: 'task_fields_only' as const, fullCallClients: grants.map(client => ({client, decisionReference: 'synthetic test grant'}))}])),
  });
}

export function setup(over: Parameters<typeof makeConfig>[1] = {}, budget: Budget = BUDGET, model = fakeModel(() => ({supported: false, answer: '', quotes: []})), sensitivity: SensitivityPolicy | null = permissivePolicy()) {
  const brain = makeBrain();
  const config = makeConfig(brain, over);
  const hosted = fakeHosted();
  const tokens: Record<string, string> = {};
  const reg = {tokens: Object.keys(config.principals).map(p => { tokens[p] = newToken(); return {principal: p, sha256: digest(tokens[p]), created: 'test', label: p}; })};
  writeRegistry(config.tokensFile, reg);
  const a = assemble({config, budget, hosted, askKey: TEST_KEY, askTransport: model.transport, sensitivity});
  return {...a, hosted, tokens, model, brain};
}
