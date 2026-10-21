/**
 * Atlas MCP Phase A tools. All read-only. Every call:
 *  1. is rate limited per principal;
 *  2. is authorised server-side against the hosted service with that principal's own hosted
 *     credential (meeting_capability, and meeting_queue('list') for the grant set) — the
 *     same principal pattern the board uses, no new superuser path;
 *  3. masks every transcript-derived string;
 *  4. writes one audit row with no transcript text.
 * Principals with scope 'granted' (nat, grok_as_nat) only ever see calls and tasks that the
 * hosted service returns for their hosted actor. Unknown and out-of-scope ids get the same
 * "not found" answer so existence does not leak.
 */
import {readFileSync} from 'node:fs';
import type {Budget, McpConfig, PrincipalConfig, ToolName} from './config.ts';
import {TOOL_NAMES} from './config.ts';
import type {Capability, Hosted, HostedMeeting, HostedTask, Queue} from './hosted.ts';
import {HostedRefusal} from './hosted.ts';
import type {CallIndex, CallHit} from './call-index.ts';
import {queryTerms} from './call-index.ts';
import {argsHash, type AuditLog, type BudgetLedger} from './ledger.ts';
import type {RateLimiter} from './auth.ts';
import {maskJson, maskText, maskTurns, type MaskCounter} from './mask.ts';
import {parseNote, type Turn} from './notes.ts';
import {runAsk} from './ask-call.ts';

export const SERVER_INFO = {name: 'atlas-mcp', title: 'Atlas (Rhys AI) — Phase A, read-only', version: '0.1.0'};

export class ToolRefusal extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type Prop = {type: 'string' | 'integer'; description: string; maxLength?: number; minimum?: number; maximum?: number; pattern?: string; enum?: string[]};
type ToolDef = {name: ToolName; title: string; description: string; inputSchema: {type: 'object'; properties: Record<string, Prop>; required: string[]; additionalProperties: false}; annotations: {readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: boolean}};

const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const ID = '^[A-Za-z0-9_-]{1,80}$';
const def = (name: ToolName, title: string, description: string, properties: Record<string, Prop> = {}, required: string[] = [], openWorld = false): ToolDef =>
  ({name, title, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld}});

export const TOOL_DEFS: ToolDef[] = [
  def('whoami', 'Who am I', 'Who this connection is (principal and hosted actor), what it may see, and the remaining ask_call budget.'),
  def('capabilities', 'Capabilities', 'What this Atlas server can do in Phase A: the tool list, limits and safety rules. Read-only; nothing is created, assigned, approved or sent.'),
  def('list_tasks', 'List tasks', 'Tasks and task suggestions from Rhys\'s calls that this caller may see, with owner, client, status and source call. Use for "what\'s waiting on me?" (owner = rhys) or "what is pending approval?" (status = pending_approval).', {
    owner: {type: 'string', description: 'Filter by owner actor, e.g. rhys or nat.', maxLength: 40},
    status: {type: 'string', description: 'Filter by request state (pending_approval, approved, deferred, dismissed, completed) or work status (todo, in_progress, review, done).', maxLength: 40},
    client: {type: 'string', description: 'Filter by client (case-insensitive substring).', maxLength: 80},
    limit: {type: 'integer', description: 'Maximum tasks to return (default 25).', minimum: 1, maximum: 100},
  }),
  def('get_task', 'Get task', 'One task: the request, its supporting quotes from the call, status, draft status and source call.', {
    id: {type: 'string', description: 'Task id or request id from list_tasks.', pattern: ID},
  }, ['id']),
  def('get_draft', 'Get draft', 'The latest reviewed or generated draft for a task, with its citations, if one exists and this caller may read it.', {
    task_id: {type: 'string', description: 'Task id from list_tasks.', pattern: ID},
  }, ['task_id']),
  def('search_calls', 'Search calls', 'Find past calls by words in their title, attendees, analysis or transcript. Returns date, title, client, a short summary, matching quotes and the Fireflies link. Use before ask_call to get a call_id.', {
    query: {type: 'string', description: 'Words to look for, e.g. "Jess pricing".', maxLength: 200},
    client: {type: 'string', description: 'Only calls for this client (matched on title, attendees or the task client).', maxLength: 80},
    from: {type: 'string', description: 'Earliest call date, YYYY-MM-DD.', pattern: DATE},
    to: {type: 'string', description: 'Latest call date, YYYY-MM-DD.', pattern: DATE},
    limit: {type: 'integer', description: 'Maximum calls (default 8).', minimum: 1, maximum: 25},
  }, ['query']),
  def('ask_call', 'Ask a call', 'Answer a question from ONE call\'s transcript, with exact supporting quotes (verified) and timestamps where recorded. Refuses when the call does not support an answer. Costs a small, budget-capped model call.', {
    call_id: {type: 'string', description: 'call_id from search_calls.', pattern: ID},
    question: {type: 'string', description: 'The question, e.g. "What did Jess say about pricing?".', maxLength: 1000},
  }, ['call_id', 'question'], true),
];

