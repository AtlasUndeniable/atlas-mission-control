import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

const TASKS_FILE = "/Users/atlasai/.openclaw/data/rhys-tasks.json";

// Aging thresholds — used by the Follow-Ups panel + followup-digest service.
// Mirror these in /Users/atlasai/.openclaw/workspace/services/followup-digest/
// if you change them.
export const AGING = {
  STALE_DAYS: 14,    // yellow → red crossover + "stale" count in header
  ANCIENT_DAYS: 21,  // shows the subtle "stale" icon
} as const;

export interface DraftedFollowup {
  draft: string;
  draftedAt: string;
  sentToRhysAt: string | null;
  sources: Array<{ kind: "retrieval" | "slack" | "voice-profile"; summary: string }>;
}

export interface RhysTask {
  id: string;
  text: string;
  sourceCall: string;
  sourceDate: number | null;
  status: "pending" | "completed";
  extractedAt: string;
  completedAt: string | null;
  // Additive fields — safe to be missing on older records.
  draftedFollowups?: DraftedFollowup[];
}

export interface TasksFile {
  tasks: RhysTask[];
  updatedAt: string | null;
}

export function readTasksFile(): TasksFile {
  try {
    if (existsSync(TASKS_FILE)) {
      const d = JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
      if (Array.isArray(d.tasks)) return d;
    }
  } catch {}
  return { tasks: [], updatedAt: null };
}

export function writeTasksFile(data: TasksFile) {
  const tmp = `${TASKS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, TASKS_FILE);
}

export function setTaskStatus(id: string, status: "pending" | "completed"): RhysTask | null {
  const data = readTasksFile();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;

  const now = new Date().toISOString();
  data.tasks[idx] = {
    ...data.tasks[idx],
    status,
    completedAt: status === "completed" ? now : null,
  };
  data.updatedAt = now;
  writeTasksFile(data);
  return data.tasks[idx];
}

/** Append a drafted follow-up to a task. Returns the updated task or null. */
export function appendDraftedFollowup(
  id: string,
  draft: DraftedFollowup
): RhysTask | null {
  const data = readTasksFile();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const existing = data.tasks[idx].draftedFollowups ?? [];
  data.tasks[idx] = {
    ...data.tasks[idx],
    draftedFollowups: [...existing, draft],
  };
  data.updatedAt = new Date().toISOString();
  writeTasksFile(data);
  return data.tasks[idx];
}

/** Mark the most recent draft on a task as sent-to-Rhys. */
export function markLatestDraftSent(id: string): RhysTask | null {
  const data = readTasksFile();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const drafts = data.tasks[idx].draftedFollowups;
  if (!drafts?.length) return null;
  const latest = drafts[drafts.length - 1];
  if (latest.sentToRhysAt) return data.tasks[idx]; // already sent
  drafts[drafts.length - 1] = {
    ...latest,
    sentToRhysAt: new Date().toISOString(),
  };
  data.updatedAt = new Date().toISOString();
  writeTasksFile(data);
  return data.tasks[idx];
}

/**
 * Compute follow-up stats for the header + digest.
 */
export function computeStats(data: TasksFile) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const staleCutoff = now - AGING.STALE_DAYS * dayMs;
  const weekAgo = now - 7 * dayMs;

  let pending = 0;
  let completed = 0;
  let stale = 0;
  let completedThisWeek = 0;
  const turnarounds: number[] = [];

  for (const t of data.tasks) {
    if (t.status === "pending") {
      pending++;
      if (t.sourceDate && t.sourceDate < staleCutoff) stale++;
    } else if (t.status === "completed") {
      completed++;
      const completedMs = t.completedAt ? Date.parse(t.completedAt) : NaN;
      if (!Number.isNaN(completedMs) && completedMs >= weekAgo) completedThisWeek++;
      if (!Number.isNaN(completedMs) && t.sourceDate) {
        turnarounds.push((completedMs - t.sourceDate) / dayMs);
      }
    }
  }

  const avgTurnaroundDays = turnarounds.length
    ? Math.round(turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length)
    : null;

  return { pending, completed, stale, completedThisWeek, avgTurnaroundDays };
}
