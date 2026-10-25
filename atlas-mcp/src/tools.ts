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
import type {Capability, Hosted, HostedItem, HostedMeeting, HostedTask, Queue} from './hosted.ts';
import {HostedRefusal} from './hosted.ts';
import type {CallIndex, CallHit} from './call-index.ts';
import {queryTerms} from './call-index.ts';
import {argsHash, type AuditLog, type BudgetLedger} from './ledger.ts';
import type {RateLimiter} from './auth.ts';
import {maskJson, maskText, maskTurns, type MaskCounter} from './mask.ts';
import {parseNote, type Turn} from './notes.ts';
import {runAsk} from './ask-call.ts';
import type {PolicySource, PolicyState, SensitivityPolicy} from './sensitivity.ts';
import type {BrainFiles} from './brain-files.ts';

export const SERVER_INFO = {name: 'atlas-mcp', title: 'Atlas (Rhys AI) — Phase A, read-only', version: '0.1.0'};

export class ToolRefusal extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
/**
 * Sensitivity-policy withholding. The caller sees EXACTLY the same refusal as for an id that
 * does not exist (same code and message); only the local audit row records 'withheld'.
 */
export class Withheld extends ToolRefusal {
  /** For list/search tools: the ordinary empty result, identical to "nothing matched". */
  empty?: Record<string, unknown>;
  constructor(message: string, empty?: Record<string, unknown>) { super('not_found', message); this.empty = empty; }
}
const EMPTY: Partial<Record<ToolName, Record<string, unknown>>> = {
  list_tasks: {count: 0, totalMatching: 0, tasks: []},
  search_calls: {count: 0, calls: []},
};
const NOT_FOUND_TASK = 'No task with that id is visible to this caller.';
const NOT_FOUND_CALL = 'No call with that id is visible to this caller.';
/** A constant note on every scoped response; it never varies with what was withheld. */
export const SHARING_NOTE = 'Rhys\'s sharing policy applies to this caller: some items are not available and are not listed.';

type Prop = {type: 'string' | 'integer'; description: string; maxLength?: number; minimum?: number; maximum?: number; pattern?: string; enum?: string[]};
type ToolDef = {name: ToolName; title: string; description: string; inputSchema: {type: 'object'; properties: Record<string, Prop>; required: string[]; additionalProperties: false}; annotations: {readOnlyHint: true; destructiveHint: false; idempotentHint: boolean; openWorldHint: boolean}};

const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const ID = '^[A-Za-z0-9_-]{1,80}$';
const def = (name: ToolName, title: string, description: string, properties: Record<string, Prop> = {}, required: string[] = [], openWorld = false): ToolDef =>
  ({name, title, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: !openWorld, openWorldHint: openWorld}});

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
  /** The reviewed sensitivity policy, re-read and validated on every scoped call and at release. */
  sensitivity: PolicySource;
  /** Authoritative brain-note metadata for path exclusions and whole-record checks (not the search cache). */
  brain: BrainFiles;
};
/** policy: the sensitivity policy for scoped callers; null for the owner (never affected). */
type Ctx = {principal: string; p: PrincipalConfig; cap: Capability; counter: MaskCounter; ids: string[]; costMicros: number; policy: SensitivityPolicy | null; tools: ToolName[]; signal?: AbortSignal};
/** toolCeiling: transport narrowing (exposure). signal: the end-to-end deadline; aborted work releases nothing. */
export type CallOpts = {toolCeiling?: readonly ToolName[]; signal?: AbortSignal};

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
      client: t?.client ? maskText(String(t.client), counter) : m.clientLabel ? maskText(String(m.clientLabel), counter) : null,
      requestState: it.state, workStatus: (t?.work_status as string) ?? null, due: (t?.due as string) ?? it.due ?? null, deferred: !!it.deferred,
      // access 'task_only': the caller holds reviewed task context only, never the transcript.
      source: {callId: m.id, title: maskText(m.title ?? '', counter), instant: m.instant, link: firefliesLink(m.id), access: m.taskOnly === true ? 'task_only' : 'full'},
      _item: it, _meeting: m,
    });
  }
  return out;
}
const publicTask = <T extends {_item: unknown; _meeting: unknown}>(t: T) => { const {_item, _meeting, ...rest} = t; void _item; void _meeting; return rest; };

