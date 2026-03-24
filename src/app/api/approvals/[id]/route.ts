import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";

const QUEUE_FILE = "/Users/atlasai/.openclaw/data/slack-queue.json";
const AUDIT_LOG = "/Users/atlasai/.openclaw/logs/comms-audit.jsonl";
const SLACK_BRIDGE = "http://127.0.0.1:4006";

// ===== SAFETY LIMITS =====
const MAX_REPLY_LENGTH = 2000; // Slack message limit
const MIN_REPLY_LENGTH = 2; // Prevent empty/whitespace sends

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
}

// ===== AUDIT LOGGING =====
// Every approve/deny is logged immutably. If something goes wrong, we have a trail.
function auditLog(entry: Record<string, unknown>) {
  try {
    const line = JSON.stringify({
      ...entry,
      loggedAt: new Date().toISOString(),
    });
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
      body: JSON.stringify({
        text,
        thread_ts: threadTs || null,
      }),
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

  let items: QueueItem[];
  try {
    items = JSON.parse(readFileSync(QUEUE_FILE, "utf-8"));
  } catch {
    return NextResponse.json({ error: "Queue file corrupted" }, { status: 500 });
  }

  const item = items.find((a) => a.id === id);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  // ===== DOUBLE-SEND PREVENTION =====
  if (item.status === "approved" || item.status === "denied") {
    auditLog({ event: "double_action_blocked", id, action, existingStatus: item.status });
    return NextResponse.json(
      { error: `Already ${item.status}`, id },
      { status: 409 },
    );
  }

  // ===== DENY =====
  if (action === "deny") {
    const updated = items.map((a) =>
      a.id === id ? { ...a, status: "denied" } : a,
    );
    writeFileSync(QUEUE_FILE, JSON.stringify(updated, null, 2));

    auditLog({
      event: "denied",
      id,
      channel: item.channelName,
      sender: item.senderName,
      originalMessage: item.originalMessage.slice(0, 200),
    });

    return NextResponse.json({ ok: true, id, action: "deny" });
  }

  // ===== APPROVE — SAFETY CHECKS =====
  const draft = (item.draftReply || "").trim();

  if (draft.length < MIN_REPLY_LENGTH) {
    auditLog({ event: "approve_blocked_empty", id, draftLength: draft.length });
    return NextResponse.json(
      { error: "Cannot send — draft is empty. Deny this item or wait for a draft." },
      { status: 422 },
    );
  }

  if (draft.length > MAX_REPLY_LENGTH) {
    auditLog({ event: "approve_blocked_too_long", id, draftLength: draft.length });
    return NextResponse.json(
      { error: `Draft exceeds ${MAX_REPLY_LENGTH} characters (${draft.length})` },
      { status: 422 },
    );
  }

  if (!item.channel) {
    auditLog({ event: "approve_blocked_no_channel", id });
    return NextResponse.json(
      { error: "Cannot send — no channel ID on this item" },
      { status: 422 },
    );
  }

  // ===== SEND VIA SLACK BRIDGE AS RHYS =====
  auditLog({
    event: "approve_sending",
    id,
    channel: item.channel,
    channelName: item.channelName,
    sender: item.senderName,
    threadTs: item.messageTs,
    draftLength: draft.length,
    draftPreview: draft.slice(0, 100),
  });

  const result = await sendAsRhys(item.channel, draft, item.messageTs);

  if (!result.ok) {
    auditLog({
      event: "send_failed",
      id,
      error: result.error,
      channel: item.channel,
    });
    return NextResponse.json(
      { error: `Slack send failed: ${result.error}` },
      { status: 502 },
    );
  }

  // ===== SUCCESS — UPDATE QUEUE =====
  const updated = items.map((a) =>
    a.id === id
      ? { ...a, status: "approved", sentAt: new Date().toISOString(), slackTs: result.ts }
      : a,
  );
  writeFileSync(QUEUE_FILE, JSON.stringify(updated, null, 2));

  auditLog({
    event: "sent_as_rhys",
    id,
    channel: item.channel,
    channelName: item.channelName,
    sender: item.senderName,
    slackTs: result.ts,
    draftLength: draft.length,
  });

  return NextResponse.json({ ok: true, id, action: "approve", slackTs: result.ts });
}
