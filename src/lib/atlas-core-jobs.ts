import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const ATLAS_CORE_JOB_ROOT = "/Users/atlasai/.openclaw/workspace/state/atlas-core-jobs";
export const ATLAS_CORE_JOB_EVENTS_FILE = "atlas-core-job-events.jsonl";
export const ATLAS_CORE_JOB_STORE_VERSION = 1;

export const ATLAS_CORE_JOB_STATUSES = [
  "received",
  "queued",
  "building",
  "artifact_ready",
  "delivery_requested",
  "delivered",
  "blocked",
  "failed",
  "waiting_for_approval",
] as const;

export const ATLAS_CORE_JOB_EVENT_KINDS = [
  "job.created",
  "job.status_changed",
  "artifact.recorded",
  "delivery.receipted",
  "approval.recorded",
] as const;

export type AtlasCoreJobStatus = (typeof ATLAS_CORE_JOB_STATUSES)[number];
export type AtlasCoreJobEventKind = (typeof ATLAS_CORE_JOB_EVENT_KINDS)[number];
export type AtlasCoreJobSourceType = "slack" | "workspace" | "operator";
export type AtlasCoreArtifactKind = "pdf" | "docx" | "html" | "md" | "deck" | "sheet" | "png";
export type AtlasCoreDeliveryStatus = "delivered";
export type AtlasCoreApprovalStatus = "pending" | "approved" | "denied" | "redraft_requested" | "sent" | "failed";

export interface AtlasCoreJob {
  schemaVersion: typeof ATLAS_CORE_JOB_STORE_VERSION;
  id: string;
  projectId: string;
  source: {
    type: AtlasCoreJobSourceType;
    channelId?: string;
    messageTs?: string;
    userId?: string;
  };
  request: {
    text: string;
    classification: string;
    createdAt: string;
  };
  status: AtlasCoreJobStatus;
  workflow?: {
    key: string;
    id: string;
    adapter: string;
  };
  artifactIds: string[];
  deliveryIds: string[];
  approvalIds: string[];
  createdAt: string;
  updatedAt: string;
  safeErrorSummary?: string;
}

export interface AtlasCoreArtifact {
  schemaVersion: typeof ATLAS_CORE_JOB_STORE_VERSION;
  id: string;
  projectId: string;
  jobId: string;
  title: string;
  kind: AtlasCoreArtifactKind;
  paths: string[];
  sourcePaths: string[];
  validation: {
    status: "passed" | "failed";
    checks: Record<string, boolean | string | number>;
  };
  version: number;
  createdAt: string;
}

export interface AtlasCoreDeliveryReceipt {
  channelId: string;
  fileId?: string;
  messageTs?: string;
}

export interface AtlasCoreDelivery {
  schemaVersion: typeof ATLAS_CORE_JOB_STORE_VERSION;
  id: string;
  projectId: string;
  jobId: string;
  artifactId?: string;
  destination: {
    type: "slack_dm" | "slack_channel" | "workspace_review";
    channelId?: string;
  };
  status: AtlasCoreDeliveryStatus;
  result: AtlasCoreDeliveryReceipt;
  createdAt: string;
}