function validate(def: ToolDef, args: unknown): Record<string, string | number> {
  const a = args ?? {};
  if (typeof a !== 'object' || Array.isArray(a)) throw new ToolRefusal('invalid_arguments', 'Arguments must be an object.');
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
    const p = def.inputSchema.properties[k];
    if (!p) throw new ToolRefusal('invalid_arguments', `Unknown argument: ${k.slice(0, 40)}.`);
    if (v === undefined || v === null) continue;
    if (p.type === 'string') {
      if (typeof v !== 'string' || !v.trim() || (p.maxLength && v.length > p.maxLength) || v.includes('\0')) throw new ToolRefusal('invalid_arguments', `Invalid ${k}.`);
      if (p.pattern && !new RegExp(p.pattern).test(v)) throw new ToolRefusal('invalid_arguments', `Invalid ${k}.`);
      out[k] = v.trim();
    } else {
      if (!Number.isInteger(v) || (p.minimum !== undefined && (v as number) < p.minimum) || (p.maximum !== undefined && (v as number) > p.maximum)) throw new ToolRefusal('invalid_arguments', `Invalid ${k}.`);
      out[k] = v as number;
    }
  }
  for (const r of def.inputSchema.required) if (!(r in out)) throw new ToolRefusal('invalid_arguments', `Missing ${r}.`);
  return out;
}

export type Deps = {
  config: McpConfig; budget: Budget; hosted: Hosted; index: CallIndex; audit: AuditLog; ledger: BudgetLedger; limiter: RateLimiter;
  askKey?: (signal: AbortSignal) => Promise<string>; askTransport?: typeof fetch;
};
type Ctx = {principal: string; p: PrincipalConfig; cap: Capability; counter: MaskCounter; ids: string[]; costMicros: number};

const firefliesLink = (id: string) => (/^[A-Za-z0-9_-]{6,64}$/.test(id) ? `https://app.fireflies.ai/view/${id}` : null);
const usd = (micros: number) => Math.round(micros) / 1e6;
const ts = (s: unknown) => (typeof s === 'number' && Number.isFinite(s) ? `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}` : null);

function taskViews(queue: Queue, counter: MaskCounter) {
  const out = [];
  for (const m of queue.meetings) for (const it of m.items ?? []) {
    const t = it.task;
    out.push({
      id: (t?.id as string) ?? it.id, taskId: (t?.id as string) ?? null, requestId: it.id,
      title: maskText(String(t?.title ?? it.title ?? ''), counter),
      owner: (t?.owner as string) ?? it.owner ?? null, executor: t?.executor ?? null, reviewer: t?.next_reviewer ?? null,
      client: (t?.client as string) ?? null,
      requestState: it.state, workStatus: (t?.work_status as string) ?? null, due: (t?.due as string) ?? it.due ?? null, deferred: !!it.deferred,
      source: {callId: m.id, title: maskText(m.title ?? '', counter), instant: m.instant, link: firefliesLink(m.id)},
      _item: it, _meeting: m,
    });
  }
  return out;
}
const publicTask = <T extends {_item: unknown; _meeting: unknown}>(t: T) => { const {_item, _meeting, ...rest} = t; void _item; void _meeting; return rest; };

export class AtlasMcp {
  deps: Deps;
  constructor(deps: Deps) { this.deps = deps; }

  toolsFor(principal: string) {
    const p = this.deps.config.principals[principal];
    return p ? TOOL_DEFS.filter(d => p.tools.includes(d.name)) : [];
  }

