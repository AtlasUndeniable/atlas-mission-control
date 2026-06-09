import { NextRequest, NextResponse } from "next/server";
import { appendFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { mutateQueue } from "@/lib/queue-writer";
import {
  claimForApproval,
  claimForDeny,
  finalizeApproved,
  markSendFailed,
  type ClaimResult,
  type DenyResult,
} from "@/lib/approval-claim";

const QUEUE_FILE = "/Users/atlasai/.openclaw/data/slack-queue.json";
const AUDIT_LOG = "/Users/atlasai/.openclaw/logs/comms-audit.jsonl";
const SLACK_BRIDGE = "http://127.0.0.1:4006";

interface QueueItem {
  id: string;
  channel: string;
  channelName: string;
  sender: string;
  senderName: string;
  originalMessage: string;
  draftReply: string | null;
  timestamp: number;
  messageTs: string;
  status: string;
  approvalRequestId?: string;
  approvalStartedAt?: string;
  sentAt?: string;
  slackTs?: string;
  lastSendError?: string;
  sendFailedAt?: string;
  deniedAt?: string;
}

// ===== AUDIT LOGGING =====
// Every claim/send/finalize/deny/failure is logged immutably for the trail.
function auditLog(entry: Record<string, unknown>) {
  try {
    const line = JSON.stringify({ ...entry, loggedAt: new Date().toISOString() });
    appendFileSync(AUDIT_LOG, line + "\n");
  } catch {
    // Audit log failure must not block the operation
  }
}

// ===== SLACK SEND (via bridge — sends as Rhys using user token) =====
async function sendAsRhys(
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<{ ok: boolean; error?: string; ts?: string }> {
  try {
    const res = await fetch(`${SLACK_BRIDGE}/channels/${channelId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, thread_ts: threadTs || null, as_rhys: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, ts: data.ts };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ===== ROUTE HANDLER =====
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const action = body.action as "approve" | "deny";

  if (!["approve", "deny"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  if (!existsSync(QUEUE_FILE)) {
    return NextResponse.json({ error: "Queue file not found" }, { status: 404 });
  }

  // ===== DENY — atomic, never races an in-flight send =====
  if (action === "deny") {
    // Holder typed as the full union (not a literal) so TS control-flow
    // narrowing works after the closure assignment inside mutateQueue.
    let outcome: DenyResult<QueueItem> | undefined;
    await mutateQueue<QueueItem>((q) => {
      const r = claimForDeny<QueueItem>(q, id, new Date().toISOString());
      outcome = r.result;
      return r.queue;
    });

    if (!outcome) {
      auditLog({ event: "deny_internal_error", id });
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
    if (outcome.kind === "not_found") {
      auditLog({ event: "deny_not_found", id });
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    if (outcome.kind === "conflict") {
      auditLog({ event: "double_action_blocked", id, action, existingStatus: outcome.status });
      return NextResponse.json(
        { error: `Cannot deny — item is ${outcome.status}`, id },
        { status: 409 },
      );
    }
    auditLog({
      event: "denied",
      id,
      channel: outcome.item.channelName,
      sender: outcome.item.senderName,
      originalMessage: (outcome.item.originalMessage || "").slice(0, 200),
    });
    return NextResponse.json({ ok: true, id, action: "deny" });
  }

  // ===== APPROVE — PHASE 1: atomic claim under lock (BEFORE any Slack send) ==
  const approvalRequestId = randomUUID();
  const startedAt = new Date().toISOString();
  // Holder typed as the full union (not a literal) so TS control-flow
  // narrowing works after the closure assignment inside mutateQueue.
  let claim: ClaimResult<QueueItem> | undefined;

  await mutateQueue<QueueItem>((q) => {
    const r = claimForApproval<QueueItem>(q, id, approvalRequestId, startedAt);
    claim = r.result;
    return r.queue;
  });

  if (!claim) {
    auditLog({ event: "approve_internal_error", id, approvalRequestId });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (claim.kind === "not_found") {
    auditLog({ event: "approve_not_found", id });
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (claim.kind === "conflict") {
    // Another approve already claimed it (or it is terminal). Do NOT send.
    auditLog({ event: "double_action_blocked", id, action, existingStatus: claim.status });
    return NextResponse.json(
      { error: `Already ${claim.status}`, id },
      { status: 409 },
    );
  }
  if (claim.kind === "invalid") {
    auditLog({ event: claim.auditEvent, id });
    return NextResponse.json({ error: claim.error }, { status: claim.code });
  }

  // claim.kind === "claimed": we exclusively own this item for this requestId.
  const claimed = claim.item;
  const draft = (claimed.draftReply || "").trim();

  auditLog({
    event: "approve_claimed",
    id,
    approvalRequestId,
    approvalStartedAt: startedAt,
    channel: claimed.channel,
    channelName: claimed.channelName,
    sender: claimed.senderName,
  });
  auditLog({
    event: "approve_sending",
    id,
    approvalRequestId,
    channel: claimed.channel,
    channelName: claimed.channelName,
    sender: claimed.senderName,
    threadTs: claimed.messageTs,
    draftLength: draft.length,
    draftPreview: draft.slice(0, 100),
  });

  // ===== PHASE 2: Slack send (outside lock) on the exact claimed snapshot ===
  const result = await sendAsRhys(claimed.channel, draft, claimed.messageTs);

  // ===== PHASE 3a: send FAILED → mark non-sendable (only if still our claim) =
  if (!result.ok) {
    let marked = false;
    await mutateQueue<QueueItem>((q) => {
      const r = markSendFailed<QueueItem>(
        q,
        id,
        approvalRequestId,
        result.error || "Unknown error",
        new Date().toISOString(),
      );
      marked = r.marked;
      return r.queue;
    });
    auditLog({
      event: "send_failed",
      id,
      approvalRequestId,
      error: result.error,
      channel: claimed.channel,
      markedSendFailed: marked,
    });
    // 502: item is now `send_failed` (not pending) so an operator retry cannot
    // silently double-send after an ambiguous Slack timeout.
    return NextResponse.json(
      { error: `Slack send failed: ${result.error}`, status: "send_failed" },
      { status: 502 },
    );
  }

  // ===== PHASE 3b: send OK → finalize to approved (only if still our claim) ==
  const sentAt = new Date().toISOString();
  let finalized = false;
  await mutateQueue<QueueItem>((q) => {
    const r = finalizeApproved<QueueItem>(q, id, approvalRequestId, sentAt, result.ts);
    finalized = r.finalized;
    return r.queue;
  });

  if (!finalized) {
    // Send went out but our claim was superseded externally — record it; do
    // not overwrite whatever now owns the item.
    auditLog({
      event: "finalize_conflict",
      id,
      approvalRequestId,
      slackTs: result.ts,
      note: "Slack send succeeded but claim no longer owned the item",
    });
  } else {
    auditLog({
      event: "sent_as_rhys",
      id,
      approvalRequestId,
      channel: claimed.channel,
      channelName: claimed.channelName,
      sender: claimed.senderName,
      slackTs: result.ts,
      draftLength: draft.length,
    });
  }

  return NextResponse.json({ ok: true, id, action: "approve", slackTs: result.ts });
}
