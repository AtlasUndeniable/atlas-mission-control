import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendWorkspaceLocalSessionEvent,
  buildWorkspaceLocalSessionThread,
  getLatestWorkspaceLocalSession,
  hydrateWorkspaceLocalSession,
  listWorkspaceLocalSessions,
  updateWorkspaceLocalSessionSelection,
} from "../src/lib/workspace-local-sessions.ts";
import type { AgentEvent, Artifact, Task, TaskStep } from "../src/lib/workspace-demo-events.ts";

const workspaceId = "workspace_undeniable_demo";
const taskId = "task_hybrid_local_demo";

function eventBase(index: number, overrides: Partial<AgentEvent> = {}) {
  return {
    id: `evt_${index}`,
    workspaceId,
    taskId,
    runId: `run_${index}`,
    createdAt: new Date(Date.UTC(2026, 5, 2, 0, index, 0)).toISOString(),
    ...overrides,
  };
}

function userMessage(index: number, content: string): AgentEvent {
  return {
    ...eventBase(index),
    kind: "message.complete",
    visibility: "presentation",
    messageId: `msg_user_${index}`,
    role: "user",
    content,
  };
}

function assistantMessage(index: number, content: string): AgentEvent {
  return {
    ...eventBase(index),
    kind: "message.complete",
    visibility: "presentation",
    messageId: `msg_assistant_${index}`,
    role: "assistant",
    content,
  };
}

function artifactEvent(index: number, artifact: Artifact): AgentEvent {
  return {
    ...eventBase(index),
    kind: "artifact.created",
    visibility: "presentation",
    artifact,
  };
}

function taskEvents(index: number, title: string): [AgentEvent, AgentEvent] {
  const step: TaskStep = { id: `step_${index}`, title: "Create draft", status: "complete", summary: "Saved locally." };
  const task: Task = {
    id: `task_${index}`,
    title,
    status: "complete",
    completedSteps: 1,
    totalSteps: 1,
    steps: [step],
  };
  return [
    {
      ...eventBase(index),
      kind: "task.step",
      visibility: "presentation",
      step,
    },
    {
      ...eventBase(index + 1),
      runId: `run_${index}`,
      kind: "task.complete",
      visibility: "presentation",
      task,
    },
  ];
}

test("append and hydrate local workspace session events", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-"));
  try {
    const [stepEvent, completeEvent] = taskEvents(3, "Ricky PDF handover");
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_append", title: "Ricky PDF handover", event: userMessage(1, "Return this as a PDF.") });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_append", title: "Ricky PDF handover", event: assistantMessage(2, "PDF draft saved.") });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_append", title: "Ricky PDF handover", event: stepEvent });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_append", title: "Ricky PDF handover", event: completeEvent });

    const snapshot = await hydrateWorkspaceLocalSession({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_append" });
    assert.ok(snapshot);
    assert.equal(snapshot.metadata.title, "Ricky PDF handover");
    assert.equal(snapshot.thread.messages.length, 2);
    assert.equal(snapshot.thread.messages[0]?.content, "Return this as a PDF.");
    assert.equal(snapshot.thread.tasks[0]?.title, "Ricky PDF handover");

    const sessionJson = JSON.parse(await readFile(join(root, "workspace-demo", "undeniable-os", "session_append", "session.json"), "utf8")) as {
      localOnly?: boolean;
      events?: unknown[];
      thread?: { messages?: unknown[]; tasks?: unknown[] };
    };
    assert.equal(sessionJson.localOnly, true);
    assert.equal(sessionJson.events?.length, 4);
    assert.equal(sessionJson.thread?.messages?.length, 2);
    assert.equal(sessionJson.thread?.tasks?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest local session lookup is project scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-project-"));
  try {
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_a", title: "Undeniable session", event: userMessage(1, "Project A") });
    await appendWorkspaceLocalSessionEvent({ root, project: "ricky-coach-hire", room: "workspace-demo", sessionId: "session_b", title: "Ricky session", event: userMessage(2, "Project B") });

    const undeniable = await getLatestWorkspaceLocalSession({ root, project: "undeniable-os", room: "workspace-demo" });
    const ricky = await getLatestWorkspaceLocalSession({ root, project: "ricky-coach-hire", room: "workspace-demo" });
    assert.equal(undeniable?.metadata.id, "session_a");
    assert.equal(ricky?.metadata.id, "session_b");
    assert.equal(undeniable?.thread.messages[0]?.content, "Project A");
    assert.equal(ricky?.thread.messages[0]?.content, "Project B");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("local session list returns newest metadata for sidebar hydration", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-list-"));
  try {
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_first", title: "First task", event: userMessage(1, "First") });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_second", title: "Second task", event: userMessage(5, "Second") });

    const sessions = await listWorkspaceLocalSessions({ root, project: "undeniable-os", room: "workspace-demo" });
    assert.deepEqual(sessions.map((session) => session.id), ["session_second", "session_first"]);
    assert.equal(sessions[0]?.title, "Second task");
    assert.equal(sessions[1]?.eventCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new task creates a separate latest local session", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-new-task-"));
  try {
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_old", title: "Old task", event: userMessage(1, "Old task") });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_new", title: "New task", event: userMessage(10, "New task") });

    const latest = await getLatestWorkspaceLocalSession({ root, project: "undeniable-os", room: "workspace-demo" });
    assert.equal(latest?.metadata.id, "session_new");
    const old = await hydrateWorkspaceLocalSession({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_old" });
    assert.equal(old?.thread.messages[0]?.content, "Old task");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact survives hydration and selected artifact metadata stays safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-artifact-"));
  try {
    const artifact: Artifact = {
      id: "artifact_demo_ricky_pdf",
      type: "pdf",
      title: "Ricky Calder pay structure handover PDF draft",
      subtitle: "Atlas / mastra / PDF draft",
      preview: "PDF draft saved.",
    };
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_artifact", title: "Ricky PDF", event: artifactEvent(1, artifact) });
    const metadata = await updateWorkspaceLocalSessionSelection({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_artifact", selectedArtifactId: artifact.id });
    const snapshot = await hydrateWorkspaceLocalSession({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_artifact" });

    assert.equal(metadata?.selectedArtifactId, artifact.id);
    assert.equal(snapshot?.thread.artifacts[0]?.type, "pdf");
    assert.equal(snapshot?.thread.artifacts[0]?.title, "Ricky Calder pay structure handover PDF draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal events do not hydrate into presentation thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-internal-"));
  try {
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_internal", title: "Internal test", event: userMessage(1, "Visible") });
    const internalEvent: AgentEvent = {
      ...eventBase(2),
      kind: "tool.result",
      visibility: "internal",
      toolName: "workspace.references",
      label: "Internal only",
      resultSummary: "/Users/atlasai/private/path",
    };
    assert.equal(await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_internal", title: "Internal test", event: internalEvent }), null);

    const snapshot = await hydrateWorkspaceLocalSession({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_internal" });
    assert.equal(snapshot?.events.length, 1);
    assert.equal(snapshot?.thread.messages.length, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /\/Users\/atlasai\/private/);

    const directThread = buildWorkspaceLocalSessionThread([internalEvent, userMessage(3, "Still visible")]);
    assert.equal(directThread.messages.length, 1);
    assert.equal(directThread.messages[0]?.content, "Still visible");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
