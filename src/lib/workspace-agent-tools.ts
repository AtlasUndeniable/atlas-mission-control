import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  getWorkspaceArtifactControlProjection,
  WORKSPACE_ARTIFACT_CONTROL_ROOT,
  WORKSPACE_ARCHIVE_ROOT,
  WORKSPACE_EXPORTS_ROOT,
} from "./workspace-artifact-control-projection.ts";
import type { ContractValidationResult, WorkspaceArtifact } from "./workspace-contracts.ts";
import {
  validateArtifactCollection,
  validateWorkspaceArtifact,
  validateWorkspaceProject,
} from "./workspace-contracts.ts";
import type { AgentEvent } from "./workspace-demo-events.ts";
import {
  WORKSPACE_DEMO_ARTIFACT_ROOT,
  type WorkspaceDraftArtifactMetadata,
} from "./workspace-draft-artifacts.ts";
import {
  createWorkspaceReferenceInspectorPacket,
  resolveWorkspaceReferences,
  type WorkspaceReferenceConfidence,
  type WorkspaceReferenceInspectorPacket,
  type WorkspaceReferencePacket,
  type WorkspaceReferenceResolverOptions,
} from "./workspace-reference-resolver.ts";

export const WORKSPACE_AGENT_TOOL_NAMES = [
  "search_memory",
  "find_artifact",
  "get_reference_packet",
  "summarize_calls",
] as const;

export type WorkspaceAgentToolName = (typeof WORKSPACE_AGENT_TOOL_NAMES)[number];
export type WorkspaceAgentToolCoverage = "matched" | "thin" | "none";
export type WorkspaceAgentToolStatus = "ok" | "limited" | "no_results";

export interface WorkspaceAgentToolSchema {
  name: WorkspaceAgentToolName;
  description: string;
  readOnly: true;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  sourceRoots: string[];
}

export interface WorkspaceAgentToolBaseInput {
  project?: string;
  room?: string;
  limit?: number;
}

export interface SearchMemoryInput extends WorkspaceAgentToolBaseInput {
  query: string;
}

export interface FindArtifactInput extends WorkspaceAgentToolBaseInput {
  query: string;
  type?: string;
}

export interface GetReferencePacketInput {
  prompt: string;
  project: string;
  room: string;
  limit?: number;
}

export interface SummarizeCallsInput extends WorkspaceAgentToolBaseInput {
  query?: string;
}

export interface WorkspaceAgentSafeReference {
  handle: string;
  title: string;
  sourceType: string;
  excerpt: string;
  confidence: WorkspaceReferenceConfidence;
  freshness?: string;
  score?: number;
  matchedTerms: string[];
}

export interface WorkspaceAgentSafeArtifact {
  handle: string;
  title: string;
  type: string;
  preview: string;
  confidence: WorkspaceReferenceConfidence;
  freshness?: string;
  source: "workspace-artifact-projection" | "workspace-demo-artifact";
}

export interface WorkspaceAgentToolAudit {
  readOnly: true;
  mutationsAllowed: false;
  externalSystemsCalled: false;
  browserUsed: false;
}

export interface SearchMemoryOutput {
  tool: "search_memory";
  status: WorkspaceAgentToolStatus;
  coverage: WorkspaceAgentToolCoverage;
  resolvedAt: string;
  sourceRootsUsed: string[];
  results: WorkspaceAgentSafeReference[];
  summary: string;
  audit: WorkspaceAgentToolAudit;
}

export interface FindArtifactOutput {
  tool: "find_artifact";
  status: WorkspaceAgentToolStatus;
  coverage: WorkspaceAgentToolCoverage;
  resolvedAt: string;
  sourceRootsUsed: string[];
  artifacts: WorkspaceAgentSafeArtifact[];
  summary: string;
  audit: WorkspaceAgentToolAudit;
}

export interface GetReferencePacketOutput {
  tool: "get_reference_packet";
  status: WorkspaceAgentToolStatus;
  coverage: WorkspaceAgentToolCoverage;
  referencePacket: WorkspaceReferenceInspectorPacket;
  guidance: string[];
  summary: string;
  audit: WorkspaceAgentToolAudit;
}

