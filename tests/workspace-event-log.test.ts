/**
 * Local P2 event-log tests.
 * No Supabase client, fs, network, or Next runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentEventToDbInsert,
  buildWorkspaceEventReplayQuery,
  dbRowToAgentEvent,
  filterPresentationAgentEvents,
  filterPresentationEventRows,
  isAgentEventKind,
  isAgentEventVisibility,
  type WorkspaceEventLogRow,
} from "../src/lib/workspace-event-log.ts";
import type { AgentEvent } from "../src/lib/workspace-demo-events.ts";

const baseEvent = {
  workspaceId: "workspace_undeniable_demo",
  taskId: "task_competitive_intel_demo",
  runId: "run_competitive_intel_demo",
  createdAt: "2026-05-28T00:00:00.000Z",
};

const replayEvents: AgentEvent[] = [
  {
    ...baseEvent,
    id: "evt_001",
    kind: "message.complete",
    visibility: "presentation",
    messageId: "msg_user",
    role: "user",
    content: "Pull a competitive intel report.",
  },
  {
    ...baseEvent,
    id: "evt_002",
    kind: "tool.call",
    visibility: "internal",
    toolName: "librarian.search",
    label: "Search competitor memory",
    inputSummary: "Query existing market notes.",
  },
  {
    ...baseEvent,
    id: "evt_003",
    kind: "tool.result",
    visibility: "internal",
    toolName: "librarian.search",
    label: "Memory references found",
    resultSummary: "Found positioning notes.",
  },
  {
    ...baseEvent,
    id: "evt_004",
    kind: "message.delta",
    visibility: "presentation",
    messageId: "msg_assistant",
    role: "assistant",
    delta: "Done.",
  },
  {
    ...baseEvent,
    id: "evt_005",
    kind: "run.phase",
    visibility: "presentation",
    phase: {
      id: "run_competitive_intel_demo:critic_check",
      name: "critic_check",
      title: "Critic check",
      status: "complete",
      summary: "Critic passed.",
      checked: ["Source labels", "Path leaks"],
      sourceCategories: ["librarian-report"],
      qa: { passed: true, issues: ["No critic issues found."], revised: false },
      finalAnswer: null,
      nextAction: "Check source excerpts.",
    },
  },
  {
    ...baseEvent,
    id: "evt_006",
    kind: "artifact.created",
    visibility: "presentation",
    artifact: {
      id: "artifact_ricky_handover_draft",
      type: "markdown",
      title: "Ricky pay structure handover draft",
      subtitle: "Atlas / mastra / markdown draft",
      preview: "A local markdown handover draft.",
    },
  },
  {
    ...baseEvent,
    id: "evt_007",
    kind: "task.step",
    visibility: "presentation",
    step: {
      id: "step_market_scan",
      title: "Scan competitor positioning",
      status: "complete",
      summary: "Mapped seven agencies.",
    },
  },
  {
    ...baseEvent,
    id: "evt_008",
    kind: "task.complete",
    visibility: "presentation",
    task: {
      id: "task_competitive_intel_demo",
      title: "Compile competitive intelligence report",
      status: "complete",
      completedSteps: 1,
      totalSteps: 1,
      steps: [
        {
          id: "step_market_scan",
          title: "Scan competitor positioning",
          status: "complete",
          summary: "Mapped seven agencies.",
        },
      ],
    },
  },
  {
    ...baseEvent,
    id: "evt_009",
    kind: "error",
    visibility: "internal",
    message: "Recoverable local adapter error.",
    recoverable: true,
  },
];

test("event kind and visibility validation accepts only the P1 contract", () => {
  assert.equal(isAgentEventKind("message.delta"), true);
  assert.equal(isAgentEventKind("artifact.created"), true);
  assert.equal(isAgentEventKind("message.started"), false);

  assert.equal(isAgentEventVisibility("internal"), true);
  assert.equal(isAgentEventVisibility("presentation"), true);
  assert.equal(isAgentEventVisibility("public"), false);
});

test("AgentEvent maps to DB insert shape and back without losing the contract", () => {
  for (const event of replayEvents) {
    const insert = agentEventToDbInsert(event);

    assert.equal(insert.id, event.id);
    assert.equal(insert.workspace_id, event.workspaceId);
    assert.equal(insert.task_id, event.taskId);
    assert.equal(insert.run_id, event.runId);
    assert.equal(insert.kind, event.kind);
    assert.equal(insert.visibility, event.visibility);
    assert.equal(insert.created_at, event.createdAt);

    const roundTripped = dbRowToAgentEvent(insert);
    assert.deepEqual(roundTripped, event);
  }
});

test("DB row to AgentEvent rejects unsupported kind and invalid visibility pairing", () => {
  const event = replayEvents.find((candidate) => candidate.kind === "tool.call");
  assert.ok(event);

  const insert = agentEventToDbInsert(event);
  assert.throws(
    () => dbRowToAgentEvent({ ...insert, kind: "tool.progress" }),
    /Unsupported workspace event kind/,
  );
  assert.throws(
    () => dbRowToAgentEvent({ ...insert, visibility: "presentation" }),
    /tool\.call events must be internal/,
  );
});

test("presentation filtering keeps UI-visible events out of internal tool chatter", () => {
  const events = replayEvents;
  const presentationEvents = filterPresentationAgentEvents(events);

  assert.ok(presentationEvents.length > 0);
  assert.equal(presentationEvents.every((event) => event.visibility === "presentation"), true);
  assert.equal(presentationEvents.some((event) => event.kind === "tool.call" || event.kind === "tool.result"), false);

  const rows: WorkspaceEventLogRow[] = events.map(agentEventToDbInsert);
  const presentationRows = filterPresentationEventRows(rows);

  assert.deepEqual(
    presentationRows.map((row) => row.id),
    presentationEvents.map((event) => event.id),
  );
});

test("rehydration query defaults to presentation-only replay order", () => {
  assert.deepEqual(
    buildWorkspaceEventReplayQuery({
      workspaceId: "workspace_undeniable_demo",
      taskId: "task_competitive_intel_demo",
      limit: 250,
    }),
    {
      table: "events",
      select: "id,workspace_id,task_id,run_id,kind,visibility,payload,created_at",
      filters: [
        { column: "workspace_id", operator: "eq", value: "workspace_undeniable_demo" },
        { column: "task_id", operator: "eq", value: "task_competitive_intel_demo" },
        { column: "visibility", operator: "eq", value: "presentation" },
      ],
      order: [
        { column: "created_at", ascending: true },
        { column: "id", ascending: true },
      ],
      limit: 250,
    },
  );
});

test("rehydration query can include internal rows for Inspector-only recovery", () => {
  const query = buildWorkspaceEventReplayQuery({
    workspaceId: "workspace_undeniable_demo",
    runId: "run_competitive_intel_demo",
    presentationOnly: false,
  });

  assert.equal(query.filters.some((filter) => filter.column === "visibility"), false);
  assert.deepEqual(query.filters, [
    { column: "workspace_id", operator: "eq", value: "workspace_undeniable_demo" },
    { column: "run_id", operator: "eq", value: "run_competitive_intel_demo" },
  ]);
});

test("rehydration query rejects unsafe empty identifiers and runaway limits", () => {
  assert.throws(() => buildWorkspaceEventReplayQuery({ workspaceId: "" }), /workspaceId/);
  assert.throws(() => buildWorkspaceEventReplayQuery({ workspaceId: "workspace", limit: 0 }), /limit/);
  assert.throws(() => buildWorkspaceEventReplayQuery({ workspaceId: "workspace", limit: 1001 }), /limit/);
});

test("mapping rejects malformed payloads before they reach the renderer", () => {
  const completeEvent = replayEvents.find(
    (candidate): candidate is Extract<AgentEvent, { kind: "message.complete" }> =>
      candidate.kind === "message.complete",
  );
  assert.ok(completeEvent);

  const row = agentEventToDbInsert(completeEvent);
  assert.throws(
    () => dbRowToAgentEvent({ ...row, payload: { ...row.payload, content: 123 } }),
    /message\.complete\.content must be a string/,
  );
});
