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
  status: "pending" | "needs_draft" | "approved" | "denied";
}

function toApproval(item: QueueItem) {
  return {
    id: item.id,
    type: "slack" as const,
    tier: item.draftReply ? ("yellow" as const) : ("red" as const),
    channel: item.channelName,
    replyingTo: item.senderName,
    draft: item.draftReply || `[No draft — original: "${item.originalMessage.slice(0, 120)}"]`,
    createdAt: new Date(item.timestamp).toISOString(),
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
      .filter((a) => a.status === "pending" || a.status === "needs_draft")
      .map(toApproval);
    return NextResponse.json({ approvals: pending });
  } catch {
    return NextResponse.json({ approvals: [] });
  }
}
