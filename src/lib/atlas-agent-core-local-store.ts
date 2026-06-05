import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  isAtlasAgentCoreLoopPhase,
  type AtlasAgentBudget,
  type AtlasAgentCoreLoopPhase,
  type AtlasAgentCoreRun,
  type AtlasAgentCoreStartInput,
  type AtlasAgentCriticResult,
  type AtlasAgentPlan,
  type AtlasAgentRunStatus,
} from "./atlas-agent-core.ts";
import type { AgentEvent } from "./workspace-demo-events.ts";
import { agentEventToDbInsert } from "./workspace-event-log.ts";

export const ATLAS_AGENT_CORE_RUN_ROOT = "/Users/atlasai/.openclaw/workspace/state/atlas-agent-core-runs";
export const ATLAS_AGENT_CORE_STORE_VERSION = 1;

export const ATLAS_AGENT_CORE_EVENT_KINDS = [
  "agent.run.created",
  "agent.user_message.appended",
  "agent.plan.updated",
  "agent.decision.made",
  "agent.tool.dispatched",
  "agent.event.emitted",
  "agent.reflection.created",
  "agent.summary.compressed",
  "agent.critic.completed",
  "agent.status.updated",
  "agent.error",
] as const;

export type AtlasAgentCoreEventKind = (typeof ATLAS_AGENT_CORE_EVENT_KINDS)[number];

export interface AtlasAgentCoreEvent {
  id: string;
  runId: string;
  kind: AtlasAgentCoreEventKind;
  phase: AtlasAgentCoreLoopPhase;
  createdAt: string;
  summary: string;
  payload?: Record<string, unknown>;
  agentEvent?: AgentEvent;
  plan?: AtlasAgentPlan;
  critic?: AtlasAgentCriticResult;
  compressedSummary?: string;
}

export interface AtlasAgentCoreRunMetadata {
  runId: string;
  workspaceId: string;
  project: string;
  room: string;
  sessionId: string;
  userId: string | null;
  parentRunId: string | null;
  status: AtlasAgentRunStatus;
  loopPhase: AtlasAgentCoreLoopPhase;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  budgetCount: number;
}

export interface AtlasAgentCoreRunSnapshot {
  version: typeof ATLAS_AGENT_CORE_STORE_VERSION;
  localOnly: true;
  metadata: AtlasAgentCoreRunMetadata;
  run: AtlasAgentCoreRun;
  coreEvents: AtlasAgentCoreEvent[];
  plan?: AtlasAgentPlan;
  critic?: AtlasAgentCriticResult;
  compressedSummary?: string;
}

export interface AtlasAgentCoreCreateRunInput extends AtlasAgentCoreStartInput {
  runId?: string;
  userId?: string;
  parentRunId?: string;
  now?: Date;
  idFactory?: () => string;
  root?: string;
  plan?: AtlasAgentPlan;
}

export interface AtlasAgentCoreStoreScope {
  root?: string;
}

export interface AtlasAgentCoreReadRunInput extends AtlasAgentCoreStoreScope {
  runId: string;
}

export interface AtlasAgentCoreListRunsInput extends AtlasAgentCoreStoreScope {
  project?: string;
  room?: string;
  sessionId?: string;
  status?: AtlasAgentRunStatus;
  limit?: number;
}

export interface AtlasAgentCoreAppendEventInput extends AtlasAgentCoreStoreScope {
  runId: string;
  event: AtlasAgentCoreEvent;
}

export interface AtlasAgentCoreUpdateStatusInput extends AtlasAgentCoreStoreScope {
  runId: string;
  status: AtlasAgentRunStatus;
  loopPhase?: AtlasAgentCoreLoopPhase;
  now?: Date;
  idFactory?: () => string;
}

export interface AtlasAgentCoreReplay {
  run: AtlasAgentCoreRun;
  metadata: AtlasAgentCoreRunMetadata;
  coreEvents: AtlasAgentCoreEvent[];
  agentEvents: AgentEvent[];
  plan?: AtlasAgentPlan;
  critic?: AtlasAgentCriticResult;
  compressedSummary?: string;
}

const CORE_EVENT_KIND_SET = new Set<string>(ATLAS_AGENT_CORE_EVENT_KINDS);
const RUN_STATUS_SET = new Set<AtlasAgentRunStatus>(["queued", "running", "paused", "waiting_for_approval", "complete", "failed"]);
const TERMINAL_RUN_STATUSES = new Set<AtlasAgentRunStatus>(["complete", "failed"]);
const MAX_EVENTS = 5_000;