export interface SummarizeCallsOutput {
  tool: "summarize_calls";
  status: WorkspaceAgentToolStatus;
  coverage: WorkspaceAgentToolCoverage;
  resolvedAt: string;
  sourceRootsUsed: string[];
  callReferences: WorkspaceAgentSafeReference[];
  trends: Array<{
    title: string;
    summary: string;
    confidence: WorkspaceReferenceConfidence;
  }>;
  limitation: string;
  audit: WorkspaceAgentToolAudit;
}

export type WorkspaceAgentToolInput =
  | SearchMemoryInput
  | FindArtifactInput
  | GetReferencePacketInput
  | SummarizeCallsInput;

export type WorkspaceAgentToolOutput =
  | SearchMemoryOutput
  | FindArtifactOutput
  | GetReferencePacketOutput
  | SummarizeCallsOutput;

export interface WorkspaceAgentToolExecution<TOutput extends WorkspaceAgentToolOutput = WorkspaceAgentToolOutput> {
  toolName: WorkspaceAgentToolName;
  checkedInput: WorkspaceAgentToolInput;
  output: TOutput;
  runtimeReferencePacket?: WorkspaceReferencePacket;
}

export interface WorkspaceAgentToolOptions {
  now?: () => Date;
  referenceOptions?: WorkspaceReferenceResolverOptions;
  referenceResolver?: (input: GetReferencePacketInput) => Promise<WorkspaceReferencePacket>;
  artifactControlRoot?: string;
  artifactMetadataRoots?: string[];
  artifactExportRoots?: string[];
  workspaceDemoArtifactRoot?: string;
}

export interface WorkspaceAgentToolEventContext {
  workspaceId: string;
  taskId: string;
  runId: string;
  now: () => Date;
  nextId: (prefix: string) => string;
}

type ScoredArtifact = WorkspaceAgentSafeArtifact & {
  score: number;
  updatedAtMs: number;
};

const DEFAULT_PROJECT = "Undeniable";
const DEFAULT_ROOM = "workspace-demo";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_EXCERPT_CHARS = 360;

const REFERENCE_SOURCE_ROOTS = [
  "librarian-context-packs",
  "librarian-reports",
  "librarian-review-queue",
  "call-transcripts",
  "call-archives",
  "knowledge-topic-indexes",
  "project-docs",
  "workspace-state",
];

const ARTIFACT_SOURCE_ROOTS = [
  "workspace-artifact-projection",
  "workspace-demo-artifacts",
];

const audit: WorkspaceAgentToolAudit = {
  readOnly: true,
  mutationsAllowed: false,
  externalSystemsCalled: false,
  browserUsed: false,
};

