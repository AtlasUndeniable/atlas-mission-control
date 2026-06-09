/**
 * Pure, dependency-free claim/finalize/fail logic for the Mission Control
 * approval route. Extracted so the action-level double-send race fix can be
 * unit-tested against an in-memory queue without touching Slack, fs, or Next.
 *
 * Status model
 * ------------
 *   actionable (claimable for approve): pending | needs_draft | drafted
 *   in-flight  (claimed, send running): approving
 *   terminal success:                   approved
 *   terminal operator-stop:             denied
 *   failed send (NOT auto-sendable):    send_failed
 *
 * Race fix: the approve route claims the item to `approving` INSIDE the queue
 * lock BEFORE any Slack send. A second concurrent approve, serialized by the
 * same lock, then sees `approving` (non-actionable) and 409s — so only one
 * Slack send can ever happen per item per claim. Finalize/fail only mutate the
 * item if its approvalRequestId still matches the claim that did the send.
 */

export const MAX_REPLY_LENGTH = 2000; // Slack message limit
export const MIN_REPLY_LENGTH = 2; // prevent empty/whitespace sends

// Statuses an approve POST may claim from.
export const APPROVE_ACTIONABLE = new Set(["pending", "needs_draft", "drafted"]);

// Deny must not race an in-flight send (`approving`) nor re-finalize a terminal
// item. `send_failed` is intentionally NOT blocked: denying a failed send is a
// valid explicit operator resolution and sends nothing.
export const DENY_BLOCKED = new Set(["approved", "denied", "approving"]);

export interface ClaimItem {
  id: string;
  channel: string;
  draftReply: string | null;
  status: string;
  approvalRequestId?: string;
}

export type DraftValidation =
  | { ok: true }
  | { ok: false; code: number; error: string; auditEvent: string };

export function validateForSend(item: ClaimItem): DraftValidation {
  const draft = (item.draftReply || "").trim();
  if (draft.length < MIN_REPLY_LENGTH) {
    return {
      ok: false,
      code: 422,
      error: "Cannot send — draft is empty. Deny this item or wait for a draft.",
      auditEvent: "approve_blocked_empty",
    };
  }
  if (draft.length > MAX_REPLY_LENGTH) {
    return {
      ok: false,
      code: 422,
      error: `Draft exceeds ${MAX_REPLY_LENGTH} characters (${draft.length})`,
      auditEvent: "approve_blocked_too_long",
    };
  }
  if (!item.channel) {
    return {
      ok: false,
      code: 422,
      error: "Cannot send — no channel ID on this item",
      auditEvent: "approve_blocked_no_channel",
    };
  }
  return { ok: true };
}

export type ClaimResult<T> =
  | { kind: "not_found" }
  | { kind: "conflict"; status: string }
  | { kind: "invalid"; code: number; error: string; auditEvent: string }
  | { kind: "claimed"; item: T };

/**
 * Atomic claim transform. MUST be called inside mutateQueue's mutator (under
 * the queue lock). Only on `claimed` is the queue changed: the target flips to
 * `approving` with claim metadata, so any concurrent approve serialized after
 * this one sees a non-actionable status and conflicts instead of double-sending.
 */
export function claimForApproval<T extends ClaimItem>(
  queue: T[],
  id: string,
  requestId: string,
  nowIso: string,
): { queue: T[]; result: ClaimResult<T> } {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx === -1) return { queue, result: { kind: "not_found" } };

  const current = queue[idx];
  if (!APPROVE_ACTIONABLE.has(current.status)) {
    return { queue, result: { kind: "conflict", status: current.status } };
  }

  // Validate INSIDE the lock so a claim only ever happens for a sendable item.
  const v = validateForSend(current);
  if (!v.ok) {
    return {
      queue,
      result: { kind: "invalid", code: v.code, error: v.error, auditEvent: v.auditEvent },
    };
  }

  const claimed = {
    ...current,
    status: "approving",
    approvalStartedAt: nowIso,
    approvalRequestId: requestId,
  } as T;
  const next = queue.slice();
  next[idx] = claimed;
  return { queue: next, result: { kind: "claimed", item: claimed } };
}

/**
 * Finalize to `approved` ONLY if the item still carries our claim's
 * approvalRequestId. If it was superseded externally, do not overwrite.
 */
export function finalizeApproved<T extends ClaimItem>(
  queue: T[],
  id: string,
  requestId: string,
  sentAtIso: string,
  slackTs: string | undefined,
): { queue: T[]; finalized: boolean } {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx === -1) return { queue, finalized: false };
  const cur = queue[idx];
  if (cur.approvalRequestId !== requestId) return { queue, finalized: false };
  const next = queue.slice();
  next[idx] = { ...cur, status: "approved", sentAt: sentAtIso, slackTs } as T;
  return { queue: next, finalized: true };
}

/**
 * Mark a failed send as `send_failed` ONLY if our claim still owns the item.
 * approvalRequestId is deliberately RETAINED and the status is left
 * non-actionable: an operator retry cannot silently re-send after an ambiguous
 * Slack timeout. Resolving send_failed requires an explicit action (deny, or a
 * future deliberate re-queue) — never an automatic re-send.
 */
export function markSendFailed<T extends ClaimItem>(
  queue: T[],
  id: string,
  requestId: string,
  error: string,
  failedAtIso: string,
): { queue: T[]; marked: boolean } {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx === -1) return { queue, marked: false };
  const cur = queue[idx];
  if (cur.approvalRequestId !== requestId) return { queue, marked: false };
  const next = queue.slice();
  next[idx] = {
    ...cur,
    status: "send_failed",
    lastSendError: error,
    sendFailedAt: failedAtIso,
    approvalRequestId: requestId,
  } as T;
  return { queue: next, marked: true };
}

export type DenyResult<T> =
  | { kind: "not_found" }
  | { kind: "conflict"; status: string }
  | { kind: "denied"; item: T };

/**
 * Atomic deny transform. MUST be called inside mutateQueue's mutator. Returns
 * conflict (→ 409) when the item is approved/denied/approving so deny never
 * races an in-flight send.
 */
export function claimForDeny<T extends ClaimItem>(
  queue: T[],
  id: string,
  nowIso: string,
): { queue: T[]; result: DenyResult<T> } {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx === -1) return { queue, result: { kind: "not_found" } };
  const cur = queue[idx];
  if (DENY_BLOCKED.has(cur.status)) {
    return { queue, result: { kind: "conflict", status: cur.status } };
  }
  const denied = { ...cur, status: "denied", deniedAt: nowIso } as T;
  const next = queue.slice();
  next[idx] = denied;
  return { queue: next, result: { kind: "denied", item: denied } };
}