  async callTool(principal: string, name: string, rawArgs: unknown, transport: 'http' | 'stdio' | 'test') {
    const started = Date.now();
    const ctxBase = {principal, counter: {spans: 0}, ids: [] as string[], costMicros: 0};
    let ctx: Ctx | undefined;
    let outcome: 'ok' | 'refused' | 'error' = 'ok', reason: string | undefined;
    let result: Record<string, unknown>;
    try {
      const p = this.deps.config.principals[principal];
      if (!p) throw new ToolRefusal('unauthorized', 'Unknown principal.');
      const d = TOOL_DEFS.find(t => t.name === name);
      if (!d || !(TOOL_NAMES as readonly string[]).includes(name)) throw new ToolRefusal('unknown_tool', 'Unknown tool. Phase A tools are read-only.');
      if (!p.tools.includes(d.name)) throw new ToolRefusal('forbidden', 'This tool is not enabled for this caller.');
      if (!this.deps.limiter.take(`tool:${principal}`, this.deps.config.rateLimits.toolCallsPerMinute, 60_000)) throw new ToolRefusal('rate_limited', 'Too many requests; try again in a minute.');
      const args = validate(d, rawArgs);
      // Server-side hosted authorisation on every call, with this principal's own credential.
      const cap = await this.deps.hosted.capability(p.hostedActor);
      if (p.scope === 'owner' && !(cap.review && cap.rhysActor === cap.actor)) throw new ToolRefusal('forbidden', 'Owner scope is not confirmed by the hosted service for this caller.');
      ctx = {...ctxBase, p, cap};
      result = await this.run(ctx, d.name, args);
    } catch (e) {
      if (e instanceof ToolRefusal) { outcome = 'refused'; reason = e.code; result = {error: e.code, message: e.message}; }
      else if (e instanceof HostedRefusal) { outcome = 'refused'; reason = `hosted_${e.status}`; result = {error: 'hosted_refused', message: e.message}; }
      else { outcome = 'error'; reason = 'internal'; result = {error: 'internal', message: 'The request could not be completed; no diagnostic text was returned.'}; }
    }
    this.deps.audit.write({
      at: new Date().toISOString(), principal, transport, tool: String(name).slice(0, 40), argsSha256: argsHash(rawArgs ?? {}),
      outcome, ...(reason ? {reason} : {}), resultIds: ctxBase.ids.slice(0, 50), costMicros: ctx?.costMicros ?? 0, maskSpans: ctxBase.counter.spans, ms: Date.now() - started,
    });
    return {isError: outcome !== 'ok', structured: result};
  }

  private async allowedCalls(ctx: Ctx): Promise<{queue: Queue; allowed: 'all' | Set<string>}> {
    const queue = await this.deps.hosted.list(ctx.p.hostedActor);
    return {queue, allowed: ctx.p.scope === 'owner' ? 'all' : new Set(queue.meetings.map(m => m.id))};
  }