export interface AtlasCoreApproval {
  schemaVersion: typeof ATLAS_CORE_JOB_STORE_VERSION;
  id: string;
  projectId: string;
  jobId?: string;
  artifactId?: string;
  channel: "slack" | "email" | "workspace";
  destination: string;
  draft: string | null;
  status: AtlasCoreApprovalStatus;
  feedback?: string;
  deliveryResult?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AtlasCoreProjectLane {
  id: string;
  name: string;
  client: string;
  allowedUsers: string[];
  slackChannels: string[];
  defaultDelivery: "slack_dm" | "workspace_review";
  activeWorkflowKeys: string[];
}

export interface AtlasCoreJobEvent {
  schemaVersion: typeof ATLAS_CORE_JOB_STORE_VERSION;
  id: string;
  jobId: string;
  kind: AtlasCoreJobEventKind;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface AtlasCoreJobProjection {
  jobs: AtlasCoreJob[];
  artifacts: AtlasCoreArtifact[];
  deliveries: AtlasCoreDelivery[];
  approvals: AtlasCoreApproval[];
  events: AtlasCoreJobEvent[];
  health: {
    present: boolean;
    recordCount: number;
    validRecordCount: number;
    invalidRecordCount: number;
  };
}

export interface AtlasCoreJobStoreScope {
  root?: string;
}

export interface CreateAtlasCoreJobInput {
  projectId: string;
  source: AtlasCoreJob["source"];
  request: {
    text: string;
    classification: string;
    createdAt?: string;
  };
  status?: AtlasCoreJobStatus;
  workflow?: AtlasCoreJob["workflow"];
}

export interface AtlasCoreJobStoreOptions extends AtlasCoreJobStoreScope {
  now?: Date;
  idFactory?: () => string;
}

export interface AtlasCoreTransitionInput {
  jobId: string;
  status: AtlasCoreJobStatus;
  workflow?: AtlasCoreJob["workflow"];
  safeErrorSummary?: string;
}

export interface RecordAtlasCoreArtifactInput {
  jobId: string;
  title: string;
  kind: AtlasCoreArtifactKind;
  paths: string[];
  sourcePaths?: string[];
  validation: AtlasCoreArtifact["validation"];
  version?: number;
}

export interface RecordAtlasCoreDeliveryReceiptInput {
  jobId: string;
  artifactId?: string;
  destination: AtlasCoreDelivery["destination"];
  result: AtlasCoreDeliveryReceipt;
}

export interface RecordAtlasCoreApprovalInput {
  projectId: string;
  jobId?: string;
  artifactId?: string;
  channel: AtlasCoreApproval["channel"];
  destination: string;
  draft: string | null;
  status?: AtlasCoreApprovalStatus;
  feedback?: string;
}

const STATUS_SET = new Set<string>(ATLAS_CORE_JOB_STATUSES);
const EVENT_KIND_SET = new Set<string>(ATLAS_CORE_JOB_EVENT_KINDS);
const TERMINAL_STATUSES = new Set<AtlasCoreJobStatus>(["delivered", "blocked", "failed"]);
const ALLOWED_TRANSITIONS: Record<AtlasCoreJobStatus, Set<AtlasCoreJobStatus>> = {
  received: new Set(["queued", "waiting_for_approval", "blocked", "failed"]),
  queued: new Set(["building", "waiting_for_approval", "blocked", "failed"]),
  building: new Set(["artifact_ready", "waiting_for_approval", "blocked", "failed"]),
  artifact_ready: new Set(["delivery_requested", "waiting_for_approval", "blocked", "failed"]),
  delivery_requested: new Set(["blocked", "failed"]),
  delivered: new Set(),
  blocked: new Set(),
  failed: new Set(),
  waiting_for_approval: new Set(["queued", "building", "delivery_requested", "blocked", "failed"]),
};

export async function createAtlasCoreJob(
  input: CreateAtlasCoreJobInput,
  options: AtlasCoreJobStoreOptions = {},
): Promise<AtlasCoreJob> {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const id = createAtlasCoreJobId(options.idFactory);
  const status = input.status ?? "received";
  if (status === "delivered") throw new Error("Core jobs cannot be created as delivered.");
  assertStatus(status);

  const job: AtlasCoreJob = {
    schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
    id,
    projectId: cleanRequired(input.projectId, "projectId"),
    source: normalizeSource(input.source),
    request: {
      text: cleanRequired(input.request.text, "request.text", 10_000),
      classification: cleanRequired(input.request.classification, "request.classification", 200),
      createdAt: input.request.createdAt ?? createdAt,
    },
    status,
    ...(input.workflow ? { workflow: normalizeWorkflow(input.workflow) } : {}),
    artifactIds: [],
    deliveryIds: [],
    approvalIds: [],
    createdAt,
    updatedAt: createdAt,
  };

  await appendCoreJobEvent(
    {
      id: createAtlasCoreEventId(options.idFactory),
      jobId: id,
      kind: "job.created",
      createdAt,
      payload: { job },
      schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
    },
    options,
  );
  return job;
}

export async function transitionAtlasCoreJob(
  input: AtlasCoreTransitionInput,
  options: AtlasCoreJobStoreOptions = {},
): Promise<AtlasCoreJob> {
  if (input.status === "delivered") {
    throw new Error("Use recordAtlasCoreDeliveryReceipt() to mark a job delivered.");
  }
  assertStatus(input.status);
  const projection = await readAtlasCoreJobProjection(options);
  const job = projection.jobs.find((j) => j.id === input.jobId);
  if (!job) throw new Error(`Core job not found: ${input.jobId}`);
  assertCanTransition(job.status, input.status);

  const now = options.now ?? new Date();
  const event: AtlasCoreJobEvent = {
    schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
    id: createAtlasCoreEventId(options.idFactory),
    jobId: job.id,
    kind: "job.status_changed",
    createdAt: now.toISOString(),
    payload: {
      status: input.status,
      ...(input.workflow ? { workflow: normalizeWorkflow(input.workflow) } : {}),
      ...(input.safeErrorSummary ? { safeErrorSummary: cleanRequired(input.safeErrorSummary, "safeErrorSummary", 1_000) } : {}),
    },
  };
  await appendCoreJobEvent(event, options);

  const next = applyEventToProjection(projection, event).jobs.find((j) => j.id === job.id);
  if (!next) throw new Error(`Core job disappeared after transition: ${job.id}`);
  return next;
}

export async function recordAtlasCoreArtifact(
  input: RecordAtlasCoreArtifactInput,
  options: AtlasCoreJobStoreOptions = {},
): Promise<AtlasCoreArtifact> {
  const projection = await readAtlasCoreJobProjection(options);
  const job = projection.jobs.find((j) => j.id === input.jobId);
  if (!job) throw new Error(`Core job not found: ${input.jobId}`);
  if (TERMINAL_STATUSES.has(job.status)) throw new Error(`Cannot add artifact to terminal job: ${job.status}`);
  if (!input.paths.length) throw new Error("Artifact requires at least one path.");
  if (input.validation.status !== "passed") throw new Error("Only validated artifacts can be recorded in the core store.");

  const now = options.now ?? new Date();
  const artifact: AtlasCoreArtifact = {
    schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
    id: createAtlasCoreArtifactId(options.idFactory),
    projectId: job.projectId,
    jobId: job.id,
    title: cleanRequired(input.title, "artifact.title", 500),
    kind: input.kind,
    paths: input.paths.map((p) => cleanRequired(p, "artifact.path", 2_000)),
    sourcePaths: (input.sourcePaths ?? []).map((p) => cleanRequired(p, "artifact.sourcePath", 2_000)),
    validation: input.validation,
    version: input.version ?? 1,
    createdAt: now.toISOString(),
  };

  await appendCoreJobEvent(
    {
      schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
      id: createAtlasCoreEventId(options.idFactory),
      jobId: job.id,
      kind: "artifact.recorded",
      createdAt: artifact.createdAt,
      payload: { artifact },
    },
    options,
  );
  return artifact;
}

export async function recordAtlasCoreDeliveryReceipt(
  input: RecordAtlasCoreDeliveryReceiptInput,
  options: AtlasCoreJobStoreOptions = {},
): Promise<AtlasCoreDelivery> {
  assertDeliveryReceipt(input.result);
  const projection = await readAtlasCoreJobProjection(options);
  const job = projection.jobs.find((j) => j.id === input.jobId);
  if (!job) throw new Error(`Core job not found: ${input.jobId}`);
  if (job.status !== "delivery_requested" && job.status !== "artifact_ready") {
    throw new Error(`Cannot receipt delivery from status: ${job.status}`);
  }
  if (input.artifactId && !job.artifactIds.includes(input.artifactId)) {
    throw new Error(`Artifact ${input.artifactId} is not attached to job ${job.id}.`);
  }

  const now = options.now ?? new Date();
  const delivery: AtlasCoreDelivery = {
    schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
    id: createAtlasCoreDeliveryId(options.idFactory),
    projectId: job.projectId,
    jobId: job.id,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    destination: input.destination,
    status: "delivered",
    result: input.result,
    createdAt: now.toISOString(),
  };

  await appendCoreJobEvent(
    {
      schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
      id: createAtlasCoreEventId(options.idFactory),
      jobId: job.id,
      kind: "delivery.receipted",
      createdAt: delivery.createdAt,
      payload: { delivery },
    },
    options,
  );
  return delivery;
}

export async function recordAtlasCoreApproval(
  input: RecordAtlasCoreApprovalInput,
  options: AtlasCoreJobStoreOptions = {},
): Promise<AtlasCoreApproval> {
  const projection = await readAtlasCoreJobProjection(options);
  if (input.jobId && !projection.jobs.some((j) => j.id === input.jobId)) {
    throw new Error(`Core job not found: ${input.jobId}`);
  }
  if (input.artifactId && !projection.artifacts.some((a) => a.id === input.artifactId)) {
    throw new Error(`Core artifact not found: ${input.artifactId}`);
  }
  const now = (options.now ?? new Date()).toISOString();
  const approval: AtlasCoreApproval = {
    schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
    id: createAtlasCoreApprovalId(options.idFactory),
    projectId: cleanRequired(input.projectId, "projectId"),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    channel: input.channel,
    destination: cleanRequired(input.destination, "approval.destination", 500),
    draft: input.draft,
    status: input.status ?? "pending",
    ...(input.feedback ? { feedback: cleanRequired(input.feedback, "approval.feedback", 1_000) } : {}),
    createdAt: now,
    updatedAt: now,
  };

  await appendCoreJobEvent(
    {
      schemaVersion: ATLAS_CORE_JOB_STORE_VERSION,
      id: createAtlasCoreEventId(options.idFactory),
      jobId: input.jobId ?? `approval:${approval.id}`,
      kind: "approval.recorded",
      createdAt: now,
      payload: { approval },
    },
    options,
  );
  return approval;
}

export async function listAtlasCoreJobs(
  input: { projectId?: string; status?: AtlasCoreJobStatus; limit?: number } = {},
  options: AtlasCoreJobStoreScope = {},
): Promise<AtlasCoreJob[]> {
  const projection = await readAtlasCoreJobProjection(options);
  let jobs = projection.jobs;
  if (input.projectId) jobs = jobs.filter((j) => j.projectId === input.projectId);
  if (input.status) jobs = jobs.filter((j) => j.status === input.status);
  jobs = [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return typeof input.limit === "number" ? jobs.slice(0, Math.max(0, input.limit)) : jobs;
}

export async function readAtlasCoreJobProjection(
  options: AtlasCoreJobStoreScope = {},
): Promise<AtlasCoreJobProjection> {
  const events = await readCoreJobEvents(options);
  const projection = emptyProjection(events.present, events.recordCount, events.validRecordCount, events.invalidRecordCount);
  for (const event of events.validEvents) {
    applyEventToProjection(projection, event);
  }
  return projection;
}

function applyEventToProjection(projection: AtlasCoreJobProjection, event: AtlasCoreJobEvent): AtlasCoreJobProjection {
  projection.events.push(event);
  if (event.kind === "job.created") {
    const job = validateJobPayload(event.payload.job);
    projection.jobs.push(job);
    return projection;
  }

  if (event.kind === "job.status_changed") {
    const job = findJobOrSkip(projection, event.jobId);
    if (!job) return projection;
    const status = event.payload.status;
    if (typeof status !== "string") return projection;
    assertStatus(status);
    job.status = status;
    job.updatedAt = event.createdAt;
    if (event.payload.workflow) job.workflow = normalizeWorkflow(event.payload.workflow as AtlasCoreJob["workflow"]);
    if (typeof event.payload.safeErrorSummary === "string") job.safeErrorSummary = event.payload.safeErrorSummary;
    return projection;
  }

  if (event.kind === "artifact.recorded") {
    const artifact = validateArtifactPayload(event.payload.artifact);
    projection.artifacts.push(artifact);
    const job = findJobOrSkip(projection, artifact.jobId);
    if (job) {
      job.artifactIds = appendUnique(job.artifactIds, artifact.id);
      job.status = "artifact_ready";
      job.updatedAt = artifact.createdAt;
    }
    return projection;
  }

  if (event.kind === "delivery.receipted") {
    const delivery = validateDeliveryPayload(event.payload.delivery);
    projection.deliveries.push(delivery);
    const job = findJobOrSkip(projection, delivery.jobId);
    if (job) {
      job.deliveryIds = appendUnique(job.deliveryIds, delivery.id);
      job.status = "delivered";
      job.updatedAt = delivery.createdAt;
    }
    return projection;
  }

  if (event.kind === "approval.recorded") {
    const approval = validateApprovalPayload(event.payload.approval);
    projection.approvals.push(approval);
    if (approval.jobId) {
      const job = findJobOrSkip(projection, approval.jobId);
      if (job) {
        job.approvalIds = appendUnique(job.approvalIds, approval.id);
        job.updatedAt = approval.updatedAt;
      }
    }
  }
  return projection;
}

async function appendCoreJobEvent(event: AtlasCoreJobEvent, options: AtlasCoreJobStoreOptions): Promise<void> {
  validateCoreJobEvent(event);
  const filePath = coreJobEventsPath(options.root);
  await mkdir(resolveRoot(options.root), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

async function readCoreJobEvents(options: AtlasCoreJobStoreScope) {
  const filePath = coreJobEventsPath(options.root);
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return { present: false, recordCount: 0, validRecordCount: 0, invalidRecordCount: 0, validEvents: [] as AtlasCoreJobEvent[] };
    }
    throw error;
  }
  const validEvents: AtlasCoreJobEvent[] = [];
  let invalidRecordCount = 0;
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      validateCoreJobEvent(parsed);
      validEvents.push(parsed);
    } catch {
      invalidRecordCount++;
    }
  }
  return {
    present: true,
    recordCount: lines.length,
    validRecordCount: validEvents.length,
    invalidRecordCount,
    validEvents,
  };
}

function emptyProjection(
  present: boolean,
  recordCount: number,
  validRecordCount: number,
  invalidRecordCount: number,
): AtlasCoreJobProjection {
  return {
    jobs: [],
    artifacts: [],
    deliveries: [],
    approvals: [],
    events: [],
    health: { present, recordCount, validRecordCount, invalidRecordCount },
  };
}

function resolveRoot(root?: string): string {
  return resolve(root ?? ATLAS_CORE_JOB_ROOT);
}

function coreJobEventsPath(root?: string): string {
  const resolvedRoot = resolveRoot(root);
  const path = resolve(resolvedRoot, ATLAS_CORE_JOB_EVENTS_FILE);
  if (path !== resolvedRoot && !path.startsWith(resolvedRoot + sep)) {
    throw new Error("Core job events path escaped the configured root.");
  }
  return path;
}

function createAtlasCoreJobId(idFactory?: () => string): string {
  return `atlas_job_${cleanIdPart(idFactory?.() ?? randomUUID())}`;
}

function createAtlasCoreEventId(idFactory?: () => string): string {
  return `atlas_job_event_${cleanIdPart(idFactory?.() ?? randomUUID())}`;
}

function createAtlasCoreArtifactId(idFactory?: () => string): string {
  return `atlas_artifact_${cleanIdPart(idFactory?.() ?? randomUUID())}`;
}

function createAtlasCoreDeliveryId(idFactory?: () => string): string {
  return `atlas_delivery_${cleanIdPart(idFactory?.() ?? randomUUID())}`;
}

function createAtlasCoreApprovalId(idFactory?: () => string): string {
  return `atlas_approval_${cleanIdPart(idFactory?.() ?? randomUUID())}`;
}

function cleanIdPart(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  if (!clean) throw new Error("Generated empty id.");
  return clean;
}

function cleanRequired(value: string, field: string, max = 200): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required.`);
  if (clean.length > max) return clean.slice(0, max);
  return clean;
}

function normalizeSource(source: AtlasCoreJob["source"]): AtlasCoreJob["source"] {
  if (!["slack", "workspace", "operator"].includes(source.type)) throw new Error(`Invalid job source: ${source.type}`);
  return {
    type: source.type,
    ...(source.channelId ? { channelId: cleanRequired(source.channelId, "source.channelId", 200) } : {}),
    ...(source.messageTs ? { messageTs: cleanRequired(source.messageTs, "source.messageTs", 200) } : {}),
    ...(source.userId ? { userId: cleanRequired(source.userId, "source.userId", 200) } : {}),
  };
}

function normalizeWorkflow(workflow: AtlasCoreJob["workflow"]): AtlasCoreJob["workflow"] {
  if (!workflow) return workflow;
  return {
    key: cleanRequired(workflow.key, "workflow.key", 200),
    id: cleanRequired(workflow.id, "workflow.id", 200),
    adapter: cleanRequired(workflow.adapter, "workflow.adapter", 200),
  };
}

function assertStatus(status: string): asserts status is AtlasCoreJobStatus {
  if (!STATUS_SET.has(status)) throw new Error(`Invalid core job status: ${status}`);
}

function assertCanTransition(from: AtlasCoreJobStatus, to: AtlasCoreJobStatus): void {
  if (from === to) return;
  if (TERMINAL_STATUSES.has(from)) throw new Error(`Cannot transition terminal job from ${from} to ${to}.`);
  if (!ALLOWED_TRANSITIONS[from].has(to)) throw new Error(`Invalid core job transition: ${from} -> ${to}.`);
}

function assertDeliveryReceipt(result: AtlasCoreDeliveryReceipt): void {
  if (!result.channelId?.trim()) throw new Error("Delivery receipt requires channelId.");
  if (!result.fileId?.trim() && !result.messageTs?.trim()) {
    throw new Error("Delivery receipt requires fileId or messageTs.");
  }
}

function validateCoreJobEvent(value: unknown): asserts value is AtlasCoreJobEvent {
  const event = value as AtlasCoreJobEvent;
  if (event?.schemaVersion !== ATLAS_CORE_JOB_STORE_VERSION) throw new Error("Invalid core event schema version.");
  if (!event.id || !event.jobId || !event.createdAt) throw new Error("Invalid core event identity.");
  if (!EVENT_KIND_SET.has(event.kind)) throw new Error(`Invalid core event kind: ${event.kind}`);
  if (!event.payload || typeof event.payload !== "object") throw new Error("Invalid core event payload.");
}

function validateJobPayload(value: unknown): AtlasCoreJob {
  const job = value as AtlasCoreJob;
  if (job?.schemaVersion !== ATLAS_CORE_JOB_STORE_VERSION) throw new Error("Invalid job payload schema.");
  assertStatus(job.status);
  return {
    ...job,
    projectId: cleanRequired(job.projectId, "projectId"),
    source: normalizeSource(job.source),
    workflow: normalizeWorkflow(job.workflow),
    artifactIds: Array.isArray(job.artifactIds) ? job.artifactIds : [],
    deliveryIds: Array.isArray(job.deliveryIds) ? job.deliveryIds : [],
    approvalIds: Array.isArray(job.approvalIds) ? job.approvalIds : [],
  };
}

function validateArtifactPayload(value: unknown): AtlasCoreArtifact {
  const artifact = value as AtlasCoreArtifact;
  if (artifact?.schemaVersion !== ATLAS_CORE_JOB_STORE_VERSION) throw new Error("Invalid artifact payload schema.");
  if (artifact.validation?.status !== "passed") throw new Error("Invalid artifact validation status.");
  if (!Array.isArray(artifact.paths) || artifact.paths.length === 0) throw new Error("Artifact payload requires paths.");
  return artifact;
}

function validateDeliveryPayload(value: unknown): AtlasCoreDelivery {
  const delivery = value as AtlasCoreDelivery;
  if (delivery?.schemaVersion !== ATLAS_CORE_JOB_STORE_VERSION) throw new Error("Invalid delivery payload schema.");
  assertDeliveryReceipt(delivery.result);
  return delivery;
}

function validateApprovalPayload(value: unknown): AtlasCoreApproval {
  const approval = value as AtlasCoreApproval;
  if (approval?.schemaVersion !== ATLAS_CORE_JOB_STORE_VERSION) throw new Error("Invalid approval payload schema.");
  return approval;
}

function findJobOrSkip(projection: AtlasCoreJobProjection, jobId: string): AtlasCoreJob | null {
  return projection.jobs.find((job) => job.id === jobId) ?? null;
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