export async function createRun(input: AtlasAgentCoreCreateRunInput): Promise<AtlasAgentCoreRunSnapshot> {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const runId = assertSafeAgentCoreRunId(input.runId ?? createAgentCoreRunId(input.idFactory));
  const sessionId = cleanRequiredString(input.sessionId ?? createAgentCoreSessionId(input.idFactory), "sessionId", 160);
  const workspaceId = cleanRequiredString(input.workspaceId ?? "workspace_undeniable_demo", "workspaceId", 160);
  const project = cleanRequiredString(input.project, "project", 160);
  const room = cleanRequiredString(input.room, "room", 160);
  const budgets = normalizeBudgets(input.budgets ?? []);
  const run: AtlasAgentCoreRun = {
    context: {
      workspaceId,
      project,
      room,
      sessionId,
      runId,
      ...(input.parentRunId ? { parentRunId: assertSafeAgentCoreRunId(input.parentRunId) } : {}),
      ...(input.userId ? { userId: cleanRequiredString(input.userId, "userId", 160) } : {}),
      createdAt,
    },
    status: "queued",
    loopPhase: "observe",
    budgets,
  };
  const createdEvent: AtlasAgentCoreEvent = {
    id: createAgentCoreEventId(input.idFactory),
    runId,
    kind: "agent.run.created",
    phase: "observe",
    createdAt,
    summary: "Agent Core run created locally.",
    payload: {
      prompt: input.prompt,
      project,
      room,
      sessionId,
      workspaceId,
      localOnly: true,
    },
    ...(input.plan ? { plan: input.plan } : {}),
  };
  validateAtlasAgentCoreEvent(createdEvent);
  const snapshot = snapshotFromParts({
    run,
    events: [createdEvent],
    updatedAt: createdAt,
    plan: input.plan,
  });
  await writeRunSnapshot(input.root, snapshot);
  await appendCoreEventsFile(input.root, runId, createdEvent);
  return snapshot;
}

export async function appendCoreEvent(input: AtlasAgentCoreAppendEventInput): Promise<AtlasAgentCoreRunSnapshot> {
  const runId = assertSafeAgentCoreRunId(input.runId);
  const snapshot = await requireRun(input.root, runId);
  validateAtlasAgentCoreEvent(input.event);
  if (input.event.runId !== runId) throw new Error("Core event runId does not match target run.");
  if (snapshot.coreEvents.length >= MAX_EVENTS) throw new Error("Agent Core run event limit reached.");

  const nextSnapshot = snapshotFromParts({
    run: snapshot.run,
    events: [...snapshot.coreEvents, input.event],
    updatedAt: input.event.createdAt,
    plan: input.event.plan ?? snapshot.plan,
    critic: input.event.critic ?? snapshot.critic,
    compressedSummary: input.event.compressedSummary ?? snapshot.compressedSummary,
  });
  await writeRunSnapshot(input.root, nextSnapshot);
  await appendCoreEventsFile(input.root, runId, input.event);
  return nextSnapshot;
}

