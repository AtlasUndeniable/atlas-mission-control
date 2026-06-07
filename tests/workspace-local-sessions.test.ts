import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendWorkspaceLocalSessionEvent,
  archiveStaleDuplicateWorkspaceLocalSessions,
  buildWorkspaceLocalSessionThread,
  getLatestWorkspaceLocalSession,
  hydrateWorkspaceLocalSession,
  listWorkspaceLocalArtifacts,
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

test("thread task projection deduplicates repeated task chips for one run", () => {
  const [, completeEvent] = taskEvents(3, "First 10k strategy pass");
  const repeatedComplete: AgentEvent = {
    ...completeEvent,
    id: "evt_duplicate_complete",
  };

  const thread = buildWorkspaceLocalSessionThread([completeEvent, repeatedComplete]);

  assert.equal(thread.task?.id, "run_3:task_3");
  assert.equal(thread.tasks.length, 1);
  assert.equal(thread.tasks[0]?.title, "First 10k strategy pass");
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

test("archived duplicate local sessions are excluded from default sidebar list", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-archive-"));
  try {
    const title = "Ricky Calder pay structure handover";
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_old_dup", title, event: userMessage(1, "Old Ricky request") });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_new_dup", title, event: userMessage(10, "New Ricky request") });

    const archived = await archiveStaleDuplicateWorkspaceLocalSessions({ root, project: "undeniable-os", room: "workspace-demo" });
    assert.deepEqual(archived.map((session) => session.id), ["session_old_dup"]);
    assert.equal(archived[0]?.archivedReason, "duplicate-local-test-session");

    const defaultSessions = await listWorkspaceLocalSessions({ root, project: "undeniable-os", room: "workspace-demo" });
    assert.deepEqual(defaultSessions.map((session) => session.id), ["session_new_dup"]);

    const allSessions = await listWorkspaceLocalSessions({
      root,
      project: "undeniable-os",
      room: "workspace-demo",
      includeArchived: true,
      collapseDuplicateTitles: false,
    });
    assert.deepEqual(allSessions.map((session) => session.id), ["session_new_dup", "session_old_dup"]);
    assert.ok(allSessions.find((session) => session.id === "session_old_dup")?.archivedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected session continuation appends events to the same local session", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-continuation-"));
  try {
    const title = "Ricky Calder pay structure handover";
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_selected", title, event: userMessage(1, "Create the handover.") });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_selected", title, event: assistantMessage(2, "Draft saved.") });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_selected", title, event: userMessage(5, "Add a follow-up note.") });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_selected", title, event: assistantMessage(6, "Follow-up added.") });

    const snapshot = await hydrateWorkspaceLocalSession({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_selected" });
    assert.equal(snapshot?.metadata.id, "session_selected");
    assert.equal(snapshot?.metadata.title, title);
    assert.equal(snapshot?.metadata.eventCount, 4);
    assert.equal(snapshot?.thread.messages.length, 4);
    assert.equal(snapshot?.thread.messages[2]?.content, "Add a follow-up note.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate archive keeps the newest complete local session when available", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-archive-complete-"));
  try {
    const title = "Ricky Calder pay structure handover";
    const completeArtifact: Artifact = {
      id: "artifact_demo_complete_ricky_pdf",
      type: "pdf",
      title: "Complete Ricky PDF",
      subtitle: "Atlas / mastra / PDF draft",
      preview: "PDF draft saved.",
    };
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_complete", title, event: artifactEvent(1, completeArtifact) });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_new_incomplete", title, event: userMessage(10, "Started another Ricky request") });

    const archived = await archiveStaleDuplicateWorkspaceLocalSessions({ root, project: "undeniable-os", room: "workspace-demo" });
    const defaultSessions = await listWorkspaceLocalSessions({ root, project: "undeniable-os", room: "workspace-demo" });

    assert.deepEqual(archived.map((session) => session.id), ["session_new_incomplete"]);
    assert.deepEqual(defaultSessions.map((session) => session.id), ["session_complete"]);
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

test("local artifact library lists safe project scoped artifacts newest first", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-library-"));
  const artifactRoot = await mkdtemp(join(tmpdir(), "atlas-workspace-artifacts-library-"));
  try {
    const olderArtifact: Artifact = {
      id: "artifact_demo_ricky_markdown",
      type: "markdown",
      title: "Ricky markdown draft",
      subtitle: "Atlas / mock / Markdown draft",
      preview: "Markdown draft saved.",
    };
    const newerArtifact: Artifact = {
      id: "artifact_demo_ricky_pdf",
      type: "pdf",
      title: "Ricky PDF /Users/atlasai/private.pdf",
      subtitle: "Atlas / mastra / PDF draft",
      preview: "PDF draft saved in /Users/atlasai/.openclaw/workspace/state.",
    };
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_old", title: "Older task", event: artifactEvent(1, olderArtifact) });
    await appendWorkspaceLocalSessionEvent({ root, project: "ricky-coach-hire", room: "workspace-demo", sessionId: "session_other", title: "Other project", event: artifactEvent(2, olderArtifact) });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_new", title: "Newer task", event: artifactEvent(5, newerArtifact) });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(artifactRoot, `${newerArtifact.id}.metadata.json`), JSON.stringify({
      id: newerArtifact.id,
      type: "pdf",
      createdAt: new Date(Date.UTC(2026, 5, 2, 0, 6, 0)).toISOString(),
      taskTitle: "Ricky PDF metadata task",
      requestedFormat: "pdf",
      sourceWorkflow: "atlas-rhys-ricky-handover-archive",
      localPath: "/Users/atlasai/private.pdf",
    }));

    const artifacts = await listWorkspaceLocalArtifacts({ root, artifactRoot, project: "undeniable-os", room: "workspace-demo" });
    assert.deepEqual(artifacts.map((artifact) => artifact.id), ["artifact_demo_ricky_pdf", "artifact_demo_ricky_markdown"]);
    assert.equal(artifacts[0]?.type, "pdf");
    assert.equal(artifacts[0]?.requestedFormat, "pdf");
    assert.equal(artifacts[0]?.taskTitle, "Ricky PDF metadata task");
    assert.equal(artifacts[0]?.sessionTitle, "Newer task");
    assert.doesNotMatch(JSON.stringify(artifacts), /\/Users\/atlasai|\.openclaw/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("legacy placeholder PDFs hydrate and list as internal markdown drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-legacy-pdf-"));
  const artifactRoot = await mkdtemp(join(tmpdir(), "atlas-workspace-artifacts-legacy-pdf-"));
  try {
    const artifact: Artifact = {
      id: "artifact_demo_legacy_pdf",
      type: "pdf",
      title: "Legacy PDF draft",
      subtitle: "Atlas / mastra / PDF draft",
      preview: "PDF draft saved.",
    };
    await appendWorkspaceLocalSessionEvent({
      root,
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_legacy_pdf",
      title: "Legacy PDF task",
      event: artifactEvent(1, artifact),
    });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(artifactRoot, `${artifact.id}.metadata.json`), JSON.stringify({
      id: artifact.id,
      type: "pdf",
      createdAt: new Date(Date.UTC(2026, 5, 2, 0, 6, 0)).toISOString(),
      taskTitle: "Legacy PDF task",
      requestedFormat: "pdf",
    }));

    const snapshot = await hydrateWorkspaceLocalSession({
      root,
      artifactRoot,
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_legacy_pdf",
    });
    assert.equal(snapshot?.thread.artifacts[0]?.type, "markdown");
    assert.equal(snapshot?.thread.artifacts[0]?.title, "Legacy internal draft");
    assert.match(snapshot?.thread.artifacts[0]?.subtitle ?? "", /internal markdown draft/);

    const artifacts = await listWorkspaceLocalArtifacts({ root, artifactRoot, project: "undeniable-os", room: "workspace-demo" });
    assert.equal(artifacts[0]?.type, "markdown");
    assert.equal(artifacts[0]?.title, "Legacy internal draft");
    assert.equal(artifacts[0]?.requestedFormat, "pdf");
    assert.match(artifacts[0]?.preview ?? "", /Legacy placeholder PDF hidden/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("archived artifact metadata hides bad local test artifacts without deleting files", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-archived-artifact-"));
  const artifactRoot = await mkdtemp(join(tmpdir(), "atlas-workspace-artifacts-archived-artifact-"));
  try {
    const artifact: Artifact = {
      id: "artifact_demo_bad_beta_pdf",
      type: "markdown",
      title: "Undeniable OS workspace session PDF draft",
      subtitle: "Internal markdown draft saved.",
      preview: "Bad beta artifact.",
    };
    await appendWorkspaceLocalSessionEvent({
      root,
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_archived_artifact",
      title: "Undeniable OS workspace session",
      event: artifactEvent(1, artifact),
    });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(join(artifactRoot, `${artifact.id}.metadata.json`), JSON.stringify({
      id: artifact.id,
      type: "markdown",
      createdAt: new Date(Date.UTC(2026, 5, 6, 3, 15, 0)).toISOString(),
      taskTitle: "Undeniable OS workspace session",
      requestedFormat: "pdf",
      archivedAt: "2026-06-07T00:00:00.000Z",
      archivedReason: "bad-beta-artifact-intent",
    }));
    await writeFile(join(artifactRoot, `${artifact.id}.md`), "# Preserved for rollback\n", "utf8");

    const snapshot = await hydrateWorkspaceLocalSession({
      root,
      artifactRoot,
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_archived_artifact",
    });
    const artifacts = await listWorkspaceLocalArtifacts({ root, artifactRoot, project: "undeniable-os", room: "workspace-demo" });

    assert.equal(snapshot?.thread.artifacts.length, 0);
    assert.equal(snapshot?.metadata.artifactCount, 0);
    assert.equal(artifacts.length, 0);
    assert.match(await readFile(join(artifactRoot, `${artifact.id}.md`), "utf8"), /Preserved for rollback/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("local artifact library keeps artifacts from archived sessions accessible", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-sessions-archived-library-"));
  try {
    const title = "Ricky Calder pay structure handover";
    const olderArtifact: Artifact = {
      id: "artifact_demo_archived_ricky_pdf",
      type: "pdf",
      title: "Archived Ricky PDF",
      subtitle: "Atlas / mastra / PDF draft",
      preview: "PDF draft saved.",
    };
    const newerArtifact: Artifact = {
      id: "artifact_demo_current_ricky_pdf",
      type: "pdf",
      title: "Current Ricky PDF",
      subtitle: "Atlas / mastra / PDF draft",
      preview: "PDF draft saved.",
    };
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_old_dup", title, event: artifactEvent(1, olderArtifact) });
    await appendWorkspaceLocalSessionEvent({ root, project: "undeniable-os", room: "workspace-demo", sessionId: "session_new_dup", title, event: artifactEvent(10, newerArtifact) });
    await archiveStaleDuplicateWorkspaceLocalSessions({ root, project: "undeniable-os", room: "workspace-demo" });

    const visibleSessions = await listWorkspaceLocalSessions({ root, project: "undeniable-os", room: "workspace-demo" });
    const artifacts = await listWorkspaceLocalArtifacts({ root, project: "undeniable-os", room: "workspace-demo" });

    assert.deepEqual(visibleSessions.map((session) => session.id), ["session_new_dup"]);
    assert.deepEqual(artifacts.map((artifact) => artifact.id), [
      "artifact_demo_current_ricky_pdf",
      "artifact_demo_archived_ricky_pdf",
    ]);
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
