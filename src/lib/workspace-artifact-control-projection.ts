import { existsSync } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type {
  ArtifactCollection,
  ContractValidationResult,
  WorkspaceArtifact,
  WorkspaceProject,
} from "./workspace-contracts";

export const WORKSPACE_ARTIFACT_CONTROL_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-artifacts";
export const WORKSPACE_ARCHIVE_ROOT = "/Users/atlasai/.openclaw/workspace/memory/PARA/Archives";
export const WORKSPACE_EXPORTS_ROOT = "/Users/atlasai/.openclaw/workspace/exports";
export const ARTIFACT_DELIVERIES_LEDGER = "/Users/atlasai/.openclaw/data/artifact-deliveries.jsonl";

const WORKSPACE_SCHEMA_VERSION = 1;
const MAX_METADATA_SCAN_DEPTH = 8;
const ARTIFACT_FILE_EXTENSIONS = new Set([".docx", ".html", ".json", ".md", ".pdf", ".png", ".txt", ".zip"]);

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

export type WorkspaceArtifactMetadataDiscoveryHealth = {
  metadataRoots: string[];
  exportRoots: string[];
  metadataSidecars: {
    present: boolean;
    paths: string[];
    recordCount: number;
    validRecordCount: number;
    invalidRecordCount: number;
    lastModified: string | null;
  };
  deliveryLedger: {
    path: string;
    present: boolean;
    recordCount: number;
    matchedRecordCount: number;
    invalidRecordCount: number;
    lastModified: string | null;
  };
  counts: {
    realMetadataRecordsFound: number;
    exportFilesMatched: number;
    missingSidecars: number;
    orphanExports: number;
    duplicateArtifactIds: number;
    ambiguousArtifactIds: number;
    fixtureFallbackCount: number;
  };
  errors: Array<{
    source: string;
    ref?: string;
    message: string;
  }>;
};

