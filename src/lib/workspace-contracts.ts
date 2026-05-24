export const WORKSPACE_SCHEMA_VERSION = 1;

export const WORKSPACE_WORKFLOWS = [
  "audit",
  "content_batch",
  "approval_projection",
  "memory_maintenance",
  "call_processor",
  "doc_export",
] as const;

export type WorkspaceWorkflowName = (typeof WORKSPACE_WORKFLOWS)[number];

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "ready_for_review",
  "completed",
  "failed_recoverable",
  "failed_blocked",
  "cancelled",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const APPROVAL_ACTION_TYPES = [
  "slack_reply",
  "monday_update",
  "client_notice",
  "audit_delivery",
  "content_publish",
  "task_update",
] as const;

export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "held",
  "expired",
  "executed",
  "failed",
  "cancelled",
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type SourceReference = {
  system: string;
  ref: string;
  label?: string;
};

export type ArtifactReference = {
  artifactId: string;
  kind:
    | "markdown"
    | "pdf"
    | "preview"
    | "validation"
    | "content_pack"
    | "report"
    | "index"
    | "other";
  path?: string;
  role?: string;
  title?: string;
  sha256?: string;
  validationStatus?: "unknown" | "pending" | "passed" | "warning" | "failed";
};

export type ValidationSummary = {
  status: "unknown" | "pending" | "passed" | "warning" | "failed";
  checkedAt?: string;
  score?: number;
  failures: string[];
  warnings: string[];
};

export type SafeErrorSummary = {
  code: string;
  message: string;
  recoverable: boolean;
  occurredAt?: string;
};

export type AgentRunEvent = {
  id: string;
  type:
    | "created"
    | "phase_started"
    | "phase_completed"
    | "artifact_created"
    | "validation_result"
    | "approval_requested"
    | "approval_decided"
    | "heartbeat"
    | "warning"
    | "failed"
    | "recovered"
    | "completed";
  at: string;
  step?: string;
  summary?: string;
  artifactId?: string;
  approvalId?: string;
};

export type AgentRun = {
  id: string;
  schemaVersion: number;
  workflow: WorkspaceWorkflowName;
  title: string;
  status: AgentRunStatus;
  projectRef?: string;
  requestedBy?: string;
  ownerRole?: "rhys" | "pat" | "jian" | "corey" | "dante" | "worker";
  sourceRefs: SourceReference[];
  currentStep?: string;
  progressPct?: number;
  heartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  idempotencyKey?: string;
  artifacts: ArtifactReference[];
  relatedApprovalIds: string[];
  validation?: ValidationSummary;
  events: AgentRunEvent[];
  error?: SafeErrorSummary;
};

