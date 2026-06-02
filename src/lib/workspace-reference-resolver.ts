import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type WorkspaceReferenceSourceType =
  | "librarian-context-pack"
  | "librarian-report"
  | "librarian-review-queue"
  | "workspace-state"
  | "artifact-metadata";

export type WorkspaceReferenceConfidence = "high" | "medium" | "low";
export type WorkspaceReferenceCoverage = "matched" | "thin" | "none";

export interface WorkspaceReferenceInput {
  prompt: string;
  title?: string;
  workspaceId?: string;
  project?: string;
  room?: string;
}

export interface WorkspaceReferenceSourceRoot {
  key: string;
  path: string;
  present: boolean;
}

export interface WorkspaceResolvedReference {
  handle: string;
  title: string;
  sourceType: WorkspaceReferenceSourceType;
  sourcePath: string;
  pathSummary: string;
  excerpt: string;
  updatedAt?: string;
  freshness?: string;
  confidence: WorkspaceReferenceConfidence;
  score: number;
  matchedTerms: string[];
}

export interface WorkspaceReferencePacket {
  resolvedAt: string;
  coverage: WorkspaceReferenceCoverage;
  rootsRead: WorkspaceReferenceSourceRoot[];
  references: WorkspaceResolvedReference[];
  guidance: string[];
  userFacingSummary: string;
  internalSummary: string;
}

export interface WorkspaceReferenceResolverOptions {
  contextPacksRoot?: string;
  reportsRoot?: string;
  reviewQueueRoot?: string;
  stateCurrentPath?: string;
  maxReferences?: number;
  maxCandidateReads?: number;
  now?: () => Date;
}

interface CandidatePath {
  path: string;
  sourceType: WorkspaceReferenceSourceType;
  sourceKey: string;
  filenameScore: number;
  matchedTerms: string[];
}

interface ScoredReference extends WorkspaceResolvedReference {
  contentScore: number;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "give",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "our",
  "the",
  "this",
  "to",
  "top",
  "update",
  "what",
  "with",
]);

const MEMORY_INTENT_TERMS = new Set([
  "artifact",
  "bands",
  "calder",
  "call",
  "calls",
  "client",
  "current",
  "handover",
  "hire",
  "memory",
  "model",
  "pay",
  "recent",
  "reference",
  "report",
  "ricky",
  "source",
  "transcript",
  "trends",
  "workspace",
]);

const MAX_FILE_CHARS = 80_000;
const MAX_EXCERPT_CHARS = 420;
const MAX_REFERENCES = 5;
const MAX_CANDIDATE_READS = 32;

export const WORKSPACE_REFERENCE_CONTEXT_PACKS_ROOT = "/Users/atlasai/.openclaw/workspace/tools/librarian-context-packs";
export const WORKSPACE_REFERENCE_REPORTS_ROOT = "/Users/atlasai/.openclaw/workspace/tools/librarian-reports";
export const WORKSPACE_REFERENCE_REVIEW_QUEUE_ROOT = "/Users/atlasai/.openclaw/workspace/tools/librarian-review-queue";
export const WORKSPACE_REFERENCE_STATE_CURRENT_FILE = "/Users/atlasai/.openclaw/workspace/state/state-current.md";

export function createEmptyWorkspaceReferencePacket(
  input: WorkspaceReferenceInput,
  options: { now?: () => Date; rootsRead?: WorkspaceReferenceSourceRoot[] } = {},
): WorkspaceReferencePacket {
  const resolvedAt = (options.now ?? (() => new Date()))().toISOString();
  return {
    resolvedAt,
    coverage: "none",
    rootsRead: options.rootsRead ?? [],
    references: [],
    guidance: missingReferenceGuidance(input),
    userFacingSummary: "No matching Workspace references were resolved for this prompt.",
    internalSummary: "references=none",
  };
}

