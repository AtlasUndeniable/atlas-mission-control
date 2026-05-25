import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ArtifactCollection,
  ContractValidationResult,
  WorkspaceArtifact,
  WorkspaceProject,
} from "./workspace-contracts";

export const WORKSPACE_ARTIFACT_CONTROL_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-artifacts";

export type WorkspaceArtifactControlCollectionName = "projects" | "collections" | "artifacts";

export type WorkspaceArtifactControlRecord = WorkspaceProject | ArtifactCollection | WorkspaceArtifact;

export type WorkspaceArtifactControlValidators = {
  projects: (value: unknown) => ContractValidationResult<WorkspaceProject>;
  collections: (value: unknown) => ContractValidationResult<ArtifactCollection>;
  artifacts: (value: unknown) => ContractValidationResult<WorkspaceArtifact>;
};

export type WorkspaceArtifactControlSourceHealth = {
  collection: WorkspaceArtifactControlCollectionName;
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

export type WorkspaceArtifactControlProjection = {
  root: string;
  sources: Record<WorkspaceArtifactControlCollectionName, WorkspaceArtifactControlSourceHealth>;
  records: {
    projects: WorkspaceProject[];
    collections: ArtifactCollection[];
    artifacts: WorkspaceArtifact[];
  };
  counts: {
    projects: number;
    collections: number;
    artifacts: number;
    totalValidRecords: number;
    totalInvalidRecords: number;
    sourcesPresent: number;
    sourcesMissing: number;
  };
};

type SourceDescriptor<T extends WorkspaceArtifactControlRecord> = {
  collection: WorkspaceArtifactControlCollectionName;
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
  projects: { jsonlName: "projects.jsonl", jsonName: "projects.json" },
  collections: { jsonlName: "collections.jsonl", jsonName: "collections.json" },
  artifacts: { jsonlName: "artifacts.jsonl", jsonName: "artifacts.json" },
} as const satisfies Record<WorkspaceArtifactControlCollectionName, { jsonlName: string; jsonName: string }>;

function emptyRecords(): WorkspaceArtifactControlProjection["records"] {
  return {
    projects: [],
    collections: [],
    artifacts: [],
  };
}

async function getFileModifiedAt(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return new Date(info.mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function extractJsonRecords(
  parsed: unknown,
  collection: WorkspaceArtifactControlCollectionName,
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
          value: { __workspaceArtifactProjectionParseError: error instanceof Error ? error.message : "Invalid JSONL record" },
          source,
          ref: `line:${index + 1}`,
        };
      }
    });
}

async function readCandidates(
  descriptor: SourceDescriptor<WorkspaceArtifactControlRecord>,
  root: string,
): Promise<{
  candidates: ParsedCandidate[];
  presentPaths: string[];
  missingPaths: string[];
  lastModified: string | null;
  readErrors: WorkspaceArtifactControlSourceHealth["errors"];
}> {
  const jsonlPath = join(root, descriptor.jsonlName);
  const jsonPath = join(root, descriptor.jsonName);
  const candidates: ParsedCandidate[] = [];
  const presentPaths: string[] = [];
  const missingPaths: string[] = [];
  const readErrors: WorkspaceArtifactControlSourceHealth["errors"] = [];
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
        message: error instanceof Error ? error.message : "Unable to read artifact control source file",
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

async function loadCollection<T extends WorkspaceArtifactControlRecord>(
  descriptor: SourceDescriptor<T>,
  root: string,
): Promise<{ records: T[]; health: WorkspaceArtifactControlSourceHealth }> {
  const { candidates, presentPaths, missingPaths, lastModified, readErrors } = await readCandidates(
    descriptor as SourceDescriptor<WorkspaceArtifactControlRecord>,
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
      invalidRecordCount: errors.length,
      lastModified,
      errors,
    },
  };
}

export async function getWorkspaceArtifactControlProjection(options: {
  root?: string;
  validators: WorkspaceArtifactControlValidators;
}): Promise<WorkspaceArtifactControlProjection> {
  const root = options.root ?? WORKSPACE_ARTIFACT_CONTROL_ROOT;
  const records = emptyRecords();
  const sources = {} as WorkspaceArtifactControlProjection["sources"];

  const projects = await loadCollection<WorkspaceProject>(
    { collection: "projects", ...SOURCE_FILES.projects, validate: options.validators.projects },
    root,
  );
  records.projects = projects.records;
  sources.projects = projects.health;

  const collections = await loadCollection<ArtifactCollection>(
    { collection: "collections", ...SOURCE_FILES.collections, validate: options.validators.collections },
    root,
  );
  records.collections = collections.records;
  sources.collections = collections.health;

  const artifacts = await loadCollection<WorkspaceArtifact>(
    { collection: "artifacts", ...SOURCE_FILES.artifacts, validate: options.validators.artifacts },
    root,
  );
  records.artifacts = artifacts.records;
  sources.artifacts = artifacts.health;

  const totalValidRecords = records.projects.length + records.collections.length + records.artifacts.length;
  const totalInvalidRecords = Object.values(sources).reduce((total, source) => total + source.invalidRecordCount, 0);
  const sourcesPresent = Object.values(sources).filter((source) => source.present).length;

  return {
    root,
    sources,
    records,
    counts: {
      projects: records.projects.length,
      collections: records.collections.length,
      artifacts: records.artifacts.length,
      totalValidRecords,
      totalInvalidRecords,
      sourcesPresent,
      sourcesMissing: Object.keys(SOURCE_FILES).length - sourcesPresent,
    },
  };
}