export type AuditRun = {
  id: string;
  schemaVersion: number;
  agentRunId: string;
  source: "manual" | "typeform" | "slack_dm";
  sourceRef?: string;
  status: AgentRunStatus;
  prospect: {
    businessName?: string;
    clientName?: string;
    summary?: string;
  };
  inputHash?: string;
  stages: Array<{
    name: "parse" | "retrieve" | "generate" | "render" | "validate" | "deliver";
    status: AgentRunStatus;
    startedAt?: string;
    completedAt?: string;
  }>;
  docRef?: string;
  compliance?: {
    pass: boolean;
    tier?: string;
    score?: number;
    wordCount?: number;
    installCount?: number;
    failures: string[];
  };
  artifacts: ArtifactReference[];
  relatedApprovalIds: string[];
  validation: ValidationSummary;
  delivery: {
    state: "not_requested" | "waiting_for_approval" | "delivered" | "blocked";
    approvalId?: string;
    target?: string;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: SafeErrorSummary;
};

export type ContentBatch = {
  id: string;
  schemaVersion: number;
  agentRunId: string;
  weekOf: string;
  status: "drafting" | "ready_for_review" | "needs_changes" | "approved" | "blocked";
  audience: "corey" | "rhys";
  title: string;
  theme?: string;
  sourceRefs: SourceReference[];
  frameworkRefs: SourceReference[];
  items: Array<{
    id: string;
    type: "topic" | "hook" | "script_outline" | "caption" | "filming_note";
    title: string;
    hook?: string;
    framework?: string;
    status: "draft" | "reviewed" | "needs_changes" | "approved";
    reviewer?: string;
    notes?: string;
  }>;
  artifacts: ArtifactReference[];
  relatedApprovalIds: string[];
  validation: ValidationSummary;
  publishingBlocked: true;
  createdAt: string;
  updatedAt: string;
  error?: SafeErrorSummary;
};

export type Approval = {
  id: string;
  schemaVersion: number;
  sourceSystem:
    | "mission_control_comms"
    | "jian_monday"
    | "rhys_reaper"
    | "audit"
    | "content";
  sourceRef?: string;
  actionType: ApprovalActionType;
  status: ApprovalStatus;
  workspaceStatus: "awaiting_review" | "approved" | "rejected" | "held" | "completed" | "failed";
  subject: string;
  personOrClient?: string;
  exactPayloadPreview?: string;
  payloadHash?: string;
  destination?: {
    kind: "slack" | "monday" | "email" | "workspace";
    label: string;
    id?: string;
  };
  requiredPermission?: string;
  requestedBy?: string;
  decidedBy?: string;
  decisionNote?: string;
  createdAt: string;
  updatedAt?: string;
  decidedAt?: string;
  expiresAt?: string;
  relatedAgentRunId?: string;
  relatedArtifactIds: string[];
  error?: SafeErrorSummary;
};

export type MemoryMaintenanceRun = {
  id: string;
  schemaVersion: number;
  agentRunId: string;
  scope: "global" | "project" | "person" | "client" | "content";
  mode: "scan" | "link" | "summarise" | "dedupe" | "staleness_check" | "permission_audit";
  status: AgentRunStatus;
  sourceRoots: string[];
  counts: {
    scanned: number;
    orphans: number;
    linked: number;
    conflicts: number;
    stale: number;
    proposedChanges: number;
    appliedChanges: number;
  };
  findings: Array<{
    id: string;
    severity: "info" | "warning" | "critical";
    ref: string;
    summary: string;
    proposedAction?: string;
  }>;
  artifacts: ArtifactReference[];
  relatedApprovalIds: string[];
  validation: ValidationSummary;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: SafeErrorSummary;
};

export type ContractValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; issues: string[] };

type Validator = {
  path: string;
  issues: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(v: Validator, message: string) {
  v.issues.push(`${v.path}: ${message}`);
}

function child(v: Validator, key: string): Validator {
  return { path: `${v.path}.${key}`, issues: v.issues };
}

function requireString(v: Validator, obj: Record<string, unknown>, key: string) {
  if (typeof obj[key] !== "string" || obj[key].trim() === "") issue(child(v, key), "must be a non-empty string");
}

function optionalString(v: Validator, obj: Record<string, unknown>, key: string) {
  if (obj[key] !== undefined && typeof obj[key] !== "string") issue(child(v, key), "must be a string when present");
}

function requireNumber(v: Validator, obj: Record<string, unknown>, key: string) {
  if (typeof obj[key] !== "number" || !Number.isFinite(obj[key])) issue(child(v, key), "must be a finite number");
}

function optionalNumber(v: Validator, obj: Record<string, unknown>, key: string) {
  if (obj[key] !== undefined && (typeof obj[key] !== "number" || !Number.isFinite(obj[key]))) {
    issue(child(v, key), "must be a finite number when present");
  }
}

function requireBoolean(v: Validator, obj: Record<string, unknown>, key: string) {
  if (typeof obj[key] !== "boolean") issue(child(v, key), "must be a boolean");
}

function requireArray(v: Validator, obj: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(obj[key])) {
    issue(child(v, key), "must be an array");
    return [];
  }
  return obj[key];
}

function requireEnum<T extends readonly string[]>(v: Validator, obj: Record<string, unknown>, key: string, values: T) {
  if (typeof obj[key] !== "string" || !values.includes(obj[key] as T[number])) {
    issue(child(v, key), `must be one of ${values.join(", ")}`);
  }
}

function optionalEnum<T extends readonly string[]>(v: Validator, obj: Record<string, unknown>, key: string, values: T) {
  if (obj[key] !== undefined) requireEnum(v, obj, key, values);
}

function requireTimestamp(v: Validator, obj: Record<string, unknown>, key: string) {
  requireString(v, obj, key);
  if (typeof obj[key] === "string" && Number.isNaN(Date.parse(obj[key] as string))) {
    issue(child(v, key), "must be an ISO-like timestamp");
  }
}

function optionalTimestamp(v: Validator, obj: Record<string, unknown>, key: string) {
  if (obj[key] !== undefined) requireTimestamp(v, obj, key);
}

