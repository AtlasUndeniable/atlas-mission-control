/**
 * Every piece of transcript-derived text passes the Lane P card-mask module before it is
 * indexed, returned or sent to a model. vendor/card-mask.mjs is a byte-identical copy of
 * fireflies-bridge/card-mask.mjs (SHA256 pinned in test/mask.test.ts). Only span counts
 * leave this module; the original digits are never logged or returned.
 */
import {maskCardReadouts} from '../vendor/card-mask.mjs';

export const CARD_MASK_SHA256 = '6891d69c627155af5af739a0c127ad52fbc60b8473d3c6ba0776f2a72d403926';
export type MaskCounter = {spans: number};

/** Mask an ordered sequence of turns. Cross-turn read-outs are detected as one exchange. */
export function maskTurns(texts: string[], counter?: MaskCounter): string[] {
  const r = maskCardReadouts(texts.map(text => ({text: typeof text === 'string' ? text : ''})));
  if (counter) counter.spans += r.spans;
  return r.sentences.map((s: {text: string}) => s.text);
}

/** Mask free text (summaries, analyses, titles, drafts) line by line as one sequence. */
export function maskText(text: string, counter?: MaskCounter): string {
  if (typeof text !== 'string' || !text) return '';
  const lines = text.split('\n');
  const idx: number[] = [];
  const nonblank: string[] = [];
  lines.forEach((l, i) => { if (l.trim()) { idx.push(i); nonblank.push(l); } });
  const masked = maskTurns(nonblank, counter);
  idx.forEach((i, k) => { lines[i] = masked[k]; });
  return lines.join('\n');
}

/** Deep-mask every string inside a JSON value (used for drafts and hosted task fields). */
export function maskJson<T>(value: T, counter?: MaskCounter): T {
  if (typeof value === 'string') return maskText(value, counter) as T;
  if (Array.isArray(value)) return value.map(v => maskJson(v, counter)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskJson(v, counter)])) as T;
  }
  return value;
}