export const WORKSPACE_AGENT_TOOL_SCHEMAS: Record<WorkspaceAgentToolName, WorkspaceAgentToolSchema> = {
  search_memory: {
    name: "search_memory",
    description: "Search existing Librarian context packs, reports, review queue items, and workspace state for safe memory references.",
    readOnly: true,
    sourceRoots: REFERENCE_SOURCE_ROOTS,
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000 },
        project: { type: "string", maxLength: 120 },
        room: { type: "string", maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
    },
    outputSchema: {
      type: "object",
      required: ["tool", "status", "coverage", "resolvedAt", "sourceRootsUsed", "results", "summary", "audit"],
      properties: {
        results: { type: "array", items: "safe handles, titles, excerpts, confidence, freshness, and matched terms" },
      },
    },
  },
  find_artifact: {
    name: "find_artifact",
    description: "Find safe artifact handles from the read-only workspace artifact projection and workspace-demo draft artifacts.",
    readOnly: true,
    sourceRoots: ARTIFACT_SOURCE_ROOTS,
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000 },
        type: { type: "string", maxLength: 60 },
        project: { type: "string", maxLength: 120 },
        room: { type: "string", maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
    },
    outputSchema: {
      type: "object",
      required: ["tool", "status", "coverage", "resolvedAt", "sourceRootsUsed", "artifacts", "summary", "audit"],
      properties: {
        artifacts: { type: "array", items: "safe artifact handles, titles, types, previews, confidence, and freshness" },
      },
    },
  },
  get_reference_packet: {
    name: "get_reference_packet",
    description: "Resolve the compact Workspace reference packet used by the runtime, with safe Inspector fields only in the tool result.",
    readOnly: true,
    sourceRoots: REFERENCE_SOURCE_ROOTS,
    inputSchema: {
      type: "object",
      required: ["prompt", "project", "room"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        project: { type: "string", minLength: 1, maxLength: 120 },
        room: { type: "string", minLength: 1, maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
    },
    outputSchema: {
      type: "object",
      required: ["tool", "status", "coverage", "referencePacket", "guidance", "summary", "audit"],
      properties: {
        referencePacket: { type: "object", description: "Safe compact packet with handles, titles, confidence, freshness, and path summaries only." },
      },
    },
  },
  summarize_calls: {
    name: "summarize_calls",
    description: "Summarize available call/context references from read-only Librarian outputs; report thin coverage honestly.",
    readOnly: true,
    sourceRoots: REFERENCE_SOURCE_ROOTS,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 1000 },
        project: { type: "string", maxLength: 120 },
        room: { type: "string", maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
    },
    outputSchema: {
      type: "object",
      required: ["tool", "status", "coverage", "resolvedAt", "sourceRootsUsed", "callReferences", "trends", "limitation", "audit"],
      properties: {
        trends: { type: "array", items: "reference-backed trend snippets only; no fake full transcript recall" },
      },
    },
  },
};

export async function executeWorkspaceAgentTool(
  toolName: WorkspaceAgentToolName,
  input: unknown,
  options: WorkspaceAgentToolOptions = {},
): Promise<WorkspaceAgentToolExecution> {
  const checked = validateWorkspaceAgentToolInput(toolName, input);
  if (!checked.ok) throw new Error(`Invalid ${toolName} input: ${checked.issues.join("; ")}`);

  if (toolName === "search_memory") {
    return executeSearchMemory(checked.data as SearchMemoryInput, options);
  }
  if (toolName === "find_artifact") {
    return executeFindArtifact(checked.data as FindArtifactInput, options);
  }
  if (toolName === "get_reference_packet") {
    return executeGetReferencePacket(checked.data as GetReferencePacketInput, options);
  }
  return executeSummarizeCalls(checked.data as SummarizeCallsInput, options);
}

export function validateWorkspaceAgentToolInput(
  toolName: WorkspaceAgentToolName,
  input: unknown,
): ContractValidationResult<WorkspaceAgentToolInput> {
  if (!WORKSPACE_AGENT_TOOL_NAMES.includes(toolName)) {
    return { ok: false, issues: [`WorkspaceAgentTool: unsupported tool ${String(toolName)}`] };
  }
  if (!isRecord(input)) return { ok: false, issues: [`${toolName}: input must be an object`] };

  const issues: string[] = [];
  const limit = normalizeLimit(input.limit, issues);
  const project = optionalTrimmedString(input.project, "project", issues);
  const room = optionalTrimmedString(input.room, "room", issues);

  if (toolName === "search_memory") {
    const query = requiredTrimmedString(input.query, "query", issues, 1000);
    return finishInput<SearchMemoryInput>({ query, project, room, limit }, issues);
  }

  if (toolName === "find_artifact") {
    const query = requiredTrimmedString(input.query, "query", issues, 1000);
    const type = optionalTrimmedString(input.type, "type", issues, 60);
    return finishInput<FindArtifactInput>({ query, type, project, room, limit }, issues);
  }

  if (toolName === "get_reference_packet") {
    const prompt = requiredTrimmedString(input.prompt, "prompt", issues, 4000);
    const requiredProject = requiredTrimmedString(input.project, "project", issues, 120);
    const requiredRoom = requiredTrimmedString(input.room, "room", issues, 120);
    return finishInput<GetReferencePacketInput>({ prompt, project: requiredProject, room: requiredRoom, limit }, issues);
  }

  const query = optionalTrimmedString(input.query, "query", issues, 1000);
  return finishInput<SummarizeCallsInput>({ query, project, room, limit }, issues);
}