  private async run(ctx: Ctx, name: ToolName, args: Record<string, string | number>): Promise<Record<string, unknown>> {
    const {config, budget, ledger, index} = this.deps;
    switch (name) {
      case 'whoami': {
        const s = ledger.state();
        return {
          principal: ctx.principal, label: ctx.p.label, hostedActor: ctx.cap.actor, scope: ctx.p.scope,
          sees: ctx.p.scope === 'owner' ? 'All of Rhys\'s calls, clients and internal tasks.' : 'Only calls and tasks for clients granted to this hosted actor.',
          tools: ctx.p.tools, readOnly: true,
          askCallBudget: {usedThisMonthUsd: usd(s.monthMicros), monthlyCapUsd: usd(budget.monthlyMicros), callsThisMonth: s.monthCalls, monthlyCalls: budget.monthlyCalls, callsToday: s.dayCalls, dailyCalls: budget.dailyCalls},
        };
      }
      case 'capabilities':
        return {
          server: SERVER_INFO, phase: 'A', readOnly: true, exposure: 'Bound to 127.0.0.1 only; not reachable from other machines.',
          tools: this.toolsFor(ctx.principal).map(t => ({name: t.name, description: t.description})),
          notAvailable: ['create_task', 'assign_client', 'request_draft', 'approve', 'send_back', 'hand_off', 'deliver'],
          safety: ['Card read-outs are masked before indexing, returning or model use.', 'Scoped callers see only hosted-granted clients.', 'Every call is audited without transcript text.', 'ask_call quotes are verified as exact transcript substrings.'],
          limits: {toolCallsPerMinute: config.rateLimits.toolCallsPerMinute, askCallsPerHour: config.rateLimits.askCallsPerHour, askCallMonthlyUsd: usd(budget.monthlyMicros), askCallMonthlyCalls: budget.monthlyCalls, askCallDailyCalls: budget.dailyCalls},
          indexedCalls: index.count(),
        };
      case 'list_tasks': {
        const queue = await this.deps.hosted.list(ctx.p.hostedActor);
        let tasks = taskViews(queue, ctx.counter);
        if (args.owner) tasks = tasks.filter(t => (t.owner ?? '').toLowerCase() === String(args.owner).toLowerCase());
        if (args.status) tasks = tasks.filter(t => [t.requestState, t.workStatus].includes(String(args.status).toLowerCase()));
        if (args.client) tasks = tasks.filter(t => (t.client ?? '').toLowerCase().includes(String(args.client).toLowerCase()));
        const limited = tasks.slice(0, Number(args.limit ?? 25)).map(publicTask);
        ctx.ids.push(...limited.map(t => t.id));
        return {count: limited.length, totalMatching: tasks.length, tasks: limited};
      }
      case 'get_task': {
        const queue = await this.deps.hosted.list(ctx.p.hostedActor);
        const t = taskViews(queue, ctx.counter).find(x => x.taskId === args.id || x.requestId === args.id);
        if (!t) throw new ToolRefusal('not_found', 'No task with that id is visible to this caller.');
        ctx.ids.push(t.id);
        const ev = t._item.evidence ?? {};
        const task = (t._item.task ?? {}) as HostedTask;
        const draft = t.taskId ? await this.draftStatus(ctx, t.taskId) : {available: false, reason: 'This suggestion has not been accepted as a task yet.'};
        return {
          task: {...publicTask(t), kind: task.kind ?? null, origin: task.origin ?? null, executionGate: task.execution_gate ?? null, createdAt: task.created_at ?? null, updatedAt: task.updated_at ?? null,
            sentBackReason: task.sent_back_reason ? maskText(String(task.sent_back_reason), ctx.counter) : null, declinedReason: task.declined_reason ? maskText(String(task.declined_reason), ctx.counter) : null},
          request: {id: t.requestId, title: maskText(t._item.title ?? '', ctx.counter), state: t.requestState, due: t._item.due ?? null, owner: t._item.owner ?? null},
          quotes: [ev.quote, task.source_quote].filter((q, i, a): q is string => typeof q === 'string' && !!q && a.indexOf(q) === i)
            .map((q, i) => ({text: maskText(q, ctx.counter), speaker: i === 0 && ev.speaker ? maskText(ev.speaker, ctx.counter) : null, timestamp: i === 0 ? ts(ev.start) : null})),
          status: {request: t.requestState, work: t.workStatus, deferred: t.deferred},
          draft,
          sources: [t.source],
        };
      }
      case 'get_draft': {
        const queue = await this.deps.hosted.list(ctx.p.hostedActor);
        const t = taskViews(queue, ctx.counter).find(x => x.taskId === args.task_id);
        if (!t || !t.taskId) throw new ToolRefusal('not_found', 'No task with that id is visible to this caller.');
        ctx.ids.push(t.taskId);
        const status = await this.draftStatus(ctx, t.taskId);
        if (!status.available || !status.currentVersion) return {taskId: t.taskId, ...status, draft: null};
        const art = await this.deps.hosted.documentArtifact(ctx.p.hostedActor, t.taskId, status.currentVersion);
        if (art.status !== 200 || !art.body) return {taskId: t.taskId, ...status, draft: null, reason: 'The current draft version could not be read (authority changed or not permitted).'};
        const content = maskJson(art.body.content ?? null, ctx.counter) as Record<string, unknown> | null;
        const facts = content && Array.isArray(content.facts) ? content.facts : [];
        return {taskId: t.taskId, ...status, draft: {version: art.body.version, contentSha256: art.body.hash, content}, citations: facts};
      }
      case 'search_calls': {
        const {queue, allowed} = await this.allowedCalls(ctx);
        const limit = Number(args.limit ?? 8);
        const clientOf = new Map<string, string>();
        for (const m of queue.meetings) for (const it of m.items ?? []) if (it.task?.client) clientOf.set(m.id, String(it.task.client));
        const clientCallIds = args.client ? new Set([...clientOf].filter(([, c]) => c.toLowerCase().includes(String(args.client).toLowerCase())).map(([id]) => id)) : undefined;
        const hits: (CallHit & {client: string | null; source: string})[] = index.search({
          query: String(args.query), from: args.from as string | undefined, to: args.to as string | undefined, limit, client: args.client as string | undefined, clientCallIds, allowed,
        }).map(h => ({...h, client: clientOf.get(h.callId) ?? null, source: 'brain'}));
        // Hosted catalog calls this caller may see that are not (yet) in the brain: title match only.
        const terms = queryTerms(String(args.query));
        for (const m of queue.meetings) {
          if (hits.length >= limit || hits.some(h => h.callId === m.id) || index.fileFor(m.id)) continue;
          const date = (m.instant ?? '').slice(0, 10);
          if ((args.from && date < String(args.from)) || (args.to && date > String(args.to))) continue;
          if (clientCallIds && !clientCallIds.has(m.id)) continue;
          const title = maskText(m.title ?? '', ctx.counter);
          if (!terms.some(t => title.toLowerCase().includes(t))) continue;
          hits.push({callId: m.id, title, date, attendees: [], link: firefliesLink(m.id), summary: '', turns: 0, quotes: [], client: clientOf.get(m.id) ?? null, source: 'hosted'});
        }
        ctx.ids.push(...hits.map(h => h.callId));
        return {count: hits.length, calls: hits.map(h => ({callId: h.callId, date: h.date, title: h.title, client: h.client, attendees: h.attendees, summary: h.summary, quotes: h.quotes, link: h.link, source: h.source}))};
      }
      case 'ask_call': {
        if (!this.deps.limiter.take(`ask:${ctx.principal}`, config.rateLimits.askCallsPerHour, 3_600_000)) throw new ToolRefusal('rate_limited', 'ask_call hourly limit reached for this caller.');
        const {queue, allowed} = await this.allowedCalls(ctx);
        const id = String(args.call_id);
        if (allowed !== 'all' && !allowed.has(id)) throw new ToolRefusal('not_found', 'No call with that id is visible to this caller.');
        const source = await this.callSource(ctx, queue, id);
        if (!source) throw new ToolRefusal('not_found', 'No call with that id is visible to this caller.');
        ctx.ids.push(id);
        const r = await runAsk({cfg: config.askCall, budget, ledger, principal: ctx.principal, meta: source.meta, turns: source.turns, question: String(args.question), key: this.deps.askKey, transport: this.deps.askTransport, counter: ctx.counter});
        ctx.costMicros = r.costMicros;
        const base = {callId: id, title: source.meta.title, date: source.meta.date, link: firefliesLink(id), transcriptSource: source.kind, costUsd: usd(r.costMicros), latencyMs: r.latencyMs};
        if (!r.ok) {
          if (!r.dispatched && r.reason.startsWith('Budget')) throw new ToolRefusal('budget_refused', r.reason);
          return {...base, supported: false, reason: r.reason, quotes: []};
        }
        return {...base, supported: true, answer: r.answer, quotes: r.quotes, rejectedQuotes: r.rejectedQuotes};
      }
    }
  }

