import type {
  AgentEvent,
  AgentEventKind,
  AgentEventVisibility,
} from "./workspace-demo-events";

export const agentEventKinds = [
  "message.delta",
  "message.complete",
  "tool.call",
  "tool.result",
  "artifact.created",
  "task.step",
  "task.complete",
  "error",
] as const satisfies readonly AgentEventKind[];

export const agentEventVisibilities = [
  "internal",
  "presentation",
] as const satisfies readonly AgentEventVisibility[];

const agentEventKindSet = new Set<string>(agentEventKinds);
const agentEventVisibilitySet = new Set<string>(agentEventVisibilities);

export type WorkspaceEventLogPayload = Record<string, unknown>;

export interface WorkspaceEventLogRow {
  id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  kind: string;
  visibility: string;
  payload: unknown;
  created_at: string;
}

export interface WorkspaceEventLogInsert {
  id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  kind: AgentEventKind;
  visibility: AgentEventVisibility;
  payload: WorkspaceEventLogPayload;
  created_at: string;
}

export interface WorkspaceEventReplayQueryOptions {
  workspaceId: string;
  taskId?: string;
  runId?: string;
  presentationOnly?: boolean;
  limit?: number;
}

export interface WorkspaceEventReplayQuery {
  table: "events";
  select: "id,workspace_id,task_id,run_id,kind,visibility,payload,created_at";
  filters: readonly WorkspaceEventReplayQueryFilter[];
  order: readonly WorkspaceEventReplayQueryOrder[];
  limit?: number;
}

export interface WorkspaceEventReplayQueryFilter {
  column: "workspace_id" | "task_id" | "run_id" | "visibility";
  operator: "eq";
  value: string;
}

export interface WorkspaceEventReplayQueryOrder {
  column: "created_at" | "id";
  ascending: boolean;
}

export function isAgentEventKind(value: unknown): value is AgentEventKind {
  return typeof value === "string" && agentEventKindSet.has(value);
}

export function isAgentEventVisibility(value: unknown): value is AgentEventVisibility {
  return typeof value === "string" && agentEventVisibilitySet.has(value);
}

export function assertAgentEventKind(value: unknown): asserts value is AgentEventKind {
  if (!isAgentEventKind(value)) {
    throw new Error(`Unsupported workspace event kind: ${String(value)}`);
  }
}

export function assertAgentEventVisibility(value: unknown): asserts value is AgentEventVisibility {
  if (!isAgentEventVisibility(value)) {
    throw new Error(`Unsupported workspace event visibility: ${String(value)}`);
  }
}

export function agentEventToDbInsert(event: AgentEvent): WorkspaceEventLogInsert {
  assertAgentEventKind(event.kind);
  assertAgentEventVisibility(event.visibility);
  validateEventVisibilityPair(event.kind, event.visibility);

  const {
    id,
    workspaceId,
    taskId,
    runId,
    kind,
    visibility,
    createdAt,
    ...payload
  } = event;

  return {
    id,
    workspace_id: workspaceId,
    task_id: taskId,
    run_id: runId,
    kind,
    visibility,
    payload: payload as WorkspaceEventLogPayload,
    created_at: createdAt,
  };
}

export function dbRowToAgentEvent(row: WorkspaceEventLogRow): AgentEvent {
  assertNonEmptyString(row.id, "events.id");
  assertNonEmptyString(row.workspace_id, "events.workspace_id");
  assertNonEmptyString(row.task_id, "events.task_id");
  assertNonEmptyString(row.run_id, "events.run_id");
  assertNonEmptyString(row.created_at, "events.created_at");
  assertAgentEventKind(row.kind);
  assertAgentEventVisibility(row.visibility);
  validateEventVisibilityPair(row.kind, row.visibility);

  if (!isObjectRecord(row.payload)) {
    throw new Error("events.payload must be a JSON object");
  }

  const event = {
    ...row.payload,
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    visibility: row.visibility,
    createdAt: row.created_at,
  };

  validateAgentEventShape(event);
  return event;
}

export function isPresentationAgentEvent(event: AgentEvent): boolean {
  return event.visibility === "presentation";
}

export function isPresentationEventRow(row: WorkspaceEventLogRow): boolean {
  return row.visibility === "presentation";
}

export function filterPresentationAgentEvents(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter(isPresentationAgentEvent);
}

export function filterPresentationEventRows(rows: readonly WorkspaceEventLogRow[]): WorkspaceEventLogRow[] {
  return rows.filter(isPresentationEventRow);
}