export async function prepareWorkspaceAgentToolExecutions(
  input: { prompt: string; title?: string },
  options: WorkspaceAgentToolOptions = {},
): Promise<WorkspaceAgentToolExecution[]> {
  const prompt = input.prompt.trim();
  const project = DEFAULT_PROJECT;
  const room = DEFAULT_ROOM;
  const tools: Array<{ name: WorkspaceAgentToolName; input: WorkspaceAgentToolInput }> = [
    { name: "get_reference_packet", input: { prompt, project, room, limit: DEFAULT_LIMIT } },
  ];

  if (looksLikeCallTrendRequest(prompt)) {
    tools.push({ name: "summarize_calls", input: { query: prompt, project, room, limit: DEFAULT_LIMIT } });
    tools.push({ name: "search_memory", input: { query: prompt, project, room, limit: DEFAULT_LIMIT } });
  } else if (looksLikeArtifactFindRequest(prompt)) {
    tools.push({ name: "find_artifact", input: { query: prompt, project, room, limit: DEFAULT_LIMIT } });
  } else if (looksMemoryDependent(prompt)) {
    tools.push({ name: "search_memory", input: { query: prompt, project, room, limit: DEFAULT_LIMIT } });
  }

  const executions: WorkspaceAgentToolExecution[] = [];
  for (const tool of tools) {
    executions.push(await executeWorkspaceAgentTool(tool.name, tool.input, options));
  }
  return executions;
}

export function runtimeReferencePacketFromToolExecutions(
  executions: WorkspaceAgentToolExecution[],
): WorkspaceReferencePacket | null {
  return executions.find((execution) => execution.toolName === "get_reference_packet")?.runtimeReferencePacket ?? null;
}

export function createWorkspaceAgentToolEvents(
  ctx: WorkspaceAgentToolEventContext,
  execution: WorkspaceAgentToolExecution,
): [AgentEvent, AgentEvent] {
  return [
    {
      ...baseToolEvent(ctx),
      id: ctx.nextId("evt_tool"),
      kind: "tool.call",
      visibility: "internal",
      toolName: `workspace_agent.${execution.toolName}`,
      label: toolCallLabel(execution.toolName),
      inputSummary: JSON.stringify(safeToolInputSummary(execution.toolName, execution.checkedInput)),
    },
    {
      ...baseToolEvent(ctx),
      id: ctx.nextId("evt_tool"),
      kind: "tool.result",
      visibility: "internal",
      toolName: `workspace_agent.${execution.toolName}`,
      label: toolResultLabel(execution.output),
      resultSummary: JSON.stringify(execution.output),
    },
  ];
}

export function formatWorkspaceAgentToolOutputsForPrompt(executions: WorkspaceAgentToolExecution[]): string[] {
  const lines: string[] = [];
  for (const execution of executions) {
    const output = execution.output;
    if (output.tool === "search_memory") {
      lines.push(`- search_memory: coverage=${output.coverage}; results=${output.results.length}; ${output.summary}`);
      output.results.forEach((result) => {
        lines.push(`  reference=${result.title}; handle=${result.handle}; confidence=${result.confidence}; excerpt=${result.excerpt}`);
      });
    } else if (output.tool === "find_artifact") {
      lines.push(`- find_artifact: coverage=${output.coverage}; artifacts=${output.artifacts.length}; ${output.summary}`);
      output.artifacts.forEach((artifact) => {
        lines.push(`  artifact=${artifact.title}; handle=${artifact.handle}; type=${artifact.type}; confidence=${artifact.confidence}; preview=${artifact.preview}`);
      });
    } else if (output.tool === "summarize_calls") {
      lines.push(`- summarize_calls: coverage=${output.coverage}; references=${output.callReferences.length}; ${output.limitation}`);
      output.trends.forEach((trend) => {
        lines.push(`  trend=${trend.title}; confidence=${trend.confidence}; summary=${trend.summary}`);
      });
    }
  }
  return lines.length ? lines : ["- No read-only agent tool results beyond the reference packet."];
}

