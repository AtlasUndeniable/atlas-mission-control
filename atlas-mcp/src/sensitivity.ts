/**
 * "Never share with Nat/Grok" sensitivity policy (sprint-20261007 DECISIONS item 19(a)(b)).
 *
 * A reviewed policy file that EVERY tool checks for every principal with scope 'granted'
 * (today: nat and grok_as_nat). The owner principal (rhys) is never affected.
 *
 *  - topics: words and phrases (financials, pricing, payroll/team pay, staff/HR, internal
 *    strategy, Undeniable financial data, bank/card details). A topic term anywhere in an
 *    item's text withholds the whole item.
 *  - patterns: a closed set of built-in detectors (money amounts, long digit runs). Config
 *    cannot supply its own regular expressions (no ReDoS, no reviewer surprise).
 *  - classifications: hosted classification/sensitivity labels that are always withheld.
 *  - excluded: client labels, task/request ids, call ids and brain note path fragments that
 *    Rhys excludes outright.
 *  - principals: per-principal posture. The only posture is 'task_fields_only': task-level
 *    fields, no call quotes, transcript search, drafts or ask_call, unless Rhys records a
 *    per-client full-call grant (with its decision reference). There are none today.
 *
 * A withheld item is answered exactly as if it did not exist (same refusal, same shape), so
 * nothing about it leaks. Over-withholding is by design; the owner sees everything.
 * The loader is strict and fails closed: an unreadable or invalid policy refuses every tool
 * for every scoped principal.
 */
import {readOwnerOnlyFile} from './auth.ts';

export const REQUIRED_TOPICS = ['financials', 'pricing', 'payroll_team_pay', 'staff_hr', 'internal_strategy', 'undeniable_financials', 'bank_card'] as const;
export const REQUIRED_CLASSIFICATIONS = ['client_financial', 'internal'] as const;
export const PATTERN_IDS = ['money_amount', 'long_digit_run', 'percentage_figure'] as const;
export type PatternId = typeof PATTERN_IDS[number];
export const POSTURES = ['task_fields_only'] as const;
export type Posture = typeof POSTURES[number];

const BUILTIN: Record<PatternId, RegExp> = {
  // $500, £1,200, € 3k, 5k, 2.5m, 997 dollars, 300 aud, 40 grand
  money_amount: /(?:[$£€]\s?\d)|(?:\b\d[\d,.]*\s?(?:k|m|mil|million|thousand|grand|aud|usd|nzd|gbp|eur|dollars?|bucks)\b)/i,
  // 6+ consecutive digits (account, card, phone-like), a BSB shape, or grouped 4-4-n digits
  long_digit_run: /(?<![\d-])\d{6,}(?![\d-])|\b\d{3}-\d{3}\b|\b\d{4}[ -]\d{4}[ -]\d{2,4}\b/,
  percentage_figure: /\b\d+(?:\.\d+)?\s?(?:%|percent\b)/i,
};

export type SensitivitySpec = {
  version: string;
  decisionReference: string;
  reviewState: string;
  topics: {id: string; terms: string[]}[];
  patterns: PatternId[];
  classifications: string[];
  excluded: {clientLabels: string[]; taskIds: string[]; callIds: string[]; brainPathFragments: string[]};
  principals: Record<string, {posture: Posture; fullCallClients: {client: string; decisionReference: string}[]}>;
};

