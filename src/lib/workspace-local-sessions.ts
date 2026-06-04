import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { AgentEvent, Artifact, Message, Task, TaskStep } from "./workspace-demo-events.ts";

export const WORKSPACE_DEMO_SESSION_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-demo-sessions";
export const DEFAULT_WORKSPACE_ROOM = "workspace-demo";
export const DEFAULT_WORKSPACE_PROJECT = "undeniable-os";

export interface WorkspaceLocalSessionMetadata {
  id: string;
  workspaceId: string;
  project: string;
  room: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  selectedArtifactId: string | null;
}

export interface WorkspaceLocalSessionSnapshot {
  metadata: WorkspaceLocalSessionMetadata;
  events: AgentEvent[];
  thread: WorkspaceLocalSessionThread;
}

export interface WorkspaceLocalSessionThread {
  messages: Message[];
  artifacts: Artifact[];
  steps: TaskStep[];
  task: Task | null;
  tasks: Task[];
}

export interface WorkspaceLocalSessionScope {
  project?: string;
  room?: string;
  root?: string;
}

interface WorkspaceLocalSessionStoreFile extends WorkspaceLocalSessionSnapshot {
  version: 1;
  localOnly: true;
}

export function createWorkspaceLocalSessionId(): string {
  return `session_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export async function appendWorkspaceLocalSessionEvent({
  sessionId,
  project,
  room,
  title,
  event,
  root,
}: WorkspaceLocalSessionScope & {
  sessionId: string;
  title: string;
  event: AgentEvent;
}): Promise<WorkspaceLocalSessionMetadata | null> {
  if (!isHydratableWorkspaceSessionEvent(event)) return null;

  const normalized = normalizeWorkspaceSessionScope({ project, room, root });
  const safeSessionId = assertSafeWorkspaceSessionId(sessionId);
  const dir = workspaceSessionDir(normalized.root, normalized.room, normalized.project, safeSessionId);
  await mkdir(dir, { recursive: true });

  const metadataPath = workspaceSessionFilePath(dir, "metadata.json");
  const eventsPath = workspaceSessionFilePath(dir, "events.jsonl");
  const existingSnapshot = await readWorkspaceSessionStoreFile(workspaceSessionFilePath(dir, "session.json"));
  const existingMetadata = existingSnapshot?.metadata ?? await readWorkspaceSessionMetadataFile(metadataPath);
  const existingEvents = existingSnapshot?.events ?? await readWorkspaceSessionEventsFile(eventsPath);
  const nextEvents = [...existingEvents, event];
  const createdAt = existingMetadata?.createdAt ?? event.createdAt;
  const metadata: WorkspaceLocalSessionMetadata = {
    id: safeSessionId,
    workspaceId: event.workspaceId,
    project: normalized.project,
    room: normalized.room,
    title: title.trim() || existingMetadata?.title || "Workspace session",
    createdAt,
    updatedAt: event.createdAt,
    eventCount: nextEvents.length,
    selectedArtifactId: existingMetadata?.selectedArtifactId ?? null,
  };
  const snapshot: WorkspaceLocalSessionSnapshot = {
    metadata,
    events: nextEvents,
    thread: buildWorkspaceLocalSessionThread(nextEvents),
  };

  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeWorkspaceSessionStoreFile(dir, snapshot);
  return metadata;
}

export async function listWorkspaceLocalSessions(
  scope: WorkspaceLocalSessionScope = {},
): Promise<WorkspaceLocalSessionMetadata[]> {
  const normalized = normalizeWorkspaceSessionScope(scope);
  const projectDir = workspaceProjectDir(normalized.root, normalized.room, normalized.project);
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }

  const snapshots = await Promise.all(
    entries
      .filter(isSafeWorkspaceSessionId)
      .map((sessionId) => hydrateWorkspaceLocalSession({ ...normalized, sessionId })),
  );
  return snapshots
    .filter((snapshot): snapshot is WorkspaceLocalSessionSnapshot => Boolean(snapshot))
    .map((snapshot) => snapshot.metadata)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function getLatestWorkspaceLocalSession(
  scope: WorkspaceLocalSessionScope = {},
): Promise<WorkspaceLocalSessionSnapshot | null> {
  const sessions = await listWorkspaceLocalSessions(scope);
  const latest = sessions[0];
  if (!latest) return null;
  return hydrateWorkspaceLocalSession({ ...scope, sessionId: latest.id });
}

export async function hydrateWorkspaceLocalSession(
  scope: WorkspaceLocalSessionScope & { sessionId: string },
): Promise<WorkspaceLocalSessionSnapshot | null> {
  const normalized = normalizeWorkspaceSessionScope(scope);
  const sessionId = assertSafeWorkspaceSessionId(scope.sessionId);
  const dir = workspaceSessionDir(normalized.root, normalized.room, normalized.project, sessionId);
  const storeSnapshot = await readWorkspaceSessionStoreFile(workspaceSessionFilePath(dir, "session.json"));
  if (storeSnapshot) return storeSnapshot;

  const metadata = await readWorkspaceSessionMetadataFile(workspaceSessionFilePath(dir, "metadata.json"));
  if (!metadata) return null;
  const events = await readWorkspaceSessionEventsFile(workspaceSessionFilePath(dir, "events.jsonl"));
  const snapshot: WorkspaceLocalSessionSnapshot = {
    metadata: { ...metadata, eventCount: events.length },
    events,
    thread: buildWorkspaceLocalSessionThread(events),
  };
  await writeWorkspaceSessionStoreFile(dir, snapshot);
  return snapshot;
}

export async function updateWorkspaceLocalSessionSelection(
  scope: WorkspaceLocalSessionScope & {
    sessionId: string;
    selectedArtifactId: string | null;
  },
): Promise<WorkspaceLocalSessionMetadata | null> {
  const normalized = normalizeWorkspaceSessionScope(scope);
  const sessionId = assertSafeWorkspaceSessionId(scope.sessionId);
  const dir = workspaceSessionDir(normalized.root, normalized.room, normalized.project, sessionId);
  const metadataPath = workspaceSessionFilePath(dir, "metadata.json");
  const snapshot = await hydrateWorkspaceLocalSession({ ...normalized, sessionId });
  if (!snapshot) return null;
  const selectedArtifactId = scope.selectedArtifactId
    ? assertSafeWorkspaceArtifactId(scope.selectedArtifactId)
    : null;
  const nextMetadata: WorkspaceLocalSessionMetadata = {
    ...snapshot.metadata,
    selectedArtifactId,
    updatedAt: new Date().toISOString(),
  };
  const nextSnapshot: WorkspaceLocalSessionSnapshot = {
    ...snapshot,
    metadata: nextMetadata,
  };
  await writeFile(metadataPath, `${JSON.stringify(nextMetadata, null, 2)}\n`, "utf8");
  await writeWorkspaceSessionStoreFile(dir, nextSnapshot);
  return nextMetadata;
}

export function buildWorkspaceLocalSessionThread(events: AgentEvent[]): WorkspaceLocalSessionThread {
  const thread: WorkspaceLocalSessionThread = {
    messages: [],
    artifacts: [],
    steps: [],
    task: null,
    tasks: [],
  };

  for (const event of events) {
    if (!isHydratableWorkspaceSessionEvent(event)) continue;
    if (event.kind === "message.complete") {
      const nextMessage: Message = { id: event.messageId, role: event.role, content: event.content, complete: true };
      thread.messages = thread.messages.some((message) => message.id === event.messageId)
        ? thread.messages.map((message) => (message.id === event.messageId ? nextMessage : message))
        : [...thread.messages, nextMessage];
    }
    if (event.kind === "message.delta") {
      const existing = thread.messages.find((message) => message.id === event.messageId);
      if (!existing) {
        thread.messages = [...thread.messages, { id: event.messageId, role: event.role, content: event.delta, complete: false }];
      } else if (!existing.complete) {
        thread.messages = thread.messages.map((message) =>
          message.id === event.messageId ? { ...message, content: message.content + event.delta } : message,
        );
      }
    }
    if (event.kind === "artifact.created" && !thread.artifacts.some((artifact) => artifact.id === event.artifact.id)) {
      thread.artifacts = [...thread.artifacts, event.artifact];
    }
    if (event.kind === "task.step") {
      thread.steps = thread.steps.some((step) => step.id === event.step.id)
        ? thread.steps.map((step) => (step.id === event.step.id ? event.step : step))
        : [...thread.steps, event.step];
    }
    if (event.kind === "task.complete") {
      const taskSnapshot: Task = { ...event.task, id: `${event.runId}:${event.task.id}` };
      thread.task = event.task;
      thread.tasks = thread.tasks.some((task) => task.id === taskSnapshot.id)
        ? thread.tasks.map((task) => (task.id === taskSnapshot.id ? taskSnapshot : task))
        : [...thread.tasks, taskSnapshot];
      thread.steps = event.task.steps;
    }
  }

  return thread;
}

export function isHydratableWorkspaceSessionEvent(event: AgentEvent): boolean {
  return event.visibility === "presentation" && (
    event.kind === "message.delta" ||
    event.kind === "message.complete" ||
    event.kind === "artifact.created" ||
    event.kind === "task.step" ||
    event.kind === "task.complete"
  );
}

export function normalizeWorkspaceSessionScope(scope: WorkspaceLocalSessionScope = {}) {
  return {
    root: scope.root ?? WORKSPACE_DEMO_SESSION_ROOT,
    room: safeWorkspaceScopeSegment(scope.room ?? DEFAULT_WORKSPACE_ROOM),
    project: safeWorkspaceScopeSegment(scope.project ?? DEFAULT_WORKSPACE_PROJECT),
  };
}

function workspaceProjectDir(root: string, room: string, project: string): string {
  return safeWorkspaceSessionPath(root, room, project);
}

function workspaceSessionDir(root: string, room: string, project: string, sessionId: string): string {
  return safeWorkspaceSessionPath(root, room, project, sessionId);
}

function workspaceSessionFilePath(dir: string, filename: "events.jsonl" | "metadata.json" | "session.json"): string {
  return safeWorkspaceSessionPath(dir, filename);
}

function safeWorkspaceSessionPath(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, ...segments);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Workspace session path escaped controlled root.");
  }
  return resolvedPath;
}

function safeWorkspaceScopeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
}

function assertSafeWorkspaceSessionId(value: string): string {
  if (!isSafeWorkspaceSessionId(value)) throw new Error("Unsafe workspace session id.");
  return value;
}

function isSafeWorkspaceSessionId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
}

function assertSafeWorkspaceArtifactId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value)) throw new Error("Unsafe workspace artifact id.");
  return value;
}

async function readWorkspaceSessionMetadataFile(path: string): Promise<WorkspaceLocalSessionMetadata | null> {
  try {
    return parseWorkspaceSessionMetadata(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function readWorkspaceSessionEventsFile(path: string): Promise<AgentEvent[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AgentEvent)
      .filter(isHydratableWorkspaceSessionEvent);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function readWorkspaceSessionStoreFile(path: string): Promise<WorkspaceLocalSessionSnapshot | null> {
  try {
    return parseWorkspaceSessionStoreFile(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function writeWorkspaceSessionStoreFile(dir: string, snapshot: WorkspaceLocalSessionSnapshot): Promise<void> {
  const store: WorkspaceLocalSessionStoreFile = {
    version: 1,
    localOnly: true,
    metadata: snapshot.metadata,
    events: snapshot.events.filter(isHydratableWorkspaceSessionEvent),
    thread: buildWorkspaceLocalSessionThread(snapshot.events),
  };
  await writeFile(workspaceSessionFilePath(dir, "session.json"), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function parseWorkspaceSessionStoreFile(value: string): WorkspaceLocalSessionSnapshot {
  const parsed = JSON.parse(value) as Partial<WorkspaceLocalSessionStoreFile>;
  if (!parsed || typeof parsed !== "object") throw new Error("Workspace session store is invalid.");
  const metadata = parseWorkspaceSessionMetadata(JSON.stringify(parsed.metadata));
  const events = Array.isArray(parsed.events) ? parsed.events.filter(isHydratableWorkspaceSessionEvent) : [];
  return {
    metadata: { ...metadata, eventCount: events.length },
    events,
    thread: buildWorkspaceLocalSessionThread(events),
  };
}

function parseWorkspaceSessionMetadata(value: string): WorkspaceLocalSessionMetadata {
  const parsed = JSON.parse(value) as Partial<WorkspaceLocalSessionMetadata>;
  if (!parsed || typeof parsed !== "object") throw new Error("Workspace session metadata is invalid.");
  if (!parsed.id || !isSafeWorkspaceSessionId(parsed.id)) throw new Error("Workspace session id is invalid.");
  if (typeof parsed.workspaceId !== "string" || typeof parsed.project !== "string" || typeof parsed.room !== "string") {
    throw new Error("Workspace session scope is invalid.");
  }
  if (typeof parsed.title !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.updatedAt !== "string") {
    throw new Error("Workspace session metadata is incomplete.");
  }
  return {
    id: parsed.id,
    workspaceId: parsed.workspaceId,
    project: parsed.project,
    room: parsed.room,
    title: parsed.title,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    eventCount: Number.isFinite(parsed.eventCount) ? Number(parsed.eventCount) : 0,
    selectedArtifactId: typeof parsed.selectedArtifactId === "string" ? parsed.selectedArtifactId : null,
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
