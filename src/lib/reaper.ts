/**
 * Stale Obligation Reaper — read-only projection over rhys-tasks.json.
 *
 * IMPORTANT: the rows here are EXTRACTED Fireflies/Rhys action items. They are
 * NOT confirmed live obligations. This module only ever READS (via the
 * existing read-only `readTasksFile`). It never completes, deletes, mutates,
 * or sends anything. Its sole job is to project pending items for human triage
 * with conservative, explainable suggestions.
 */

import { readTasksFile, AGING, type RhysTask } from "@/lib/rhys-tasks-store";
import { extractClientName } from "@/lib/client-match";

const DAY_MS = 24 * 60 * 60 * 1000;

// The only labels the UI offers. A machine suggestion may only ever be one of
// these, and we deliberately never auto-suggest the judgement-heavy ones
// ("still real" / "delegate" / "ignore") — those require a human.
export const TRIAGE_LABELS = [
  "still real",
  "draft follow-up",
  "delegate",
  "mark stale",
  "ignore",
  "needs Rhys",
] as const;
export type TriageLabel = (typeof TRIAGE_LABELS)[number];

// Past this many days with zero draft activity, an extracted item is far more
// likely superseded than live. Set well beyond ANCIENT_DAYS (21) on purpose so
// the suggestion stays conservative.
const LIKELY_STALE_DAYS = 45;

export interface ProvenanceSource {
  kind: string;
  summary: string;
}

export interface ReaperItem {
  id: string;
  client: string | null;
  clientLabel: string;
  text: string;
  status: RhysTask["status"];
  sourceCall: string;
  sourceDate: number | null;
  extractedAt: string;
  ageDays: number | null;
  aging: "fresh" | "aging" | "stale" | "unknown";
  draftCount: number;
  draftSent: boolean;
  provenance: ProvenanceSource[];
  signalScore: number;
  suggestedLabel: TriageLabel | null;
  suggestionReason: string | null;
}

export interface ReaperSummary {
  totalPending: number;
  stale: number; // ageDays > AGING.STALE_DAYS
  ancient: number; // ageDays > AGING.ANCIENT_DAYS
  withDraft: number;
  unattributed: number;
  withSuggestion: number;
}

export interface ReaperData {
  items: ReaperItem[];
  summary: ReaperSummary;
  thresholds: {
    staleDays: number;
    ancientDays: number;
    likelyStaleDays: number;
  };
  sortExplanation: string;
  updatedAt: string | null;
}

function daysSince(ts: number | null): number | null {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / DAY_MS);
}

function agingBand(days: number | null): ReaperItem["aging"] {
  if (days === null) return "unknown";
  if (days <= 5) return "fresh";
  if (days <= AGING.STALE_DAYS) return "aging";
  return "stale";
}

function provenanceOf(task: RhysTask): ProvenanceSource[] {
  const out: ProvenanceSource[] = [];
  for (const d of task.draftedFollowups ?? []) {
    for (const s of d.sources ?? []) {
      out.push({ kind: s.kind, summary: s.summary });
    }
  }
  return out;
}

/**
 * Conservative, explainable suggestion. Returns null when nothing is safely
 * inferable. We never guess "still real" / "delegate" / "ignore" — those are
 * human judgement calls and faking them would defeat the point of triage.
 */
function suggest(
  ageDays: number | null,
  client: string | null,
  draftCount: number,
  draftSent: boolean,
): { label: TriageLabel | null; reason: string | null } {
  if (draftSent) {
    return {
      label: "needs Rhys",
      reason:
        "A follow-up draft was already sent to Rhys’s DM; the decision now sits with him.",
    };
  }
  if (draftCount > 0) {
    return {
      label: "draft follow-up",
      reason:
        "A follow-up draft already exists on this item; review and progress it.",
    };
  }
  if (!client) {
    return {
      label: "needs Rhys",
      reason:
        "No client or person is inferable from the source; Rhys must classify it.",
    };
  }
  if (ageDays !== null && ageDays > LIKELY_STALE_DAYS) {
    return {
      label: "mark stale",
      reason: `No activity ${ageDays}d after the source call — likely superseded. Verify before treating as live.`,
    };
  }
  return { label: null, reason: null };
}

// Old + high-signal first. Draft activity means a human already engaged the
// item, so it outranks raw age; an identifiable client makes it more
// actionable. Documented in the API response as `sortExplanation`.
function signalScore(
  ageDays: number | null,
  draftCount: number,
  hasClient: boolean,
): number {
  const age = ageDays ?? 0;
  return age + (draftCount > 0 ? 40 : 0) + (hasClient ? 8 : 0);
}

const SORT_EXPLANATION =
  "signalScore = ageDays + 40 if a follow-up draft exists + 8 if a client is identifiable; sorted desc, then by age desc.";

export function buildReaperData(): ReaperData {
  const file = readTasksFile();
  const pending = file.tasks.filter((t) => t.status === "pending");

  const items: ReaperItem[] = pending.map((task) => {
    const ageDays = daysSince(task.sourceDate);
    const client = extractClientName(task.sourceCall);
    const drafts = task.draftedFollowups ?? [];
    const draftCount = drafts.length;
    const draftSent = drafts.some((d) => !!d.sentToRhysAt);
    const { label, reason } = suggest(ageDays, client, draftCount, draftSent);
    return {
      id: task.id,
      client,
      clientLabel: client ?? "Unattributed source",
      text: task.text,
      status: task.status,
      sourceCall: task.sourceCall,
      sourceDate: task.sourceDate,
      extractedAt: task.extractedAt,
      ageDays,
      aging: agingBand(ageDays),
      draftCount,
      draftSent,
      provenance: provenanceOf(task),
      signalScore: signalScore(ageDays, draftCount, !!client),
      suggestedLabel: label,
      suggestionReason: reason,
    };
  });

  items.sort((a, b) => {
    if (b.signalScore !== a.signalScore) return b.signalScore - a.signalScore;
    const ad = a.ageDays ?? -1;
    const bd = b.ageDays ?? -1;
    if (bd !== ad) return bd - ad;
    return a.extractedAt.localeCompare(b.extractedAt);
  });

  const summary: ReaperSummary = {
    totalPending: items.length,
    stale: items.filter((i) => i.ageDays !== null && i.ageDays > AGING.STALE_DAYS)
      .length,
    ancient: items.filter(
      (i) => i.ageDays !== null && i.ageDays > AGING.ANCIENT_DAYS,
    ).length,
    withDraft: items.filter((i) => i.draftCount > 0).length,
    unattributed: items.filter((i) => !i.client).length,
    withSuggestion: items.filter((i) => i.suggestedLabel !== null).length,
  };

  return {
    items,
    summary,
    thresholds: {
      staleDays: AGING.STALE_DAYS,
      ancientDays: AGING.ANCIENT_DAYS,
      likelyStaleDays: LIKELY_STALE_DAYS,
    },
    sortExplanation: SORT_EXPLANATION,
    updatedAt: file.updatedAt,
  };
}