export async function readRun(input: AtlasAgentCoreReadRunInput): Promise<AtlasAgentCoreRunSnapshot | null> {
  const runId = assertSafeAgentCoreRunId(input.runId);
  try {
    const raw = await readFile(runStorePath(input.root, runId, "run.json"), "utf8");
    return validateAtlasAgentCoreRunSnapshot(JSON.parse(raw));
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function listRuns(input: AtlasAgentCoreListRunsInput = {}): Promise<AtlasAgentCoreRunMetadata[]> {
  const root = input.root ?? ATLAS_AGENT_CORE_RUN_ROOT;
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  const snapshots: AtlasAgentCoreRunSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeAgentCoreRunId(entry.name)) continue;
    const snapshot = await readRun({ root, runId: entry.name });
    if (snapshot) snapshots.push(snapshot);
  }

  const limit = input.limit === undefined ? 80 : Math.max(1, Math.min(input.limit, 200));
  return snapshots
    .map((snapshot) => snapshot.metadata)
    .filter((metadata) => input.project === undefined || metadata.project === input.project)
    .filter((metadata) => input.room === undefined || metadata.room === input.room)
    .filter((metadata) => input.sessionId === undefined || metadata.sessionId === input.sessionId)
    .filter((metadata) => input.status === undefined || metadata.status === input.status)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

export async function updateRunStatus(input: AtlasAgentCoreUpdateStatusInput): Promise<AtlasAgentCoreRunSnapshot> {
  const runId = assertSafeAgentCoreRunId(input.runId);
  const snapshot = await requireRun(input.root, runId);
  assertAgentRunStatus(input.status);
  const loopPhase = input.loopPhase ?? snapshot.run.loopPhase;
  if (!isAtlasAgentCoreLoopPhase(loopPhase)) throw new Error("Invalid Agent Core loop phase.");
  validateRunStatusTransition(snapshot.run.status, input.status);

  const now = input.now ?? new Date();
  const event: AtlasAgentCoreEvent = {
    id: createAgentCoreEventId(input.idFactory),
    runId,
    kind: "agent.status.updated",
    phase: loopPhase,
    createdAt: now.toISOString(),
    summary: `Run status updated to ${input.status}.`,
    payload: {
      previousStatus: snapshot.run.status,
      status: input.status,
      previousLoopPhase: snapshot.run.loopPhase,
      loopPhase,
    },
  };
  validateAtlasAgentCoreEvent(event);

  const run: AtlasAgentCoreRun = {
    ...snapshot.run,
    status: input.status,
    loopPhase,
  };
  const nextSnapshot = snapshotFromParts({
    run,
    events: [...snapshot.coreEvents, event],
    updatedAt: event.createdAt,
    plan: snapshot.plan,
    critic: snapshot.critic,
    compressedSummary: snapshot.compressedSummary,
  });
  await writeRunSnapshot(input.root, nextSnapshot);
  await appendCoreEventsFile(input.root, runId, event);
  return nextSnapshot;
}

export async function replayRun(input: AtlasAgentCoreReadRunInput): Promise<AtlasAgentCoreReplay | null> {
  const snapshot = await readRun(input);
  if (!snapshot) return null;
  return {
    run: snapshot.run,
    metadata: snapshot.metadata,
    coreEvents: snapshot.coreEvents,
    agentEvents: snapshot.coreEvents
      .filter((event) => event.kind === "agent.event.emitted" && event.agentEvent)
      .map((event) => event.agentEvent as AgentEvent),
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
    ...(snapshot.critic ? { critic: snapshot.critic } : {}),
    ...(snapshot.compressedSummary ? { compressedSummary: snapshot.compressedSummary } : {}),
  };
}

export function createAgentCoreRunId(idFactory: () => string = randomUUID): string {
  return `core_run_${idFactory().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
}

export function createAgentCoreEventId(idFactory: () => string = randomUUID): string {
  return `core_evt_${idFactory().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
}

export function validateAtlasAgentCoreEvent(event: AtlasAgentCoreEvent): void {
  if (!event || typeof event !== "object") throw new Error("Agent Core event must be an object.");
  assertSafeAgentCoreEventId(event.id);
  assertSafeAgentCoreRunId(event.runId);
  if (!CORE_EVENT_KIND_SET.has(event.kind)) throw new Error(`Unsupported Agent Core event kind: ${String(event.kind)}`);
  if (!isAtlasAgentCoreLoopPhase(event.phase)) throw new Error("Invalid Agent Core event phase.");
  if (!isIsoDate(event.createdAt)) throw new Error("Agent Core event createdAt must be an ISO timestamp.");
  if (typeof event.summary !== "string" || !event.summary.trim()) throw new Error("Agent Core event summary is required.");
  if (event.summary.length > 1_000) throw new Error("Agent Core event summary is too long.");
  if (event.payload !== undefined && !isRecord(event.payload)) throw new Error("Agent Core event payload must be an object.");
  if (event.kind === "agent.event.emitted") {
    if (!event.agentEvent) throw new Error("agent.event.emitted requires an embedded AgentEvent.");
    agentEventToDbInsert(event.agentEvent);
    if (event.agentEvent.runId !== event.runId) throw new Error("Embedded AgentEvent runId does not match Core event runId.");
  } else if (event.agentEvent !== undefined) {
    throw new Error("Only agent.event.emitted can include an embedded AgentEvent.");
  }
  if (event.plan !== undefined) validatePlan(event.plan, event.runId);
  if (event.critic !== undefined) validateCritic(event.critic, event.runId);
  if (event.compressedSummary !== undefined && typeof event.compressedSummary !== "string") {
    throw new Error("compressedSummary must be a string.");
  }
}

function snapshotFromParts({
  run,
  events,
  updatedAt,
  plan,
  critic,
  compressedSummary,
}: {
  run: AtlasAgentCoreRun;
  events: AtlasAgentCoreEvent[];
  updatedAt: string;
  plan?: AtlasAgentPlan;
  critic?: AtlasAgentCriticResult;
  compressedSummary?: string;
}): AtlasAgentCoreRunSnapshot {
  const metadata: AtlasAgentCoreRunMetadata = {
    runId: run.context.runId,
    workspaceId: run.context.workspaceId,
    project: run.context.project,
    room: run.context.room,
    sessionId: run.context.sessionId,
    userId: run.context.userId ?? null,
    parentRunId: run.context.parentRunId ?? null,
    status: run.status,
    loopPhase: run.loopPhase,
    createdAt: run.context.createdAt,
    updatedAt,
    eventCount: events.length,
    budgetCount: run.budgets.length,
  };
  return {
    version: ATLAS_AGENT_CORE_STORE_VERSION,
    localOnly: true,
    metadata,
    run,
    coreEvents: events,
    ...(plan ? { plan } : {}),
    ...(critic ? { critic } : {}),
    ...(compressedSummary ? { compressedSummary } : {}),
  };
}

async function requireRun(root: string | undefined, runId: string): Promise<AtlasAgentCoreRunSnapshot> {
  const snapshot = await readRun({ root, runId });
  if (!snapshot) throw new Error(`Agent Core run ${runId} was not found.`);
  return snapshot;
}

async function writeRunSnapshot(root: string | undefined, snapshot: AtlasAgentCoreRunSnapshot): Promise<void> {
  const dir = runStoreDir(root, snapshot.metadata.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(runStorePath(root, snapshot.metadata.runId, "metadata.json"), `${JSON.stringify(snapshot.metadata, null, 2)}\n`, "utf8");
  await writeFile(runStorePath(root, snapshot.metadata.runId, "run.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function appendCoreEventsFile(root: string | undefined, runId: string, event: AtlasAgentCoreEvent): Promise<void> {
  await appendFile(runStorePath(root, runId, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

function validateAtlasAgentCoreRunSnapshot(value: unknown): AtlasAgentCoreRunSnapshot {
  if (!isRecord(value)) throw new Error("Agent Core run snapshot must be an object.");
  if (value.version !== ATLAS_AGENT_CORE_STORE_VERSION || value.localOnly !== true) {
    throw new Error("Unsupported Agent Core run snapshot version.");
  }
  if (!isRecord(value.run)) throw new Error("Agent Core run is missing.");
  const run = value.run as unknown as AtlasAgentCoreRun;
  validateRun(run);
  if (!Array.isArray(value.coreEvents)) throw new Error("Agent Core events must be an array.");
  for (const event of value.coreEvents) validateAtlasAgentCoreEvent(event as AtlasAgentCoreEvent);
  if (isRecord(value.metadata)) {
    if (value.metadata.runId !== run.context.runId) throw new Error("Agent Core metadata runId mismatch.");
    if (value.metadata.eventCount !== value.coreEvents.length) throw new Error("Agent Core metadata event count mismatch.");
  } else {
    throw new Error("Agent Core metadata is missing.");
  }
  return value as unknown as AtlasAgentCoreRunSnapshot;
}

function validateRun(run: AtlasAgentCoreRun): void {
  if (!run || typeof run !== "object") throw new Error("Agent Core run must be an object.");
  if (!run.context || typeof run.context !== "object") throw new Error("Agent Core run context is missing.");
  assertSafeAgentCoreRunId(run.context.runId);
  cleanRequiredString(run.context.workspaceId, "workspaceId", 160);
  cleanRequiredString(run.context.project, "project", 160);
  cleanRequiredString(run.context.room, "room", 160);
  cleanRequiredString(run.context.sessionId, "sessionId", 160);
  if (!isIsoDate(run.context.createdAt)) throw new Error("Run createdAt must be an ISO timestamp.");
  assertAgentRunStatus(run.status);
  if (!isAtlasAgentCoreLoopPhase(run.loopPhase)) throw new Error("Invalid Agent Core run loop phase.");
  normalizeBudgets(run.budgets);
}

function validateRunStatusTransition(current: AtlasAgentRunStatus, next: AtlasAgentRunStatus): void {
  if (current === next) return;
  if (TERMINAL_RUN_STATUSES.has(current)) throw new Error(`Cannot transition terminal Agent Core run from ${current} to ${next}.`);
  const allowed: Record<AtlasAgentRunStatus, AtlasAgentRunStatus[]> = {
    queued: ["running", "paused", "waiting_for_approval", "failed"],
    running: ["paused", "waiting_for_approval", "complete", "failed"],
    paused: ["running", "failed"],
    waiting_for_approval: ["running", "paused", "failed"],
    complete: [],
    failed: [],
  };
  if (!allowed[current].includes(next)) throw new Error(`Invalid Agent Core status transition: ${current} -> ${next}.`);
}

function normalizeBudgets(budgets: AtlasAgentBudget[]): AtlasAgentBudget[] {
  if (!Array.isArray(budgets)) throw new Error("budgets must be an array.");
  return budgets.map((budget) => {
    if (!budget || typeof budget !== "object") throw new Error("budget must be an object.");
    if (!["turns", "tool_calls", "wall_time_ms", "tokens", "cost_usd"].includes(budget.kind)) {
      throw new Error("Unsupported budget kind.");
    }
    if (!Number.isFinite(budget.limit) || budget.limit < 0) throw new Error("budget limit must be a non-negative number.");
    if (!Number.isFinite(budget.used) || budget.used < 0) throw new Error("budget used must be a non-negative number.");
    if (budget.used > budget.limit) throw new Error("budget used cannot exceed limit.");
    return { kind: budget.kind, limit: budget.limit, used: budget.used };
  });
}

function validatePlan(plan: AtlasAgentPlan, runId: string): void {
  if (!plan || typeof plan !== "object") throw new Error("plan must be an object.");
  if (plan.runId !== runId) throw new Error("plan runId mismatch.");
  if (!isIsoDate(plan.createdAt)) throw new Error("plan createdAt must be an ISO timestamp.");
  cleanRequiredString(plan.goal, "plan.goal", 1_000);
  if (!Array.isArray(plan.steps)) throw new Error("plan steps must be an array.");
  if (!Array.isArray(plan.openQuestions)) throw new Error("plan openQuestions must be an array.");
}

function validateCritic(critic: AtlasAgentCriticResult, runId: string): void {
  if (!critic || typeof critic !== "object") throw new Error("critic must be an object.");
  if (critic.runId !== runId) throw new Error("critic runId mismatch.");
  if (!["pass", "revise", "block"].includes(critic.verdict)) throw new Error("critic verdict is invalid.");
  if (!Array.isArray(critic.issues) || !Array.isArray(critic.requiredFollowUp)) {
    throw new Error("critic issues and requiredFollowUp must be arrays.");
  }
}

function runStoreDir(root: string | undefined, runId: string): string {
  return safeAgentCoreStorePath(root ?? ATLAS_AGENT_CORE_RUN_ROOT, assertSafeAgentCoreRunId(runId));
}

function runStorePath(root: string | undefined, runId: string, filename: "metadata.json" | "events.jsonl" | "run.json"): string {
  return safeAgentCoreStorePath(root ?? ATLAS_AGENT_CORE_RUN_ROOT, assertSafeAgentCoreRunId(runId), filename);
}

function safeAgentCoreStorePath(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, ...segments);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Agent Core run path escaped controlled root.");
  }
  return resolvedPath;
}

function createAgentCoreSessionId(idFactory: (() => string) | undefined): string {
  return `session_${(idFactory ?? randomUUID)().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 18)}`;
}

function assertSafeAgentCoreRunId(value: string): string {
  if (!isSafeAgentCoreRunId(value)) throw new Error("Unsafe Agent Core run id.");
  return value;
}

function assertSafeAgentCoreEventId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value)) throw new Error("Unsafe Agent Core event id.");
  return value;
}

function isSafeAgentCoreRunId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
}

function assertAgentRunStatus(value: unknown): asserts value is AtlasAgentRunStatus {
  if (!RUN_STATUS_SET.has(value as AtlasAgentRunStatus)) throw new Error(`Unsupported Agent Core run status: ${String(value)}`);
}

function cleanRequiredString(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new Error(`${field} is too long.`);
  return trimmed;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