function executeSearchMemory(
  input: SearchMemoryInput,
  options: WorkspaceAgentToolOptions,
): Promise<WorkspaceAgentToolExecution<SearchMemoryOutput>> {
  return resolveReferencePacket({
    prompt: input.query,
    project: input.project ?? DEFAULT_PROJECT,
    room: input.room ?? DEFAULT_ROOM,
    limit: input.limit,
  }, options).then((packet) => {
    const results = packet.references.slice(0, input.limit ?? DEFAULT_LIMIT).map(safeReference);
    return {
      toolName: "search_memory",
      checkedInput: input,
      runtimeReferencePacket: packet,
      output: {
        tool: "search_memory",
        status: statusForCoverage(packet.coverage),
        coverage: packet.coverage,
        resolvedAt: packet.resolvedAt,
        sourceRootsUsed: safeRootKeys(packet.rootsRead),
        results,
        summary: results.length
          ? `${results.length} safe Workspace memory reference${results.length === 1 ? "" : "s"} found.`
          : "No safe Workspace memory references found.",
        audit,
      },
    };
  });
}

async function executeFindArtifact(
  input: FindArtifactInput,
  options: WorkspaceAgentToolOptions,
): Promise<WorkspaceAgentToolExecution<FindArtifactOutput>> {
  const now = options.now ?? (() => new Date());
  const limit = input.limit ?? DEFAULT_LIMIT;
  const terms = tokenize(input.query);
  const projection = await getWorkspaceArtifactControlProjection({
    root: options.artifactControlRoot ?? WORKSPACE_ARTIFACT_CONTROL_ROOT,
    metadataRoots: options.artifactMetadataRoots ?? [WORKSPACE_ARCHIVE_ROOT, WORKSPACE_EXPORTS_ROOT],
    exportRoots: options.artifactExportRoots ?? [WORKSPACE_ARCHIVE_ROOT, WORKSPACE_EXPORTS_ROOT],
    validators: {
      projects: validateWorkspaceProject,
      collections: validateArtifactCollection,
      artifacts: validateWorkspaceArtifact,
    },
  });
  const projected = projection.records.artifacts.map((artifact) => scoreProjectedArtifact(artifact, terms, input.type));
  const demoArtifacts = await readWorkspaceDemoArtifacts(options.workspaceDemoArtifactRoot ?? WORKSPACE_DEMO_ARTIFACT_ROOT, terms, input.type);
  const artifacts = [...projected, ...demoArtifacts]
    .filter((artifact): artifact is ScoredArtifact => artifact !== null && artifact.score > 0)
    .sort((a, b) => b.score - a.score || b.updatedAtMs - a.updatedAtMs)
    .slice(0, limit)
    .map(stripArtifactScore);
  const coverage = artifacts.length === 0 ? "none" : artifacts.some((artifact) => artifact.confidence === "high") ? "matched" : "thin";

  return {
    toolName: "find_artifact",
    checkedInput: input,
    output: {
      tool: "find_artifact",
      status: statusForCoverage(coverage),
      coverage,
      resolvedAt: now().toISOString(),
      sourceRootsUsed: ARTIFACT_SOURCE_ROOTS,
      artifacts,
      summary: artifacts.length
        ? `${artifacts.length} safe artifact handle${artifacts.length === 1 ? "" : "s"} found.`
        : "No matching artifacts found in the read-only workspace projections.",
      audit,
    },
  };
}

async function executeGetReferencePacket(
  input: GetReferencePacketInput,
  options: WorkspaceAgentToolOptions,
): Promise<WorkspaceAgentToolExecution<GetReferencePacketOutput>> {
  const packet = await resolveReferencePacket(input, options);
  const inspectorPacket = createWorkspaceReferenceInspectorPacket(packet);
  return {
    toolName: "get_reference_packet",
    checkedInput: input,
    runtimeReferencePacket: packet,
    output: {
      tool: "get_reference_packet",
      status: statusForCoverage(packet.coverage),
      coverage: packet.coverage,
      referencePacket: inspectorPacket,
      guidance: packet.guidance,
      summary: packet.userFacingSummary,
      audit,
    },
  };
}

