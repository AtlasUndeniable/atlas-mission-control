/**
 * Golden Workspace beta regressions from Rhys testing.
 * These tests lock user-visible behavior, not broad product features.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildBlockedCapabilityAnswer,
  routeWorkspaceCapability,
} from "../src/lib/workspace-capability-router.ts";
import {
  detectWorkspaceDraftArtifactIntent,
  maybeWriteWorkspaceDraftArtifact,
} from "../src/lib/workspace-draft-artifacts.ts";
import {
  TerminalLocalRuntimeAdapter,
  workspaceDemoRuntimeIds,
} from "../src/lib/workspace-local-runtime-adapter.ts";
import {
  buildWorkspaceLocalSessionThread,
} from "../src/lib/workspace-local-sessions.ts";
import type { AgentEvent, Task, TaskStep } from "../src/lib/workspace-demo-events.ts";
import type { WorkspaceReferencePacket } from "../src/lib/workspace-reference-resolver.ts";

async function collectGoldenEvents(options: {
  prompt: string;
  title: string;
  referencePacket?: WorkspaceReferencePacket;
  draftArtifactRoot?: string;
}): Promise<AgentEvent[]> {
  const adapter = new TerminalLocalRuntimeAdapter({ forcedMode: "mock" });
  const events: AgentEvent[] = [];
  let id = 0;
  const transientRoot = options.draftArtifactRoot ? null : await mkdtemp(join(tmpdir(), "atlas-workspace-golden-artifacts-"));
  try {
    for await (const event of adapter.runTask(
      { prompt: options.prompt, title: options.title },
      {
        workspaceId: workspaceDemoRuntimeIds.workspaceId,
        taskId: workspaceDemoRuntimeIds.taskId,
        runId: "run_golden_beta",
        cwd: "/tmp",
        env: {},
        now: () => new Date("2026-06-07T00:00:00.000Z"),
        idFactory: () => String(id++).padStart(3, "0"),
        commandRunner: async () => ({
          ok: false,
          stdout: "",
          stderr: "The golden harness must not invoke a real local runner.",
          exitCode: 1,
          timedOut: false,
        }),
        referenceResolver: async () => options.referencePacket ?? matchedCallReferencePacket(),
        draftArtifactRoot: options.draftArtifactRoot ?? transientRoot ?? undefined,
      },
    )) {
      events.push(event);
    }
    return events;
  } finally {
    if (transientRoot) await rm(transientRoot, { recursive: true, force: true });
  }
}

function assistantText(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { kind: "message.complete" }> => event.kind === "message.complete" && event.role === "assistant")
    .map((event) => event.content)
    .join("\n");
}

function runPhases(events: AgentEvent[]): Array<Extract<AgentEvent, { kind: "run.phase" }>["phase"]> {
  return events
    .filter((event): event is Extract<AgentEvent, { kind: "run.phase" }> => event.kind === "run.phase")
    .map((event) => event.phase);
}

function matchedCallReferencePacket(): WorkspaceReferencePacket {
  return {
    resolvedAt: "2026-06-07T00:00:00.000Z",
    coverage: "matched",
    rootsRead: [],
    references: [
      {
        handle: "fireflies-pete-rhys",
        title: "Pete Morel x Rhys call",
        sourceType: "call-transcript",
        sourcePath: "/Users/atlasai/.openclaw/workspace/memory/PARA/Resources/fireflies/pete-rhys.md",
        pathSummary: "fireflies/pete-rhys.md",
        excerpt: "Pete mentioned the average sales wave around $250/week pricing and client capacity constraints.",
        confidence: "high",
        score: 88,
        matchedTerms: ["calls", "250", "clients"],
      },
    ],
    guidance: ["Use call source labels and keep coverage visible."],
    userFacingSummary: "1 call transcript reference resolved.",
    internalSummary: "references=1; coverage=matched; path_summaries=fireflies/pete-rhys.md",
  };
}

function taskCompleteEvent(index: number, runId: string, title: string): AgentEvent {
  const step: TaskStep = {
    id: `step_${index}`,
    title: "Complete run",
    status: "complete",
  };
  const task: Task = {
    id: "task_workspace_session",
    title,
    status: "complete",
    completedSteps: 1,
    totalSteps: 1,
    steps: [step],
  };
  return {
    id: `evt_${index}`,
    workspaceId: workspaceDemoRuntimeIds.workspaceId,
    taskId: workspaceDemoRuntimeIds.taskId,
    runId,
    createdAt: new Date(Date.UTC(2026, 5, 7, 0, index, 0)).toISOString(),
    kind: "task.complete",
    visibility: "presentation",
    task,
  };
}

test("golden: Rhys $10k math correction is enforced before final answer", async () => {
  const events = await collectGoldenEvents({
    prompt: "40 clients x $250/week is not $10k/month. With available knowledge, what is the real model?",
    title: "Rhys model correction",
  });
  const phases = runPhases(events);
  const final = phases.find((phase) => phase.name === "final");

  assert.equal(events.some((event) => event.kind === "artifact.created"), false);
  assert.equal(phases.find((phase) => phase.name === "critic_check")?.qa?.passed, true);
  assert.match(final?.finalAnswer ?? assistantText(events), /40 clients x \$250\/week = \$10,000\/week/);
  assert.match(final?.finalAnswer ?? assistantText(events), /\$43,300\/month/);
  assert.doesNotMatch(assistantText(events), /\$10,000\/month\.?\s*$/i);
});

test("golden: broad strategic asset prompt uses analysis route and creates no fake artifact", async () => {
  const prompt = "I want to create an asset I can use that has predictable strategies and models to make their first 10k. Use all learned knowledge, call logs, playbooks, and pdf to construct a custom strategic doc for someone to make their first 10k month as an online coach.";
  const route = routeWorkspaceCapability({ prompt, title: "First 10k strategy analysis" });
  const intent = detectWorkspaceDraftArtifactIntent({ prompt, taskTitle: "First 10k strategy analysis" });
  const events = await collectGoldenEvents({ prompt, title: "First 10k strategy analysis" });

  assert.equal(route.capabilityId, "call-memory-answer");
  assert.equal(route.artifactIntent.shouldCreate, false);
  assert.equal(intent.shouldCreate, false);
  assert.equal(events.some((event) => event.kind === "artifact.created"), false);
  assert.match(assistantText(events), /## What I checked/);
  assert.match(assistantText(events), /## Confidence \/ coverage/);
});

test("golden: generic branded PDF request is blocked and does not create an artifact card", async () => {
  const prompt = "Can you do the PDF with proper Undeniable branding and assets?";
  const route = routeWorkspaceCapability({ prompt, title: "Undeniable branded PDF" });
  const answer = buildBlockedCapabilityAnswer(route);
  const events = await collectGoldenEvents({ prompt, title: "Undeniable branded PDF" });
  const observe = runPhases(events).find((phase) => phase.name === "observe");

  assert.equal(route.capabilityId, "arbitrary-branded-pdf-generation");
  assert.equal(route.allowed, false);
  assert.equal(observe?.capabilityPlan?.allowed, false);
  assert.equal(events.some((event) => event.kind === "artifact.created"), false);
  assert.match(answer, /Arbitrary branded PDF generation is blocked/);
  assert.match(assistantText(events), /Arbitrary branded PDF generation is blocked/);
  assert.doesNotMatch(assistantText(events), /PDF draft saved|Download PDF|localPath|\/Users\/atlasai|\.openclaw/);
});

test("golden: supported Ricky PDF package route remains allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-golden-ricky-pdf-"));
  try {
    const prompt = "Update the Ricky Calder coach hire pay model handover and return it as a PDF.";
    const route = routeWorkspaceCapability({ prompt, title: "Ricky Calder pay structure handover" });
    const artifact = await maybeWriteWorkspaceDraftArtifact({
      prompt,
      content: "Use the accepted Ricky package.",
      taskTitle: "Ricky Calder pay structure handover",
      runtimeProvider: "mastra",
      runId: "run_golden_ricky_pdf",
      taskId: "task_golden_ricky_pdf",
      now: () => new Date("2026-06-07T00:00:00.000Z"),
      root,
    });

    assert.equal(route.capabilityId, "ricky-pdf-package-retrieval");
    assert.equal(route.allowed, true);
    assert.equal(artifact?.artifact.type, "pdf");
    assert.equal(artifact?.metadata.sourceWorkflow, "atlas-rhys-ricky-handover-archive");
    assert.equal(artifact?.metadata.requestedFormat, "pdf");
    assert.doesNotMatch(JSON.stringify(artifact?.artifact), /\/Users\/atlasai|\.openclaw/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("golden: Slack send remains blocked before runtime execution", async () => {
  const prompt = "Send this summary to Rhys in Slack.";
  const route = routeWorkspaceCapability({ prompt, title: "Slack send" });
  const events = await collectGoldenEvents({ prompt, title: "Slack send" });

  assert.equal(route.capabilityId, "slack-send");
  assert.equal(route.allowed, false);
  assert.equal(runPhases(events).find((phase) => phase.name === "observe")?.capabilityPlan?.capabilityId, "slack-send");
  assert.equal(events.some((event) => event.kind === "artifact.created"), false);
  assert.match(assistantText(events), /Slack send is blocked/);
});

test("golden: recent call memory prompt shows call route, source labels, and coverage", async () => {
  const events = await collectGoldenEvents({
    prompt: "With available knowledge, what are some topics from today's calls or recent memory?",
    title: "Recent call memory routing",
  });
  const phases = runPhases(events);
  const observe = phases.find((phase) => phase.name === "observe");
  const retrieve = phases.find((phase) => phase.name === "retrieve");
  const text = assistantText(events);

  assert.equal(observe?.capabilityPlan?.capabilityId, "recent-call-topic-retrieval");
  assert.equal(observe?.capabilityPlan?.skillId, "call-retrieval");
  assert.ok(retrieve?.sourceCategories.includes("call-transcript"));
  assert.match(text, /\[call-transcript: Pete Morel x Rhys call\]/);
  assert.match(text, /## Confidence \/ coverage/);
  assert.doesNotMatch(text, /\/Users\/atlasai|\.openclaw/);
});

test("golden: duplicate task chips collapse across repeated same-title session runs", () => {
  const thread = buildWorkspaceLocalSessionThread([
    taskCompleteEvent(1, "run_first", "Undeniable OS workspace session"),
    taskCompleteEvent(2, "run_second", "Undeniable OS workspace session"),
    taskCompleteEvent(3, "run_third", "Ricky Calder pay structure handover"),
    taskCompleteEvent(4, "run_fourth", "Ricky Calder pay structure handover"),
  ]);

  assert.deepEqual(thread.tasks.map((task) => task.id), [
    "run_second:task_workspace_session",
    "run_fourth:task_workspace_session",
  ]);
  assert.deepEqual(thread.tasks.map((task) => task.title), [
    "Undeniable OS workspace session",
    "Ricky Calder pay structure handover",
  ]);
});
