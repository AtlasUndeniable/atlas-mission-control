import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export const LIBRARIAN_REPORTS_DIR = "/Users/atlasai/.openclaw/workspace/tools/librarian-reports";
export const LIBRARIAN_CONTEXT_PACKS_DIR = "/Users/atlasai/.openclaw/workspace/tools/librarian-context-packs";
export const LIBRARIAN_REVIEW_QUEUE_DIR = "/Users/atlasai/.openclaw/workspace/tools/librarian-review-queue";

export type LibrarianSourceName =
  | "memoryReports"
  | "artifactHygieneReports"
  | "contextPacks"
  | "reviewQueue";

export type LibrarianSourceHealth = {
  source: LibrarianSourceName;
  directory: string;
  present: boolean;
  filesFound: number;
  validRecordCount: number;
  invalidRecordCount: number;
  lastModified: string | null;
  errors: Array<{
    path: string;
    message: string;
  }>;
};

export type MemoryReportSummary = {
  kind: "memory_maintenance_report";
  path: string;
  generatedAt: string | null;
  notesScanned: number;
  brokenLinks: number;
  orphanNotes: number;
  weakNodes: number;
  highDegreeHubs: number;
};

export type ArtifactHygieneReportSummary = {
  kind: "artifact_hygiene_report";
  path: string;
  generatedAt: string | null;
  exportFilesScanned: number;
  exportFilesMatched: number;
  orphanExports: number;
  exportsMissingMetadata: number;
};

export type ContextPackSummary = {
  id: string;
  kind: string;
  path: string;
  generatedAt: string | null;
  title: string;
  canonicalCount: number;
  graphConnectedCount: number;
  tagMatchedCount: number;
  keywordInferredCount: number;
  totalMembers: number;
};

export type ReviewQueueSummary = {
  path: string;
  generatedAt: string | null;
  totalItems: number;
  pendingItems: number;
  riskySuggestions: number;
  topSuggestionTypes: Array<{
    type: string;
    count: number;
  }>;
};

export type WorkspaceMemoryMaintenanceProjection = {
  readOnly: true;
  status: "ready" | "partial" | "not_ready" | "error";
  generatedAt: string;
  roots: {
    reports: string;
    contextPacks: string;
    reviewQueue: string;
  };
  sources: Record<LibrarianSourceName, LibrarianSourceHealth>;
  summary: {
    lastRunAt: string | null;
    notesScanned: number;
    brokenLinks: number;
    orphanNotes: number;
    weakNodes: number;
    highDegreeHubs: number;
    orphanExports: number;
    exportsMissingMetadata: number;
    contextPacksGenerated: number;
    reviewQueueItems: number;
    riskySuggestions: number;
  };
  reports: {
    memoryMaintenance: MemoryReportSummary | null;
    artifactHygiene: ArtifactHygieneReportSummary | null;
    contextPacks: ContextPackSummary[];
    reviewQueue: ReviewQueueSummary | null;
    latestReports: Array<{
      kind: "memory_maintenance_report" | "artifact_hygiene_report" | "context_pack" | "review_queue";
      title: string;
      path: string;
      generatedAt: string | null;
    }>;
  };
};

type JsonRecord = Record<string, unknown>;

