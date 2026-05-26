import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export const WORKSPACE_LIBRARIAN_CONTEXT_PACKS_ROOT = "/Users/atlasai/.openclaw/workspace/tools/librarian-context-packs";
export const WORKSPACE_LIBRARIAN_REPORTS_ROOT = "/Users/atlasai/.openclaw/workspace/tools/librarian-reports";
export const WORKSPACE_LIBRARIAN_REVIEW_QUEUE_ROOT = "/Users/atlasai/.openclaw/workspace/tools/librarian-review-queue";
export const WORKSPACE_LIBRARIAN_STATE_CURRENT_FILE = "/Users/atlasai/.openclaw/workspace/state/state-current.md";

export type WorkspaceLibrarianReference = {
  title: string;
  type: string;
  sourcePath: string;
  summary?: string;
  relevanceReason: string;
  updatedAt?: string;
};

export type WorkspaceLibrarianReferenceJob = {
  title: string;
  prompt: string;
  room: string;
  project: string;
  requesterRole: string;
  intendedWorkflow: string;
};

export type WorkspaceLibrarianReferenceResolverOptions = {
  contextPacksRoot?: string;
  reportsRoot?: string;
  reviewQueueRoot?: string;
  stateCurrentPath?: string;
  maxReferences?: number;
};

type Candidate = WorkspaceLibrarianReference & {
  score: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compact(value: string, maxLength = 240): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function dateValue(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function jobTokens(job: WorkspaceLibrarianReferenceJob): string {
  return [
    job.title,
    job.prompt,
    job.room,
    job.project,
    job.requesterRole,
    job.intendedWorkflow,
  ].join(" ").toLowerCase();
}

function referenceIntent(job: WorkspaceLibrarianReferenceJob): "audits" | "memory-knowledge" | "rhys" | "general" {
  const text = jobTokens(job);
  if (job.room === "training" || job.project === "memory-knowledge" || /memory|knowledge|librarian|context|training/.test(text)) {
    return "memory-knowledge";
  }
  if (job.room === "audits" || job.project === "l2-audits" || /audit|l2|typeform|qa/.test(text)) {
    return "audits";
  }
  if (job.room === "home" || job.project === "undeniable-os" || /rhys|undeniable/.test(text)) {
    return "rhys";
  }
  return "general";
}

async function directFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(root, entry.name));
}

function allowedReportFile(path: string): boolean {
  const name = basename(path);
  if (!/\.(json|md)$/.test(name)) return false;
  return /^(memory-maintenance|memory-repair-plan|artifact-hygiene|review-queue|latest-handoff|graph-diff)/.test(name);
}

function titleFromPath(path: string): string {
  return basename(path)
    .replace(/\.(json|md)$/i, "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function summaryFromJson(path: string, value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.spec)) {
    const spec = value.spec;
    const keywords = Array.isArray(spec.keywords) ? spec.keywords.slice(0, 6).join(", ") : "";
    const seeds = Array.isArray(spec.seeds) ? spec.seeds.slice(0, 3).join(", ") : "";
    return compact([keywords ? `Keywords: ${keywords}.` : "", seeds ? `Seeds: ${seeds}.` : ""].filter(Boolean).join(" "));
  }
  if (isRecord(value.stats)) {
    const stats = value.stats;
    return compact(Object.entries(stats).slice(0, 5).map(([key, count]) => `${key}: ${count}`).join(", "));
  }
  if (typeof value.total === "number") return `Review queue suggestions: ${value.total}.`;
  if (typeof value.generatedAt === "string") return `Generated ${value.generatedAt}.`;
  return undefined;
}

function summaryFromMarkdown(content: string): string | undefined {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("|---"));
  return lines.length ? compact(lines.slice(0, 3).join(" ")) : undefined;
}

async function readSummary(path: string): Promise<{ title?: string; summary?: string; generatedAt?: string }> {
  const content = await readFile(path, "utf8");
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) return {};
    const id = typeof parsed.id === "string" ? parsed.id : undefined;
    const kind = typeof parsed.kind === "string" ? parsed.kind : undefined;
    return {
      title: id ? `${kind === "workflow" ? "Workflow" : kind === "user" ? "User" : "Librarian"} context pack: ${id}` : undefined,
      summary: summaryFromJson(path, parsed),
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : undefined,
    };
  }
  const heading = content.split("\n").find((line) => line.trim().startsWith("#"));
  return {
    title: heading?.replace(/^#+\s*/, "").trim(),
    summary: summaryFromMarkdown(content),
  };
}

