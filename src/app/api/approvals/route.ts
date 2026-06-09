import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";

const QUEUE_FILE = "/Users/atlasai/.openclaw/data/slack-queue.json";

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
  status:
    | "pending"
    | "needs_draft"
    | "drafted"
    | "approving"
    | "approved"
    | "denied"
    | "send_failed";
  lastSendError?: string;
  sendFailedAt?: string;
}

const ACTIONABLE_STATUSES = new Set(["pending", "needs_draft", "drafted"]);
// send_failed must stay VISIBLE to the operator, but it is NOT in
// ACTIONABLE_STATUSES so the approve route 409s it — it can never be directly
// re-sent without a separate explicit action (deny, or a future re-queue).
const VISIBLE_STATUSES = new Set([...ACTIONABLE_STATUSES, "send_failed"]);

function toApproval(item: QueueItem) {
  const hasDraft = !!item.draftReply && item.draftReply !== "None";
  const failed = item.status === "send_failed";
  return {
    id: item.id,
    type: "slack" as const,
    tier: hasDraft ? ("yellow" as const) : ("red" as const),
    channel: item.channelName,
    replyingTo: item.senderName,
    draft: hasDraft ? item.draftReply! : null,
    originalMessage: item.originalMessage || "",
    createdAt: new Date(item.timestamp).toISOString(),
    status: item.status,
    sendable: !failed,
    lastSendError: failed ? item.lastSendError ?? null : null,
    sendFailedAt: failed ? item.sendFailedAt ?? null : null,
  };
}

export async function GET() {
  if (!existsSync(QUEUE_FILE)) {
    return NextResponse.json({ approvals: [] });
  }

  try {
    const raw = readFileSync(QUEUE_FILE, "utf-8");
    const items: QueueItem[] = JSON.parse(raw);
    const pending = items
      .filter((a) => VISIBLE_STATUSES.has(a.status))
      .map(toApproval);
    return NextResponse.json({ approvals: pending });
  } catch {
    return NextResponse.json({ approvals: [] });
  }
}