  private async callSource(ctx: Ctx, queue: Queue, id: string): Promise<{kind: 'hosted' | 'brain'; meta: {title: string; date: string | null}; turns: Turn[]} | null> {
    const hostedMeeting: HostedMeeting | undefined = queue.meetings.find(m => m.id === id);
    if (hostedMeeting) {
      // Hosted transcript (has timestamps), read with this caller's own hosted credential.
      const c = await this.deps.hosted.context(ctx.p.hostedActor, id);
      const passages = Array.isArray(c?.source?.passages) ? c.source.passages : [];
      const texts = maskTurns(passages.map(p => String(p.text ?? '')), ctx.counter);
      const speakers = maskTurns(passages.map(p => String(p.speaker ?? '')), ctx.counter);
      const turns = passages.map((p, i) => ({speaker: speakers[i], text: texts[i], start: typeof p.start === 'number' ? p.start : null}));
      if (turns.length) return {kind: 'hosted', meta: {title: maskText(hostedMeeting.title ?? '', ctx.counter), date: (hostedMeeting.instant ?? '').slice(0, 10) || null}, turns};
    }
    const file = this.deps.index.fileFor(id);
    if (!file) return null;
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch { return null; }
    const note = parseNote(file, raw, ctx.counter);
    if (note.callId !== id) return null;
    return {kind: 'brain', meta: {title: note.title, date: note.date}, turns: note.turns};
  }

  private async draftStatus(ctx: Ctx, taskId: string): Promise<{available: boolean; reason?: string; status?: string; currentVersion?: number; title?: string; owner?: string; reviewer?: string}> {
    const r = await this.deps.hosted.documentRead(ctx.p.hostedActor, taskId);
    if (r.status === 401 || r.status === 403) return {available: false, reason: 'Draft access is not provisioned for this caller yet (the hosted service refused the read).'};
    if (r.status !== 200 || !r.body) return {available: false, reason: 'Draft status could not be read.'};
    if (r.body.available !== true) return {available: false, reason: typeof r.body.reason === 'string' ? r.body.reason : 'No draft is set up for this task.'};
    return {available: true, status: String(r.body.status ?? ''), currentVersion: Number.isInteger(r.body.currentVersion) ? r.body.currentVersion as number : undefined,
      title: maskText(String(r.body.title ?? ''), ctx.counter), owner: r.body.owner as string, reviewer: r.body.reviewer as string};
  }
}