async function executeSummarizeCalls(
  input: SummarizeCallsInput,
  options: WorkspaceAgentToolOptions,
): Promise<WorkspaceAgentToolExecution<SummarizeCallsOutput>> {
  const prompt = input.query?.trim() || "recent calls trends call summaries transcripts";
  const packet = await resolveReferencePacket({
    prompt: `recent calls call transcript context trends ${prompt}`,
    project: input.project ?? DEFAULT_PROJECT,
    room: input.room ?? DEFAULT_ROOM,
    limit: input.limit,
  }, options);
  const callReferences = packet.references
    .filter(isCallContentReference)
    .slice(0, input.limit ?? DEFAULT_LIMIT)
    .map(safeReference);
  const systemReferences = packet.references.filter((reference) => reference.sourceType === "system-memory-maintenance");
  const coverage: WorkspaceAgentToolCoverage = callReferences.length === 0
    ? packet.references.length ? "thin" : "none"
    : callReferences.some((reference) => reference.confidence === "high") ? "matched" : "thin";
  const limitation = callReferences.length === 0
    ? [
      systemReferences.length
        ? `Found: ${systemReferences.length} system memory-maintenance reference${systemReferences.length === 1 ? "" : "s"}, but no call transcript or call-summary handles.`
        : "Found: no usable call transcript or call-summary references.",
      "Missing: call transcript/call-summary content for the requested period.",
      "Best next search: call-transcripts and call-archives for today's or recent Fireflies notes.",
    ].join(" ")
    : [
      `Found: ${callReferences.length} call transcript/summary reference${callReferences.length === 1 ? "" : "s"}.`,
      systemReferences.length ? `Also found: ${systemReferences.length} system memory-maintenance reference${systemReferences.length === 1 ? "" : "s"}; treat as ingestion/graph health, not call content.` : "",
      "Missing: any source type not listed in the resolved handles.",
      "Best next search: narrow by client/date if more detail is needed.",
    ].filter(Boolean).join(" ");

  return {
    toolName: "summarize_calls",
    checkedInput: input,
    runtimeReferencePacket: packet,
    output: {
      tool: "summarize_calls",
      status: statusForCoverage(coverage),
      coverage,
      resolvedAt: packet.resolvedAt,
      sourceRootsUsed: safeRootKeys(packet.rootsRead),
      callReferences,
      trends: callReferences.map((reference) => ({
        title: reference.title,
        summary: reference.excerpt,
        confidence: reference.confidence,
      })),
      limitation,
      audit,
    },
  };
}

async function resolveReferencePacket(
  input: GetReferencePacketInput,
  options: WorkspaceAgentToolOptions,
): Promise<WorkspaceReferencePacket> {
  if (options.referenceResolver) return options.referenceResolver(input);
  return resolveWorkspaceReferences({
    prompt: input.prompt,
    workspaceId: "workspace_undeniable_demo",
    project: input.project,
    room: input.room,
  }, {
    ...options.referenceOptions,
    maxReferences: input.limit ?? options.referenceOptions?.maxReferences,
    now: options.now ?? options.referenceOptions?.now,
  });
}

function scoreProjectedArtifact(
  artifact: WorkspaceArtifact,
  terms: string[],
  requestedType?: string,
): ScoredArtifact | null {
  const searchable = [
    artifact.artifactId,
    artifact.title,
    artifact.type,
    artifact.status,
    artifact.owner,
    artifact.requestedBy,
    artifact.reviewNotes.join(" "),
    artifact.naming.canonicalName,
  ].filter(Boolean).join(" ");
  const typePenalty = requestedType && artifact.type !== requestedType ? -8 : 0;
  const score = scoreText(searchable, terms) + typePenalty + recencyBoost(artifact.updatedAt);
  if (score <= 0) return null;
  return {
    handle: artifact.artifactId,
    title: safeText(artifact.title, 120),
    type: artifact.type,
    preview: safeText(artifact.reviewNotes[0] || artifact.naming.canonicalName || artifact.title, 220),
    confidence: confidenceForScore(score),
    freshness: `updated ${artifact.updatedAt}`,
    source: "workspace-artifact-projection",
    score,
    updatedAtMs: dateMs(artifact.updatedAt),
  };
}