type TaskView = ReturnType<typeof taskViews>[number];
/**
 * The ONE authoritative release decision for a request (R16 findings 1-4), computed before any
 * output is selected:
 *  - visible: tasks whose task-level fields may be released;
 *  - full / fullIds: meetings whose transcript-derived output (quotes, drafts, search, ask)
 *    may be released. For a scoped caller that needs ALL of: not task-only; classification
 *    resolved and not denylisted; no excluded id/client/path; no denylisted meeting text; no
 *    withheld task on the same call; a per-client full-call grant; and every brain note and
 *    index record of the call free of denylisted text.
 */
type Decision = {queue: Queue; visible: TaskView[]; full: HostedMeeting[]; fullIds: 'all' | Set<string>};
const CLASSIFICATION = /^[a-z][a-z_]{1,40}$/;

export class AtlasMcp {
  deps: Deps;
  constructor(deps: Deps) { this.deps = deps; }

  /** The tools this principal may use, narrowed by an optional transport ceiling (exposure). */
  effectiveTools(principal: string, ceiling?: readonly ToolName[]): ToolName[] {
    const p = this.deps.config.principals[principal];
    if (!p) return [];
    return p.tools.filter(t => !ceiling || ceiling.includes(t));
  }

  toolsFor(principal: string, ceiling?: readonly ToolName[]) {
    const allowed = this.effectiveTools(principal, ceiling);
    return TOOL_DEFS.filter(d => allowed.includes(d.name));
  }

  private guard(signal?: AbortSignal) {
    if (signal?.aborted) throw new ToolRefusal('cancelled', 'The request was cancelled.');
  }

