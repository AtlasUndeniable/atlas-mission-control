import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { AgentEvent, Artifact, ArtifactType, Message, Task, TaskStep } from "./workspace-demo-events.ts";
import { WORKSPACE_DEMO_ARTIFACT_ROOT, type WorkspaceDraftArtifactRequestedFormat } from "./workspace-draft-artifacts.ts";

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
  artifactCount: number;
  selectedArtifactId: string | null;
  archivedAt: string | null;
  archivedReason: string | null;
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

export interface WorkspaceLocalArtifact {
  id: string;
  type: ArtifactType;
  title: string;
  subtitle: string;
  preview: string;
  requestedFormat: WorkspaceDraftArtifactRequestedFormat | "unknown";
  createdAt: string;
  sessionId: string;
  sessionTitle: string;
  sessionUpdatedAt: string;
  taskTitle: string | null;
}

export interface WorkspaceLocalSessionScope {
  project?: string;
  room?: string;
  root?: string;
  artifactRoot?: string;
}

export interface WorkspaceLocalSessionListScope extends WorkspaceLocalSessionScope {
  collapseDuplicateTitles?: boolean;
  includeArchived?: boolean;
}

interface WorkspaceLocalSessionStoreFile extends WorkspaceLocalSessionSnapshot {
  version: 1;
  localOnly: true;
}

interface WorkspaceLocalArtifactMetadata {
  createdAt: string | null;
  type: ArtifactType | "unknown";
  requestedFormat: WorkspaceDraftArtifactRequestedFormat | "unknown";
  taskTitle: string | null;
  sourceWorkflow: "atlas-rhys-ricky-handover-archive" | null;
  unsupportedPdf: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
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
  const nextThread = buildWorkspaceLocalSessionThread(nextEvents);
  const metadata: WorkspaceLocalSessionMetadata = {
    id: safeSessionId,
    workspaceId: event.workspaceId,
    project: normalized.project,
    room: normalized.room,
    title: title.trim() || existingMetadata?.title || "Workspace session",
    createdAt,
    updatedAt: event.createdAt,
    eventCount: nextEvents.length,
    artifactCount: nextThread.artifacts.length,
    selectedArtifactId: existingMetadata?.selectedArtifactId ?? null,
    archivedAt: existingMetadata?.archivedAt ?? null,
    archivedReason: existingMetadata?.archivedReason ?? null,
  };
  const snapshot: WorkspaceLocalSessionSnapshot = {
    metadata,
    events: nextEvents,
    thread: nextThread,
  };

  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeWorkspaceSessionStoreFile(dir, snapshot);
  return metadata;
}