async function readWorkspaceDemoArtifacts(
  root: string,
  terms: string[],
  requestedType?: string,
): Promise<ScoredArtifact[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const artifacts: ScoredArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".metadata.json")) continue;
    const metadataPath = join(root, entry.name);
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<WorkspaceDraftArtifactMetadata>;
      if (!metadata.id || !metadata.title || (metadata.type !== "markdown" && metadata.type !== "pdf")) continue;
      const markdownPath = join(root, `${metadata.id}.md`);
      const markdown = await readFile(markdownPath, "utf8").catch(() => "");
      const info = await stat(metadataPath);
      const searchable = [
        metadata.id,
        metadata.title,
        metadata.taskTitle,
        metadata.userFacingName,
        metadata.requestedFormat,
        metadata.type,
        markdown.slice(0, 2000),
      ].filter(Boolean).join(" ");
      const typePenalty = requestedType && metadata.type !== requestedType ? -8 : 0;
      const score = scoreText(searchable, terms) + typePenalty + recencyBoost(metadata.createdAt);
      if (score <= 0) continue;
      artifacts.push({
        handle: metadata.id,
        title: safeText(metadata.userFacingName || metadata.title, 120),
        type: metadata.type,
        preview: safeText(markdown || metadata.taskTitle || metadata.title, 220),
        confidence: confidenceForScore(score),
        freshness: `created ${metadata.createdAt ?? new Date(info.mtimeMs).toISOString()}`,
        source: "workspace-demo-artifact",
        score,
        updatedAtMs: metadata.createdAt ? dateMs(metadata.createdAt) : info.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  return artifacts;
}

function safeReference(reference: WorkspaceReferencePacket["references"][number]): WorkspaceAgentSafeReference {
  return {
    handle: safeText(reference.handle, 120),
    title: safeText(reference.title, 160),
    sourceType: reference.sourceType,
    excerpt: safeText(reference.excerpt, MAX_EXCERPT_CHARS),
    confidence: reference.confidence,
    ...(reference.freshness ? { freshness: safeText(reference.freshness, 120) } : {}),
    score: reference.score,
    matchedTerms: reference.matchedTerms.map((term) => safeText(term, 40)).slice(0, 8),
  };
}

function isCallContentReference(reference: WorkspaceReferencePacket["references"][number]): boolean {
  return reference.sourceType === "call-transcript" || reference.sourceType === "call-summary";
}

function stripArtifactScore(artifact: ScoredArtifact): WorkspaceAgentSafeArtifact {
  return {
    handle: artifact.handle,
    title: artifact.title,
    type: artifact.type,
    preview: artifact.preview,
    confidence: artifact.confidence,
    ...(artifact.freshness ? { freshness: artifact.freshness } : {}),
    source: artifact.source,
  };
}

function safeRootKeys(rootsRead: WorkspaceReferencePacket["rootsRead"]): string[] {
  const keys = rootsRead.map((root) => root.key).filter(Boolean);
  return keys.length ? keys : REFERENCE_SOURCE_ROOTS;
}

function statusForCoverage(coverage: WorkspaceAgentToolCoverage): WorkspaceAgentToolStatus {
  if (coverage === "matched") return "ok";
  if (coverage === "thin") return "limited";
  return "no_results";
}

function confidenceForScore(score: number): WorkspaceReferenceConfidence {
  if (score >= 16) return "high";
  if (score >= 8) return "medium";
  return "low";
}

function recencyBoost(value: string | undefined): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  if (ageDays < 14) return 6;
  if (ageDays < 60) return 3;
  return 0;
}

function dateMs(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function looksLikeCallTrendRequest(prompt: string): boolean {
  return /\b(calls?|call logs?|transcripts?|recent calls?|trends?)\b/i.test(prompt) &&
    /\b(top|trend|summary|summari[sz]e|recent|predict|predictable|strateg(?:y|ies)|models?|learned knowledge|playbooks?)\b/i.test(prompt);
}

function looksLikeArtifactFindRequest(prompt: string): boolean {
  return /\b(find|latest|show|locate|open)\b/i.test(prompt) && /\bartifacts?\b/i.test(prompt);
}

function looksMemoryDependent(prompt: string): boolean {
  return /\b(ricky|calder|pay|handover|memory|reference|client|source|workspace|current|recent calls?)\b/i.test(prompt);
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])]
    .filter((term) => !["and", "are", "can", "for", "from", "give", "latest", "the", "this", "what", "with"].includes(term))
    .slice(0, 20);
}