export type WorkspaceArtifactControlProjection = {
  root: string;
  sources: Record<WorkspaceArtifactControlCollectionName, WorkspaceArtifactControlSourceHealth>;
  discovery: WorkspaceArtifactMetadataDiscoveryHealth;
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

type DeliveryLedgerRecord = {
  deliveryId?: string;
  artifactPaths?: string[];
  title?: string;
  requestedBy?: string;
  source?: string;
  summary?: string;
  artifactCreatedAt?: string;
  eventType?: string;
};

type DiscoveredMetadataRecord = {
  metadataPath: string;
  metadataModifiedAt: string;
  value: Record<string, unknown>;
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

function emptyDiscoveryHealth(options: {
  metadataRoots: string[];
  exportRoots: string[];
  deliveryLedgerPath: string;
}): WorkspaceArtifactMetadataDiscoveryHealth {
  return {
    metadataRoots: options.metadataRoots,
    exportRoots: options.exportRoots,
    metadataSidecars: {
      present: false,
      paths: [],
      recordCount: 0,
      validRecordCount: 0,
      invalidRecordCount: 0,
      lastModified: null,
    },
    deliveryLedger: {
      path: options.deliveryLedgerPath,
      present: false,
      recordCount: 0,
      matchedRecordCount: 0,
      invalidRecordCount: 0,
      lastModified: null,
    },
    counts: {
      realMetadataRecordsFound: 0,
      exportFilesMatched: 0,
      missingSidecars: 0,
      orphanExports: 0,
      duplicateArtifactIds: 0,
      ambiguousArtifactIds: 0,
      fixtureFallbackCount: 0,
    },
    errors: [],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function slugToContractId(prefix: string, value: unknown, fallback: string) {
  const raw = isNonEmptyString(value) ? value : fallback;
  if (raw.startsWith(`${prefix}_`)) return raw;
  return `${prefix}_${raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fallback}`;
}

function normalizeProjectId(value: unknown) {
  if (value === "undeniable-os") return "project_undeniable_os";
  if (value === "memory-knowledge") return "project_memory_knowledge";
  return slugToContractId("project", value, "undeniable_os");
}

function normalizeCollectionId(value: unknown) {
  if (value === "call-archives") return "collection_call_archives";
  if (value === "client-person-archives") return "collection_call_archives";
  return slugToContractId("collection", value, "call_archives");
}

function pathRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(isNonEmptyString);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).filter(isNonEmptyString);
  }
  return [];
}

function latestIso(values: Array<string | null | undefined>): string {
  const valid = values.filter((value): value is string => isNonEmptyString(value) && !Number.isNaN(Date.parse(value)));
  return valid.sort().at(-1) ?? new Date(0).toISOString();
}

function artifactTypeFromPaths(paths: string[]): WorkspaceArtifact["type"] {
  if (paths.some((path) => path.toLowerCase().endsWith(".pdf"))) return "pdf";
  if (paths.some((path) => path.toLowerCase().endsWith(".docx"))) return "doc";
  if (paths.some((path) => path.toLowerCase().endsWith(".md"))) return "overview";
  if (paths.some((path) => path.toLowerCase().endsWith(".json"))) return "data";
  return "report";
}

function artifactStatusFromMetadata(metadata: Record<string, unknown>): WorkspaceArtifact["status"] {
  const status = String(metadata.status ?? "");
  const projection = pathRecord(metadata.workspaceProjection);
  if (status.includes("blocked")) return "blocked";
  if (projection.ready === true) return "ready_for_review";
  return "draft";
}

function metadataTitle(metadata: Record<string, unknown>, paths: string[]) {
  if (isNonEmptyString(metadata.title)) return metadata.title;
  const preferred = paths.find((path) => path.toLowerCase().endsWith(".pdf")) ?? paths[0];
  return preferred ? basename(preferred, extname(preferred)).replace(/[-_]+/g, " ") : "Workspace artifact";
}

function metadataCanonicalName(metadata: Record<string, unknown>, paths: string[]) {
  if (isNonEmptyString(metadata.artifactId)) return metadata.artifactId;
  const preferred = paths.find((path) => path.toLowerCase().endsWith(".pdf")) ?? paths[0];
  return preferred ? basename(preferred, extname(preferred)) : "workspace-artifact";
}

function deliveryRecordFor(metadata: Record<string, unknown>, ledgerByPath: Map<string, DeliveryLedgerRecord>, ledgerById: Map<string, DeliveryLedgerRecord>) {
  const ledger = pathRecord(metadata.deliveryLedger);
  if (isNonEmptyString(ledger.deliveryId)) return ledgerById.get(ledger.deliveryId);
  const paths = stringValues(metadata.outputPaths);
  return paths.map((path) => ledgerByPath.get(path)).find(Boolean);
}

function normalizeMetadataArtifact(
  metadataRecord: DiscoveredMetadataRecord,
  ledgerByPath: Map<string, DeliveryLedgerRecord>,
  ledgerById: Map<string, DeliveryLedgerRecord>,
): WorkspaceArtifact {
  const metadata = metadataRecord.value;
  const outputPaths = stringValues(metadata.outputPaths);
  const renderVerification = pathRecord(metadata.renderVerification);
  const delivery = pathRecord(metadata.deliveryLedger);
  const ledger = deliveryRecordFor(metadata, ledgerByPath, ledgerById);
  const deliveryId = isNonEmptyString(delivery.deliveryId) ? delivery.deliveryId : ledger?.deliveryId;
  const artifactId = deliveryId ?? slugToContractId("artifact", metadata.artifactId, basename(metadataRecord.metadataPath, ".metadata.json"));
  const title = metadataTitle(metadata, outputPaths);
  const updatedAt = latestIso([
    metadataRecord.metadataModifiedAt,
    ledger?.artifactCreatedAt,
    isNonEmptyString(metadata.generatedAt) ? metadata.generatedAt : null,
  ]);
  const preferredPath = outputPaths.find((path) => path.toLowerCase().endsWith(".pdf")) ?? outputPaths[0] ?? metadataRecord.metadataPath;

  return {
    artifactId,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    projectId: normalizeProjectId(metadata.projectId),
    collectionId: normalizeCollectionId(metadata.collectionId),
    sourceJobId: isNonEmptyString(ledger?.source) ? ledger.source : undefined,
    title,
    type: artifactTypeFromPaths(outputPaths),
    status: artifactStatusFromMetadata(metadata),
    createdAt: updatedAt,
    updatedAt,
    owner: isNonEmptyString(metadata.requestedBy) ? metadata.requestedBy.toLowerCase() : "rhys",
    requestedBy: isNonEmptyString(metadata.requestedBy) ? metadata.requestedBy.toLowerCase() : undefined,
    sourceRefs: [
      { system: "artifact_metadata", ref: metadataRecord.metadataPath, label: "Artifact metadata sidecar" },
      ...(deliveryId ? [{ system: "artifact_delivery_ledger", ref: deliveryId, label: "Artifact delivery ledger" }] : []),
    ],
    filePaths: outputPaths.length > 0 ? outputPaths : [metadataRecord.metadataPath],
    previewPaths: stringValues(renderVerification.pdfRenderedSamplePages),
    sensitivity: metadata.personClientId ? "client_confidential" : "internal",
    visibility: "owner",
    reviewNotes: [
      isNonEmptyString(metadata.sourceInclusionPolicy) ? metadata.sourceInclusionPolicy : "Real artifact metadata discovered from a read-only sidecar.",
      "Workspace file controls remain disabled; this record is projected for visibility only.",
    ],
    relatedApprovalIds: [],
    naming: {
      canonicalName: metadataCanonicalName(metadata, outputPaths),
      suggestedFolder: dirname(preferredPath),
    },
  };
}

async function walkFiles(root: string, predicate: (path: string) => boolean, depth = 0): Promise<string[]> {
  if (depth > MAX_METADATA_SCAN_DEPTH || !existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath, predicate, depth + 1));
      continue;
    }
    if (entry.isFile() && predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

async function readDeliveryLedger(path: string): Promise<{
  byPath: Map<string, DeliveryLedgerRecord>;
  byId: Map<string, DeliveryLedgerRecord>;
  health: WorkspaceArtifactMetadataDiscoveryHealth["deliveryLedger"];
  errors: WorkspaceArtifactMetadataDiscoveryHealth["errors"];
}> {
  const byPath = new Map<string, DeliveryLedgerRecord>();
  const byId = new Map<string, DeliveryLedgerRecord>();
  const errors: WorkspaceArtifactMetadataDiscoveryHealth["errors"] = [];
  const lastModified = await getFileModifiedAt(path);
  if (!lastModified) {
    return {
      byPath,
      byId,
      health: { path, present: false, recordCount: 0, matchedRecordCount: 0, invalidRecordCount: 0, lastModified: null },
      errors,
    };
  }

  const content = await readFile(path, "utf8").catch((error) => {
    errors.push({ source: path, message: error instanceof Error ? error.message : "Unable to read artifact delivery ledger" });
    return "";
  });
  let recordCount = 0;
  let invalidRecordCount = 0;
  for (const candidate of parseJsonl(content, path)) {
    recordCount += 1;
    if (!isRecord(candidate.value)) {
      invalidRecordCount += 1;
      errors.push({ source: path, ref: candidate.ref, message: "Delivery ledger record must be an object" });
      continue;
    }
    const record = candidate.value as DeliveryLedgerRecord;
    if (!isNonEmptyString(record.deliveryId)) {
      invalidRecordCount += 1;
      errors.push({ source: path, ref: candidate.ref, message: "Delivery ledger record missing deliveryId" });
      continue;
    }
    byId.set(record.deliveryId, record);
    if (Array.isArray(record.artifactPaths)) {
      for (const artifactPath of record.artifactPaths.filter(isNonEmptyString)) byPath.set(artifactPath, record);
    }
  }

  return {
    byPath,
    byId,
    health: { path, present: true, recordCount, matchedRecordCount: byPath.size, invalidRecordCount, lastModified },
    errors,
  };
}

async function loadDiscoveredMetadataArtifacts(options: {
  metadataRoots: string[];
  exportRoots: string[];
  deliveryLedgerPath: string;
  validate: (value: unknown) => ContractValidationResult<WorkspaceArtifact>;
}): Promise<{
  artifacts: WorkspaceArtifact[];
  projects: WorkspaceProject[];
  collections: ArtifactCollection[];
  discovery: WorkspaceArtifactMetadataDiscoveryHealth;
}> {
  const discovery = emptyDiscoveryHealth(options);
  const ledger = await readDeliveryLedger(options.deliveryLedgerPath);
  discovery.deliveryLedger = ledger.health;
  discovery.errors.push(...ledger.errors);

  const metadataPaths = (await Promise.all(options.metadataRoots.map((root) =>
    walkFiles(root, (path) => path.endsWith(".metadata.json")),
  ))).flat().sort();
  const metadataModifiedTimes: string[] = [];
  const artifacts: WorkspaceArtifact[] = [];

  for (const metadataPath of metadataPaths) {
    const modifiedAt = await getFileModifiedAt(metadataPath) ?? new Date(0).toISOString();
    metadataModifiedTimes.push(modifiedAt);
    try {
      const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        discovery.errors.push({ source: metadataPath, message: "Metadata sidecar must contain an object" });
        continue;
      }
      const artifact = normalizeMetadataArtifact(
        { metadataPath, metadataModifiedAt: modifiedAt, value: parsed },
        ledger.byPath,
        ledger.byId,
      );
      const result = options.validate(artifact);
      if (result.ok) artifacts.push(result.data);
      else discovery.errors.push({ source: metadataPath, message: result.issues.join("; ") });
    } catch (error) {
      discovery.errors.push({
        source: metadataPath,
        message: error instanceof Error ? error.message : "Unable to read metadata sidecar",
      });
    }
  }

  const exportFiles = (await Promise.all(options.exportRoots.map((root) =>
    walkFiles(root, (path) => ARTIFACT_FILE_EXTENSIONS.has(extname(path).toLowerCase()) && !path.endsWith(".metadata.json")),
  ))).flat();
  const metadataFilePaths = new Set(artifacts.flatMap((artifact) => artifact.filePaths));
  const matched = exportFiles.filter((path) => metadataFilePaths.has(path));
  const missingPaths = artifacts.flatMap((artifact) => artifact.filePaths).filter((path) => !existsSync(path));
  const duplicateIds = new Map<string, number>();
  for (const artifact of artifacts) duplicateIds.set(artifact.artifactId, (duplicateIds.get(artifact.artifactId) ?? 0) + 1);
  const duplicateArtifactIds = [...duplicateIds.values()].filter((count) => count > 1).length;
  const uniqueArtifacts = artifacts.filter((artifact, index) =>
    artifacts.findIndex((candidate) => candidate.artifactId === artifact.artifactId) === index,
  );

  discovery.metadataSidecars = {
    present: metadataPaths.length > 0,
    paths: metadataPaths,
    recordCount: metadataPaths.length,
    validRecordCount: uniqueArtifacts.length,
    invalidRecordCount: discovery.errors.filter((error) => error.source.endsWith(".metadata.json")).length,
    lastModified: metadataModifiedTimes.sort().at(-1) ?? null,
  };
  discovery.counts.realMetadataRecordsFound = uniqueArtifacts.length;
  discovery.counts.exportFilesMatched = matched.length;
  discovery.counts.missingSidecars = missingPaths.length;
  discovery.counts.orphanExports = Math.max(0, exportFiles.length - matched.length);
  discovery.counts.duplicateArtifactIds = duplicateArtifactIds;
  discovery.counts.ambiguousArtifactIds = duplicateArtifactIds;

  const projectMap = new Map<string, WorkspaceProject>();
  const collectionMap = new Map<string, ArtifactCollection>();
  for (const artifact of uniqueArtifacts) {
    projectMap.set(artifact.projectId, {
      id: artifact.projectId,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      title: artifact.projectId === "project_memory_knowledge" ? "Memory/Knowledge" : "Undeniable OS",
      slug: artifact.projectId.replace(/^project_/, "").replaceAll("_", "-"),
      status: "active",
      ownerRole: "rhys",
      description: "Read-only project inferred from real artifact metadata sidecars.",
      collectionIds: [...new Set(uniqueArtifacts.filter((item) => item.projectId === artifact.projectId).map((item) => item.collectionId))],
      sourceRefs: [{ system: "artifact_metadata", ref: artifact.artifactId }],
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    });
    collectionMap.set(artifact.collectionId, {
      id: artifact.collectionId,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      projectId: artifact.projectId,
      title: artifact.collectionId === "collection_call_archives" ? "Call archives" : artifact.collectionId.replace(/^collection_/, "").replaceAll("_", " "),
      collectionType: artifact.collectionId === "collection_call_archives" ? "call_archives" : "strategic_documents",
      defaultPath: artifact.naming.suggestedFolder,
      namingPattern: "{date}-{subject}-artifact",
      description: "Read-only collection inferred from real artifact metadata sidecars.",
      artifactIds: uniqueArtifacts.filter((item) => item.collectionId === artifact.collectionId).map((item) => item.artifactId),
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    });
  }

  return {
    artifacts: uniqueArtifacts,
    projects: [...projectMap.values()],
    collections: [...collectionMap.values()],
    discovery,
  };
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
  metadataRoots?: string[];
  exportRoots?: string[];
  deliveryLedgerPath?: string;
  fixtureFallbackCount?: number;
  validators: WorkspaceArtifactControlValidators;
}): Promise<WorkspaceArtifactControlProjection> {
  const root = options.root ?? WORKSPACE_ARTIFACT_CONTROL_ROOT;
  const metadataRoots = options.metadataRoots ?? [WORKSPACE_ARCHIVE_ROOT, WORKSPACE_EXPORTS_ROOT];
  const exportRoots = options.exportRoots ?? [WORKSPACE_ARCHIVE_ROOT, WORKSPACE_EXPORTS_ROOT];
  const deliveryLedgerPath = options.deliveryLedgerPath ?? ARTIFACT_DELIVERIES_LEDGER;
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

  const discovered = await loadDiscoveredMetadataArtifacts({
    metadataRoots,
    exportRoots,
    deliveryLedgerPath,
    validate: options.validators.artifacts,
  });

  const mergedProjects = [...records.projects, ...discovered.projects];
  const mergedCollections = [...records.collections, ...discovered.collections];
  const mergedArtifacts = [...records.artifacts, ...discovered.artifacts];

  records.projects = mergedProjects.filter((project, index) =>
    mergedProjects.findIndex((candidate) => candidate.id === project.id) === index,
  );
  records.collections = mergedCollections.filter((collection, index) =>
    mergedCollections.findIndex((candidate) => candidate.id === collection.id) === index,
  );
  records.artifacts = mergedArtifacts.filter((artifact, index) =>
    mergedArtifacts.findIndex((candidate) => candidate.artifactId === artifact.artifactId) === index,
  );

  const totalValidRecords = records.projects.length + records.collections.length + records.artifacts.length;
  const totalInvalidRecords = Object.values(sources).reduce((total, source) => total + source.invalidRecordCount, 0)
    + discovered.discovery.errors.length;
  const sourcesPresent = Object.values(sources).filter((source) => source.present).length;
  discovered.discovery.counts.fixtureFallbackCount = totalValidRecords === 0 ? options.fixtureFallbackCount ?? 0 : 0;

  return {
    root,
    sources,
    discovery: discovered.discovery,
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