const fail = (what: string): never => { throw Error(`atlas_mcp_sensitivity_invalid:${what}`); };
const exactKeys = (o: unknown, keys: string[], what: string) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(what);
  const extra = Object.keys(o as object).filter(k => !keys.includes(k));
  const missing = keys.filter(k => !(k in (o as object)));
  if (extra.length || missing.length) fail(`${what}:keys`);
  return o as Record<string, unknown>;
};
const strList = (v: unknown, re: RegExp, what: string, max = 500) => {
  if (!Array.isArray(v) || v.length > max || v.some(x => typeof x !== 'string' || !re.test(x))) fail(what);
  return [...new Set(v as string[])];
};
const TERM = /^[a-z0-9$£€%&' -]{1,60}\*?$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const LABEL = /^[^\0\n]{1,80}$/;
const REF = /^[^\0\n]{8,300}$/;

/** Lowercase, NFKC, every non-word character (except $ £ € % &) becomes one space. */
export function normalize(text: string): string {
  return ` ${text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9$£€%&]+/g, ' ').trim()} `;
}

export function parseSensitivity(raw: unknown): SensitivitySpec {
  const s = exactKeys(raw, ['version', 'decisionReference', 'reviewState', 'topics', 'patterns', 'classifications', 'excluded', 'principals'], 'root');
  if (typeof s.version !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(s.version)) fail('version');
  if (typeof s.decisionReference !== 'string' || !REF.test(s.decisionReference)) fail('decisionReference');
  if (typeof s.reviewState !== 'string' || !REF.test(s.reviewState)) fail('reviewState');
  if (!Array.isArray(s.topics) || !s.topics.length) fail('topics');
  const topics = (s.topics as unknown[]).map((t, i) => {
    const o = exactKeys(t, ['id', 'terms'], `topic:${i}`);
    if (typeof o.id !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(o.id)) fail(`topic:${i}:id`);
    const terms = strList(o.terms, TERM, `topic:${o.id}:terms`).map(x => x.trim()).filter(Boolean);
    if (!terms.length) fail(`topic:${o.id}:empty`);
    return {id: o.id as string, terms};
  });
  const ids = topics.map(t => t.id);
  if (new Set(ids).size !== ids.length) fail('topics:duplicate');
  for (const r of REQUIRED_TOPICS) if (!ids.includes(r)) fail(`topics:missing:${r}`);
  const patterns = strList(s.patterns, /^.+$/, 'patterns') as PatternId[];
  if (patterns.some(p => !(PATTERN_IDS as readonly string[]).includes(p))) fail('patterns:unknown');
  const classifications = strList(s.classifications, /^[a-z][a-z_]{1,40}$/, 'classifications');
  for (const r of REQUIRED_CLASSIFICATIONS) if (!classifications.includes(r)) fail(`classifications:missing:${r}`);
  const e = exactKeys(s.excluded, ['clientLabels', 'taskIds', 'callIds', 'brainPathFragments'], 'excluded');
  const excluded = {
    clientLabels: strList(e.clientLabels, LABEL, 'excluded.clientLabels'),
    taskIds: strList(e.taskIds, ID, 'excluded.taskIds'),
    callIds: strList(e.callIds, ID, 'excluded.callIds'),
    brainPathFragments: strList(e.brainPathFragments, /^[a-z0-9 ._/-]{2,80}$/, 'excluded.brainPathFragments'),
  };
  const p = s.principals;
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('principals');
  const principals: SensitivitySpec['principals'] = {};
  for (const [name, v] of Object.entries(p as object)) {
    if (!/^[a-z][a-z_]{1,31}$/.test(name)) fail('principal_name');
    const o = exactKeys(v, ['posture', 'fullCallClients'], `principal:${name}`);
    if (!(POSTURES as readonly string[]).includes(o.posture as string)) fail(`principal:${name}:posture`);
    if (!Array.isArray(o.fullCallClients) || o.fullCallClients.length > 200) fail(`principal:${name}:fullCallClients`);
    const grants = (o.fullCallClients as unknown[]).map((g, i) => {
      const x = exactKeys(g, ['client', 'decisionReference'], `principal:${name}:grant:${i}`);
      if (typeof x.client !== 'string' || !LABEL.test(x.client)) fail(`principal:${name}:grant:${i}:client`);
      if (typeof x.decisionReference !== 'string' || !REF.test(x.decisionReference)) fail(`principal:${name}:grant:${i}:decisionReference`);
      return {client: x.client as string, decisionReference: x.decisionReference as string};
    });
    principals[name] = {posture: o.posture as Posture, fullCallClients: grants};
  }
  for (const r of ['nat', 'grok_as_nat']) if (!principals[r]) fail(`principals:missing:${r}`);
  return {version: s.version as string, decisionReference: s.decisionReference as string, reviewState: s.reviewState as string, topics, patterns, classifications, excluded, principals};
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Structural keys whose values are ids, dates, links or enums, never free text. */
const STRUCTURAL = new Set(['id', 'taskId', 'requestId', 'callId', 'link', 'instant', 'due', 'date', 'createdAt', 'updatedAt', 'contentSha256', 'hash', 'requestState', 'workStatus', 'state', 'status', 'access', 'transcriptSource', 'version', 'currentVersion',
  'created_at', 'updated_at', 'work_status', 'execution_gate', 'sourceRevision', 'projectionHash', 'revision', 'sharingPolicy']);

export type ItemFacts = {callId?: string | null; taskIds?: (string | null | undefined)[]; clients?: unknown[]; classifications?: unknown[]; brainPath?: string | null};

export class SensitivityPolicy {
  readonly spec: SensitivitySpec;
  private topicRe: RegExp;
  private patternRes: RegExp[];
  private clients: Set<string>;
  constructor(spec: SensitivitySpec) {
    this.spec = spec;
    const alts: string[] = [];
    for (const t of spec.topics) for (const term of t.terms) {
      const prefix = term.endsWith('*');
      const core = normalize(prefix ? term.slice(0, -1) : term).trim();
      if (!core) continue;
      alts.push(prefix ? `${esc(core)}[a-z0-9]*` : esc(core));
    }
    // Terms are matched on whole words of the normalized text (space-delimited).
    this.topicRe = new RegExp(`(?<= )(?:${alts.join('|') || '(?!)'})(?= )`);
    this.patternRes = spec.patterns.map(p => BUILTIN[p]);
    this.clients = new Set(spec.excluded.clientLabels.map(c => normalize(c).trim()));
  }

  /** True when this free text mentions a denylisted topic or matches a built-in pattern. */
  textHits(text: unknown): boolean {
    if (typeof text !== 'string' || !text) return false;
    if (this.topicRe.test(normalize(text))) return true;
    return this.patternRes.some(r => r.test(text));
  }

  /** Deep scan of every free-text string value (structural id/date/enum keys skipped). */
  scan(value: unknown, key = ''): boolean {
    if (typeof value === 'string') return !STRUCTURAL.has(key) && this.textHits(value);
    if (Array.isArray(value)) return value.some(v => this.scan(v, key));
    if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).some(([k, v]) => this.scan(v, k));
    return false;
  }

  clientExcluded(client: unknown): boolean {
    return typeof client === 'string' && !!client && this.clients.has(normalize(client).trim());
  }

  /** Id, client, classification and brain-path exclusions for one item. */
  excludedFacts(f: ItemFacts): boolean {
    const ex = this.spec.excluded;
    if (f.callId && ex.callIds.includes(f.callId)) return true;
    if ((f.taskIds ?? []).some(t => typeof t === 'string' && ex.taskIds.includes(t))) return true;
    if ((f.clients ?? []).some(c => this.clientExcluded(c))) return true;
    if ((f.classifications ?? []).some(c => typeof c === 'string' && this.spec.classifications.includes(c.toLowerCase()))) return true;
    if (f.brainPath) {
      const p = f.brainPath.toLowerCase();
      if (ex.brainPathFragments.some(fr => p.includes(fr))) return true;
    }
    return false;
  }

  posture(principal: string): Posture | null { return this.spec.principals[principal]?.posture ?? null; }

  /** Per-client full-call grant (quotes, transcript search, drafts, ask_call). None today. */
  fullCallGranted(principal: string, client: unknown): boolean {
    if (typeof client !== 'string' || !client || this.clientExcluded(client)) return false;
    const c = normalize(client).trim();
    return (this.spec.principals[principal]?.fullCallClients ?? []).some(g => normalize(g.client).trim() === c);
  }
}

export function loadSensitivity(file: string): SensitivityPolicy {
  let raw: unknown;
  try { raw = JSON.parse(readOwnerOnlyFile(file, 'sensitivity_policy')); } catch (e) {
    if (e instanceof Error && e.message.startsWith('atlas_mcp_sensitivity_invalid')) throw e;
    return fail('unreadable');
  }
  return new SensitivityPolicy(parseSensitivity(raw));
}