type ParsedJsonFile = {
  path: string;
  modifiedAt: string;
  value: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function firstNumber(value: unknown, paths: string[][]): number {
  for (const path of paths) {
    const numberValue = asNumber(getPath(value, path));
    if (numberValue !== null) return numberValue;
  }
  return 0;
}

function arrayLength(value: unknown, path: string[]): number | null {
  const next = getPath(value, path);
  return Array.isArray(next) ? next.length : null;
}

function firstArrayLength(value: unknown, paths: string[][]): number {
  for (const path of paths) {
    const length = arrayLength(value, path);
    if (length !== null) return length;
  }
  return 0;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

async function listJsonFiles(
  directory: string,
  source: LibrarianSourceName,
  matches: (name: string) => boolean,
): Promise<{
  files: ParsedJsonFile[];
  health: LibrarianSourceHealth;
}> {
  const errors: LibrarianSourceHealth["errors"] = [];
  let names: string[] = [];

  try {
    names = await readdir(directory);
  } catch {
    return {
      files: [],
      health: {
        source,
        directory,
        present: false,
        filesFound: 0,
        validRecordCount: 0,
        invalidRecordCount: 0,
        lastModified: null,
        errors: [],
      },
    };
  }

  const jsonPaths = names
    .filter((name) => name.endsWith(".json") && matches(name))
    .map((name) => join(directory, name));
  const files: ParsedJsonFile[] = [];
  const modifiedTimes: string[] = [];

  for (const path of jsonPaths) {
    try {
      const [info, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
      const modifiedAt = isoFromMs(info.mtimeMs);
      modifiedTimes.push(modifiedAt);
      files.push({ path, modifiedAt, value: JSON.parse(content) as unknown });
    } catch (error) {
      errors.push({
        path,
        message: error instanceof Error ? error.message : "Unable to read librarian JSON file",
      });
    }
  }

  return {
    files,
    health: {
      source,
      directory,
      present: jsonPaths.length > 0,
      filesFound: jsonPaths.length,
      validRecordCount: files.length,
      invalidRecordCount: errors.length,
      lastModified: modifiedTimes.sort().at(-1) ?? null,
      errors,
    },
  };
}

function generatedAtFor(file: ParsedJsonFile): string | null {
  return isRecord(file.value) ? asString(file.value.generatedAt) ?? file.modifiedAt : file.modifiedAt;
}

function latestByGeneratedAt<T extends { generatedAt: string | null }>(records: T[]): T | null {
  if (!records.length) return null;
  return [...records].sort((a, b) => Date.parse(b.generatedAt ?? "") - Date.parse(a.generatedAt ?? "")).at(0) ?? null;
}

function memoryReportFrom(file: ParsedJsonFile): MemoryReportSummary | null {
  if (!isRecord(file.value)) return null;

  return {
    kind: "memory_maintenance_report",
    path: file.path,
    generatedAt: generatedAtFor(file),
    notesScanned: firstNumber(file.value, [["stats", "noteCount"], ["counts", "notesScanned"], ["summary", "notesScanned"]]),
    brokenLinks: firstNumber(file.value, [["stats", "brokenLinks"], ["counts", "brokenLinks"], ["summary", "brokenLinks"]])
      || firstArrayLength(file.value, [["broken"], ["brokenLinks"]]),
    orphanNotes: firstNumber(file.value, [["stats", "orphanCount"], ["counts", "orphanNotes"], ["summary", "orphanNotes"]])
      || firstArrayLength(file.value, [["orphans"], ["orphanNotes"]]),
    weakNodes: firstNumber(file.value, [["counts", "weakNodes"], ["summary", "weakNodes"]])
      || firstArrayLength(file.value, [["structure", "weak"], ["weakNodes"]]),
    highDegreeHubs: firstNumber(file.value, [["counts", "highDegreeHubs"], ["summary", "highDegreeHubs"]])
      || firstArrayLength(file.value, [["hubs"], ["structure", "hubsByDegree"], ["highDegreeHubs"]]),
  };
}

function artifactHygieneReportFrom(file: ParsedJsonFile): ArtifactHygieneReportSummary | null {
  if (!isRecord(file.value)) return null;
  const counts = isRecord(file.value.counts) ? file.value.counts : file.value;

  return {
    kind: "artifact_hygiene_report",
    path: file.path,
    generatedAt: generatedAtFor(file),
    exportFilesScanned: firstNumber(counts, [["exportFilesScanned"], ["exportsScanned"], ["totalExports"]]),
    exportFilesMatched: firstNumber(counts, [["exportFilesMatched"], ["matchedExports"]]),
    orphanExports: firstNumber(counts, [["orphanExports"], ["exportsWithoutMetadata"], ["orphanedExports"]]),
    exportsMissingMetadata: firstNumber(counts, [["exportsMissingMetadata"], ["missingMetadata"], ["missingSidecars"]]),
  };
}

function countMembers(value: unknown, key: string): number {
  return arrayLength(value, ["members", key]) ?? 0;
}

function contextPackFrom(file: ParsedJsonFile): ContextPackSummary | null {
  if (!isRecord(file.value)) return null;
  const id = asString(file.value.id) ?? basename(file.path, ".json").replace(/^context-pack-/, "");
  const kind = asString(file.value.kind) ?? asString(getPath(file.value, ["spec", "kind"])) ?? "context";
  const canonicalCount = countMembers(file.value, "canonical");
  const graphConnectedCount = countMembers(file.value, "graphConnected");
  const tagMatchedCount = countMembers(file.value, "tagMatched");
  const keywordInferredCount = countMembers(file.value, "keywordInferred");

  return {
    id,
    kind,
    path: file.path,
    generatedAt: generatedAtFor(file),
    title: `${kind.replaceAll("_", " ")} / ${id.replaceAll("-", " ")}`,
    canonicalCount,
    graphConnectedCount,
    tagMatchedCount,
    keywordInferredCount,
    totalMembers: canonicalCount + graphConnectedCount + tagMatchedCount + keywordInferredCount,
  };
}

function isRiskySuggestion(suggestion: unknown): boolean {
  if (!isRecord(suggestion)) return false;
  const severity = asString(suggestion.severity)?.toLowerCase() ?? "";
  const type = asString(suggestion.type)?.toLowerCase() ?? "";
  const proposal = asString(suggestion.proposal)?.toLowerCase() ?? "";
  return (
    severity.includes("approval") ||
    severity.includes("critical") ||
    severity.includes("high") ||
    /delete|move|rename|merge|archive|quarantine|visibility|overwrite|retarget/.test(`${type} ${proposal}`)
  );
}

function reviewQueueFrom(file: ParsedJsonFile): ReviewQueueSummary | null {
  if (!isRecord(file.value)) return null;
  const suggestions = Array.isArray(file.value.suggestions) ? file.value.suggestions : [];
  const typeCounts = new Map<string, number>();

  for (const suggestion of suggestions) {
    if (!isRecord(suggestion)) continue;
    const type = asString(suggestion.type) ?? "unknown";
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }

  return {
    path: file.path,
    generatedAt: generatedAtFor(file),
    totalItems: asNumber(file.value.total) ?? suggestions.length,
    pendingItems: suggestions.filter((suggestion) => isRecord(suggestion) && suggestion.status === "pending").length,
    riskySuggestions: suggestions.filter(isRiskySuggestion).length,
    topSuggestionTypes: [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([type, count]) => ({ type, count })),
  };
}

function summarizeLatestReports(projection: Pick<WorkspaceMemoryMaintenanceProjection["reports"], "memoryMaintenance" | "artifactHygiene" | "contextPacks" | "reviewQueue">) {
  return [
    projection.memoryMaintenance ? {
      kind: "memory_maintenance_report" as const,
      title: "Memory maintenance report",
      path: projection.memoryMaintenance.path,
      generatedAt: projection.memoryMaintenance.generatedAt,
    } : null,
    projection.artifactHygiene ? {
      kind: "artifact_hygiene_report" as const,
      title: "Artifact hygiene report",
      path: projection.artifactHygiene.path,
      generatedAt: projection.artifactHygiene.generatedAt,
    } : null,
    projection.reviewQueue ? {
      kind: "review_queue" as const,
      title: "Review queue",
      path: projection.reviewQueue.path,
      generatedAt: projection.reviewQueue.generatedAt,
    } : null,
    ...projection.contextPacks.slice(0, 4).map((pack) => ({
      kind: "context_pack" as const,
      title: pack.title,
      path: pack.path,
      generatedAt: pack.generatedAt,
    })),
  ].filter((report): report is NonNullable<typeof report> => Boolean(report))
    .sort((a, b) => Date.parse(b.generatedAt ?? "") - Date.parse(a.generatedAt ?? ""));
}

function statusFor(sources: Record<LibrarianSourceName, LibrarianSourceHealth>): WorkspaceMemoryMaintenanceProjection["status"] {
  const values = Object.values(sources);
  const valid = values.reduce((total, source) => total + source.validRecordCount, 0);
  const invalid = values.reduce((total, source) => total + source.invalidRecordCount, 0);
  const present = values.some((source) => source.present);

  if (valid > 0 && invalid > 0) return "partial";
  if (valid > 0) return "ready";
  if (present && invalid > 0) return "error";
  return "not_ready";
}

export async function getWorkspaceMemoryMaintenanceProjection(options?: {
  reportsDir?: string;
  contextPacksDir?: string;
  reviewQueueDir?: string;
}): Promise<WorkspaceMemoryMaintenanceProjection> {
  const reportsDir = options?.reportsDir ?? LIBRARIAN_REPORTS_DIR;
  const contextPacksDir = options?.contextPacksDir ?? LIBRARIAN_CONTEXT_PACKS_DIR;
  const reviewQueueDir = options?.reviewQueueDir ?? LIBRARIAN_REVIEW_QUEUE_DIR;

  const [memoryFiles, artifactFiles, contextFiles, reviewFiles] = await Promise.all([
    listJsonFiles(reportsDir, "memoryReports", (name) => /^memory-maintenance-.+\.json$/.test(name)),
    listJsonFiles(reportsDir, "artifactHygieneReports", (name) => /artifact.*(hygiene|report).+\.json$/.test(name)),
    listJsonFiles(contextPacksDir, "contextPacks", (name) => /^context-pack-.+\.json$/.test(name)),
    listJsonFiles(reviewQueueDir, "reviewQueue", (name) => /^review-queue-.+\.json$/.test(name)),
  ]);

  const memoryReports = memoryFiles.files.map(memoryReportFrom).filter((report): report is MemoryReportSummary => Boolean(report));
  const artifactReports = artifactFiles.files.map(artifactHygieneReportFrom).filter((report): report is ArtifactHygieneReportSummary => Boolean(report));
  const contextPacks = contextFiles.files.map(contextPackFrom).filter((pack): pack is ContextPackSummary => Boolean(pack))
    .sort((a, b) => Date.parse(b.generatedAt ?? "") - Date.parse(a.generatedAt ?? ""));
  const reviewQueues = reviewFiles.files.map(reviewQueueFrom).filter((queue): queue is ReviewQueueSummary => Boolean(queue));

  const memoryMaintenance = latestByGeneratedAt(memoryReports);
  const artifactHygiene = latestByGeneratedAt(artifactReports);
  const reviewQueue = latestByGeneratedAt(reviewQueues);

  const sources = {
    memoryReports: memoryFiles.health,
    artifactHygieneReports: artifactFiles.health,
    contextPacks: contextFiles.health,
    reviewQueue: reviewFiles.health,
  } satisfies Record<LibrarianSourceName, LibrarianSourceHealth>;
  const reports = {
    memoryMaintenance,
    artifactHygiene,
    contextPacks,
    reviewQueue,
  };

  return {
    readOnly: true,
    status: statusFor(sources),
    generatedAt: new Date().toISOString(),
    roots: {
      reports: reportsDir,
      contextPacks: contextPacksDir,
      reviewQueue: reviewQueueDir,
    },
    sources,
    summary: {
      lastRunAt: [memoryMaintenance?.generatedAt, artifactHygiene?.generatedAt, reviewQueue?.generatedAt, contextPacks[0]?.generatedAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
      notesScanned: memoryMaintenance?.notesScanned ?? 0,
      brokenLinks: memoryMaintenance?.brokenLinks ?? 0,
      orphanNotes: memoryMaintenance?.orphanNotes ?? 0,
      weakNodes: memoryMaintenance?.weakNodes ?? 0,
      highDegreeHubs: memoryMaintenance?.highDegreeHubs ?? 0,
      orphanExports: artifactHygiene?.orphanExports ?? 0,
      exportsMissingMetadata: artifactHygiene?.exportsMissingMetadata ?? 0,
      contextPacksGenerated: contextPacks.length,
      reviewQueueItems: reviewQueue?.totalItems ?? 0,
      riskySuggestions: reviewQueue?.riskySuggestions ?? 0,
    },
    reports: {
      ...reports,
      latestReports: summarizeLatestReports(reports),
    },
  };
}
