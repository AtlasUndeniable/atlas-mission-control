/**
 * Atlas Agent Core local run store tests.
 * Uses temp files only; no Slack/OpenClaw/Monday/Typeform/Supabase mutations.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendCoreEvent,
  createRun,
  listRuns,
  readRun,
  replayRun,
  updateRunStatus,
  type AtlasAgentCoreEvent,
} from "../src/lib/atlas-agent-core-local-store.ts";

async function fixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atlas-agent-core-runs-"));
}

const createdAt = new Date("2026-06-05T08:00:00.000Z");

function coreEvent(runId: string, overrides: Partial<AtlasAgentCoreEvent> = {}): AtlasAgentCoreEvent {
  return {
    id: "core_evt_fixture",
    runId,
    kind: "agent.reflection.created",
    phase: "reflect",
    createdAt: "2026-06-05T08:01:00.000Z",
    summary: "Reflected on current run state.",
    payload: { note: "local only" },
    ...overrides,
  };
}

function emittedAgentEvent(runId: string): AtlasAgentCoreEvent {
  return coreEvent(runId, {
    id: "core_evt_emit",
    kind: "agent.event.emitted",
    phase: "emit",
    summary: "Presentation event emitted.",
    agentEvent: {
      id: "evt_presentation_1",
      runId,
      workspaceId: "workspace_undeniable_demo",
      taskId: "task_1",
      kind: "message.complete",
      visibility: "presentation",
      createdAt: "2026-06-05T08:01:10.000Z",
      messageId: "msg_1",
      role: "assistant",
      content: "Done.",
    },
  });
}

test("createRun writes metadata and can be read/listed", async () => {
  const root = await fixtureRoot();
  try {
    const snapshot = await createRun({
      root,
      runId: "core_run_fixture",
      prompt: "Start a local run",
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_fixture",
      workspaceId: "workspace_undeniable_demo",
      userId: "rhys",
      now: createdAt,
      budgets: [{ kind: "tool_calls", limit: 5, used: 0 }],
    });

    assert.equal(snapshot.metadata.runId, "core_run_fixture");
    assert.equal(snapshot.metadata.status, "queued");
    assert.equal(snapshot.metadata.loopPhase, "observe");
    assert.equal(snapshot.metadata.sessionId, "session_fixture");
    assert.equal(snapshot.metadata.budgetCount, 1);
    assert.equal(snapshot.coreEvents.length, 1);

    const read = await readRun({ root, runId: "core_run_fixture" });
    assert.equal(read?.metadata.runId, "core_run_fixture");

    const listed = await listRuns({ root, project: "undeniable-os", sessionId: "session_fixture" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.runId, "core_run_fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("appendCoreEvent and replayRun preserve Core events and emitted AgentEvents", async () => {
  const root = await fixtureRoot();
  try {
    await createRun({
      root,
      runId: "core_run_replay",
      prompt: "Replay me",
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_replay",
      now: createdAt,
    });

    await appendCoreEvent({ root, runId: "core_run_replay", event: coreEvent("core_run_replay") });
    await appendCoreEvent({ root, runId: "core_run_replay", event: emittedAgentEvent("core_run_replay") });

    const replay = await replayRun({ root, runId: "core_run_replay" });
    assert.equal(replay?.coreEvents.length, 3);
    assert.equal(replay?.agentEvents.length, 1);
    assert.equal(replay?.agentEvents[0]?.kind, "message.complete");

    const eventsFile = await readFile(join(root, "core_run_replay", "events.jsonl"), "utf8");
    assert.equal(eventsFile.trim().split("\n").length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateRunStatus enforces status transitions", async () => {
  const root = await fixtureRoot();
  try {
    await createRun({
      root,
      runId: "core_run_status",
      prompt: "Status test",
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_status",
      now: createdAt,
    });

    const running = await updateRunStatus({
      root,
      runId: "core_run_status",
      status: "running",
      loopPhase: "plan",
      now: new Date("2026-06-05T08:02:00.000Z"),
    });
    assert.equal(running.metadata.status, "running");
    assert.equal(running.metadata.loopPhase, "plan");

    const complete = await updateRunStatus({
      root,
      runId: "core_run_status",
      status: "complete",
      loopPhase: "persist",
      now: new Date("2026-06-05T08:03:00.000Z"),
    });
    assert.equal(complete.metadata.status, "complete");

    await assert.rejects(
      updateRunStatus({ root, runId: "core_run_status", status: "running" }),
      /Cannot transition terminal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe path guards reject unsafe run ids", async () => {
  const root = await fixtureRoot();
  try {
    await assert.rejects(
      createRun({
        root,
        runId: "../escape",
        prompt: "Bad path",
        project: "undeniable-os",
        room: "workspace-demo",
        sessionId: "session_safe",
      }),
      /Unsafe Agent Core run id/,
    );
    await assert.rejects(readRun({ root, runId: "../escape" }), /Unsafe Agent Core run id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed Core events and embedded AgentEvents are rejected", async () => {
  const root = await fixtureRoot();
  try {
    await createRun({
      root,
      runId: "core_run_malformed",
      prompt: "Reject malformed events",
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_malformed",
      now: createdAt,
    });

    await assert.rejects(
      appendCoreEvent({
        root,
        runId: "core_run_malformed",
        event: coreEvent("core_run_malformed", { kind: "agent.event.emitted" }),
      }),
      /requires an embedded AgentEvent/,
    );
    await assert.rejects(
      appendCoreEvent({
        root,
        runId: "core_run_malformed",
        event: emittedAgentEvent("other_run"),
      }),
      /runId does not match target run/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRun rejects malformed persisted snapshots", async () => {
  const root = await fixtureRoot();
  try {
    await createRun({
      root,
      runId: "core_run_corrupt",
      prompt: "Corrupt me",
      project: "undeniable-os",
      room: "workspace-demo",
      sessionId: "session_corrupt",
      now: createdAt,
    });
    const runPath = join(root, "core_run_corrupt", "run.json");
    await writeFile(runPath, JSON.stringify({ version: 1, localOnly: true, metadata: {}, run: {}, coreEvents: [{}] }), "utf8");
    await assert.rejects(readRun({ root, runId: "core_run_corrupt" }), /Unsafe Agent Core run id|Agent Core/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
