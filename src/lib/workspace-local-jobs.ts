import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { WorkspaceLibrarianReference } from "./workspace-librarian-references";

export const WORKSPACE_LOCAL_JOBS_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-local-jobs";
export const WORKSPACE_LOCAL_JOBS_FILE = "local-jobs.jsonl";
export const WORKSPACE_LOCAL_JOB_CONTROLS_FILE = "local-job-controls.jsonl";
export const WORKSPACE_WORKER_REQUESTS_DIR = "workspace-worker-requests";
export const WORKSPACE_WORKER_RESULTS_DIR = "workspace-worker-results";

export const WORKSPACE_LOCAL_JOB_STATUSES = [
  "draft",
  "queued_local",
  "not_executing",
  "ready_for_worker",
  "result_imported",
  "completed_local",
  "worker_claimed",
  "worker_staged",
  "worker_result_written",
  "worker_failed",
  "execution_started",
  "execution_completed",
  "execution_failed",
  "archived",
] as const;
export const WORKSPACE_LOCAL_JOB_WORKFLOWS = [
  "ask_atlas",
  "audit",
  "content_batch",
  "call_archive",
  "training_session",
  "general",
] as const;
export const WORKSPACE_LOCAL_JOB_ROOMS = [
  "home",
  "audits",
  "content",
  "approvals",
  "agent-runs",
  "training",
  "knowledge",
  "readiness",
] as const;
export const WORKSPACE_LOCAL_JOB_PROJECTS = [
  "undeniable-os",
  "l2-audits",
  "content-engine",
  "delivery-ops",
  "memory-knowledge",
] as const;

export type WorkspaceLocalJobStatus = typeof WORKSPACE_LOCAL_JOB_STATUSES[number];
export type WorkspaceLocalJobWorkflow = typeof WORKSPACE_LOCAL_JOB_WORKFLOWS[number];
export type WorkspaceLocalJobRoom = typeof WORKSPACE_LOCAL_JOB_ROOMS[number];
export type WorkspaceLocalJobProject = typeof WORKSPACE_LOCAL_JOB_PROJECTS[number];
export type WorkspaceLocalJobControlAction =
  | "update"
  | "archive"
  | "delete"
  | "ready_for_worker"
  | "worker_package_created"
  | "result_imported"
  | "result_rejected"
  | "result_archived"
  | "worker_claimed"
  | "worker_staged"
  | "worker_result_written"
  | "worker_failed"
  | "execution_started"
  | "execution_completed"
  | "execution_failed";

export type WorkspaceLocalJob = {
  schemaVersion: 1;
  id: string;
  title: string;
  prompt: string;
  project: string;
  room: string;
  requesterRole: string;
  createdAt: string;
  updatedAt: string;
  status: WorkspaceLocalJobStatus;
  intendedWorkflow: WorkspaceLocalJobWorkflow;
  source: "workspace";
  execution: {
    state: "not_executing";
    reason: string;
  };
};

export type WorkspaceLocalJobControlPatch = {
  title?: string;
  prompt?: string;
  project?: WorkspaceLocalJobProject;
  room?: WorkspaceLocalJobRoom;
  intendedWorkflow?: WorkspaceLocalJobWorkflow;
};

export type WorkspaceLocalWorkerPackageContextSummary = {
  generatedAt: string;
  localJobs: {
    active: number;
    archived: number;
    controls: number;
  };
  artifacts: {
    total: number;
    recentTitles: string[];
    latestAuditTitle: string | null;
  };
  memory: {
    status: string;
    contextPacks: number;
    reviewItems: number;
  };
  runs: {
    validRecords: number;
    sourcesPresent: number;
  };
  approvals: {
    pending: number;
    slackVisible: number;
    taskReviews: number;
  };
  readiness: {
    localJobSource: string;
    artifactRecords: number;
    externalSystems: "not_connected";
  };
};

export type WorkspaceLocalWorkerPackage = {
  schemaVersion: 1;
  packageId: string;
  createdAt: string;
  handoffMode: "manual_local_only";
  job: {
    id: string;
    title: string;
    prompt: string;
    room: string;
    project: string;
    intendedWorkflow: WorkspaceLocalJobWorkflow;
    currentStatus: WorkspaceLocalJobStatus;
  };
  contextSummary: WorkspaceLocalWorkerPackageContextSummary;
  constraints: string[];
};

export type WorkspaceLocalWorkerResult = {
  schemaVersion: 1;
  id: string;
  jobId: string;
  importedAt: string;
  source: "manual-local-import";
  status: "result_imported" | "result_rejected" | "result_archived";
  title: string;
  body: string;
};

export type WorkspaceLocalWorkerRequestFiles = {
  adapter: string;
  requestJsonPath: string;
  requestMarkdownPath: string;
  resultJsonPath: string;
  resultMarkdownPath: string;
};

export type WorkspaceLocalWorkerAdapterRequest = {
  schemaVersion: 1;
  requestId: string;
  adapter: string;
  createdAt: string;
  job: {
    id: string;
    title: string;
    prompt: string;
    room: string;
    project: string;
    intendedWorkflow: WorkspaceLocalJobWorkflow;
    currentStatus: WorkspaceLocalJobStatus;
  };
  currentEvents: Array<{
    action: WorkspaceLocalJobControlAction;
    createdAt: string;
    note?: string;
  }>;
  paths: WorkspaceLocalWorkerRequestFiles;
  contextPointers: {
    workspaceUrl: string;
    localJobSource: string;
    localControlSource: string;
    artifactProjectionApi: string;
    memoryMaintenanceApi: string;
    readinessRoomUrl: string;
  };
  librarianReferences: WorkspaceLibrarianReference[];
  constraints: string[];
  resultInstructions: string[];
};

export type WorkspaceLocalJobControlEvent = {
  schemaVersion: 1;
  id: string;
  jobId: string;
  action: WorkspaceLocalJobControlAction;
  createdAt: string;
  source: "workspace-control";
  patch?: WorkspaceLocalJobControlPatch;
  workerPackage?: WorkspaceLocalWorkerPackage;
  result?: WorkspaceLocalWorkerResult;
  resultId?: string;
  adapter?: string;
  requestFiles?: WorkspaceLocalWorkerRequestFiles;
  resultPath?: string;
  errorMessage?: string;
  librarianReferences?: WorkspaceLibrarianReference[];
  note?: string;
};

export type WorkspaceLocalJobInput = {
  prompt: string;
  project: string;
  room: string;
  requesterRole: string;
  intendedWorkflow?: WorkspaceLocalJobWorkflow;
};

