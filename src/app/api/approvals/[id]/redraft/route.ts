import { NextRequest, NextResponse } from "next/server";
import { readFileSync, appendFileSync, existsSync } from "fs";
import { mutateQueue, peekQueue } from "@/lib/queue-writer";

const QUEUE_FILE = "/Users/atlasai/.openclaw/data/slack-queue.json";
const AUDIT_LOG = "/Users/atlasai/.openclaw/logs/comms-audit.jsonl";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

function getAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  // Fallback: read from .env.local (Turbopack dev mode doesn't always inject env vars)
  try {
    const envPath = "/Users/atlasai/atlas-mission-control/.env.local";
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (match) return match[1].trim();
    }
  } catch {}
  return "";
}

// Voice guide — inlined to avoid filesystem reads at request time
const VOICE_GUIDE = [
  "Write as Rhys Livingstone, CEO of Undeniable Mentoring.",
  "Short punchy sentences. No filler. No sign-offs.",
  "Conversational like a coaching text message.",
  "Australian English (colour, organise, behaviour).",
  'Openers: "So...", "Look...", "Let\'s..."',
  "No markdown formatting. No bullets. No emoji.",
  "Under 100 words.",
].join(" ");

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

function auditLog(entry: Record<string, unknown>) {
  try {
    appendFileSync(
      AUDIT_LOG,
      JSON.stringify({ ...entry, loggedAt: new Date().toISOString() }) + "\n",
    );
  } catch {}
}

async function generateRedraft(
  channelName: string,
  originalMessage: string,
  originalDraft: string,
  feedback: string,
  apiKey: string,
): Promise<string> {
  const prompt = [
    `Redraft this Slack reply for #${channelName}.`,
    `The original message from the client: "${originalMessage}"`,
    `Previous draft: "${originalDraft}"`,
    `Rhys's feedback on the draft: "${feedback}"`,
    VOICE_GUIDE,
    "Reply with ONLY the new draft text. No explanation, no quotes, no prefix.",
  ].join("\n");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("Empty response from model");
  return text.trim();
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const feedback = (body.feedback || "").trim();

  if (!feedback) {
    return NextResponse.json(
      { error: "Feedback is required for redrafting" },
      { status: 400 },
    );
  }

  const ANTHROPIC_KEY = getAnthropicKey();
  if (!ANTHROPIC_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 },
    );
  }

  if (!existsSync(QUEUE_FILE)) {
    return NextResponse.json({ error: "Queue file not found" }, { status: 404 });
  }

  const items = peekQueue<QueueItem>();
  const item = items.find((a) => a.id === id);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const originalDraft = item.draftReply || "";

  auditLog({
    event: "redraft_requested",
    id,
    channel: item.channelName,
    feedback,
    originalDraftLength: originalDraft.length,
  });

  try {
    const newDraft = await generateRedraft(
      item.channelName,
      item.originalMessage,
      originalDraft,
      feedback,
      ANTHROPIC_KEY,
    );

    await mutateQueue<QueueItem>((q) =>
      q.map((a) => (a.id === id ? { ...a, draftReply: newDraft, status: "pending" } : a)),
    );

    auditLog({
      event: "redraft_complete",
      id,
      channel: item.channelName,
      newDraftLength: newDraft.length,
      newDraftPreview: newDraft.slice(0, 100),
    });

    return NextResponse.json({ ok: true, id, draft: newDraft });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    auditLog({ event: "redraft_failed", id, error: errMsg });
    return NextResponse.json(
      { error: `Redraft failed: ${errMsg}` },
      { status: 502 },
    );
  }
}