  async callTool(principal: string, name: string, rawArgs: unknown, transport: 'http' | 'stdio' | 'test' | 'exposure', opts: CallOpts = {}) {
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
      // Per-principal allowlist, enforced here in tools/call (not only in discovery).
      const tools = this.effectiveTools(principal, opts.toolCeiling);
      if (!tools.includes(d.name)) throw new ToolRefusal('forbidden', 'This tool is not enabled for this caller.');
      // Scoped callers are ALWAYS subject to the CURRENT validated sensitivity policy, re-read
      // now and again at release; without one (or without a posture) they get nothing.
      let state: PolicyState | null = null;
      if (p.scope !== 'owner') {
        state = this.deps.sensitivity.current();
        if (!state || !state.policy.posture(principal)) throw new ToolRefusal('not_available', 'Not available to this caller.');
      }
      if (!this.deps.limiter.take(`tool:${principal}`, this.deps.config.rateLimits.toolCallsPerMinute, 60_000)) throw new ToolRefusal('rate_limited', 'Too many requests; try again in a minute.');
      const args = validate(d, rawArgs);
      this.guard(opts.signal);
      // Server-side hosted authorisation on every call, with this principal's own credential.
      const cap = await this.deps.hosted.capability(p.hostedActor, opts.signal);
      if (p.scope === 'owner' && !(cap.review && cap.rhysActor === cap.actor)) throw new ToolRefusal('forbidden', 'Owner scope is not confirmed by the hosted service for this caller.');
      ctx = {...ctxBase, p, cap, policy: state?.policy ?? null, tools, signal: opts.signal};
      result = await this.run(ctx, d.name, args);
      this.guard(opts.signal);
      if (state) {
        // Release boundary: the policy in force NOW must be the one this result was computed
        // under (deleted, insecure, edited or re-pinned policy => nothing is released).
        const now = this.deps.sensitivity.current();
        if (!now || now.sha256 !== state.sha256 || !now.policy.posture(principal)) throw new ToolRefusal('not_available', 'Not available to this caller.');
        // Final safety net over every free-text value of the response, for every data tool.
        if (d.name !== 'whoami' && d.name !== 'capabilities' && state.policy.scan(result)) throw new Withheld(d.name === 'ask_call' ? NOT_FOUND_CALL : NOT_FOUND_TASK, EMPTY[d.name]);
        result = {...result, sharingPolicy: SHARING_NOTE};
      }
    } catch (e) {
      if (e instanceof Withheld) {
        reason = 'withheld'; ctxBase.ids.length = 0;
        if (e.empty) result = {...e.empty, sharingPolicy: SHARING_NOTE};
        else { outcome = 'refused'; result = {error: e.code, message: e.message}; }
      }
      else if (e instanceof ToolRefusal) { outcome = 'refused'; reason = e.code; result = {error: e.code, message: e.message}; }
      else if (e instanceof HostedRefusal) { outcome = 'refused'; reason = `hosted_${e.status}`; result = {error: 'hosted_refused', message: e.message}; }
      else { outcome = 'error'; reason = 'internal'; result = {error: 'internal', message: 'The request could not be completed; no diagnostic text was returned.'}; }
    }
    // Schema-bound audit: only a known tool enum is ever written; a rejected name is hashed.
    // A failing audit write throws: callers (exposure) then release nothing.
    const known = (TOOL_NAMES as readonly string[]).includes(name);
    this.deps.audit.write({
      at: new Date().toISOString(), principal, transport, tool: known ? name : 'unknown_tool',
      ...(known ? {} : {toolNameSha256: argsHash(String(name))}), argsSha256: argsHash(rawArgs ?? {}),
      outcome, ...(reason ? {reason} : {}), resultIds: ctxBase.ids.slice(0, 50), costMicros: ctx?.costMicros ?? 0, maskSpans: ctxBase.counter.spans, ms: Date.now() - started,
    });
    return {isError: outcome !== 'ok', structured: result};
  }

  /** Meeting-level withholding: classification, exclusions, paths and meeting text. */
  private meetingBlocked(ctx: Ctx, m: HostedMeeting, paths: string[]): boolean {
    const pol = ctx.policy!;
    const mm = m as HostedMeeting & Record<string, unknown>;
    const cls = mm.classification;
    if (typeof cls !== 'string' || !CLASSIFICATION.test(cls)) {
      if (this.deps.config.classificationEnforcement.unclassified === 'withhold') return true;
    }
    if (pol.excludedFacts({callId: m.id, clients: [m.clientLabel], classifications: [cls, mm.sensitivity], brainPaths: paths})) return true;
    return pol.scan({title: m.title, clientLabel: m.clientLabel});
  }

  /** Task-level withholding against the RAW (pre-mask) hosted record. */
  private taskWithheld(ctx: Ctx, t: TaskView): boolean {
    const pol = ctx.policy!;
    const it = t._item as HostedItem & Record<string, unknown>;
    const task = (it.task ?? {}) as HostedTask;
    if (pol.excludedFacts({
      callId: t.source.callId, taskIds: [t.taskId, t.requestId], clients: [t.client, task.client],
      classifications: [it.classification, it.sensitivity, task.classification, task.sensitivity],
    })) return true;
    return pol.scan({item: {title: it.title, evidence: it.evidence}, task});
  }

  /** Every brain note (authoritative files) and index record of a call is free of denylisted text. */
  private brainClean(ctx: Ctx, callId: string, paths: string[]): boolean {
    const pol = ctx.policy!;
    for (const rel of paths) {
      const n = this.deps.brain.note(rel);
      if (!n) return false;
      if (pol.scan({title: n.title, attendees: n.attendees, summary: n.summary, analysis: n.analysis, turns: n.turns.map(t => [t.speaker, t.text])})) return false;
    }
    for (const r of this.deps.index.recordsFor(callId)) if (pol.scan(r)) return false;
    return true;
  }

  private async decide(ctx: Ctx): Promise<Decision> {
    this.guard(ctx.signal);
    const queue = await this.deps.hosted.list(ctx.p.hostedActor, ctx.signal);
    this.guard(ctx.signal);
    const views = taskViews(queue, ctx.counter);
    const pol = ctx.policy;
    if (!pol) return {queue, visible: views, full: queue.meetings.filter(m => m.taskOnly !== true), fullIds: 'all'};
    // Brain paths come from the brain directory itself, never from the search cache. If it
    // cannot be read and the policy has path rules, nothing is released.
    const brain = this.deps.brain.snapshot();
    if (!brain && pol.needsBrainPaths()) return {queue, visible: [], full: [], fullIds: new Set()};
    const pathsOf = (id: string) => brain?.get(id) ?? [];
    const blocked = new Set(queue.meetings.filter(m => this.meetingBlocked(ctx, m, pathsOf(m.id))).map(m => m.id));
    const withheld = new Set(views.filter(v => blocked.has(v.source.callId) || this.taskWithheld(ctx, v)));
    const visible = views.filter(v => !withheld.has(v));
    const full = queue.meetings.filter(m => {
      if (m.taskOnly === true || blocked.has(m.id)) return false;
      const mine = views.filter(v => v.source.callId === m.id);
      if (mine.some(v => withheld.has(v))) return false;
      const client = mine.find(v => v.client)?.client ?? m.clientLabel ?? null;
      if (!pol.fullCallGranted(ctx.principal, client)) return false;
      return this.brainClean(ctx, m.id, pathsOf(m.id));
    });
    return {queue, visible, full, fullIds: new Set(full.map(m => m.id))};
  }

  private fullCall(dec: Decision, callId: string) { return dec.fullIds === 'all' || dec.fullIds.has(callId); }

  private async run(ctx: Ctx, name: ToolName, args: Record<string, string | number>): Promise<Record<string, unknown>> {
    const {config, budget, ledger, index} = this.deps;
    switch (name) {
      case 'whoami': {
        // Shared usage is global metadata: only the owner sees it. Caps are policy, not usage.
        const owner = ctx.p.scope === 'owner';
        const s = owner ? ledger.state() : null;
        return {
          principal: ctx.principal, label: ctx.p.label, hostedActor: ctx.cap.actor, scope: ctx.p.scope,
          sees: owner ? 'All of Rhys\'s calls, clients and internal tasks.'
            : 'Task-level fields for clients Rhys has granted. Call quotes, transcript search, drafts and call questions only for clients with a separate full-call grant from Rhys. Items under Rhys\'s sharing policy are never available.',
          tools: ctx.tools, readOnly: true,
          askCallBudget: s
            ? {usedThisMonthUsd: usd(s.monthMicros), monthlyCapUsd: usd(budget.monthlyMicros), callsThisMonth: s.monthCalls, monthlyCalls: budget.monthlyCalls, callsToday: s.dayCalls, dailyCalls: budget.dailyCalls, halted: s.halted}
            : {monthlyCapUsd: usd(budget.monthlyMicros), monthlyCalls: budget.monthlyCalls, dailyCalls: budget.dailyCalls, usage: 'not shown to scoped callers'},
        };
      }
      case 'capabilities':
        return {
          server: SERVER_INFO, phase: 'A', readOnly: true, exposure: 'Runs on Rhys\'s Mac, bound to 127.0.0.1. Remote access, where separately enabled, passes an authenticated tunnel.',
          tools: TOOL_DEFS.filter(t => ctx.tools.includes(t.name)).map(t => ({name: t.name, description: t.description})),
          notAvailable: ['create_task', 'assign_client', 'request_draft', 'approve', 'send_back', 'hand_off', 'deliver'],
          safety: ['Card read-outs are masked before indexing, returning or model use.', 'Scoped callers see only hosted-granted clients.', 'Every call is audited without transcript text.', 'ask_call quotes are verified as exact transcript substrings.'],
          limits: {toolCallsPerMinute: config.rateLimits.toolCallsPerMinute, askCallsPerHour: config.rateLimits.askCallsPerHour, askCallMonthlyUsd: usd(budget.monthlyMicros), askCallMonthlyCalls: budget.monthlyCalls, askCallDailyCalls: budget.dailyCalls},
          // Global corpus size is owner-only metadata.
          ...(ctx.p.scope === 'owner' ? {indexedCalls: index.count()} : {}),
        };
      case 'list_tasks': {
        let tasks = (await this.decide(ctx)).visible;
        if (args.owner) tasks = tasks.filter(t => (t.owner ?? '').toLowerCase() === String(args.owner).toLowerCase());
        if (args.status) tasks = tasks.filter(t => [t.requestState, t.workStatus].includes(String(args.status).toLowerCase()));
        if (args.client) tasks = tasks.filter(t => (t.client ?? '').toLowerCase().includes(String(args.client).toLowerCase()));
        const limited = tasks.slice(0, Number(args.limit ?? 25)).map(publicTask);
        ctx.ids.push(...limited.map(t => t.id));
        return {count: limited.length, totalMatching: tasks.length, tasks: limited};
      }
      case 'get_task': {
        const dec = await this.decide(ctx);
        const t = dec.visible.find(x => x.taskId === args.id || x.requestId === args.id);
        if (!t) throw new ToolRefusal('not_found', NOT_FOUND_TASK);
        ctx.ids.push(t.id);
        // Quotes and the draft read follow the SAME full-call decision as search and ask.
        const fullCall = this.fullCall(dec, t.source.callId);
        const ev = fullCall ? t._item.evidence ?? {} : {};
        const task = (t._item.task ?? {}) as HostedTask;
        const draft = !fullCall ? {available: false, reason: 'Not available to this caller.'}
          : t.taskId ? await this.draftStatus(ctx, t.taskId) : {available: false, reason: 'This suggestion has not been accepted as a task yet.'};
        return {
          task: {...publicTask(t), kind: task.kind ?? null, origin: task.origin ?? null, executionGate: task.execution_gate ?? null, createdAt: task.created_at ?? null, updatedAt: task.updated_at ?? null,
            sentBackReason: task.sent_back_reason ? maskText(String(task.sent_back_reason), ctx.counter) : null, declinedReason: task.declined_reason ? maskText(String(task.declined_reason), ctx.counter) : null},
          request: {id: t.requestId, title: maskText(t._item.title ?? '', ctx.counter), state: t.requestState, due: t._item.due ?? null, owner: t._item.owner ?? null},
          quotes: (fullCall ? [ev.quote, task.source_quote] : []).filter((q, i, a): q is string => typeof q === 'string' && !!q && a.indexOf(q) === i)
            .map((q, i) => ({text: maskText(q, ctx.counter), speaker: i === 0 && ev.speaker ? maskText(ev.speaker, ctx.counter) : null, timestamp: i === 0 ? ts(ev.start) : null})),
          status: {request: t.requestState, work: t.workStatus, deferred: t.deferred},
          draft,
          sources: [t.source],
        };
      }
      case 'get_draft': {
        const dec = await this.decide(ctx);
        const t = dec.visible.find(x => x.taskId === args.task_id);
        if (!t || !t.taskId) throw new ToolRefusal('not_found', NOT_FOUND_TASK);
        if (!this.fullCall(dec, t.source.callId)) throw new Withheld(NOT_FOUND_TASK);
        ctx.ids.push(t.taskId);
        const status = await this.draftStatus(ctx, t.taskId);
        if (!status.available || !status.currentVersion) return {taskId: t.taskId, ...status, draft: null};
        this.guard(ctx.signal);
        const art = await this.deps.hosted.documentArtifact(ctx.p.hostedActor, t.taskId, status.currentVersion, ctx.signal);
        if (art.status !== 200 || !art.body) return {taskId: t.taskId, ...status, draft: null, reason: 'The current draft version could not be read (authority changed or not permitted).'};
        const content = maskJson(art.body.content ?? null, ctx.counter) as Record<string, unknown> | null;
        const facts = content && Array.isArray(content.facts) ? content.facts : [];
        return {taskId: t.taskId, ...status, draft: {version: art.body.version, contentSha256: art.body.hash, content}, citations: facts};
      }
      case 'search_calls': {
        // A denylisted query or client gets the ordinary empty result (same as no match).
        if (ctx.policy && (ctx.policy.textHits(args.query) || ctx.policy.textHits(args.client) || ctx.policy.clientExcluded(args.client))) throw new Withheld(NOT_FOUND_CALL, EMPTY.search_calls);
        const dec = await this.decide(ctx);
        const full = dec.full;
        const limit = Number(args.limit ?? 8);
        const clientOf = new Map<string, string>();
        for (const m of full) for (const it of m.items ?? []) if (it.task?.client) clientOf.set(m.id, maskText(String(it.task.client), ctx.counter));
        const clientCallIds = args.client ? new Set([...clientOf].filter(([, c]) => c.toLowerCase().includes(String(args.client).toLowerCase())).map(([id]) => id)) : undefined;
        // Eligibility is decided BEFORE ranking and limiting: only released calls compete, so a
        // withheld call can never displace or change a visible result (R16 finding 4).
        const hits: (CallHit & {client: string | null; source: string})[] = index.search({
          query: String(args.query), from: args.from as string | undefined, to: args.to as string | undefined, limit, client: args.client as string | undefined, clientCallIds, allowed: dec.fullIds,
        }).map(h => ({...h, client: clientOf.get(h.callId) ?? null, source: 'brain',
          // Whole records are already clean; a clipped snippet that forms a denylisted word is dropped.
          quotes: ctx.policy ? h.quotes.filter(q => !ctx.policy!.scan(q)) : h.quotes}));
        // Hosted catalog calls this caller may see that are not (yet) in the brain: title match only.
        const terms = queryTerms(String(args.query));
        for (const m of full) {
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
        // A denylisted question is refused exactly like an unknown call, before any read or spend.
        if (ctx.policy && ctx.policy.textHits(args.question)) throw new Withheld(NOT_FOUND_CALL);
        const dec = await this.decide(ctx);
        const id = String(args.call_id);
        // Same refusal for unknown, ungranted, task-only and withheld ids, before any hosted read or dispatch.
        if (!this.fullCall(dec, id)) throw new ToolRefusal('not_found', NOT_FOUND_CALL);
        const source = await this.callSource(ctx, dec.full, id);
        if (!source) throw new ToolRefusal('not_found', NOT_FOUND_CALL);
        // The whole source (hosted passages included) is checked BEFORE dispatch: no spend, no release.
        if (ctx.policy && ctx.policy.scan({meta: source.meta, turns: source.turns.map(t => [t.speaker, t.text])})) throw new Withheld(NOT_FOUND_CALL);
        ctx.ids.push(id);
        this.guard(ctx.signal);
        const r = await runAsk({cfg: config.askCall, budget, ledger, principal: ctx.principal, meta: source.meta, turns: source.turns, question: String(args.question), key: this.deps.askKey, transport: this.deps.askTransport, counter: ctx.counter});
        ctx.costMicros = r.costMicros;
        const base = {callId: id, title: source.meta.title, date: source.meta.date, link: firefliesLink(id), transcriptSource: source.kind, costUsd: usd(r.costMicros), latencyMs: r.latencyMs};
        if (!r.ok) {
          if (!r.dispatched && r.reason.startsWith('Budget')) throw new ToolRefusal('budget_refused', r.reason);
          return {...base, supported: false, reason: r.reason, quotes: []};
        }
        // A scoped answer or quote touching a denylisted topic is withheld (the spend is kept).
        if (ctx.policy && ctx.policy.scan({answer: r.answer, quotes: r.quotes})) throw new Withheld(NOT_FOUND_CALL);
        return {...base, supported: true, answer: r.answer, quotes: r.quotes, rejectedQuotes: r.rejectedQuotes};
      }
    }
  }

  private async callSource(ctx: Ctx, full: HostedMeeting[], id: string): Promise<{kind: 'hosted' | 'brain'; meta: {title: string; date: string | null}; turns: Turn[]} | null> {
    const hostedMeeting: HostedMeeting | undefined = full.find(m => m.id === id);
    if (hostedMeeting) {
      // Hosted transcript (has timestamps), read with this caller's own hosted credential.
      // A hosted refusal is final: same "not found", and no fallback to the brain copy.
      let c;
      this.guard(ctx.signal);
      try { c = await this.deps.hosted.context(ctx.p.hostedActor, id, ctx.signal); } catch (e) {
        if (e instanceof HostedRefusal) throw new ToolRefusal('not_found', NOT_FOUND_CALL);
        throw e;
      }
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
    this.guard(ctx.signal);
    const r = await this.deps.hosted.documentRead(ctx.p.hostedActor, taskId, ctx.signal);
    if (r.status === 401 || r.status === 403) return {available: false, reason: 'Draft access is not provisioned for this caller yet (the hosted service refused the read).'};
    if (r.status !== 200 || !r.body) return {available: false, reason: 'Draft status could not be read.'};
    if (r.body.available !== true) return {available: false, reason: typeof r.body.reason === 'string' ? maskText(r.body.reason.slice(0, 2000), ctx.counter).slice(0, 300) : 'No draft is set up for this task.'};
    const status = typeof r.body.status === 'string' && /^[a-z_]{1,40}$/.test(r.body.status) ? r.body.status : 'unknown';
    return {available: true, status, currentVersion: Number.isInteger(r.body.currentVersion) ? r.body.currentVersion as number : undefined,
      title: maskText(String(r.body.title ?? ''), ctx.counter), owner: r.body.owner as string, reviewer: r.body.reviewer as string};
  }
}