export async function resolveWorkspaceReferences(
  input: WorkspaceReferenceInput,
  options: WorkspaceReferenceResolverOptions = {},
): Promise<WorkspaceReferencePacket> {
  const now = options.now ?? (() => new Date());
  const roots = sourceRoots(options);
  const rootsRead = roots.map((root) => ({ key: root.key, path: root.path, present: existsSync(root.path) }));
  const terms = tokenize([input.prompt, input.title].filter(Boolean).join(" "));

  if (terms.length === 0 || !promptLooksReferenceDependent(terms)) {
    return createEmptyWorkspaceReferencePacket(input, { now, rootsRead });
  }

  const candidates = await collectCandidatePaths(roots, terms);
  const selectedPaths = candidates
    .sort((a, b) => b.filenameScore - a.filenameScore || b.path.localeCompare(a.path))
    .slice(0, options.maxCandidateReads ?? MAX_CANDIDATE_READS);

  const scored: ScoredReference[] = [];
  for (const candidate of selectedPaths) {
    const reference = await readAndScoreReference(candidate, terms);
    if (reference && reference.score >= 8) scored.push(reference);
  }

  const maxReferences = options.maxReferences ?? MAX_REFERENCES;
  const references = dedupeScoredReferences(scored)
    .sort((a, b) => b.score - a.score || dateValue(b.updatedAt) - dateValue(a.updatedAt))
    .slice(0, maxReferences)
    .map(toResolvedReference);

  if (references.length === 0) {
    return createEmptyWorkspaceReferencePacket(input, { now, rootsRead });
  }

  const coverage = references.some((reference) => reference.confidence === "high")
    ? "matched"
    : "thin";
  const guidance = coverage === "matched"
    ? [
      "Use only these resolved Workspace references for memory-backed claims.",
      "Do not claim broader search across calls, Slack, files, transcripts, or the vault.",
    ]
    : [
      "Resolved references are thin; produce a useful draft from the prompt.",
      "Mark facts that need confirmation instead of implying unavailable retrieval.",
    ];

  return {
    resolvedAt: now().toISOString(),
    coverage,
    rootsRead,
    references,
    guidance,
    userFacingSummary: `${references.length} Workspace reference${references.length === 1 ? "" : "s"} resolved (${coverage}).`,
    internalSummary: [
      `references=${references.length}`,
      `coverage=${coverage}`,
      `handles=${references.map((reference) => reference.handle).join(",")}`,
      `paths=${references.map((reference) => reference.sourcePath).join(",")}`,
    ].join("; "),
  };
}

function sourceRoots(options: WorkspaceReferenceResolverOptions) {
  return [
    {
      key: "librarian-context-packs",
      path: options.contextPacksRoot ?? WORKSPACE_REFERENCE_CONTEXT_PACKS_ROOT,
      sourceType: "librarian-context-pack" as const,
    },
    {
      key: "librarian-reports",
      path: options.reportsRoot ?? WORKSPACE_REFERENCE_REPORTS_ROOT,
      sourceType: "librarian-report" as const,
    },
    {
      key: "librarian-review-queue",
      path: options.reviewQueueRoot ?? WORKSPACE_REFERENCE_REVIEW_QUEUE_ROOT,
      sourceType: "librarian-review-queue" as const,
    },
    {
      key: "workspace-state",
      path: options.stateCurrentPath ?? WORKSPACE_REFERENCE_STATE_CURRENT_FILE,
      sourceType: "workspace-state" as const,
      file: true,
    },
  ];
}

async function collectCandidatePaths(
  roots: ReturnType<typeof sourceRoots>,
  terms: string[],
): Promise<CandidatePath[]> {
  const candidates: CandidatePath[] = [];
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    if (root.file) {
      candidates.push({
        path: root.path,
        sourceType: root.sourceType,
        sourceKey: root.key,
        filenameScore: scoreTextForTerms(basename(root.path), terms) + 4,
        matchedTerms: matchedTerms(basename(root.path), terms),
      });
      continue;
    }

    let entries: Array<{ isFile: () => boolean; name: string }>;
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(root.path, entry.name);
      if (!allowedReferenceFile(path)) continue;
      const filenameScore = scoreFilename(path, terms, root.key);
      if (filenameScore <= 0 && !alwaysConsider(path, root.key)) continue;
      candidates.push({
        path,
        sourceType: sourceTypeForPath(path, root.sourceType),
        sourceKey: root.key,
        filenameScore,
        matchedTerms: matchedTerms(entry.name, terms),
      });
    }
  }
  return candidates;
}

function allowedReferenceFile(path: string): boolean {
  return [".json", ".jsonl", ".md"].includes(extname(path).toLowerCase());
}

function alwaysConsider(path: string, sourceKey: string): boolean {
  const name = basename(path).toLowerCase();
  if (sourceKey === "librarian-context-packs") return name.startsWith("context-pack");
  return /^(daily-delta|memory-maintenance|memory-repair-plan|artifact-hygiene|review-queue|ingestion-hygiene|index-queue)/.test(name);
}

