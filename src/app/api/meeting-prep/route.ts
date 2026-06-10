import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";

const BRIEFS_FILE = "/Users/atlasai/.openclaw/data/meeting-briefs.json";

// Shape written by meeting-prep.mjs
interface Participant {
  email: string | null;
  name: string | null;
}

interface ActionItem {
  name: string;
  status: string;
}

interface SlackMessage {
  user: string;
  ts: string | null;
  text: string;
}

interface PendingApproval {
  id: string;
  title: string;
  createdAt: string | null;
}

interface KnowledgeChunk {
  source: string;
  title: string;
  date: string | null;
  snippet: string;
}

interface LastCall {
  id: string;
  date: number;
  title: string;
  summary: string;
  actionItems: string[];
  recordingLink: string | null;
}

interface UpcomingEvent {
  eventId: string;
  eventTitle: string;
  eventStart: string;
  eventEnd: string | null;
  calendar: "coaching" | "business";
  location: string | null;
  hangoutLink: string | null;
  participants: Participant[];
  clientName: string | null;
  minutesUntil: number;
  prepped: boolean;
  preppedAt: string | null;
  dmSent: boolean;
  dmSentAt: string | null;
  monday: { id: string; name: string } | null;
  channel: { id: string; name: string } | null;
  lastCall: LastCall | null;
  openTasks: ActionItem[];
  recentSlackActivity: SlackMessage[];
  pendingApprovals: PendingApproval[];
  relevantKnowledge: KnowledgeChunk[];
}

interface BriefsFile {
  updatedAt: string | null;
  authFailed: boolean;
  upcoming: UpcomingEvent[];
  note?: string;
}

function readBriefs(): BriefsFile {
  try {
    if (existsSync(BRIEFS_FILE)) {
      const parsed = JSON.parse(readFileSync(BRIEFS_FILE, "utf-8"));
      if (parsed && Array.isArray(parsed.upcoming)) {
        return parsed as BriefsFile;
      }
    }
  } catch {}
  return { updatedAt: null, authFailed: false, upcoming: [] };
}

export async function GET() {
  const briefs = readBriefs();
  // Recompute minutesUntil at request time so the countdown stays fresh
  // between 5-min service polls.
  const now = Date.now();
  const upcoming = briefs.upcoming
    .map((e) => ({
      ...e,
      minutesUntil: Math.max(0, Math.round((new Date(e.eventStart).getTime() - now) / 60000)),
    }))
    .filter((e) => e.minutesUntil >= 0 && new Date(e.eventStart).getTime() > now);

  return NextResponse.json(
    {
      updatedAt: briefs.updatedAt,
      authFailed: briefs.authFailed,
      note: briefs.note,
      upcoming,
      nextEvent: upcoming[0] || null,
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