export type WorkspaceLocalJobControlInput = {
  jobId: string;
  action: WorkspaceLocalJobControlAction;
  workerPackage?: WorkspaceLocalWorkerPackage;
  resultBody?: string;
  resultTitle?: string;
  resultId?: string;
  adapter?: string;
  requestFiles?: WorkspaceLocalWorkerRequestFiles;
  resultPath?: string;
  errorMessage?: string;
  librarianReferences?: WorkspaceLibrarianReference[];
  note?: string;
} & WorkspaceLocalJobControlPatch;

export type WorkspaceLocalJobValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export type WorkspaceLocalJobsProjection = {
  root: string;
  file: string;
  controlFile: string;
  records: WorkspaceLocalJob[];
  archivedRecords: WorkspaceLocalJob[];
  events: WorkspaceLocalJobControlEvent[];
  eventsByJob: Record<string, WorkspaceLocalJobControlEvent[]>;
  workerPackagesByJob: Record<string, WorkspaceLocalWorkerPackage>;
  workerRequestsByJob: Record<string, WorkspaceLocalWorkerRequestFiles>;
  workerResultPathsByJob: Record<string, string[]>;
  librarianReferencesByJob: Record<string, WorkspaceLibrarianReference[]>;
  resultsByJob: Record<string, WorkspaceLocalWorkerResult[]>;
  health: {
    present: boolean;
    recordCount: number;
    validRecordCount: number;
    invalidRecordCount: number;
    archivedRecordCount: number;
    deletedRecordCount: number;
    controlRecordCount: number;
    lastModified: string | null;
    errors: Array<{
      source: string;
      ref?: string;
      message: string;
    }>;
  };
  controlHealth: {
    present: boolean;
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
};

type WorkspaceLocalJobStorageOptions = {
  root?: string;
  now?: Date;
  idFactory?: () => string;
};

const MAX_PROMPT_LENGTH = 8000;
const MAX_FIELD_LENGTH = 120;
const MAX_TITLE_LENGTH = 120;
const MAX_RESULT_LENGTH = 24000;
const STATUS_SET = new Set<string>(WORKSPACE_LOCAL_JOB_STATUSES);
const WORKFLOW_SET = new Set<string>(WORKSPACE_LOCAL_JOB_WORKFLOWS);
const ROOM_SET = new Set<string>(WORKSPACE_LOCAL_JOB_ROOMS);
const PROJECT_SET = new Set<string>(WORKSPACE_LOCAL_JOB_PROJECTS);
const CONTROL_ACTION_SET = new Set<string>([
  "update",
  "archive",
  "delete",
  "ready_for_worker",
  "worker_package_created",
  "result_imported",
  "result_rejected",
  "result_archived",
  "worker_claimed",
  "worker_staged",
  "worker_result_written",
  "worker_failed",
  "execution_started",
  "execution_completed",
  "execution_failed",
]);

export const WORKSPACE_WORKER_HANDOFF_CONSTRAINTS = [
  "No external send is allowed: do not send Slack, DM, email, or external messages.",
  "Do not mutate Supabase, Monday, Typeform, OpenClaw config, or external systems.",
  "Do not delete, move, rename, or attach files.",
  "Do not mutate OpenClaw config.",
  "Do not start workers, models, daemons, background jobs, or side effects unless a later approval explicitly permits it.",
  "Treat this package as a manual local handoff contract only.",
] as const;

function storagePath(root = WORKSPACE_LOCAL_JOBS_ROOT): string {
  return join(root, WORKSPACE_LOCAL_JOBS_FILE);
}

function controlStoragePath(root = WORKSPACE_LOCAL_JOBS_ROOT): string {
  return join(root, WORKSPACE_LOCAL_JOB_CONTROLS_FILE);
}

function workerRequestsPath(root = WORKSPACE_LOCAL_JOBS_ROOT): string {
  return join(root, WORKSPACE_WORKER_REQUESTS_DIR);
}

function workerResultsPath(root = WORKSPACE_LOCAL_JOBS_ROOT): string {
  return join(root, WORKSPACE_WORKER_RESULTS_DIR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.slice(0, MAX_FIELD_LENGTH) || fallback;
}

function cleanPrompt(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_PROMPT_LENGTH) : "";
}

function cleanTitle(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TITLE_LENGTH) : "";
}

function cleanResultBody(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_RESULT_LENGTH) : "";
}

function cleanResultTitle(value: unknown, body: string): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_TITLE_LENGTH);
  return titleFromPrompt(body).slice(0, MAX_TITLE_LENGTH);
}

function cleanAdapter(value: unknown): string {
  return cleanField(value, "codex").replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || "codex";
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Workspace request";
  const withoutTrailing = firstLine.replace(/[.!?]+$/, "");
  return withoutTrailing.length > 72 ? `${withoutTrailing.slice(0, 69).trim()}...` : withoutTrailing;
}

export function inferWorkspaceLocalJobWorkflow(prompt: string): WorkspaceLocalJobWorkflow {
  const normalized = prompt.toLowerCase();
  if (/\baudit\b|l2|typeform|qa/.test(normalized)) return "audit";
  if (/call archive|transcript|call notes|recording|archive/.test(normalized)) return "call_archive";
  if (/content|\bscript\b|batch|\bpost\b|caption|newsletter/.test(normalized)) return "content_batch";
  if (/train|training|brain dump|principle|memory|context/.test(normalized)) return "training_session";
  if (/ask atlas|question|solve|think through/.test(normalized)) return "ask_atlas";
  return "general";
}

export function buildWorkspaceLocalWorkerPackage({
  job,
  contextSummary,
  now = new Date(),
  idFactory = randomUUID,
}: {
  job: WorkspaceLocalJob;
  contextSummary: WorkspaceLocalWorkerPackageContextSummary;
  now?: Date;
  idFactory?: () => string;
}): WorkspaceLocalWorkerPackage {
  return {
    schemaVersion: 1,
    packageId: `local_worker_package_${idFactory().replace(/[^a-zA-Z0-9_-]/g, "")}`,
    createdAt: now.toISOString(),
    handoffMode: "manual_local_only",
    job: {
      id: job.id,
      title: job.title,
      prompt: job.prompt,
      room: job.room,
      project: job.project,
      intendedWorkflow: job.intendedWorkflow,
      currentStatus: job.status,
    },
    contextSummary,
    constraints: [...WORKSPACE_WORKER_HANDOFF_CONSTRAINTS],
  };
}

export function formatWorkspaceLocalWorkerPackage(workerPackage: WorkspaceLocalWorkerPackage): string {
  return JSON.stringify(workerPackage, null, 2);
}