function scoreFor(path: string, job: WorkspaceLibrarianReferenceJob): { score: number; reason: string; type: string } {
  const name = basename(path).toLowerCase();
  const intent = referenceIntent(job);
  let score = 1;
  let reason = "Existing Librarian output is available as a read-only pointer.";
  let type = "librarian-report";

  if (name.startsWith("context-pack")) type = "librarian-context-pack";
  if (name.startsWith("review-queue")) type = "librarian-review-queue";
  if (name === "state-current.md") type = "workspace-state";

  if (intent === "memory-knowledge" && name.includes("memory-knowledge")) {
    score += 90;
    reason = "Matches memory/training/knowledge job context.";
  }
  if (intent === "audits" && name.includes("audits")) {
    score += 90;
    reason = "Matches audit room/project workflow.";
  }
  if (intent === "rhys" && name.includes("rhys")) {
    score += 90;
    reason = "Matches Rhys/home/Undeniable job context.";
  }
  if (name.includes("memory-maintenance") && intent === "memory-knowledge") score += 25;
  if (name.includes("artifact-hygiene") && intent === "audits") score += 20;
  if (name.includes("review-queue")) score += 10;
  if (name.includes("latest-handoff") || name === "state-current.md") score += 8;
  if (name.endsWith(".md")) score += 2;

  return { score, reason, type };
}

export async function resolveWorkspaceLibrarianReferences(
  job: WorkspaceLibrarianReferenceJob,
  options: WorkspaceLibrarianReferenceResolverOptions = {},
): Promise<WorkspaceLibrarianReference[]> {
  const contextPacksRoot = options.contextPacksRoot ?? WORKSPACE_LIBRARIAN_CONTEXT_PACKS_ROOT;
  const reportsRoot = options.reportsRoot ?? WORKSPACE_LIBRARIAN_REPORTS_ROOT;
  const reviewQueueRoot = options.reviewQueueRoot ?? WORKSPACE_LIBRARIAN_REVIEW_QUEUE_ROOT;
  const stateCurrentPath = options.stateCurrentPath ?? WORKSPACE_LIBRARIAN_STATE_CURRENT_FILE;
  const maxReferences = options.maxReferences ?? 5;

  const paths = [
    ...(await directFiles(contextPacksRoot)),
    ...(await directFiles(reportsRoot)).filter(allowedReportFile),
    ...(await directFiles(reviewQueueRoot)).filter(allowedReportFile),
    ...(existsSync(stateCurrentPath) ? [stateCurrentPath] : []),
  ];

  const candidates: Candidate[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      const scored = scoreFor(path, job);
      candidates.push({
        title: titleFromPath(path),
        type: scored.type,
        sourcePath: path,
        relevanceReason: scored.reason,
        updatedAt: new Date(info.mtimeMs).toISOString(),
        score: scored.score + Math.min(dateValue(new Date(info.mtimeMs).toISOString()) / 1_000_000_000_000, 2),
      });
    } catch {
      continue;
    }
  }

  const selected = candidates
    .sort((a, b) => b.score - a.score || dateValue(b.updatedAt) - dateValue(a.updatedAt))
    .slice(0, maxReferences);

  return Promise.all(selected.map(async (candidate) => {
    try {
      const summary = await readSummary(candidate.sourcePath);
      return {
        title: summary.title ?? candidate.title,
        type: candidate.type,
        sourcePath: candidate.sourcePath,
        ...(summary.summary ? { summary: summary.summary } : {}),
        relevanceReason: candidate.relevanceReason,
        updatedAt: summary.generatedAt ?? candidate.updatedAt,
      };
    } catch {
      return {
        title: candidate.title,
        type: candidate.type,
        sourcePath: candidate.sourcePath,
        relevanceReason: candidate.relevanceReason,
        updatedAt: candidate.updatedAt,
      };
    }
  }));
}
