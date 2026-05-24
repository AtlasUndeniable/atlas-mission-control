import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentRun,
  Approval,
  AuditRun,
  ContentBatch,
  ContractValidationResult,
  MemoryMaintenanceRun,
} from "./workspace-contracts";

export const WORKSPACE_RUNS_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-runs";

export type WorkspaceRunCollectionName =
  | "agentRuns"
  | "auditRuns"
  | "contentBatches"
  | "approvals"
  | "memoryMaintenanceRuns";

export type WorkspaceRunRecord =
  | AgentRun
  | AuditRun
  | ContentBatch
  | Approval
  | MemoryMaintenanceRun;

export type WorkspaceRunValidators = {
  agentRuns: (value: unknown) => ContractValidationResult<AgentRun>;
  auditRuns: (value: unknown) => ContractValidationResult<AuditRun>;
  contentBatches: (value: unknown) => ContractValidationResult<ContentBatch>;
  approvals: (value: unknown) => ContractValidationResult<Approval>;
  memoryMaintenanceRuns: (value: unknown) => ContractValidationResult<MemoryMaintenanceRun>;
};

export type WorkspaceRunSourceHealth = {
  collection: WorkspaceRunCollectionName;
  present: boolean;
  paths: {
    jsonl: string;
    json: string;
    present: string[];
    missing: string[];
  };
  recordCount: number;
  validRecordCount: number;
  invalidRecordCount: number;
  lastModified: string | null;
  errors: Array<{
    source: string;
    ref?: string;
    message: string;
  }>;
};

export type WorkspaceRunsProjection = {
  root: string;
  sources: Record<WorkspaceRunCollectionName, WorkspaceRunSourceHealth>;
  records: {
    agentRuns: AgentRun[];
    auditRuns: AuditRun[];
    contentBatches: ContentBatch[];
    approvals: Approval[];
    memoryMaintenanceRuns: MemoryMaintenanceRun[];
  };
  counts: {
    agentRuns: number;
    auditRuns: number;
    contentBatches: number;
    approvals: number;
    memoryMaintenanceRuns: number;
    totalValidRecords: number;
    totalInvalidRecords: number;
    sourcesPresent: number;
    sourcesMissing: number;
  };
};

type SourceDescriptor<T extends WorkspaceRunRecord> = {
  collection: WorkspaceRunCollectionName;
  jsonlName: string;
  jsonName: string;
  validate: (value: unknown) => ContractValidationResult<T>;
};

type ParsedCandidate = {
  value: unknown;
  source: string;
  ref?: string;
};

const SOURCE_FILES = {
  agentRuns: { jsonlName: "agent-runs.jsonl", jsonName: "agent-runs.json" },
  auditRuns: { jsonlName: "audit-runs.jsonl", jsonName: "audit-runs.json" },
  contentBatches: { jsonlName: "content-batches.jsonl", jsonName: "content-batches.json" },
  approvals: { jsonlName: "approvals.jsonl", jsonName: "approvals.json" },
  memoryMaintenanceRuns: { jsonlName: "memory-maintenance-runs.jsonl", jsonName: "memory-maintenance-runs.json" },
} as const satisfies Record<WorkspaceRunCollectionName, { jsonlName: string; jsonName: string }>;

function emptyRecords(): WorkspaceRunsProjection["records"] {
  return {
    agentRuns: [],
    auditRuns: [],
    contentBatches: [],
    approvals: [],
    memoryMaintenanceRuns: [],
  };
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

async function getFileModifiedAt(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return isoFromMs(info.mtimeMs);
  } catch {
    return null;
  }
}

function extractJsonRecords(
  parsed: unknown,
  collection: WorkspaceRunCollectionName,
  source: string,
): ParsedCandidate[] {
  if (Array.isArray(parsed)) return parsed.map((value, index) => ({ value, source, ref: `index:${index}` }));
  if (parsed && typeof parsed === "object") {
    const container = parsed as Record<string, unknown>;
    const nested = container[collection] ?? container.records;
    if (Array.isArray(nested)) {
      return nested.map((value, index) => ({ value, source, ref: `${collection}:${index}` }));
    }
    return [{ value: parsed, source, ref: "object" }];
  }
  return [{ value: parsed, source, ref: "value" }];
}

function parseJsonl(content: string, source: string): ParsedCandidate[] {
  return content
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => {
      try {
        return { value: JSON.parse(line) as unknown, source, ref: `line:${index + 1}` };
      } catch (error) {
        return {
          value: undefined,
          source,
          ref: `line:${index + 1}`,
          parseError: error instanceof Error ? error.message : "Invalid JSONL record",
        };
      }
    })
    .map((candidate) => {
      if ("parseError" in candidate) {
        return {
          value: { __workspaceProjectionParseError: candidate.parseError },
          source: candidate.source,
          ref: candidate.ref,
        };
      }
      return candidate;
    });
}