function requireSchemaVersion(v: Validator, obj: Record<string, unknown>) {
  requireNumber(v, obj, "schemaVersion");
  if (obj.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    issue(child(v, "schemaVersion"), `must equal ${WORKSPACE_SCHEMA_VERSION}`);
  }
}

function validateSourceRefs(v: Validator, value: unknown[]) {
  value.forEach((ref, index) => {
    const next = child(v, String(index));
    if (!isRecord(ref)) {
      issue(next, "must be an object");
      return;
    }
    requireString(next, ref, "system");
    requireString(next, ref, "ref");
    optionalString(next, ref, "label");
  });
}

function validateArtifactRefs(v: Validator, value: unknown[]) {
  value.forEach((artifact, index) => {
    const next = child(v, String(index));
    if (!isRecord(artifact)) {
      issue(next, "must be an object");
      return;
    }
    requireString(next, artifact, "artifactId");
    requireEnum(next, artifact, "kind", [
      "markdown",
      "pdf",
      "preview",
      "validation",
      "content_pack",
      "report",
      "index",
      "other",
    ] as const);
    optionalString(next, artifact, "path");
    optionalString(next, artifact, "role");
    optionalString(next, artifact, "title");
    optionalString(next, artifact, "sha256");
    optionalEnum(next, artifact, "validationStatus", ["unknown", "pending", "passed", "warning", "failed"] as const);
  });
}

function validateStringArray(v: Validator, obj: Record<string, unknown>, key: string) {
  requireArray(v, obj, key).forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") issue(child(child(v, key), String(index)), "must be a non-empty string");
  });
}

function validateValidationSummary(v: Validator, value: unknown) {
  if (!isRecord(value)) {
    issue(v, "must be an object");
    return;
  }
  requireEnum(v, value, "status", ["unknown", "pending", "passed", "warning", "failed"] as const);
  optionalTimestamp(v, value, "checkedAt");
  optionalNumber(v, value, "score");
  validateStringArray(v, value, "failures");
  validateStringArray(v, value, "warnings");
}

function validateSafeError(v: Validator, value: unknown) {
  if (!isRecord(value)) {
    issue(v, "must be an object");
    return;
  }
  requireString(v, value, "code");
  requireString(v, value, "message");
  requireBoolean(v, value, "recoverable");
  optionalTimestamp(v, value, "occurredAt");
}

function validateEvents(v: Validator, value: unknown[]) {
  value.forEach((event, index) => {
    const next = child(v, String(index));
    if (!isRecord(event)) {
      issue(next, "must be an object");
      return;
    }
    requireString(next, event, "id");
    requireEnum(next, event, "type", [
      "created",
      "phase_started",
      "phase_completed",
      "artifact_created",
      "validation_result",
      "approval_requested",
      "approval_decided",
      "heartbeat",
      "warning",
      "failed",
      "recovered",
      "completed",
    ] as const);
    requireTimestamp(next, event, "at");
    optionalString(next, event, "step");
    optionalString(next, event, "summary");
    optionalString(next, event, "artifactId");
    optionalString(next, event, "approvalId");
  });
}

function validateBaseRunFields(v: Validator, obj: Record<string, unknown>) {
  requireString(v, obj, "id");
  requireSchemaVersion(v, obj);
  requireEnum(v, obj, "status", AGENT_RUN_STATUSES);
  requireTimestamp(v, obj, "createdAt");
  requireTimestamp(v, obj, "updatedAt");
  optionalTimestamp(v, obj, "completedAt");
  if (obj.error !== undefined) validateSafeError(child(v, "error"), obj.error);
}

function finish<T>(value: unknown, issues: string[]): ContractValidationResult<T> {
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, data: value as T };
}

export function validateAgentRun(value: unknown): ContractValidationResult<AgentRun> {
  const v: Validator = { path: "AgentRun", issues: [] };
  if (!isRecord(value)) return { ok: false, issues: ["AgentRun: must be an object"] };

  validateBaseRunFields(v, value);
  requireEnum(v, value, "workflow", WORKSPACE_WORKFLOWS);
  requireString(v, value, "title");
  optionalString(v, value, "projectRef");
  optionalString(v, value, "requestedBy");
  optionalEnum(v, value, "ownerRole", ["rhys", "pat", "jian", "corey", "dante", "worker"] as const);
  optionalString(v, value, "currentStep");
  optionalNumber(v, value, "progressPct");
  optionalTimestamp(v, value, "heartbeatAt");
  optionalString(v, value, "idempotencyKey");
  validateSourceRefs(child(v, "sourceRefs"), requireArray(v, value, "sourceRefs"));
  validateArtifactRefs(child(v, "artifacts"), requireArray(v, value, "artifacts"));
  validateStringArray(v, value, "relatedApprovalIds");
  if (value.validation !== undefined) validateValidationSummary(child(v, "validation"), value.validation);
  validateEvents(child(v, "events"), requireArray(v, value, "events"));

  return finish<AgentRun>(value, v.issues);
}