function workerRequestFiles({
  root,
  jobId,
  adapter,
}: {
  root: string;
  jobId: string;
  adapter: string;
}): WorkspaceLocalWorkerRequestFiles {
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeAdapter = cleanAdapter(adapter);
  return {
    adapter: safeAdapter,
    requestJsonPath: join(workerRequestsPath(root), `${safeJobId}.json`),
    requestMarkdownPath: join(workerRequestsPath(root), `${safeJobId}.md`),
    resultJsonPath: join(workerResultsPath(root), `${safeJobId}.json`),
    resultMarkdownPath: join(workerResultsPath(root), `${safeJobId}.md`),
  };
}

function validateWorkerRequestFiles(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalWorkerRequestFiles> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Worker request files must be an object."] };
  const adapter = cleanAdapter(value.adapter);
  const requestJsonPath = typeof value.requestJsonPath === "string" ? value.requestJsonPath.trim() : "";
  const requestMarkdownPath = typeof value.requestMarkdownPath === "string" ? value.requestMarkdownPath.trim() : "";
  const resultJsonPath = typeof value.resultJsonPath === "string" ? value.resultJsonPath.trim() : "";
  const resultMarkdownPath = typeof value.resultMarkdownPath === "string" ? value.resultMarkdownPath.trim() : "";
  if (!requestJsonPath) errors.push("requestJsonPath is required.");
  if (!requestMarkdownPath) errors.push("requestMarkdownPath is required.");
  if (!resultJsonPath) errors.push("resultJsonPath is required.");
  if (!resultMarkdownPath) errors.push("resultMarkdownPath is required.");
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { adapter, requestJsonPath, requestMarkdownPath, resultJsonPath, resultMarkdownPath } };
}

function validateLibrarianReferences(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLibrarianReference[]> {
  const errors: string[] = [];
  if (!Array.isArray(value)) return { ok: false, errors: ["librarianReferences must be an array."] };
  const references: WorkspaceLibrarianReference[] = [];
  value.slice(0, 8).forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`librarianReferences[${index}] must be an object.`);
      return;
    }
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 160) : "";
    const type = typeof item.type === "string" ? item.type.trim().slice(0, 80) : "";
    const sourcePath = typeof item.sourcePath === "string" ? item.sourcePath.trim() : "";
    const relevanceReason = typeof item.relevanceReason === "string" ? item.relevanceReason.trim().slice(0, 240) : "";
    if (!title) errors.push(`librarianReferences[${index}].title is required.`);
    if (!type) errors.push(`librarianReferences[${index}].type is required.`);
    if (!sourcePath) errors.push(`librarianReferences[${index}].sourcePath is required.`);
    if (!relevanceReason) errors.push(`librarianReferences[${index}].relevanceReason is required.`);
    references.push({
      title,
      type,
      sourcePath,
      ...(typeof item.summary === "string" && item.summary.trim() ? { summary: item.summary.trim().slice(0, 300) } : {}),
      relevanceReason,
      ...(typeof item.updatedAt === "string" && item.updatedAt.trim() ? { updatedAt: item.updatedAt.trim() } : {}),
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: references };
}

export function buildWorkspaceLocalWorkerAdapterRequest({
  job,
  projection,
  adapter = "codex",
  files,
  librarianReferences = [],
  now = new Date(),
  idFactory = randomUUID,
}: {
  job: WorkspaceLocalJob;
  projection: WorkspaceLocalJobsProjection;
  adapter?: string;
  files: WorkspaceLocalWorkerRequestFiles;
  librarianReferences?: WorkspaceLibrarianReference[];
  now?: Date;
  idFactory?: () => string;
}): WorkspaceLocalWorkerAdapterRequest {
  const safeAdapter = cleanAdapter(adapter);
  const workspaceUrl = `/workspace?room=${encodeURIComponent(job.room)}&project=${encodeURIComponent(job.project)}&role=${encodeURIComponent(job.requesterRole)}&job=${encodeURIComponent(job.id)}`;
  return {
    schemaVersion: 1,
    requestId: `local_worker_request_${idFactory().replace(/[^a-zA-Z0-9_-]/g, "")}`,
    adapter: safeAdapter,
    createdAt: now.toISOString(),
    job: {
      id: job.id,
      title: job.title,
      prompt: job.prompt,
      room: job.room,
      project: job.project,
      intendedWorkflow: job.intendedWorkflow,
      currentStatus: job.status,
    },
    currentEvents: (projection.eventsByJob[job.id] ?? []).map((event) => ({
      action: event.action,
      createdAt: event.createdAt,
      ...(event.note ? { note: event.note } : {}),
    })),
    paths: files,
    contextPointers: {
      workspaceUrl,
      localJobSource: projection.file,
      localControlSource: projection.controlFile,
      artifactProjectionApi: "/api/workspace/artifacts",
      memoryMaintenanceApi: "/api/workspace/memory-maintenance",
      readinessRoomUrl: "/workspace?room=readiness",
    },
    librarianReferences,
    constraints: [
      ...WORKSPACE_WORKER_HANDOFF_CONSTRAINTS,
      `Write the final result to ${files.resultMarkdownPath} or ${files.resultJsonPath} only.`,
    ],
    resultInstructions: [
      "Write a concise result body for Workspace import.",
      "Use Markdown for the .md result path, or JSON with title/body fields for the .json result path.",
      "Do not deliver, publish, send, delete files, or mutate external systems.",
    ],
  };
}

export function formatWorkspaceLocalWorkerAdapterRequest(request: WorkspaceLocalWorkerAdapterRequest): string {
  return [
    `# Workspace local worker request: ${request.job.title}`,
    "",
    `- Request: ${request.requestId}`,
    `- Adapter: ${request.adapter}`,
    `- Job: ${request.job.id}`,
    `- Status: ${request.job.currentStatus}`,
    `- Room: ${request.job.room}`,
    `- Project: ${request.job.project}`,
    `- Workflow: ${request.job.intendedWorkflow}`,
    "",
    "## Prompt",
    "",
    request.job.prompt,
    "",
    "## Current Events",
    "",
    request.currentEvents.length
      ? request.currentEvents.map((event) => `- ${event.createdAt}: ${event.action}${event.note ? ` - ${event.note}` : ""}`).join("\n")
      : "- No prior worker adapter events.",
    "",
    "## Context Pointers",
    "",
    `- Workspace: ${request.contextPointers.workspaceUrl}`,
    `- Local jobs JSONL: ${request.contextPointers.localJobSource}`,
    `- Local controls JSONL: ${request.contextPointers.localControlSource}`,
    `- Artifacts API: ${request.contextPointers.artifactProjectionApi}`,
    `- Memory API: ${request.contextPointers.memoryMaintenanceApi}`,
    `- Readiness room: ${request.contextPointers.readinessRoomUrl}`,
    "",
    "## Librarian References",
    "",
    request.librarianReferences.length
      ? request.librarianReferences.map((reference) => [
          `- ${reference.title}`,
          `  - type: ${reference.type}`,
          `  - source: ${reference.sourcePath}`,
          reference.updatedAt ? `  - updated: ${reference.updatedAt}` : "",
          reference.summary ? `  - summary: ${reference.summary}` : "",
          `  - relevance: ${reference.relevanceReason}`,
        ].filter(Boolean).join("\n")).join("\n")
      : "No Librarian references found.",
    "",
    "## Constraints",
    "",
    ...request.constraints.map((constraint) => `- ${constraint}`),
    "",
    "## Result",
    "",
    `Write the result to one of these paths only:`,
    `- ${request.paths.resultMarkdownPath}`,
    `- ${request.paths.resultJsonPath}`,
    "",
  ].join("\n");
}

