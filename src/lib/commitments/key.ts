// Exact mc2 key subset from accepted meeting intake; no legacy execution dependencies.
import {createHash} from 'node:crypto';
export const KEY_SCHEME = "mc2";

/**
 * Comparison form for passage text.
 *
 * Deliberately narrow: case, punctuation and whitespace only. Anything more
 * aggressive starts collapsing distinct promises onto one key, and two
 * promises sharing a request is unrecoverable, where one promise appearing
 * twice is visible and fixable.
 */
export function normalisePassage(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PassageKeyParts {
  provider: string;
  sourceId: string;
  /** Who promised it. Evidence from the transcript — not an actor. */
  speakerKey: string;
  /** The GROUNDED passage: real words, from the saved source. */
  passageText: string;
}

/**
 * The key for a passage. 32 hex characters, prefixed with the scheme.
 *
 * Length and alphabet satisfy migration 010's `idempotency_key` constraint
 * exactly — 8-200 characters of `[A-Za-z0-9_.:-]` — so it goes through as the
 * idempotency key with no re-encoding step two callers could differ on.
 */
export function passageCommitmentKey(parts: PassageKeyParts): string {
  const passage = normalisePassage(parts.passageText);
  if (!passage) throw new Error("passageCommitmentKey: the passage normalises to nothing");
  // \x1f cannot occur in any of these, so no combination of values can produce
  // the same bytes as a different combination.
  const material = [KEY_SCHEME, parts.provider, parts.sourceId, parts.speakerKey, passage]
    .join("\x1f");
  return `${KEY_SCHEME}:${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32)}`;
}

export function isCommitmentKey(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${KEY_SCHEME}:[0-9a-f]{32}$`).test(value);
}