async function readCandidates(
  descriptor: SourceDescriptor<WorkspaceRunRecord>,
  root: string,
): Promise<{
  candidates: ParsedCandidate[];
  presentPaths: string[];
  missingPaths: string[];
  lastModified: string | null;
  readErrors: WorkspaceRunSourceHealth["errors"];
}> {
  const jsonlPath = join(root, descriptor.jsonlName);
  const jsonPath = join(root, descriptor.jsonName);
  const candidates: ParsedCandidate[] = [];
  const presentPaths: string[] = [];
  const missingPaths: string[] = [];
  const readErrors: WorkspaceRunSourceHealth["errors"] = [];
  const modifiedTimes: string[] = [];

  for (const [path, format] of [
    [jsonlPath, "jsonl"],
    [jsonPath, "json"],
  ] as const) {
    const modifiedAt = await getFileModifiedAt(path);
    if (!modifiedAt) {
      missingPaths.push(path);
      continue;
    }

    presentPaths.push(path);
    modifiedTimes.push(modifiedAt);

    try {
      const content = await readFile(path, "utf8");
      if (format === "jsonl") {
        candidates.push(...parseJsonl(content, path));
      } else {
        candidates.push(...extractJsonRecords(JSON.parse(content), descriptor.collection, path));
      }
    } catch (error) {
      readErrors.push({
        source: path,
        message: error instanceof Error ? error.message : "Unable to read source file",
      });
    }
  }

  return {
    candidates,
    presentPaths,
    missingPaths,
    lastModified: modifiedTimes.length > 0 ? modifiedTimes.sort().at(-1) ?? null : null,
    readErrors,
  };
}

async function loadCollection<T extends WorkspaceRunRecord>(
  descriptor: SourceDescriptor<T>,
  root: string,
): Promise<{ records: T[]; health: WorkspaceRunSourceHealth }> {
  const { candidates, presentPaths, missingPaths, lastModified, readErrors } = await readCandidates(
    descriptor as SourceDescriptor<WorkspaceRunRecord>,
    root,
  );
  const records: T[] = [];
  const errors = [...readErrors];

  for (const candidate of candidates) {
    const result = descriptor.validate(candidate.value);
    if (result.ok) {
      records.push(result.data);
    } else {
      errors.push({
        source: candidate.source,
        ref: candidate.ref,
        message: result.issues.join("; "),
      });
    }
  }

  return {
    records,
    health: {
      collection: descriptor.collection,
      present: presentPaths.length > 0,
      paths: {
        jsonl: join(root, descriptor.jsonlName),
        json: join(root, descriptor.jsonName),
        present: presentPaths,
        missing: missingPaths,
      },
      recordCount: candidates.length,
      validRecordCount: records.length,
      invalidRecordCount: Math.max(0, candidates.length - records.length) + readErrors.length,
      lastModified,
      errors,
    },
  };
}

function sortByUpdatedAt<T extends { updatedAt?: string; createdAt?: string }>(records: T[]): T[] {
  return [...records].sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? ""));
}

export async function getWorkspaceRunsProjection(options: {
  root?: string;
  validators: WorkspaceRunValidators;
}): Promise<WorkspaceRunsProjection> {
  const root = options.root ?? WORKSPACE_RUNS_ROOT;
  const [agentRuns, auditRuns, contentBatches, approvals, memoryMaintenanceRuns] = await Promise.all([
    loadCollection<AgentRun>(
      { collection: "agentRuns", ...SOURCE_FILES.agentRuns, validate: options.validators.agentRuns },
      root,
    ),
    loadCollection<AuditRun>(
      { collection: "auditRuns", ...SOURCE_FILES.auditRuns, validate: options.validators.auditRuns },
      root,
    ),
    loadCollection<ContentBatch>(
      { collection: "contentBatches", ...SOURCE_FILES.contentBatches, validate: options.validators.contentBatches },
      root,
    ),
    loadCollection<Approval>(
      { collection: "approvals", ...SOURCE_FILES.approvals, validate: options.validators.approvals },
      root,
    ),
    loadCollection<MemoryMaintenanceRun>(
      {
        collection: "memoryMaintenanceRuns",
        ...SOURCE_FILES.memoryMaintenanceRuns,
        validate: options.validators.memoryMaintenanceRuns,
      },
      root,
    ),
  ]);

  const records = {
    ...emptyRecords(),
    agentRuns: sortByUpdatedAt(agentRuns.records),
    auditRuns: sortByUpdatedAt(auditRuns.records),
    contentBatches: sortByUpdatedAt(contentBatches.records),
    approvals: sortByUpdatedAt(approvals.records),
    memoryMaintenanceRuns: sortByUpdatedAt(memoryMaintenanceRuns.records),
  };
  const sources: Record<WorkspaceRunCollectionName, WorkspaceRunSourceHealth> = {
    agentRuns: agentRuns.health,
    auditRuns: auditRuns.health,
    contentBatches: contentBatches.health,
    approvals: approvals.health,
    memoryMaintenanceRuns: memoryMaintenanceRuns.health,
  };

  const counts = {
    agentRuns: records.agentRuns.length,
    auditRuns: records.auditRuns.length,
    contentBatches: records.contentBatches.length,
    approvals: records.approvals.length,
    memoryMaintenanceRuns: records.memoryMaintenanceRuns.length,
    totalValidRecords:
      records.agentRuns.length +
      records.auditRuns.length +
      records.contentBatches.length +
      records.approvals.length +
      records.memoryMaintenanceRuns.length,
    totalInvalidRecords: Object.values(sources).reduce((total, source) => total + source.invalidRecordCount, 0),
    sourcesPresent: Object.values(sources).filter((source) => source.present).length,
    sourcesMissing: Object.values(sources).filter((source) => !source.present).length,
  };

  return { root, sources, records, counts };
}