export function validateAuditRun(value: unknown): ContractValidationResult<AuditRun> {
  const v: Validator = { path: "AuditRun", issues: [] };
  if (!isRecord(value)) return { ok: false, issues: ["AuditRun: must be an object"] };

  validateBaseRunFields(v, value);
  requireString(v, value, "agentRunId");
  requireEnum(v, value, "source", ["manual", "typeform", "slack_dm"] as const);
  optionalString(v, value, "sourceRef");
  optionalString(v, value, "inputHash");
  optionalString(v, value, "docRef");
  if (!isRecord(value.prospect)) {
    issue(child(v, "prospect"), "must be an object");
  } else {
    optionalString(child(v, "prospect"), value.prospect, "businessName");
    optionalString(child(v, "prospect"), value.prospect, "clientName");
    optionalString(child(v, "prospect"), value.prospect, "summary");
  }
  requireArray(v, value, "stages").forEach((stage, index) => {
    const next = child(child(v, "stages"), String(index));
    if (!isRecord(stage)) {
      issue(next, "must be an object");
      return;
    }
    requireEnum(next, stage, "name", ["parse", "retrieve", "generate", "render", "validate", "deliver"] as const);
    requireEnum(next, stage, "status", AGENT_RUN_STATUSES);
    optionalTimestamp(next, stage, "startedAt");
    optionalTimestamp(next, stage, "completedAt");
  });
  if (value.compliance !== undefined) {
    if (!isRecord(value.compliance)) {
      issue(child(v, "compliance"), "must be an object");
    } else {
      requireBoolean(child(v, "compliance"), value.compliance, "pass");
      optionalString(child(v, "compliance"), value.compliance, "tier");
      optionalNumber(child(v, "compliance"), value.compliance, "score");
      optionalNumber(child(v, "compliance"), value.compliance, "wordCount");
      optionalNumber(child(v, "compliance"), value.compliance, "installCount");
      validateStringArray(child(v, "compliance"), value.compliance, "failures");
    }
  }
  validateArtifactRefs(child(v, "artifacts"), requireArray(v, value, "artifacts"));
  validateStringArray(v, value, "relatedApprovalIds");
  validateValidationSummary(child(v, "validation"), value.validation);
  if (!isRecord(value.delivery)) {
    issue(child(v, "delivery"), "must be an object");
  } else {
    requireEnum(child(v, "delivery"), value.delivery, "state", [
      "not_requested",
      "waiting_for_approval",
      "delivered",
      "blocked",
    ] as const);
    optionalString(child(v, "delivery"), value.delivery, "approvalId");
    optionalString(child(v, "delivery"), value.delivery, "target");
  }

  return finish<AuditRun>(value, v.issues);
}

export function validateContentBatch(value: unknown): ContractValidationResult<ContentBatch> {
  const v: Validator = { path: "ContentBatch", issues: [] };
  if (!isRecord(value)) return { ok: false, issues: ["ContentBatch: must be an object"] };

  requireString(v, value, "id");
  requireSchemaVersion(v, value);
  requireString(v, value, "agentRunId");
  requireString(v, value, "weekOf");
  requireEnum(v, value, "status", ["drafting", "ready_for_review", "needs_changes", "approved", "blocked"] as const);
  requireEnum(v, value, "audience", ["corey", "rhys"] as const);
  requireString(v, value, "title");
  optionalString(v, value, "theme");
  validateSourceRefs(child(v, "sourceRefs"), requireArray(v, value, "sourceRefs"));
  validateSourceRefs(child(v, "frameworkRefs"), requireArray(v, value, "frameworkRefs"));
  requireArray(v, value, "items").forEach((item, index) => {
    const next = child(child(v, "items"), String(index));
    if (!isRecord(item)) {
      issue(next, "must be an object");
      return;
    }
    requireString(next, item, "id");
    requireEnum(next, item, "type", ["topic", "hook", "script_outline", "caption", "filming_note"] as const);
    requireString(next, item, "title");
    optionalString(next, item, "hook");
    optionalString(next, item, "framework");
    requireEnum(next, item, "status", ["draft", "reviewed", "needs_changes", "approved"] as const);
    optionalString(next, item, "reviewer");
    optionalString(next, item, "notes");
  });
  validateArtifactRefs(child(v, "artifacts"), requireArray(v, value, "artifacts"));
  validateStringArray(v, value, "relatedApprovalIds");
  validateValidationSummary(child(v, "validation"), value.validation);
  if (value.publishingBlocked !== true) issue(child(v, "publishingBlocked"), "must be true");
  requireTimestamp(v, value, "createdAt");
  requireTimestamp(v, value, "updatedAt");
  if (value.error !== undefined) validateSafeError(child(v, "error"), value.error);

  return finish<ContentBatch>(value, v.issues);
}