function scoreText(value: string, terms: string[]): number {
  const lower = value.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 8 : 0), 0);
}

function safeText(value: string, limit: number): string {
  const redacted = redactLocalPaths(value).replace(/\s+/g, " ").trim();
  return redacted.length > limit ? `${redacted.slice(0, Math.max(0, limit - 1)).trim()}...` : redacted;
}

function redactLocalPaths(value: string): string {
  return value
    .replace(/\/Users\/[^\s"'`),;]+/g, "[Workspace internal path]")
    .replace(/\/private\/[^\s"'`),;]+/g, "[Workspace internal path]")
    .replace(/\/var\/folders\/[^\s"'`),;]+/g, "[Workspace internal path]")
    .replace(/\/tmp\/[^\s"'`),;]+/g, "[Workspace internal path]")
    .replace(/\.openclaw\/[^\s"'`),;]+/g, "[Workspace internal path]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredTrimmedString(value: unknown, field: string, issues: string[], maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${field} must be a non-empty string`);
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) issues.push(`${field} must be ${maxLength} characters or fewer`);
  return trimmed;
}

function optionalTrimmedString(value: unknown, field: string, issues: string[], maxLength = 120): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(`${field} must be a string when present`);
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) issues.push(`${field} must be ${maxLength} characters or fewer`);
  return trimmed;
}

function normalizeLimit(value: unknown, issues: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    issues.push(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    return undefined;
  }
  return value;
}

function finishInput<T extends WorkspaceAgentToolInput>(
  value: T,
  issues: string[],
): ContractValidationResult<T> {
  if (issues.length) return { ok: false, issues };
  return { ok: true, data: withoutUndefined(value) as T };
}

function withoutUndefined(value: object): object {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function baseToolEvent(ctx: WorkspaceAgentToolEventContext) {
  return {
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId,
    runId: ctx.runId,
    createdAt: ctx.now().toISOString(),
  };
}

function safeToolInputSummary(toolName: WorkspaceAgentToolName, input: WorkspaceAgentToolInput): Record<string, unknown> {
  if (toolName === "summarize_calls") {
    return {
      query: safeText((input as SummarizeCallsInput).query ?? "recent calls", 160),
      project: (input as SummarizeCallsInput).project ?? DEFAULT_PROJECT,
      room: (input as SummarizeCallsInput).room ?? DEFAULT_ROOM,
      limit: (input as SummarizeCallsInput).limit ?? DEFAULT_LIMIT,
    };
  }
  if (toolName === "get_reference_packet") {
    const referenceInput = input as GetReferencePacketInput;
    return {
      prompt: safeText(referenceInput.prompt, 160),
      project: referenceInput.project,
      room: referenceInput.room,
      limit: referenceInput.limit ?? DEFAULT_LIMIT,
    };
  }
  const baseInput = input as SearchMemoryInput | FindArtifactInput;
  return {
    query: safeText(baseInput.query, 160),
    project: baseInput.project ?? DEFAULT_PROJECT,
    room: baseInput.room ?? DEFAULT_ROOM,
    limit: baseInput.limit ?? DEFAULT_LIMIT,
    ...("type" in baseInput && baseInput.type ? { type: baseInput.type } : {}),
  };
}

function toolCallLabel(toolName: WorkspaceAgentToolName): string {
  if (toolName === "search_memory") return "Search read-only Workspace memory";
  if (toolName === "find_artifact") return "Find read-only Workspace artifacts";
  if (toolName === "summarize_calls") return "Summarize available call references";
  return "Resolve Workspace reference packet";
}

function toolResultLabel(output: WorkspaceAgentToolOutput): string {
  if (output.status === "no_results") return "No read-only references found";
  if (output.status === "limited") return "Limited read-only references found";
  return "Read-only references found";
}