function sourceTypeForPath(path: string, fallback: WorkspaceReferenceSourceType): WorkspaceReferenceSourceType {
  const name = basename(path).toLowerCase();
  if (name.includes("artifact-hygiene") || name.includes("metadata")) return "artifact-metadata";
  if (name.startsWith("review-queue") || name.startsWith("index-queue") || name.startsWith("ingestion-queue")) {
    return "librarian-review-queue";
  }
  return fallback;
}

async function readAndScoreReference(candidate: CandidatePath, terms: string[]): Promise<ScoredReference | null> {
  try {
    const info = await stat(candidate.path);
    if (!info.isFile()) return null;
    const raw = (await readFile(candidate.path, "utf8")).slice(0, MAX_FILE_CHARS);
    const summary = summarizeReferenceContent(candidate.path, raw, terms);
    const searchable = `${candidate.path} ${summary.title} ${summary.searchText} ${summary.excerpt}`;
    const contentScore = scoreTextForTerms(searchable, terms);
    const score = candidate.filenameScore + contentScore + recencyBoost(info.mtimeMs);
    const termsMatched = [...new Set([...candidate.matchedTerms, ...matchedTerms(searchable, terms)])];
    if (termsMatched.length === 0) return null;
    if (score < 8) return null;

    return {
      handle: handleFromPath(candidate.path),
      title: summary.title || titleFromPath(candidate.path),
      sourceType: candidate.sourceType,
      sourcePath: candidate.path,
      pathSummary: pathSummary(candidate.path),
      excerpt: sanitizeReferenceExcerpt(summary.excerpt || summary.searchText || titleFromPath(candidate.path)),
      updatedAt: new Date(info.mtimeMs).toISOString(),
      freshness: summary.generatedAt ? `generated ${summary.generatedAt}` : `modified ${new Date(info.mtimeMs).toISOString()}`,
      confidence: confidenceFor(score),
      score: Math.round(score),
      contentScore,
      matchedTerms: termsMatched.slice(0, 8),
    };
  } catch {
    return null;
  }
}

function promptLooksReferenceDependent(terms: string[]): boolean {
  return terms.some((term) => MEMORY_INTENT_TERMS.has(term));
}

function dedupeScoredReferences(references: ScoredReference[]): ScoredReference[] {
  const byHandle = new Map<string, ScoredReference>();
  for (const reference of references) {
    const existing = byHandle.get(reference.handle);
    if (!existing || reference.score > existing.score) byHandle.set(reference.handle, reference);
  }
  return [...byHandle.values()];
}

function toResolvedReference(reference: ScoredReference): WorkspaceResolvedReference {
  return {
    handle: reference.handle,
    title: reference.title,
    sourceType: reference.sourceType,
    sourcePath: reference.sourcePath,
    pathSummary: reference.pathSummary,
    excerpt: reference.excerpt,
    ...(reference.updatedAt ? { updatedAt: reference.updatedAt } : {}),
    ...(reference.freshness ? { freshness: reference.freshness } : {}),
    confidence: reference.confidence,
    score: reference.score,
    matchedTerms: reference.matchedTerms,
  };
}

function summarizeReferenceContent(path: string, raw: string, terms: string[]): {
  title: string;
  excerpt: string;
  searchText: string;
  generatedAt?: string;
} {
  if (path.endsWith(".json") || path.endsWith(".jsonl")) {
    const parsed = parseJsonish(raw);
    if (parsed !== null) return summarizeJson(path, parsed, terms);
  }
  return summarizeMarkdown(path, raw, terms);
}

function parseJsonish(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    const values = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 80)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((value) => value !== null);
    return values.length ? values : null;
  }
}

function summarizeJson(path: string, parsed: unknown, terms: string[]) {
  const title = titleFromJson(path, parsed);
  const generatedAt = isRecord(parsed) && typeof parsed.generatedAt === "string" ? parsed.generatedAt : undefined;
  const fragments = jsonFragments(parsed, terms);
  return {
    title,
    generatedAt,
    excerpt: sanitizeReferenceExcerpt(fragments.slice(0, 4).join(" ")),
    searchText: fragments.join(" "),
  };
}

function titleFromJson(path: string, parsed: unknown): string {
  if (isRecord(parsed)) {
    if (typeof parsed.title === "string") return parsed.title;
    if (typeof parsed.id === "string") return `${titleFromPath(path)} (${parsed.id})`;
    if (typeof parsed.generatedAt === "string") return `${titleFromPath(path)} (${parsed.generatedAt.slice(0, 10)})`;
  }
  return titleFromPath(path);
}

