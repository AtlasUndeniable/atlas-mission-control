/**
 * Audit log and ask_call budget ledger. Both are append-only JSONL files (0600) in the
 * state directory. Neither ever contains transcript text, questions, answers or quotes:
 * the audit row holds the principal, tool, a SHA-256 of the canonical arguments, result
 * ids, cost and the mask span count.
 *
 * Budget: the byte-floor cost bound (request bytes x input rate + max output tokens x
 * output rate; input tokens can never exceed request bytes) is reserved BEFORE dispatch
 * and refused if it would cross the monthly cap, or if the monthly or daily call count is
 * reached. A reservation that never settles counts at its full bound.
 */
import {appendFileSync, readFileSync, existsSync, mkdirSync, rmdirSync, chmodSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {Budget} from './config.ts';

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const argsHash = (args: unknown) => createHash('sha256').update(canonical(args)).digest('hex');

function append(file: string, row: object) {
  appendFileSync(file, JSON.stringify(row) + '\n', {mode: 0o600});
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

export type AuditRow = {
  at: string; principal: string; transport: 'http' | 'stdio' | 'test'; tool: string; argsSha256: string;
  outcome: 'ok' | 'refused' | 'error'; reason?: string; resultIds: string[]; costMicros: number; maskSpans: number; ms: number;
};
export class AuditLog {
  readonly file: string;
  constructor(stateDir: string) {
    mkdirSync(stateDir, {recursive: true, mode: 0o700});
    this.file = join(stateDir, 'audit.jsonl');
  }
  write(row: AuditRow) { append(this.file, row); }
}

export type CostBound = {requestBytes: number; maxOutputTokens: number; micros: number};
export const costBound = (body: string, maxOutputTokens: number, b: Budget): CostBound => {
  const requestBytes = Buffer.byteLength(body, 'utf8');
  return {requestBytes, maxOutputTokens, micros: requestBytes * b.inputMicrosPerToken + maxOutputTokens * b.outputMicrosPerToken};
};
export const usageMicros = (u: {input_tokens: number; output_tokens: number}, b: Budget) =>
  u.input_tokens * b.inputMicrosPerToken + u.output_tokens * b.outputMicrosPerToken;

type LedgerRow = {id: string; at: string; kind: 'reserve' | 'settle'; principal?: string; boundMicros?: number; actualMicros?: number | null; outcome?: string};
export type BudgetState = {monthCalls: number; dayCalls: number; monthMicros: number};

export class BudgetLedger {
  readonly file: string;
  readonly lockDir: string;
  readonly budget: Budget;
  readonly now: () => Date;
  constructor(stateDir: string, budget: Budget, now: () => Date = () => new Date()) {
    mkdirSync(stateDir, {recursive: true, mode: 0o700});
    this.file = join(stateDir, 'ask-call-ledger.jsonl');
    this.lockDir = join(stateDir, 'ask-call-ledger.lock');
    this.budget = budget; this.now = now;
  }

  private rows(): LedgerRow[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LedgerRow);
  }
  state(): BudgetState {
    const now = this.now();
    const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
    const reserves = new Map<string, LedgerRow>(), settles = new Map<string, LedgerRow>();
    for (const r of this.rows()) (r.kind === 'reserve' ? reserves : settles).set(r.id, r);
    let monthCalls = 0, dayCalls = 0, monthMicros = 0;
    for (const r of reserves.values()) {
      if (!r.at.startsWith(month)) continue;
      monthCalls++; if (r.at.startsWith(day)) dayCalls++;
      const s = settles.get(r.id);
      monthMicros += s && typeof s.actualMicros === 'number' ? s.actualMicros : (r.boundMicros ?? 0);
    }
    return {monthCalls, dayCalls, monthMicros};
  }
  private withLock<T>(fn: () => T): T {
    let held = false;
    for (let i = 0; i < 200 && !held; i++) {
      try { mkdirSync(this.lockDir, {mode: 0o700}); held = true; } catch { const until = Date.now() + 10; while (Date.now() < until) { /* spin briefly */ } }
    }
    if (!held) throw Error('budget_ledger_busy');
    try { return fn(); } finally { try { rmdirSync(this.lockDir); } catch { /* already gone */ } }
  }
  /** Reserve the bound or refuse. Returns the reservation id. */
  reserve(principal: string, bound: CostBound): {ok: true; id: string} | {ok: false; reason: string} {
    return this.withLock(() => {
      const s = this.state(), b = this.budget;
      if (s.monthCalls >= b.monthlyCalls) return {ok: false as const, reason: 'ask_call monthly call cap reached'};
      if (s.dayCalls >= b.dailyCalls) return {ok: false as const, reason: 'ask_call daily call cap reached'};
      if (s.monthMicros + bound.micros > b.monthlyMicros) return {ok: false as const, reason: 'ask_call monthly spend cap would be exceeded'};
      const id = randomUUID();
      append(this.file, {id, at: this.now().toISOString(), kind: 'reserve', principal, boundMicros: bound.micros, requestBytes: bound.requestBytes, maxOutputTokens: bound.maxOutputTokens});
      return {ok: true as const, id};
    });
  }
  settle(id: string, actualMicros: number | null, outcome: string) {
    this.withLock(() => append(this.file, {id, at: this.now().toISOString(), kind: 'settle', actualMicros, outcome}));
  }
}