export async function listWorkspaceLocalSessions(
  scope: WorkspaceLocalSessionListScope = {},
): Promise<WorkspaceLocalSessionMetadata[]> {
  const snapshots = await readWorkspaceLocalSessionSnapshots(scope);
  const includeArchived = scope.includeArchived === true;
  const collapseDuplicateTitles = scope.collapseDuplicateTitles !== false;
  const sessions = snapshots
    .map((snapshot) => snapshot.metadata)
    .filter((metadata) => includeArchived || !metadata.archivedAt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return collapseDuplicateTitles ? newestSessionPerTitle(sessions) : sessions;
}

export async function getLatestWorkspaceLocalSession(
  scope: WorkspaceLocalSessionScope = {},
): Promise<WorkspaceLocalSessionSnapshot | null> {
  const sessions = await listWorkspaceLocalSessions(scope);
  const latest = sessions[0];
  if (!latest) return null;
  return hydrateWorkspaceLocalSession({ ...scope, sessionId: latest.id });
}

export async function archiveStaleDuplicateWorkspaceLocalSessions(
  scope: WorkspaceLocalSessionScope = {},
): Promise<WorkspaceLocalSessionMetadata[]> {
  const normalized = normalizeWorkspaceSessionScope(scope);
  const snapshots = await readWorkspaceLocalSessionSnapshots({
    ...normalized,
    includeArchived: true,
    collapseDuplicateTitles: false,
  });
  const groups = new Map<string, WorkspaceLocalSessionSnapshot[]>();
  for (const snapshot of snapshots.filter((item) => !item.metadata.archivedAt)) {
    const key = duplicateTitleKey(snapshot.metadata.title);
    groups.set(key, [...(groups.get(key) ?? []), snapshot]);
  }

  const archived: WorkspaceLocalSessionMetadata[] = [];
  const archivedAt = new Date().toISOString();
  for (const group of groups.values()) {
    const sorted = [...group].sort(compareWorkspaceDuplicateSessionKeepOrder);
    for (const snapshot of sorted.slice(1)) {
      const nextMetadata: WorkspaceLocalSessionMetadata = {
        ...snapshot.metadata,
        archivedAt,
        archivedReason: "duplicate-local-test-session",
      };
      const nextSnapshot: WorkspaceLocalSessionSnapshot = {
        ...snapshot,
        metadata: nextMetadata,
      };
      await writeWorkspaceSessionSnapshot(normalized.root, nextSnapshot);
      archived.push(nextMetadata);
    }
  }
  return archived.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function listWorkspaceLocalArtifacts(
  scope: WorkspaceLocalSessionScope & { artifactRoot?: string; limit?: number } = {},
): Promise<WorkspaceLocalArtifact[]> {
  const sessions = await listWorkspaceLocalSessions({ ...scope, includeArchived: true, collapseDuplicateTitles: false });
  const limit = Number.isFinite(scope.limit) ? Math.max(1, Math.min(Number(scope.limit), 80)) : 40;
  const artifactRoot = scope.artifactRoot ?? WORKSPACE_DEMO_ARTIFACT_ROOT;
  const artifactById = new Map<string, WorkspaceLocalArtifact>();

  for (const session of sessions) {
    const snapshot = await hydrateWorkspaceLocalSession({ ...scope, sessionId: session.id });
    if (!snapshot) continue;
    for (const event of snapshot.events) {
      if (event.kind !== "artifact.created") continue;
      const metadata = await readWorkspaceLocalArtifactMetadata(event.artifact.id, artifactRoot);
      const normalizedEventArtifact = normalizeHydratedWorkspaceArtifact(event.artifact, metadata);
      if (!normalizedEventArtifact) continue;
      const artifact = normalizeWorkspaceLocalArtifact(normalizedEventArtifact, {
        createdAt: metadata?.createdAt ?? event.createdAt,
        sessionId: snapshot.metadata.id,
        sessionTitle: snapshot.metadata.title,
        sessionUpdatedAt: snapshot.metadata.updatedAt,
        requestedFormat: metadata?.requestedFormat ?? requestedFormatFromArtifactType(normalizedEventArtifact.type),
        taskTitle: metadata?.taskTitle ?? null,
      });
      if (!artifact) continue;
      const existing = artifactById.get(artifact.id);
      if (!existing || Date.parse(artifact.createdAt) >= Date.parse(existing.createdAt)) {
        artifactById.set(artifact.id, artifact);
      }
    }
  }

  return [...artifactById.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

export async function hydrateWorkspaceLocalSession(
  scope: WorkspaceLocalSessionScope & { sessionId: string },
): Promise<WorkspaceLocalSessionSnapshot | null> {
  const normalized = normalizeWorkspaceSessionScope(scope);
  const artifactRoot = scope.artifactRoot ?? WORKSPACE_DEMO_ARTIFACT_ROOT;
  const sessionId = assertSafeWorkspaceSessionId(scope.sessionId);
  const dir = workspaceSessionDir(normalized.root, normalized.room, normalized.project, sessionId);
  const storeSnapshot = await readWorkspaceSessionStoreFile(workspaceSessionFilePath(dir, "session.json"));
  if (storeSnapshot) return sanitizeWorkspaceLocalSessionSnapshotArtifacts(storeSnapshot, artifactRoot);

  const metadata = await readWorkspaceSessionMetadataFile(workspaceSessionFilePath(dir, "metadata.json"));
  if (!metadata) return null;
  const events = await readWorkspaceSessionEventsFile(workspaceSessionFilePath(dir, "events.jsonl"));
  const thread = buildWorkspaceLocalSessionThread(events);
  const snapshot: WorkspaceLocalSessionSnapshot = {
    metadata: { ...metadata, eventCount: events.length, artifactCount: thread.artifacts.length },
    events,
    thread,
  };
  await writeWorkspaceSessionStoreFile(dir, snapshot);
  return sanitizeWorkspaceLocalSessionSnapshotArtifacts(snapshot, artifactRoot);
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
      thread.task = taskSnapshot;
      thread.tasks = thread.tasks.some((task) => task.id === taskSnapshot.id)
        ? thread.tasks.map((task) => (task.id === taskSnapshot.id ? taskSnapshot : task))
        : [...thread.tasks, taskSnapshot];
      thread.tasks = dedupeWorkspaceThreadTasks(thread.tasks);
      thread.steps = event.task.steps;
    }
  }

  return thread;
}

function dedupeWorkspaceThreadTasks(tasks: Task[]): Task[] {
  const byKey = new Map<string, Task>();
  for (const task of tasks) {
    const key = `${task.id}::${task.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    byKey.set(key, task);
  }
  return [...byKey.values()];
}

async function sanitizeWorkspaceLocalSessionSnapshotArtifacts(
  snapshot: WorkspaceLocalSessionSnapshot,
  artifactRoot: string,
): Promise<WorkspaceLocalSessionSnapshot> {
  const artifacts = await Promise.all(snapshot.thread.artifacts.map(async (artifact) => {
    const metadata = await readWorkspaceLocalArtifactMetadata(artifact.id, artifactRoot);
    return normalizeHydratedWorkspaceArtifact(artifact, metadata);
  }));
  const thread: WorkspaceLocalSessionThread = {
    ...snapshot.thread,
    artifacts: artifacts.filter((artifact): artifact is Artifact => Boolean(artifact)),
  };
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      artifactCount: thread.artifacts.length,
    },
    thread,
  };
}

function normalizeHydratedWorkspaceArtifact(
  artifact: Artifact,
  metadata: WorkspaceLocalArtifactMetadata | null,
): Artifact | null {
  if (!artifact || typeof artifact !== "object") return null;
  if (metadata?.archivedAt) return null;
  if (artifact.type === "pdf" && metadata?.sourceWorkflow === "atlas-rhys-ricky-handover-archive") {
    return {
      ...artifact,
      preview: "Existing Atlas/Rhys Ricky handover package copied into Workspace. Review the PDF before any external use.",
    };
  }
  if (artifact.type !== "pdf" || !metadata?.unsupportedPdf) return artifact;
  return {
    ...artifact,
    type: "markdown",
    title: artifact.title.replace(/\s+PDF draft$/i, " internal draft"),
    subtitle: "PDF renderer unavailable; internal markdown draft only",
    preview: "Legacy placeholder PDF hidden. Open the internal markdown draft while the real Atlas/Rhys workflow is used for supported Ricky PDFs.",
  };
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

function normalizeWorkspaceLocalArtifact(
  artifact: Artifact,
  context: Pick<WorkspaceLocalArtifact, "createdAt" | "requestedFormat" | "sessionId" | "sessionTitle" | "sessionUpdatedAt" | "taskTitle">,
): WorkspaceLocalArtifact | null {
  if (!artifact || typeof artifact !== "object") return null;
  if (!isSafeWorkspaceArtifactId(artifact.id) || !isKnownWorkspaceArtifactType(artifact.type)) return null;
  return {
    id: artifact.id,
    type: artifact.type,
    title: safeDisplayText(artifact.title, "Workspace artifact"),
    subtitle: safeDisplayText(artifact.subtitle, "Local Workspace artifact"),
    preview: safeDisplayText(artifact.preview, ""),
    requestedFormat: context.requestedFormat,
    createdAt: context.createdAt,
    sessionId: context.sessionId,
    sessionTitle: safeDisplayText(context.sessionTitle, "Workspace session"),
    sessionUpdatedAt: context.sessionUpdatedAt,
    taskTitle: context.taskTitle ? safeDisplayText(context.taskTitle, "Workspace task") : null,
  };
}

async function readWorkspaceLocalArtifactMetadata(
  id: string,
  root: string,
): Promise<WorkspaceLocalArtifactMetadata | null> {
  if (!isSafeWorkspaceArtifactId(id)) return null;
  try {
    const raw = await readFile(safeWorkspaceLocalArtifactPath(root, `${id}.metadata.json`), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const type = typeof parsed.type === "string" && isKnownWorkspaceArtifactType(parsed.type) ? parsed.type : "unknown";
    const sourceWorkflow = parsed.sourceWorkflow === "atlas-rhys-ricky-handover-archive"
      ? "atlas-rhys-ricky-handover-archive"
      : null;
    return {
      createdAt: typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt))
        ? parsed.createdAt
        : null,
      type,
      requestedFormat: isWorkspaceDraftArtifactRequestedFormat(parsed.requestedFormat)
        ? parsed.requestedFormat
        : "unknown",
      taskTitle: typeof parsed.taskTitle === "string" ? parsed.taskTitle : null,
      sourceWorkflow,
      unsupportedPdf: type === "pdf" && sourceWorkflow !== "atlas-rhys-ricky-handover-archive",
      archivedAt: typeof parsed.archivedAt === "string" ? parsed.archivedAt : null,
      archivedReason: typeof parsed.archivedReason === "string" ? parsed.archivedReason : null,
    };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return null;
    return null;
  }
}

function isSafeWorkspaceArtifactId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
}

function isKnownWorkspaceArtifactType(value: string): value is ArtifactType {
  return ["document", "spreadsheet", "audit", "brief", "playbook", "markdown", "pdf"].includes(value);
}

function isWorkspaceDraftArtifactRequestedFormat(value: unknown): value is WorkspaceDraftArtifactRequestedFormat {
  return typeof value === "string" && [
    "document",
    "markdown",
    "pdf",
    "docx",
    "report",
    "handover",
    "deck",
    "export",
    "file",
    "deliverable",
  ].includes(value);
}

function requestedFormatFromArtifactType(type: ArtifactType): WorkspaceDraftArtifactRequestedFormat | "unknown" {
  if (type === "pdf") return "pdf";
  if (type === "markdown") return "markdown";
  return "unknown";
}

function safeWorkspaceLocalArtifactPath(root: string, filename: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, filename);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Workspace artifact path escaped controlled root.");
  }
  return resolvedPath;
}

function safeDisplayText(value: string, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/\/Users\/atlasai\/\S+/g, "[local artifact]")
    .replace(/\.openclaw\/\S+/g, "[local artifact]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
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

async function writeWorkspaceSessionSnapshot(root: string, snapshot: WorkspaceLocalSessionSnapshot): Promise<void> {
  const dir = workspaceSessionDir(root, snapshot.metadata.room, snapshot.metadata.project, snapshot.metadata.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    workspaceSessionFilePath(dir, "metadata.json"),
    `${JSON.stringify(snapshot.metadata, null, 2)}\n`,
    "utf8",
  );
  await writeWorkspaceSessionStoreFile(dir, snapshot);
}

async function readWorkspaceLocalSessionSnapshots(
  scope: WorkspaceLocalSessionListScope = {},
): Promise<WorkspaceLocalSessionSnapshot[]> {
  const normalized = normalizeWorkspaceSessionScope(scope);
  const projectDir = workspaceProjectDir(normalized.root, normalized.room, normalized.project);
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }

  const snapshots = await Promise.all(entries
    .filter(isSafeWorkspaceSessionId)
    .map((sessionId) => hydrateWorkspaceLocalSession({ ...normalized, sessionId })));
  return snapshots.filter((snapshot): snapshot is WorkspaceLocalSessionSnapshot => Boolean(snapshot));
}

function newestSessionPerTitle(sessions: WorkspaceLocalSessionMetadata[]): WorkspaceLocalSessionMetadata[] {
  const byTitle = new Map<string, WorkspaceLocalSessionMetadata>();
  for (const session of sessions) {
    const key = duplicateTitleKey(session.title);
    if (!byTitle.has(key)) byTitle.set(key, session);
  }
  return [...byTitle.values()];
}

function duplicateTitleKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim() || "workspace session";
}

function compareWorkspaceDuplicateSessionKeepOrder(
  a: WorkspaceLocalSessionSnapshot,
  b: WorkspaceLocalSessionSnapshot,
): number {
  const aComplete = isCompleteWorkspaceLocalSession(a);
  const bComplete = isCompleteWorkspaceLocalSession(b);
  if (aComplete !== bComplete) return aComplete ? -1 : 1;
  return Date.parse(b.metadata.updatedAt) - Date.parse(a.metadata.updatedAt);
}

function isCompleteWorkspaceLocalSession(snapshot: WorkspaceLocalSessionSnapshot): boolean {
  return snapshot.metadata.artifactCount > 0 ||
    snapshot.thread.tasks.some((task) => task.status === "complete") ||
    snapshot.thread.task?.status === "complete";
}

function parseWorkspaceSessionStoreFile(value: string): WorkspaceLocalSessionSnapshot {
  const parsed = JSON.parse(value) as Partial<WorkspaceLocalSessionStoreFile>;
  if (!parsed || typeof parsed !== "object") throw new Error("Workspace session store is invalid.");
  const metadata = parseWorkspaceSessionMetadata(JSON.stringify(parsed.metadata));
  const events = Array.isArray(parsed.events) ? parsed.events.filter(isHydratableWorkspaceSessionEvent) : [];
  const thread = buildWorkspaceLocalSessionThread(events);
  return {
    metadata: { ...metadata, eventCount: events.length, artifactCount: thread.artifacts.length },
    events,
    thread,
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
    artifactCount: Number.isFinite(parsed.artifactCount) ? Number(parsed.artifactCount) : 0,
    selectedArtifactId: typeof parsed.selectedArtifactId === "string" ? parsed.selectedArtifactId : null,
    archivedAt: typeof parsed.archivedAt === "string" ? parsed.archivedAt : null,
    archivedReason: typeof parsed.archivedReason === "string" ? parsed.archivedReason : null,
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