function jsonFragments(value: unknown, terms: string[]): string[] {
  const fragments: string[] = [];
  const visit = (candidate: unknown, depth: number) => {
    if (fragments.length >= 32 || depth > 4) return;
    if (typeof candidate === "string") {
      const compacted = compact(candidate, 260);
      if (compacted && (scoreTextForTerms(compacted, terms) > 0 || fragments.length < 8)) fragments.push(compacted);
      return;
    }
    if (typeof candidate === "number" || typeof candidate === "boolean") return;
    if (Array.isArray(candidate)) {
      const scoredItems = candidate
        .map((item) => ({ item, score: scoreTextForTerms(JSON.stringify(item).slice(0, 1200), terms) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      scoredItems.forEach(({ item }) => visit(item, depth + 1));
      return;
    }
    if (isRecord(candidate)) {
      const priorityKeys = [
        "title",
        "artifactId",
        "id",
        "summary",
        "proposal",
        "rationale",
        "evidence",
        "note",
        "target",
        "keywords",
        "seeds",
        "records",
        "suggestions",
        "counts",
        "stats",
      ];
      for (const key of priorityKeys) {
        if (key in candidate) visit(candidate[key], depth + 1);
      }
    }
  };
  visit(value, 0);
  return fragments;
}

function summarizeMarkdown(path: string, raw: string, terms: string[]) {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\|[-:\s|]+\|$/.test(line));
  const heading = lines.find((line) => line.startsWith("#"))?.replace(/^#+\s*/, "").trim() ?? titleFromPath(path);
  const scored = lines
    .filter((line) => !line.startsWith("#"))
    .map((line, index) => ({ line, index, score: scoreTextForTerms(line, terms) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored.filter((line) => line.score > 0).slice(0, 4);
  const fallback = scored.slice(0, 3);
  const selected = (best.length ? best : fallback).map(({ line }) => line);
  return {
    title: heading,
    excerpt: sanitizeReferenceExcerpt(selected.join(" ")),
    searchText: lines.slice(0, 80).join(" "),
  };
}

function tokenize(text: string): string[] {
  return [...new Set(text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token)))];
}

function matchedTerms(text: string, terms: string[]): string[] {
  const normalized = text.toLowerCase();
  return terms.filter((term) => normalized.includes(term));
}

function scoreTextForTerms(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += term.length >= 6 ? 8 : 5;
  }
  return score;
}

function scoreFilename(path: string, terms: string[], sourceKey: string): number {
  const name = basename(path).toLowerCase();
  let score = scoreTextForTerms(name, terms) * 2;
  if (sourceKey === "librarian-context-packs" && name.includes("rhys")) score += 4;
  if (/daily-delta|artifact-hygiene|memory-maintenance|review-queue/.test(name)) score += 2;
  return score;
}

function recencyBoost(mtimeMs: number): number {
  const ageDays = Math.max(0, (Date.now() - mtimeMs) / 86_400_000);
  return Math.max(0, 6 - Math.min(ageDays, 30) / 5);
}

function confidenceFor(score: number): WorkspaceReferenceConfidence {
  if (score >= 40) return "high";
  if (score >= 18) return "medium";
  return "low";
}

function dateValue(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function handleFromPath(path: string): string {
  return basename(path).replace(/\.(jsonl|json|md)$/i, "");
}

function titleFromPath(path: string): string {
  return handleFromPath(path).replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pathSummary(path: string): string {
  const name = basename(path);
  if (path.includes("/librarian-context-packs/")) return `librarian-context-packs/${name}`;
  if (path.includes("/librarian-reports/")) return `librarian-reports/${name}`;
  if (path.includes("/librarian-review-queue/")) return `librarian-review-queue/${name}`;
  if (name === "state-current.md") return "workspace-state/state-current.md";
  return name;
}

function sanitizeReferenceExcerpt(value: string): string {
  return compact(value, MAX_EXCERPT_CHARS)
    .replace(/\/Users\/atlasai\/\.openclaw\/workspace\/[^\s;,)]+/g, "[workspace reference]")
    .replace(/\/Users\/atlasai\/[^\s;,)]+/g, "[local reference]");
}

function compact(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}...` : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingReferenceGuidance(input: WorkspaceReferenceInput): string[] {
  return [
    "No matching Workspace references were resolved before this response.",
    "Do not claim to have searched calls, Slack, transcripts, files, or the vault.",
    `Use the prompt${input.title ? ` and task title (${input.title})` : ""} to produce a useful draft, and mark missing facts as needing confirmation.`,
  ];
}
