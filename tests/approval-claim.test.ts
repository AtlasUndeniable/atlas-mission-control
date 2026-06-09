/**
 * Isolated unit test for the approval claim/finalize/fail logic.
 * Pure in-memory queue — NO Slack, NO fs, NO network, NO Next runtime.
 * Run: node --test tests/approval-claim.test.ts   (Node 25 strips TS types)
 *
 * Lives outside src/ so it is never pulled into the Next build graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimForApproval,
  claimForDeny,
  finalizeApproved,
  markSendFailed,
  validateForSend,
  MAX_REPLY_LENGTH,
} from "../src/lib/approval-claim.ts";

type Item = {
  id: string;
  channel: string;
  draftReply: string | null;
  status: string;
  approvalRequestId?: string;
  [k: string]: unknown;
};

function freshQueue(): Item[] {
  return [
    { id: "A1", channel: "C123", draftReply: "Hello there, valid draft.", status: "drafted" },
    { id: "A2", channel: "C999", draftReply: "Another one.", status: "pending" },
  ];
}

test("concurrent approve claims: lock serialization → exactly one claim, second 409s", () => {
  let q = freshQueue();

  // Request #1 claims under lock.
  const r1 = claimForApproval(q, "A1", "req-1", "2026-05-17T00:00:00Z");
  q = r1.queue; // lock writes claim #1
  assert.equal(r1.result.kind, "claimed");

  // Request #2, serialized AFTER by the same lock, sees `approving`.
  const r2 = claimForApproval(q, "A1", "req-2", "2026-05-17T00:00:01Z");
  q = r2.queue;
  assert.equal(r2.result.kind, "conflict");
  if (r2.result.kind === "conflict") assert.equal(r2.result.status, "approving");

  // Item is owned by req-1 only — no double claim.
  const it = q.find((x) => x.id === "A1")!;
  assert.equal(it.status, "approving");
  assert.equal(it.approvalRequestId, "req-1");
});

test("finalize only with matching approvalRequestId", () => {
  let q = freshQueue();
  q = claimForApproval(q, "A1", "req-1", "t0").queue;

  // Wrong requestId must not finalize.
  const bad = finalizeApproved(q, "A1", "req-OTHER", "t1", "111.222");
  assert.equal(bad.finalized, false);
  assert.equal(bad.queue.find((x) => x.id === "A1")!.status, "approving");

  // Correct requestId finalizes.
  const good = finalizeApproved(q, "A1", "req-1", "t1", "111.222");
  assert.equal(good.finalized, true);
  const it = good.queue.find((x) => x.id === "A1")!;
  assert.equal(it.status, "approved");
  assert.equal(it.sentAt, "t1");
  assert.equal(it.slackTs, "111.222");
});

test("markSendFailed: non-sendable, requestId retained, only with matching id", () => {
  let q = freshQueue();
  q = claimForApproval(q, "A1", "req-1", "t0").queue;

  const wrong = markSendFailed(q, "A1", "req-X", "timeout", "tf");
  assert.equal(wrong.marked, false);

  const r = markSendFailed(q, "A1", "req-1", "channel_not_found", "tf");
  assert.equal(r.marked, true);
  const it = r.queue.find((x) => x.id === "A1")!;
  assert.equal(it.status, "send_failed");
  assert.equal(it.lastSendError, "channel_not_found");
  assert.equal(it.sendFailedAt, "tf");
  assert.equal(it.approvalRequestId, "req-1"); // retained → not silently re-sendable

  // A subsequent approve cannot claim a send_failed item.
  const reclaim = claimForApproval(r.queue, "A1", "req-2", "t2");
  assert.equal(reclaim.result.kind, "conflict");
});

test("validateForSend gates empty / too-long / no-channel and blocks the claim", () => {
  const empty = validateForSend({ id: "x", channel: "C1", draftReply: " ", status: "drafted" });
  assert.deepEqual(
    empty.ok === false && [empty.code, empty.auditEvent],
    [422, "approve_blocked_empty"],
  );
  const long = validateForSend({
    id: "x", channel: "C1", draftReply: "z".repeat(MAX_REPLY_LENGTH + 1), status: "drafted",
  });
  assert.equal(long.ok === false && long.auditEvent, "approve_blocked_too_long");
  const noCh = validateForSend({ id: "x", channel: "", draftReply: "ok valid", status: "drafted" });
  assert.equal(noCh.ok === false && noCh.auditEvent, "approve_blocked_no_channel");

  // Invalid item is NOT claimed (queue unchanged, no `approving`).
  const q: Item[] = [{ id: "B", channel: "", draftReply: "hi", status: "drafted" }];
  const r = claimForApproval(q, "B", "req-1", "t0");
  assert.equal(r.result.kind, "invalid");
  assert.equal(r.queue[0].status, "drafted");
});

test("claimForApproval not_found", () => {
  const r = claimForApproval(freshQueue(), "NOPE", "req-1", "t0");
  assert.equal(r.result.kind, "not_found");
});

test("deny does not race an in-flight send (approving → 409)", () => {
  let q = freshQueue();
  q = claimForApproval(q, "A1", "req-1", "t0").queue; // now approving

  const d = claimForDeny(q, "A1", "td");
  assert.equal(d.result.kind, "conflict");
  if (d.result.kind === "conflict") assert.equal(d.result.status, "approving");
  assert.equal(d.queue.find((x) => x.id === "A1")!.status, "approving"); // untouched

  // Deny works on an actionable item, and not_found is handled.
  const ok = claimForDeny(freshQueue(), "A2", "td");
  assert.equal(ok.result.kind, "denied");
  assert.equal(ok.queue.find((x) => x.id === "A2")!.status, "denied");
  assert.equal(claimForDeny(freshQueue(), "ZZZ", "td").result.kind, "not_found");
});

test("end-to-end: two approve flows on shared queue → only ONE send happens", () => {
  let q = freshQueue();
  let sends = 0;
  const fakeSend = () => { sends++; return { ok: true, ts: "1.2" }; };

  // Flow 1: claim → send → finalize
  const c1 = claimForApproval(q, "A1", "r1", "t0");
  q = c1.queue;
  assert.equal(c1.result.kind, "claimed");
  if (c1.result.kind === "claimed") fakeSend();
  q = finalizeApproved(q, "A1", "r1", "t1", "1.2").queue;

  // Flow 2 (concurrent, serialized after): claim must conflict → NO send
  const c2 = claimForApproval(q, "A1", "r2", "t2");
  q = c2.queue;
  assert.equal(c2.result.kind, "conflict");
  if (c2.result.kind === "claimed") fakeSend(); // unreachable

  assert.equal(sends, 1, "exactly one Slack send across both concurrent flows");
  assert.equal(q.find((x) => x.id === "A1")!.status, "approved");
});