export function buildWorkspaceEventReplayQuery(
  options: WorkspaceEventReplayQueryOptions,
): WorkspaceEventReplayQuery {
  assertNonEmptyString(options.workspaceId, "workspaceId");

  const filters: WorkspaceEventReplayQueryFilter[] = [
    { column: "workspace_id", operator: "eq", value: options.workspaceId },
  ];

  if (options.taskId !== undefined) {
    assertNonEmptyString(options.taskId, "taskId");
    filters.push({ column: "task_id", operator: "eq", value: options.taskId });
  }

  if (options.runId !== undefined) {
    assertNonEmptyString(options.runId, "runId");
    filters.push({ column: "run_id", operator: "eq", value: options.runId });
  }

  if (options.presentationOnly !== false) {
    filters.push({ column: "visibility", operator: "eq", value: "presentation" });
  }

  return {
    table: "events",
    select: "id,workspace_id,task_id,run_id,kind,visibility,payload,created_at",
    filters,
    order: [
      { column: "created_at", ascending: true },
      { column: "id", ascending: true },
    ],
    limit: validateReplayLimit(options.limit),
  };
}

function validateEventVisibilityPair(kind: AgentEventKind, visibility: AgentEventVisibility): void {
  if ((kind === "tool.call" || kind === "tool.result") && visibility !== "internal") {
    throw new Error(`${kind} events must be internal`);
  }

  if (
    kind !== "tool.call"
    && kind !== "tool.result"
    && kind !== "error"
    && visibility !== "presentation"
  ) {
    throw new Error(`${kind} events must be presentation visible`);
  }
}

function validateAgentEventShape(value: unknown): asserts value is AgentEvent {
  if (!isObjectRecord(value)) throw new Error("AgentEvent must be an object");

  switch (value.kind) {
    case "message.delta":
      assertNonEmptyString(value.messageId, "message.delta.messageId");
      assertEqual(value.role, "assistant", "message.delta.role");
      assertString(value.delta, "message.delta.delta");
      return;
    case "message.complete":
      assertNonEmptyString(value.messageId, "message.complete.messageId");
      assertOneOf(value.role, ["user", "assistant"], "message.complete.role");
      assertString(value.content, "message.complete.content");
      return;
    case "tool.call":
      assertNonEmptyString(value.toolName, "tool.call.toolName");
      assertNonEmptyString(value.label, "tool.call.label");
      assertString(value.inputSummary, "tool.call.inputSummary");
      return;
    case "tool.result":
      assertNonEmptyString(value.toolName, "tool.result.toolName");
      assertNonEmptyString(value.label, "tool.result.label");
      assertString(value.resultSummary, "tool.result.resultSummary");
      return;
    case "artifact.created":
      validateArtifact(value.artifact);
      return;
    case "task.step":
      validateTaskStep(value.step);
      return;
    case "task.complete":
      validateTask(value.task);
      return;
    case "error":
      assertString(value.message, "error.message");
      if (typeof value.recoverable !== "boolean") throw new Error("error.recoverable must be boolean");
      return;
    default:
      throw new Error(`Unsupported workspace event kind: ${String(value.kind)}`);
  }
}

function validateArtifact(value: unknown): void {
  if (!isObjectRecord(value)) throw new Error("artifact.created.artifact must be an object");
  assertNonEmptyString(value.id, "artifact.id");
  assertOneOf(value.type, ["document", "spreadsheet", "audit", "brief", "playbook", "markdown", "pdf"], "artifact.type");
  assertNonEmptyString(value.title, "artifact.title");
  assertString(value.subtitle, "artifact.subtitle");
  assertString(value.preview, "artifact.preview");
}

function validateTaskStep(value: unknown): void {
  if (!isObjectRecord(value)) throw new Error("task.step.step must be an object");
  assertNonEmptyString(value.id, "step.id");
  assertNonEmptyString(value.title, "step.title");
  assertOneOf(value.status, ["pending", "running", "complete", "error"], "step.status");
  if ("summary" in value && value.summary !== undefined) assertString(value.summary, "step.summary");
}

function validateTask(value: unknown): void {
  if (!isObjectRecord(value)) throw new Error("task.complete.task must be an object");
  assertNonEmptyString(value.id, "task.id");
  assertNonEmptyString(value.title, "task.title");
  assertOneOf(value.status, ["idle", "running", "complete", "error"], "task.status");
  assertNumber(value.completedSteps, "task.completedSteps");
  assertNumber(value.totalSteps, "task.totalSteps");
  if (!Array.isArray(value.steps)) throw new Error("task.steps must be an array");
  value.steps.forEach(validateTaskStep);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (value.trim() === "") throw new Error(`${path} must be a non-empty string`);
}

function assertNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
}

function assertEqual<T extends string>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) throw new Error(`${path} must be ${expected}`);
}

function assertOneOf<T extends readonly string[]>(value: unknown, options: T, path: string): asserts value is T[number] {
  if (typeof value !== "string" || !options.includes(value)) {
    throw new Error(`${path} must be one of ${options.join(", ")}`);
  }
}

function validateReplayLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;

  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error("limit must be an integer between 1 and 1000");
  }

  return value;
}
