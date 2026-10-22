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
  at: string; principal: string; transport: 'http' | 'stdio' | 'test' | 'exposure'; tool: string; toolNameSha256?: string; argsSha256: string;
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
const safeNonNeg = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
/** Provider usage, or null when malformed: nonnegative safe integers, output within the request's own limit. */
export function validUsage(u: unknown, maxOutputTokens: number): {input_tokens: number; output_tokens: number} | null {
  const x = u as {input_tokens?: unknown; output_tokens?: unknown} | null;
  if (!x || !safeNonNeg(x.input_tokens) || !safeNonNeg(x.output_tokens) || x.output_tokens > maxOutputTokens) return null;
  return {input_tokens: x.input_tokens, output_tokens: x.output_tokens};
}
/** Micro-USD for valid usage, or null if the arithmetic is not a finite safe nonnegative integer. */
export const usageMicros = (u: {input_tokens: number; output_tokens: number}, b: Budget): number | null => {
  const m = u.input_tokens * b.inputMicrosPerToken + u.output_tokens * b.outputMicrosPerToken;
  return safeNonNeg(m) ? m : null;
};

export const SETTLE_OUTCOMES = ['end_turn', 'max_tokens', 'refusal', 'unresolved', 'invalid_usage', 'other'] as const;
export type SettleOutcome = typeof SETTLE_OUTCOMES[number];
export const normalizeOutcome = (s: unknown): SettleOutcome =>
  (typeof s === 'string' && (SETTLE_OUTCOMES as readonly string[]).includes(s) && s !== 'unresolved' && s !== 'invalid_usage' ? s as SettleOutcome : 'other');

type LedgerRow = {id: string; at: string; kind: 'reserve' | 'settle' | 'halt'; principal?: string; boundMicros?: number; actualMicros?: number | null; outcome?: string; reason?: string};
export type BudgetState = {monthCalls: number; dayCalls: number; monthMicros: number; halted: boolean; invalid: boolean};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

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

  /**
   * Validated view of the ledger. Any malformed row (bad JSON, unknown kind, negative or
   * non-integer amounts, a settle without its reservation, a second settle) marks the ledger
   * invalid, and an invalid or halted ledger refuses every new reservation. Accounting can
   * therefore only be reduced by a well-formed settle of an existing reservation.
   */
  state(): BudgetState {
    const now = this.now();
    const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
    const reserves = new Map<string, LedgerRow>(), settles = new Map<string, LedgerRow>();
    let invalid = false, halted = false;
    const lines = existsSync(this.file) ? readFileSync(this.file, 'utf8').split('\n').filter(Boolean) : [];
    for (const line of lines) {
      let r: LedgerRow;
      try { r = JSON.parse(line); } catch { invalid = true; continue; }
      if (!r || typeof r.id !== 'string' || !r.id || typeof r.at !== 'string' || !ISO.test(r.at)) { invalid = true; continue; }
      if (r.kind === 'reserve') {
        if (!safeNonNeg(r.boundMicros) || reserves.has(r.id)) { invalid = true; continue; }
        reserves.set(r.id, r);
      } else if (r.kind === 'settle') {
        if (!(r.actualMicros === null || safeNonNeg(r.actualMicros)) || !reserves.has(r.id) || settles.has(r.id)) { invalid = true; continue; }
        settles.set(r.id, r);
      } else if (r.kind === 'halt') halted = true;
      else invalid = true;
    }
    let monthCalls = 0, dayCalls = 0, monthMicros = 0;
    for (const r of reserves.values()) {
      const bound = r.boundMicros as number;
      const s = settles.get(r.id);
      const actual = s && typeof s.actualMicros === 'number' ? s.actualMicros : null;
      if (actual !== null && actual > bound) halted = true; // the bound assumption failed: stop until reconciled
      if (!r.at.startsWith(month)) continue;
      monthCalls++; if (r.at.startsWith(day)) dayCalls++;
      monthMicros += actual === null ? bound : Math.max(actual, 0);
    }
    return {monthCalls, dayCalls, monthMicros, halted, invalid};
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
      if (!safeNonNeg(bound.micros)) return {ok: false as const, reason: 'ask_call cost bound is not a valid amount'};
      const s = this.state(), b = this.budget;
      if (s.invalid) return {ok: false as const, reason: 'ask_call ledger failed validation; dispatch halted pending reconciliation'};
      if (s.halted) return {ok: false as const, reason: 'ask_call dispatch halted pending reconciliation (observed usage exceeded its bound)'};
      if (s.monthCalls >= b.monthlyCalls) return {ok: false as const, reason: 'ask_call monthly call cap reached'};
      if (s.dayCalls >= b.dailyCalls) return {ok: false as const, reason: 'ask_call daily call cap reached'};
      if (s.monthMicros + bound.micros > b.monthlyMicros) return {ok: false as const, reason: 'ask_call monthly spend cap would be exceeded'};
      const id = randomUUID();
      append(this.file, {id, at: this.now().toISOString(), kind: 'reserve', principal, boundMicros: bound.micros, requestBytes: bound.requestBytes, maxOutputTokens: bound.maxOutputTokens});
      return {ok: true as const, id};
    });
  }
  /** actualMicros null keeps the full reservation. An actual above the bound is recorded AND halts. */
  settle(id: string, actualMicros: number | null, outcome: SettleOutcome, boundMicros?: number) {
    const actual = actualMicros !== null && safeNonNeg(actualMicros) ? actualMicros : null;
    this.withLock(() => {
      append(this.file, {id, at: this.now().toISOString(), kind: 'settle', actualMicros: actual, outcome: (SETTLE_OUTCOMES as readonly string[]).includes(outcome) ? outcome : 'other'});
      if (actual !== null && boundMicros !== undefined && actual > boundMicros) append(this.file, {id: randomUUID(), at: this.now().toISOString(), kind: 'halt', reason: 'usage_exceeded_bound'});
    });
  }
}