export function validateWorkspaceLocalJobInput(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalJobInput> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Input must be an object."] };

  const prompt = cleanPrompt(value.prompt);
  if (!prompt) errors.push("Prompt is required.");
  if (typeof value.prompt === "string" && value.prompt.length > MAX_PROMPT_LENGTH) {
    errors.push(`Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
  }

  const requestedWorkflow = value.intendedWorkflow;
  const intendedWorkflow = typeof requestedWorkflow === "string" && WORKFLOW_SET.has(requestedWorkflow)
    ? requestedWorkflow as WorkspaceLocalJobWorkflow
    : inferWorkspaceLocalJobWorkflow(prompt);
  if (requestedWorkflow !== undefined && (typeof requestedWorkflow !== "string" || !WORKFLOW_SET.has(requestedWorkflow))) {
    errors.push("Intended workflow is not supported.");
  }

  const project = cleanField(value.project, "undeniable-os");
  const room = cleanField(value.room, "home");
  const requesterRole = cleanField(value.requesterRole, "rhys");

  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          prompt,
          project,
          room,
          requesterRole,
          intendedWorkflow,
        },
      };
}

export function validateWorkspaceLocalJobControlInput(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalJobControlInput> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Input must be an object."] };

  const jobId = cleanField(value.jobId, "");
  if (!jobId) errors.push("jobId is required.");

  const action = value.action;
  if (typeof action !== "string" || !CONTROL_ACTION_SET.has(action)) {
    errors.push("Control action is not supported.");
  }

  const patch: WorkspaceLocalJobControlPatch = {};
  if (value.title !== undefined) {
    const title = cleanTitle(value.title);
    if (!title) errors.push("Title cannot be blank.");
    else patch.title = title;
  }
  if (value.prompt !== undefined) {
    const prompt = cleanPrompt(value.prompt);
    if (!prompt) errors.push("Prompt cannot be blank.");
    else patch.prompt = prompt;
  }
  if (value.project !== undefined) {
    if (typeof value.project !== "string" || !PROJECT_SET.has(value.project)) errors.push("Project is not supported.");
    else patch.project = value.project as WorkspaceLocalJobProject;
  }
  if (value.room !== undefined) {
    if (typeof value.room !== "string" || !ROOM_SET.has(value.room)) errors.push("Room is not supported.");
    else patch.room = value.room as WorkspaceLocalJobRoom;
  }
  if (value.intendedWorkflow !== undefined) {
    if (typeof value.intendedWorkflow !== "string" || !WORKFLOW_SET.has(value.intendedWorkflow)) {
      errors.push("Intended workflow is not supported.");
    } else {
      patch.intendedWorkflow = value.intendedWorkflow as WorkspaceLocalJobWorkflow;
    }
  }

  const typedAction = action as WorkspaceLocalJobControlAction;
  if (typedAction === "update" && Object.keys(patch).length === 0) {
    errors.push("At least one local update field is required.");
  }
  if (typedAction !== "update" && Object.keys(patch).length > 0) {
    errors.push("Only update controls can include local edit fields.");
  }

  let workerPackage: WorkspaceLocalWorkerPackage | undefined;
  if (typedAction === "worker_package_created") {
    const checkedPackage = validateWorkspaceLocalWorkerPackage(value.workerPackage);
    if (!checkedPackage.ok) errors.push(...checkedPackage.errors);
    else if (checkedPackage.value.job.id !== jobId) errors.push("Worker package job id must match jobId.");
    else workerPackage = checkedPackage.value;
  } else if (value.workerPackage !== undefined) {
    errors.push("Only worker_package_created controls can include a worker package.");
  }

  let resultBody: string | undefined;
  let resultTitle: string | undefined;
  if (typedAction === "result_imported") {
    resultBody = cleanResultBody(value.resultBody);
    if (!resultBody) errors.push("Result body is required.");
    if (typeof value.resultBody === "string" && value.resultBody.length > MAX_RESULT_LENGTH) {
      errors.push(`Result body must be ${MAX_RESULT_LENGTH} characters or fewer.`);
    }
    resultTitle = cleanResultTitle(value.resultTitle, resultBody);
  } else if (value.resultBody !== undefined || value.resultTitle !== undefined) {
    errors.push("Only result_imported controls can include a manual result.");
  }

  const resultId = cleanField(value.resultId, "");
  if (["result_rejected", "result_archived"].includes(typedAction) && !resultId) {
    errors.push("resultId is required.");
  }
  if (!["result_rejected", "result_archived"].includes(typedAction) && value.resultId !== undefined) {
    errors.push("Only result_rejected or result_archived controls can include resultId.");
  }

  const adapter = value.adapter !== undefined ? cleanAdapter(value.adapter) : undefined;
  let requestFiles: WorkspaceLocalWorkerRequestFiles | undefined;
  if (value.requestFiles !== undefined) {
    const checkedFiles = validateWorkerRequestFiles(value.requestFiles);
    if (!checkedFiles.ok) errors.push(...checkedFiles.errors);
    else requestFiles = checkedFiles.value;
  }
  if (["worker_claimed", "worker_staged", "execution_started"].includes(typedAction) && !requestFiles) {
    errors.push("Worker claim/stage events require request files.");
  }
  if (!["worker_claimed", "worker_staged", "execution_started"].includes(typedAction) && value.requestFiles !== undefined) {
    errors.push("Only worker claim/stage/execution start events can include request files.");
  }

  const resultPath = typeof value.resultPath === "string" ? value.resultPath.trim() : "";
  if (["worker_result_written", "execution_completed"].includes(typedAction) && !resultPath) errors.push("resultPath is required.");
  if (!["worker_result_written", "execution_completed"].includes(typedAction) && value.resultPath !== undefined) {
    errors.push("Only worker_result_written or execution_completed controls can include resultPath.");
  }

  const errorMessage = typeof value.errorMessage === "string" ? value.errorMessage.trim().slice(0, 2000) : "";
  if (["worker_failed", "execution_failed"].includes(typedAction) && !errorMessage) errors.push("errorMessage is required.");
  if (!["worker_failed", "execution_failed"].includes(typedAction) && value.errorMessage !== undefined) {
    errors.push("Only worker_failed or execution_failed controls can include errorMessage.");
  }

  let librarianReferences: WorkspaceLibrarianReference[] | undefined;
  if (value.librarianReferences !== undefined) {
    const checkedReferences = validateLibrarianReferences(value.librarianReferences);
    if (!checkedReferences.ok) errors.push(...checkedReferences.errors);
    else librarianReferences = checkedReferences.value;
  }
  if (!["worker_claimed", "worker_staged", "execution_started"].includes(typedAction) && value.librarianReferences !== undefined) {
    errors.push("Only worker claim/stage/execution start events can include librarianReferences.");
  }

  const note = cleanPrompt(value.note).slice(0, 1000);

  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          jobId,
          action: typedAction,
          ...(workerPackage ? { workerPackage } : {}),
          ...(resultBody ? { resultBody, resultTitle } : {}),
          ...(resultId ? { resultId } : {}),
          ...(adapter ? { adapter } : {}),
          ...(requestFiles ? { requestFiles } : {}),
          ...(resultPath ? { resultPath } : {}),
          ...(errorMessage ? { errorMessage } : {}),
          ...(librarianReferences ? { librarianReferences } : {}),
          ...(note ? { note } : {}),
          ...patch,
        },
      };
}

export function validateWorkspaceLocalJob(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalJob> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Record must be an object."] };

  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof value.id !== "string" || !value.id.trim()) errors.push("id is required.");
  if (typeof value.title !== "string" || !value.title.trim()) errors.push("title is required.");
  if (typeof value.prompt !== "string" || !value.prompt.trim()) errors.push("prompt is required.");
  if (typeof value.project !== "string" || !value.project.trim()) errors.push("project is required.");
  if (typeof value.room !== "string" || !value.room.trim()) errors.push("room is required.");
  if (typeof value.requesterRole !== "string" || !value.requesterRole.trim()) errors.push("requesterRole is required.");
  if (!isIsoDate(value.createdAt)) errors.push("createdAt must be an ISO timestamp.");
  if (!isIsoDate(value.updatedAt)) errors.push("updatedAt must be an ISO timestamp.");
  if (typeof value.status !== "string" || !STATUS_SET.has(value.status)) errors.push("status is not supported.");
  if (typeof value.intendedWorkflow !== "string" || !WORKFLOW_SET.has(value.intendedWorkflow)) {
    errors.push("intendedWorkflow is not supported.");
  }
  if (value.source !== "workspace") errors.push("source must be workspace.");
  if (!isRecord(value.execution) || value.execution.state !== "not_executing") {
    errors.push("execution.state must be not_executing.");
  }
  if (!isRecord(value.execution) || typeof value.execution.reason !== "string" || !value.execution.reason.trim()) {
    errors.push("execution.reason is required.");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: value as WorkspaceLocalJob };
}

export function validateWorkspaceLocalWorkerPackage(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalWorkerPackage> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Worker package must be an object."] };

  if (value.schemaVersion !== 1) errors.push("Worker package schemaVersion must be 1.");
  if (typeof value.packageId !== "string" || !value.packageId.trim()) errors.push("Worker package packageId is required.");
  if (!isIsoDate(value.createdAt)) errors.push("Worker package createdAt must be an ISO timestamp.");
  if (value.handoffMode !== "manual_local_only") errors.push("Worker package handoffMode must be manual_local_only.");

  if (!isRecord(value.job)) {
    errors.push("Worker package job is required.");
  } else {
    if (typeof value.job.id !== "string" || !value.job.id.trim()) errors.push("Worker package job.id is required.");
    if (typeof value.job.title !== "string" || !value.job.title.trim()) errors.push("Worker package job.title is required.");
    if (typeof value.job.prompt !== "string" || !value.job.prompt.trim()) errors.push("Worker package job.prompt is required.");
    if (typeof value.job.room !== "string" || !value.job.room.trim()) errors.push("Worker package job.room is required.");
    if (typeof value.job.project !== "string" || !value.job.project.trim()) errors.push("Worker package job.project is required.");
    if (typeof value.job.intendedWorkflow !== "string" || !WORKFLOW_SET.has(value.job.intendedWorkflow)) {
      errors.push("Worker package job.intendedWorkflow is not supported.");
    }
    if (typeof value.job.currentStatus !== "string" || !STATUS_SET.has(value.job.currentStatus)) {
      errors.push("Worker package job.currentStatus is not supported.");
    }
  }

  if (!isRecord(value.contextSummary)) errors.push("Worker package contextSummary is required.");
  if (!Array.isArray(value.constraints) || value.constraints.length === 0 || value.constraints.some((item) => typeof item !== "string" || !item.trim())) {
    errors.push("Worker package constraints are required.");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: value as WorkspaceLocalWorkerPackage };
}

export function validateWorkspaceLocalWorkerResult(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalWorkerResult> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Worker result must be an object."] };

  if (value.schemaVersion !== 1) errors.push("Worker result schemaVersion must be 1.");
  if (typeof value.id !== "string" || !value.id.trim()) errors.push("Worker result id is required.");
  if (typeof value.jobId !== "string" || !value.jobId.trim()) errors.push("Worker result jobId is required.");
  if (!isIsoDate(value.importedAt)) errors.push("Worker result importedAt must be an ISO timestamp.");
  if (value.source !== "manual-local-import") errors.push("Worker result source must be manual-local-import.");
  if (!["result_imported", "result_rejected", "result_archived"].includes(typeof value.status === "string" ? value.status : "")) {
    errors.push("Worker result status is not supported.");
  }
  if (typeof value.title !== "string" || !value.title.trim()) errors.push("Worker result title is required.");
  if (typeof value.body !== "string" || !value.body.trim()) errors.push("Worker result body is required.");

  return errors.length ? { ok: false, errors } : { ok: true, value: value as WorkspaceLocalWorkerResult };
}

export function validateWorkspaceLocalJobControlEvent(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalJobControlEvent> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Control record must be an object."] };

  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof value.id !== "string" || !value.id.trim()) errors.push("id is required.");
  if (typeof value.jobId !== "string" || !value.jobId.trim()) errors.push("jobId is required.");
  if (typeof value.action !== "string" || !CONTROL_ACTION_SET.has(value.action)) errors.push("action is not supported.");
  if (!isIsoDate(value.createdAt)) errors.push("createdAt must be an ISO timestamp.");
  if (value.source !== "workspace-control") errors.push("source must be workspace-control.");

  if (value.patch !== undefined) {
    if (!isRecord(value.patch)) {
      errors.push("patch must be an object.");
    } else {
      const checked = validateWorkspaceLocalJobControlInput({
        jobId: value.jobId,
        action: value.action,
        ...value.patch,
      });
      if (!checked.ok) errors.push(...checked.errors);
    }
  } else if (value.action === "update") {
    errors.push("Update controls require a patch.");
  }

  if (value.action === "worker_package_created") {
    const checked = validateWorkspaceLocalWorkerPackage(value.workerPackage);
    if (!checked.ok) errors.push(...checked.errors);
    if (checked.ok && checked.value.job.id !== value.jobId) errors.push("Worker package job id must match event jobId.");
  }

  if (value.action === "result_imported") {
    const checked = validateWorkspaceLocalWorkerResult(value.result);
    if (!checked.ok) errors.push(...checked.errors);
    if (checked.ok && checked.value.jobId !== value.jobId) errors.push("Worker result jobId must match event jobId.");
  }

  if (value.action === "result_rejected" || value.action === "result_archived") {
    if (typeof value.resultId !== "string" || !value.resultId.trim()) errors.push("resultId is required.");
  } else if (value.resultId !== undefined) {
    errors.push("Only result_rejected or result_archived events can include resultId.");
  }

  if (value.adapter !== undefined && (typeof value.adapter !== "string" || !value.adapter.trim())) {
    errors.push("adapter must be a non-empty string.");
  }

  if (value.action === "worker_claimed" || value.action === "worker_staged" || value.action === "execution_started") {
    const checkedFiles = validateWorkerRequestFiles(value.requestFiles);
    if (!checkedFiles.ok) errors.push(...checkedFiles.errors);
  } else if (value.requestFiles !== undefined) {
    errors.push("Only worker_claimed, worker_staged, or execution_started events can include requestFiles.");
  }

  if (value.action === "worker_result_written" || value.action === "execution_completed") {
    if (typeof value.resultPath !== "string" || !value.resultPath.trim()) errors.push("resultPath is required.");
  } else if (value.resultPath !== undefined) {
    errors.push("Only worker_result_written or execution_completed events can include resultPath.");
  }

  if (value.action === "worker_failed" || value.action === "execution_failed") {
    if (typeof value.errorMessage !== "string" || !value.errorMessage.trim()) errors.push("errorMessage is required.");
  } else if (value.errorMessage !== undefined) {
    errors.push("Only worker_failed or execution_failed events can include errorMessage.");
  }

  if (value.librarianReferences !== undefined) {
    const checkedReferences = validateLibrarianReferences(value.librarianReferences);
    if (!checkedReferences.ok) errors.push(...checkedReferences.errors);
    if (value.action !== "worker_claimed" && value.action !== "worker_staged" && value.action !== "execution_started") {
      errors.push("Only worker_claimed, worker_staged, or execution_started events can include librarianReferences.");
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: value as WorkspaceLocalJobControlEvent };
}

export async function createWorkspaceLocalJob(
  input: WorkspaceLocalJobInput,
  options: WorkspaceLocalJobStorageOptions = {},
): Promise<WorkspaceLocalJob> {
  const checked = validateWorkspaceLocalJobInput(input);
  if (!checked.ok) {
    throw new Error(checked.errors.join(" "));
  }

  const root = options.root ?? WORKSPACE_LOCAL_JOBS_ROOT;
  const now = (options.now ?? new Date()).toISOString();
  const job: WorkspaceLocalJob = {
    schemaVersion: 1,
    id: `local_job_${(options.idFactory ?? randomUUID)().replace(/[^a-zA-Z0-9_-]/g, "")}`,
    title: titleFromPrompt(checked.value.prompt),
    prompt: checked.value.prompt,
    project: checked.value.project,
    room: checked.value.room,
    requesterRole: checked.value.requesterRole,
    createdAt: now,
    updatedAt: now,
    status: "queued_local",
    intendedWorkflow: checked.value.intendedWorkflow ?? inferWorkspaceLocalJobWorkflow(checked.value.prompt),
    source: "workspace",
    execution: {
      state: "not_executing",
      reason: "Saved by Workspace local intake only. No worker, model, delivery, or external platform was invoked.",
    },
  };

  const validated = validateWorkspaceLocalJob(job);
  if (!validated.ok) throw new Error(validated.errors.join(" "));

  await mkdir(root, { recursive: true });
  await appendFile(storagePath(root), `${JSON.stringify(job)}\n`, "utf8");

  return job;
}

export async function applyWorkspaceLocalJobControl(
  input: WorkspaceLocalJobControlInput,
  options: WorkspaceLocalJobStorageOptions = {},
): Promise<WorkspaceLocalJobControlEvent> {
  const checked = validateWorkspaceLocalJobControlInput(input);
  if (!checked.ok) throw new Error(checked.errors.join(" "));

  const root = options.root ?? WORKSPACE_LOCAL_JOBS_ROOT;
  const now = (options.now ?? new Date()).toISOString();
  const {
    jobId,
    action,
    workerPackage,
    resultBody,
    resultTitle,
    resultId,
    adapter,
    requestFiles,
    resultPath,
    errorMessage,
    note,
    ...patch
  } = checked.value;
  const result: WorkspaceLocalWorkerResult | undefined = resultBody
    ? {
        schemaVersion: 1,
        id: `local_worker_result_${(options.idFactory ?? randomUUID)().replace(/[^a-zA-Z0-9_-]/g, "")}`,
        jobId,
        importedAt: now,
        source: "manual-local-import",
        status: "result_imported",
        title: resultTitle ?? cleanResultTitle(undefined, resultBody),
        body: resultBody,
      }
    : undefined;
  const event: WorkspaceLocalJobControlEvent = {
    schemaVersion: 1,
    id: `local_job_control_${(options.idFactory ?? randomUUID)().replace(/[^a-zA-Z0-9_-]/g, "")}`,
    jobId,
    action,
    createdAt: now,
    source: "workspace-control",
    ...(action === "update" ? { patch } : {}),
    ...(workerPackage ? { workerPackage } : {}),
    ...(result ? { result } : {}),
    ...(resultId ? { resultId } : {}),
    ...(adapter ? { adapter } : {}),
    ...(requestFiles ? { requestFiles } : {}),
    ...(resultPath ? { resultPath } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(checked.value.librarianReferences ? { librarianReferences: checked.value.librarianReferences } : {}),
    ...(note ? { note } : {}),
  };

  const validated = validateWorkspaceLocalJobControlEvent(event);
  if (!validated.ok) throw new Error(validated.errors.join(" "));

  await mkdir(root, { recursive: true });
  await appendFile(controlStoragePath(root), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export type WorkspaceLocalWorkerClaimResult = {
  job: WorkspaceLocalJob;
  request: WorkspaceLocalWorkerAdapterRequest;
  files: WorkspaceLocalWorkerRequestFiles;
  events: WorkspaceLocalJobControlEvent[];
};

export type WorkspaceLocalWorkerImportResult = {
  job: WorkspaceLocalJob;
  resultPath: string;
  events: WorkspaceLocalJobControlEvent[];
};

export async function claimWorkspaceLocalWorkerJob({
  jobId,
  adapter = "codex",
  root = WORKSPACE_LOCAL_JOBS_ROOT,
  librarianReferences,
  now = new Date(),
  idFactory = randomUUID,
}: {
  jobId?: string;
  adapter?: string;
  root?: string;
  librarianReferences?: WorkspaceLibrarianReference[] | false;
  now?: Date;
  idFactory?: () => string;
} = {}): Promise<WorkspaceLocalWorkerClaimResult> {
  const projection = await getWorkspaceLocalJobs({ root });
  const job = jobId
    ? projection.records.find((record) => record.id === jobId)
    : projection.records.find((record) => record.status === "ready_for_worker");
  if (!job) throw new Error(jobId ? `Local job ${jobId} was not found.` : "No ready local worker job was found.");
  if (job.status !== "ready_for_worker") {
    throw new Error(`Local job ${job.id} is ${job.status}; mark it ready_for_worker before claiming.`);
  }

  const safeAdapter = cleanAdapter(adapter);
  const files = workerRequestFiles({ root, jobId: job.id, adapter: safeAdapter });
  const resolvedLibrarianReferences = librarianReferences === false
    ? []
    : librarianReferences ?? [];
  const request = buildWorkspaceLocalWorkerAdapterRequest({
    job,
    projection,
    adapter: safeAdapter,
    files,
    librarianReferences: resolvedLibrarianReferences,
    now,
    idFactory,
  });

  await mkdir(workerRequestsPath(root), { recursive: true });
  await mkdir(workerResultsPath(root), { recursive: true });
  await writeFile(files.requestJsonPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  await writeFile(files.requestMarkdownPath, formatWorkspaceLocalWorkerAdapterRequest(request), "utf8");

  const claimed = await applyWorkspaceLocalJobControl(
    {
      jobId: job.id,
      action: "worker_claimed",
      adapter: safeAdapter,
      requestFiles: files,
      librarianReferences: resolvedLibrarianReferences,
      note: `Claimed by ${safeAdapter} local adapter. No worker was invoked.`,
    },
    { root, now, idFactory },
  );
  const staged = await applyWorkspaceLocalJobControl(
    {
      jobId: job.id,
      action: "worker_staged",
      adapter: safeAdapter,
      requestFiles: files,
      librarianReferences: resolvedLibrarianReferences,
      note: `Request package written for ${safeAdapter}. Result must be written to the staged result path only.`,
    },
    { root, now, idFactory },
  );

  return {
    job,
    request,
    files,
    events: [claimed, staged],
  };
}

function parseWorkerResultContent(resultPath: string, content: string): { title: string; body: string } {
  if (resultPath.endsWith(".json")) {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) throw new Error("JSON result must be an object.");
    const body = cleanResultBody(parsed.body ?? parsed.result ?? parsed.content);
    if (!body) throw new Error("JSON result requires a non-empty body, result, or content field.");
    return {
      title: cleanResultTitle(parsed.title, body),
      body,
    };
  }

  const body = cleanResultBody(content);
  if (!body) throw new Error("Result file is empty.");
  const heading = body.split("\n").find((line) => line.trim().startsWith("#"));
  return {
    title: cleanResultTitle(heading?.replace(/^#+\s*/, ""), body) || cleanResultTitle(basename(resultPath), body),
    body,
  };
}

export async function importWorkspaceLocalWorkerResult({
  jobId,
  resultPath,
  root = WORKSPACE_LOCAL_JOBS_ROOT,
  now = new Date(),
  idFactory = randomUUID,
}: {
  jobId: string;
  resultPath: string;
  root?: string;
  now?: Date;
  idFactory?: () => string;
}): Promise<WorkspaceLocalWorkerImportResult> {
  const projection = await getWorkspaceLocalJobs({ root });
  const job = projection.records.find((record) => record.id === jobId);
  if (!job) throw new Error(`Local job ${jobId} was not found.`);

  const resolvedResultPath = resolve(resultPath);
  const content = await readFile(resolvedResultPath, "utf8");
  const parsed = parseWorkerResultContent(resolvedResultPath, content);
  const written = await applyWorkspaceLocalJobControl(
    {
      jobId,
      action: "worker_result_written",
      resultPath: resolvedResultPath,
      note: "Worker adapter result file detected locally. Not delivered or sent.",
    },
    { root, now, idFactory },
  );
  const imported = await applyWorkspaceLocalJobControl(
    {
      jobId,
      action: "result_imported",
      resultTitle: parsed.title,
      resultBody: parsed.body,
      note: `Imported from ${resolvedResultPath}.`,
    },
    { root, now, idFactory },
  );

  return {
    job,
    resultPath: resolvedResultPath,
    events: [written, imported],
  };
}

export async function getWorkspaceLocalJobs(
  options: Pick<WorkspaceLocalJobStorageOptions, "root"> = {},
): Promise<WorkspaceLocalJobsProjection> {
  const root = options.root ?? WORKSPACE_LOCAL_JOBS_ROOT;
  const file = storagePath(root);
  const controlFile = controlStoragePath(root);
  const projection: WorkspaceLocalJobsProjection = {
    root,
    file,
    controlFile,
    records: [],
    archivedRecords: [],
    events: [],
    eventsByJob: {},
    workerPackagesByJob: {},
    workerRequestsByJob: {},
    workerResultPathsByJob: {},
    librarianReferencesByJob: {},
    resultsByJob: {},
    health: {
      present: false,
      recordCount: 0,
      validRecordCount: 0,
      invalidRecordCount: 0,
      archivedRecordCount: 0,
      deletedRecordCount: 0,
      controlRecordCount: 0,
      lastModified: null,
      errors: [],
    },
    controlHealth: {
      present: false,
      recordCount: 0,
      validRecordCount: 0,
      invalidRecordCount: 0,
      lastModified: null,
      errors: [],
    },
  };

  if (existsSync(file)) {
    try {
      const info = await stat(file);
      if (!info.isFile()) return projection;
    projection.health.present = true;
    projection.health.lastModified = new Date(info.mtimeMs).toISOString();

    const content = await readFile(file, "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      projection.health.recordCount += 1;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const checked = validateWorkspaceLocalJob(parsed);
        if (checked.ok) {
          projection.records.push(checked.value);
          projection.health.validRecordCount += 1;
        } else {
          projection.health.invalidRecordCount += 1;
          projection.health.errors.push({
            source: file,
            ref: `line:${index + 1}`,
            message: checked.errors.join(" "),
          });
        }
      } catch (error) {
        projection.health.invalidRecordCount += 1;
        projection.health.errors.push({
          source: file,
          ref: `line:${index + 1}`,
          message: error instanceof Error ? error.message : "Invalid JSONL record",
        });
      }
    }
  } catch (error) {
    projection.health.errors.push({
      source: file,
      message: error instanceof Error ? error.message : "Unable to read local job records",
    });
  }
  }

  const controls: WorkspaceLocalJobControlEvent[] = [];
  if (existsSync(controlFile)) {
    try {
      const info = await stat(controlFile);
      if (info.isFile()) {
        projection.controlHealth.present = true;
        projection.controlHealth.lastModified = new Date(info.mtimeMs).toISOString();
        const content = await readFile(controlFile, "utf8");
        for (const [index, line] of content.split("\n").entries()) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          projection.controlHealth.recordCount += 1;
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            const checked = validateWorkspaceLocalJobControlEvent(parsed);
            if (checked.ok) {
              controls.push(checked.value);
              projection.controlHealth.validRecordCount += 1;
            } else {
              projection.controlHealth.invalidRecordCount += 1;
              projection.controlHealth.errors.push({
                source: controlFile,
                ref: `line:${index + 1}`,
                message: checked.errors.join(" "),
              });
            }
          } catch (error) {
            projection.controlHealth.invalidRecordCount += 1;
            projection.controlHealth.errors.push({
              source: controlFile,
              ref: `line:${index + 1}`,
              message: error instanceof Error ? error.message : "Invalid JSONL control record",
            });
          }
        }
      }
    } catch (error) {
      projection.controlHealth.errors.push({
        source: controlFile,
        message: error instanceof Error ? error.message : "Unable to read local job controls",
      });
    }
  }

  const sortedControls = controls.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  projection.events = sortedControls;
  sortedControls.forEach((event) => {
    projection.eventsByJob[event.jobId] = [...(projection.eventsByJob[event.jobId] ?? []), event];
  });

  const jobsById = new Map(projection.records.map((job) => [job.id, { ...job }]));
  const deletedIds = new Set<string>();
  const resultsById = new Map<string, WorkspaceLocalWorkerResult>();
  sortedControls
    .forEach((event) => {
      const job = jobsById.get(event.jobId);
      if (!job) return;

      if (event.action === "delete") {
        deletedIds.add(event.jobId);
        jobsById.delete(event.jobId);
        return;
      }

      if (deletedIds.has(event.jobId)) return;

      if (event.action === "archive") {
        jobsById.set(event.jobId, {
          ...job,
          status: "archived",
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "ready_for_worker") {
        jobsById.set(event.jobId, {
          ...job,
          status: "ready_for_worker",
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "worker_claimed" && event.requestFiles) {
        projection.workerRequestsByJob[event.jobId] = event.requestFiles;
        if (event.librarianReferences) projection.librarianReferencesByJob[event.jobId] = event.librarianReferences;
        jobsById.set(event.jobId, {
          ...job,
          status: "worker_claimed",
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "worker_staged" && event.requestFiles) {
        projection.workerRequestsByJob[event.jobId] = event.requestFiles;
        if (event.librarianReferences) projection.librarianReferencesByJob[event.jobId] = event.librarianReferences;
        jobsById.set(event.jobId, {
          ...job,
          status: "worker_staged",
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "execution_started" && event.requestFiles) {
        projection.workerRequestsByJob[event.jobId] = event.requestFiles;
        if (event.librarianReferences) projection.librarianReferencesByJob[event.jobId] = event.librarianReferences;
        jobsById.set(event.jobId, {
          ...job,
          status: "execution_started",
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "worker_package_created" && event.workerPackage) {
        projection.workerPackagesByJob[event.jobId] = event.workerPackage;
        jobsById.set(event.jobId, {
          ...job,
          status: job.status === "queued_local" || job.status === "not_executing" ? "ready_for_worker" : job.status,
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "worker_result_written" && event.resultPath) {
        projection.workerResultPathsByJob[event.jobId] = [
          ...(projection.workerResultPathsByJob[event.jobId] ?? []),
          event.resultPath,
        ];
        jobsById.set(event.jobId, {
          ...job,
          status: "worker_result_written",
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "execution_completed" && event.resultPath) {
        jobsById.set(event.jobId, {
          ...job,
          status: job.status === "completed_local" ? "completed_local" : "execution_completed",
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "result_imported" && event.result) {
        resultsById.set(event.result.id, event.result);
        jobsById.set(event.jobId, {
          ...job,
          status: "completed_local",
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "worker_failed" || event.action === "execution_failed") {
        jobsById.set(event.jobId, {
          ...job,
          status: "worker_failed",
          updatedAt: event.createdAt,
        });
        return;
      }

      if ((event.action === "result_rejected" || event.action === "result_archived") && event.resultId) {
        const result = resultsById.get(event.resultId);
        if (result) {
          resultsById.set(event.resultId, {
            ...result,
            status: event.action === "result_rejected" ? "result_rejected" : "result_archived",
          });
        }
        jobsById.set(event.jobId, {
          ...job,
          updatedAt: event.createdAt,
        });
        return;
      }

      if (event.action === "update" && event.patch) {
        jobsById.set(event.jobId, {
          ...job,
          ...event.patch,
          updatedAt: event.createdAt,
        });
      }
    });

  resultsById.forEach((result) => {
    projection.resultsByJob[result.jobId] = [...(projection.resultsByJob[result.jobId] ?? []), result];
  });

  const projectedRecords = [...jobsById.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  projection.records = projectedRecords.filter((job) => job.status !== "archived");
  projection.archivedRecords = projectedRecords.filter((job) => job.status === "archived");
  projection.health.archivedRecordCount = projection.archivedRecords.length;
  projection.health.deletedRecordCount = deletedIds.size;
  projection.health.controlRecordCount = projection.controlHealth.validRecordCount;
  return projection;
}