export function validateApproval(value: unknown): ContractValidationResult<Approval> {
  const v: Validator = { path: "Approval", issues: [] };
  if (!isRecord(value)) return { ok: false, issues: ["Approval: must be an object"] };

  requireString(v, value, "id");
  requireSchemaVersion(v, value);
  requireEnum(v, value, "sourceSystem", ["mission_control_comms", "jian_monday", "rhys_reaper", "audit", "content"] as const);
  optionalString(v, value, "sourceRef");
  requireEnum(v, value, "actionType", APPROVAL_ACTION_TYPES);
  requireEnum(v, value, "status", APPROVAL_STATUSES);
  requireEnum(v, value, "workspaceStatus", ["awaiting_review", "approved", "rejected", "held", "completed", "failed"] as const);
  requireString(v, value, "subject");
  optionalString(v, value, "personOrClient");
  optionalString(v, value, "exactPayloadPreview");
  optionalString(v, value, "payloadHash");
  if (value.destination !== undefined) {
    if (!isRecord(value.destination)) {
      issue(child(v, "destination"), "must be an object");
    } else {
      requireEnum(child(v, "destination"), value.destination, "kind", ["slack", "monday", "email", "workspace"] as const);
      requireString(child(v, "destination"), value.destination, "label");
      optionalString(child(v, "destination"), value.destination, "id");
    }
  }
  optionalString(v, value, "requiredPermission");
  optionalString(v, value, "requestedBy");
  optionalString(v, value, "decidedBy");
  optionalString(v, value, "decisionNote");
  requireTimestamp(v, value, "createdAt");
  optionalTimestamp(v, value, "updatedAt");
  optionalTimestamp(v, value, "decidedAt");
  optionalTimestamp(v, value, "expiresAt");
  optionalString(v, value, "relatedAgentRunId");
  validateStringArray(v, value, "relatedArtifactIds");
  if (value.error !== undefined) validateSafeError(child(v, "error"), value.error);

  return finish<Approval>(value, v.issues);
}

export function validateMemoryMaintenanceRun(value: unknown): ContractValidationResult<MemoryMaintenanceRun> {
  const v: Validator = { path: "MemoryMaintenanceRun", issues: [] };
  if (!isRecord(value)) return { ok: false, issues: ["MemoryMaintenanceRun: must be an object"] };

  validateBaseRunFields(v, value);
  requireString(v, value, "agentRunId");
  requireEnum(v, value, "scope", ["global", "project", "person", "client", "content"] as const);
  requireEnum(v, value, "mode", ["scan", "link", "summarise", "dedupe", "staleness_check", "permission_audit"] as const);
  validateStringArray(v, value, "sourceRoots");
  if (!isRecord(value.counts)) {
    issue(child(v, "counts"), "must be an object");
  } else {
    for (const key of ["scanned", "orphans", "linked", "conflicts", "stale", "proposedChanges", "appliedChanges"]) {
      requireNumber(child(v, "counts"), value.counts, key);
    }
  }
  requireArray(v, value, "findings").forEach((finding, index) => {
    const next = child(child(v, "findings"), String(index));
    if (!isRecord(finding)) {
      issue(next, "must be an object");
      return;
    }
    requireString(next, finding, "id");
    requireEnum(next, finding, "severity", ["info", "warning", "critical"] as const);
    requireString(next, finding, "ref");
    requireString(next, finding, "summary");
    optionalString(next, finding, "proposedAction");
  });
  validateArtifactRefs(child(v, "artifacts"), requireArray(v, value, "artifacts"));
  validateStringArray(v, value, "relatedApprovalIds");
  validateValidationSummary(child(v, "validation"), value.validation);

  return finish<MemoryMaintenanceRun>(value, v.issues);
}
