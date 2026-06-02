/**
 * Local runtime adapter tests.
 * No live CLI, network, Slack, Monday, Typeform, OpenClaw, Mastra, or Supabase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TerminalLocalRuntimeAdapter,
  isApprovedLocalCommand,
  selectLocalRunner,
  validateLocalRuntimeInput,
  workspaceDemoRuntimeIds,
  type TerminalCommandRequest,
} from "../src/lib/workspace-local-runtime-adapter.ts";
import {
  MastraAiSdkRuntimeAdapter,
  sanitizeMastraPresentationText,
} from "../src/lib/workspace-mastra-runtime-adapter.ts";
import {
  createWorkspaceRuntimeAdapter,
  resolveWorkspaceRuntimeProvider,
} from "../src/lib/workspace-runtime-provider.ts";
import { buildWorkspaceRuntimeContext } from "../src/lib/workspace-runtime-context.ts";
import {
  createEmptyWorkspaceReferencePacket,
  type WorkspaceReferencePacket,
} from "../src/lib/workspace-reference-resolver.ts";
import {
  demoRhysReadyStarterPrompt,
  demoRhysReadyTaskTitle,
  demoStarterPrompts,
  type AgentEvent,
} from "../src/lib/workspace-demo-events.ts";

function emptyReferencePacket(): WorkspaceReferencePacket {
  return createEmptyWorkspaceReferencePacket({
    prompt: "test prompt",
    workspaceId: workspaceDemoRuntimeIds.workspaceId,
    project: "Undeniable",
    room: "workspace-demo",
  }, { now: () => new Date("2026-06-01T00:00:00.000Z") });
}

async function collectEvents(adapter: TerminalLocalRuntimeAdapter, options: {
  env?: NodeJS.ProcessEnv;
  referencePacket?: WorkspaceReferencePacket;
  commandRunner?: (request: TerminalCommandRequest) => Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }>;
} = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let id = 0;
  for await (const event of adapter.runTask(
    {
      prompt: "Draft a local summary for the workspace demo",
      title: "Workspace local demo",
    },
    {
      workspaceId: workspaceDemoRuntimeIds.workspaceId,
      taskId: workspaceDemoRuntimeIds.taskId,
      runId: "run_test",
      cwd: "/tmp",
      env: options.env ?? {},
      now: () => new Date("2026-05-29T00:00:00.000Z"),
      idFactory: () => String(id++).padStart(3, "0"),
      commandRunner: options.commandRunner,
      referenceResolver: async () => options.referencePacket ?? emptyReferencePacket(),
    },
  )) {
    events.push(event);
  }
  return events;
}

async function collectRuntimeEvents(adapter: {
  runTask(input: { prompt: string; title?: string }, ctx: {
    workspaceId: string;
    taskId: string;
    runId?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    idFactory?: () => string;
  }): AsyncIterable<AgentEvent>;
}, options: { env?: NodeJS.ProcessEnv } = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let id = 0;
  for await (const event of adapter.runTask(
    {
      prompt: "Summarize the top 3 themes this workspace is built around.",
      title: "Runtime provider smoke",
    },
    {
      workspaceId: workspaceDemoRuntimeIds.workspaceId,
      taskId: workspaceDemoRuntimeIds.taskId,
      runId: "run_runtime_test",
      cwd: "/tmp",
      env: options.env ?? {},
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      idFactory: () => String(id++).padStart(3, "0"),
      referenceResolver: async () => emptyReferencePacket(),
    },
  )) {
    events.push(event);
  }
  return events;
}

test("local runtime input validation rejects blank or oversized prompts", () => {
  assert.throws(() => validateLocalRuntimeInput({ prompt: "  " }), /prompt is required/);
  assert.throws(() => validateLocalRuntimeInput({ prompt: "x".repeat(4_001) }), /4000 characters/);
  assert.deepEqual(validateLocalRuntimeInput({ prompt: "  hello  ", title: " Demo " }), {
    prompt: "hello",
    title: "Demo",
  });
});

test("local runner selection is safe mock by default and only approves known commands", async () => {
  assert.equal(isApprovedLocalCommand("codex"), true);
  assert.equal(isApprovedLocalCommand("claude"), true);
  assert.equal(isApprovedLocalCommand("bash"), false);

  const selection = await selectLocalRunner({ cwd: "/tmp", env: {} });
  assert.equal(selection.mode, "mock");
  assert.equal(selection.available, false);
  assert.equal(selection.command, null);
});

test("workspace runtime provider defaults to mock and gates local codex and mastra explicitly", () => {
  assert.equal(resolveWorkspaceRuntimeProvider({}), "mock");
  assert.equal(resolveWorkspaceRuntimeProvider({ ATLAS_WORKSPACE_DEMO_RUNTIME: "mock" }), "mock");
  assert.equal(resolveWorkspaceRuntimeProvider({ ATLAS_WORKSPACE_DEMO_RUNTIME: "local-codex" }), "local-codex");
  assert.equal(resolveWorkspaceRuntimeProvider({ ATLAS_WORKSPACE_DEMO_RUNTIME: "mastra" }), "mastra");
  assert.equal(resolveWorkspaceRuntimeProvider({ ATLAS_WORKSPACE_DEMO_RUNTIME: "unknown" }), "mock");

  assert.ok(createWorkspaceRuntimeAdapter("mock"));
  assert.ok(createWorkspaceRuntimeAdapter("local-codex"));
  assert.ok(createWorkspaceRuntimeAdapter("mastra"));
});

test("workspace runtime context carries Atlas visibility and execution boundaries", () => {
  const context = buildWorkspaceRuntimeContext({
    prompt: "Prepare the workspace for a readiness pass.",
    title: "Readiness pass",
  }, { provider: "local-codex" });

  assert.equal(context.workspace.id, workspaceDemoRuntimeIds.workspaceId);
  assert.equal(context.workspace.project, "Undeniable");
  assert.equal(context.workspace.room, "workspace-demo");
  assert.equal(context.user.role, "rhys_owner");
  assert.equal(context.user.view, "owner");
  assert.equal(context.provider, "local-codex");
  assert.ok(context.eventVisibilityRules.some((rule) => rule.includes("visibility=presentation")));
  assert.ok(context.eventVisibilityRules.some((rule) => rule.includes("visibility=internal")));
  assert.ok(context.prohibitedBehaviors.some((rule) => rule.includes("Slack")));
  assert.ok(context.prohibitedBehaviors.some((rule) => rule.includes("live Supabase")));
  assert.ok(context.prohibitedBehaviors.some((rule) => rule.includes("files")));
  assert.ok(context.librarianReferences.length >= 2);
  assert.ok(context.librarianReferences.some((reference) => reference.handle.includes("obsidian")));
  assert.equal(context.librarianReferences.every((reference) => reference.pathSummary.length < 140), true);
  assert.match(context.internalSummary, /librarian_handles=/);
  assert.match(context.systemPrompt, /Rhys owner view/);
  assert.match(context.systemPrompt, /presentation events/i);
  assert.match(context.systemPrompt, /Obsidian/);
  assert.match(context.systemPrompt, /do not print JSON, XML, AgentEvent tags/i);
  assert.match(context.systemPrompt, /No matching Workspace references were resolved/i);
  assert.doesNotMatch(context.systemPrompt, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
});

test("runtime context keeps reference paths internal while exposing safe excerpts", () => {
  const referencePacket: WorkspaceReferencePacket = {
    resolvedAt: "2026-06-01T00:00:00.000Z",
    coverage: "matched",
    rootsRead: [],
    references: [{
      handle: "ricky-calder-source-match",
      title: "Ricky Calder Source Match",
      sourceType: "librarian-report",
      sourcePath: "/Users/atlasai/.openclaw/workspace/tools/librarian-reports/ricky-calder-source-match.md",
      pathSummary: "librarian-reports/ricky-calder-source-match.md",
      excerpt: "Matched Ricky Calder call archive candidates with transcript availability.",
      updatedAt: "2026-06-01T00:00:00.000Z",
      confidence: "high",
      score: 80,
      matchedTerms: ["ricky", "calder"],
    }],
    guidance: ["Use only these resolved Workspace references for memory-backed claims."],
    userFacingSummary: "1 Workspace reference resolved.",
    internalSummary: "references=1; paths=/Users/atlasai/.openclaw/workspace/tools/librarian-reports/ricky-calder-source-match.md",
  };
  const context = buildWorkspaceRuntimeContext({
    prompt: "Update Ricky handover",
    title: "Ricky handover",
  }, { provider: "mastra", referencePacket });

  assert.match(context.systemPrompt, /Ricky Calder Source Match/);
  assert.match(context.systemPrompt, /Matched Ricky Calder call archive candidates/);
  assert.doesNotMatch(context.systemPrompt, /\/Users\/atlasai/);
  assert.match(context.internalSummary, /\/Users\/atlasai/);
});

test("Rhys-ready starter task is first and carries a handover title", () => {
  assert.equal(demoStarterPrompts[0], demoRhysReadyStarterPrompt);
  assert.equal(
    demoRhysReadyStarterPrompt,
    "Update the Ricky coach hire pay model handover with clearer bands and a pyramid structure.",
  );
  assert.equal(demoRhysReadyTaskTitle, "Ricky coach hire pay model handover");
});

test("Mastra presentation sanitizer removes event envelope narration", () => {
  const cleaned = sanitizeMastraPresentationText([
    "I'll help with the Ricky handover.",
    "<AgentEvent type=\"task.step\" visibility=\"internal\">Searching internal context</AgentEvent>",
    "<AgentEvent type=\"message.delta\" visibility=\"presentation\">Use clearer bands and a pyramid.</AgentEvent>",
    "```json",
    "{\"visibility\":\"internal\",\"provider\":\"anthropic\"}",
    "```",
  ].join("\n"));

  assert.match(cleaned, /Ricky handover/);
  assert.match(cleaned, /clearer bands and a pyramid/);
  assert.doesNotMatch(cleaned, /AgentEvent|task\.step|visibility|provider|anthropic|internal context/);
});

test("safe mock adapter streams presentation text and completes the task chip", async () => {
  const events = await collectEvents(new TerminalLocalRuntimeAdapter());

  const deltas = events.filter((event) => event.kind === "message.delta");
  const completions = events.filter((event) => event.kind === "message.complete");
  const artifacts = events.filter((event) => event.kind === "artifact.created");
  const taskComplete = events.find((event) => event.kind === "task.complete");

  assert.ok(deltas.length > 3);
  assert.equal(completions.length, 2);
  assert.equal(artifacts.length, 1);
  assert.equal(taskComplete?.kind, "task.complete");
  assert.equal(taskComplete?.task.status, "complete");
  assert.equal(taskComplete?.task.completedSteps, taskComplete?.task.totalSteps);
});

test("internal command details are internal only and presentation stream excludes them", async () => {
  const events = await collectEvents(new TerminalLocalRuntimeAdapter());
  const internalEvents = events.filter((event) => event.visibility === "internal");
  const presentationText = events
    .filter((event): event is Extract<AgentEvent, { kind: "message.delta" }> => event.kind === "message.delta")
    .map((event) => event.delta)
    .join("");

  assert.ok(internalEvents.some((event) => event.kind === "tool.call"));
  assert.ok(internalEvents.some((event) => event.kind === "tool.result"));
  assert.equal(internalEvents.every((event) => event.visibility === "internal"), true);
  assert.doesNotMatch(presentationText, /ATLAS_WORKSPACE_DEMO_LOCAL_RUNNER/);
  assert.doesNotMatch(presentationText, /codex exec|claude -p/);
});

test("approved CLI path uses injected runner only when explicitly selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-demo-runner-"));
  let calledWith: TerminalCommandRequest | null = null;
  try {
    const fakeCodex = join(root, "codex");
    await mkdir(root, { recursive: true });
    await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n");
    await chmod(fakeCodex, 0o755);

    const events = await collectEvents(new TerminalLocalRuntimeAdapter(), {
      env: {
        ATLAS_WORKSPACE_DEMO_LOCAL_RUNNER: "codex",
        ATLAS_CODEX_EXECUTABLE: fakeCodex,
        OPENAI_API_KEY: "must-not-reach-runner",
      },
      commandRunner: async (request) => {
        calledWith = request;
        return {
          ok: true,
          stdout: "CLI generated a concise local workspace answer.",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
    });

    assert.equal(calledWith?.command, fakeCodex);
    assert.deepEqual(calledWith?.args.slice(0, 2), ["exec", "--cd"]);
    assert.equal(calledWith?.env?.OPENAI_API_KEY, undefined);
    assert.match(calledWith?.input ?? "", /Project: Undeniable/);
    assert.match(calledWith?.input ?? "", /Rhys owner view/);
    assert.match(calledWith?.input ?? "", /Librarian context/);
    assert.match(calledWith?.input ?? "", /Obsidian/);
    assert.doesNotMatch(calledWith?.input ?? "", /OPENAI_API_KEY|ANTHROPIC_API_KEY/);
    assert.ok(events.some((event) => event.kind === "message.delta"));
    assert.ok(events.some((event) => event.kind === "artifact.created"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit real runner failure fails closed with command details internal only", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-demo-runner-"));
  try {
    const fakeCodex = join(root, "codex");
    await mkdir(root, { recursive: true });
    await writeFile(fakeCodex, "#!/bin/sh\nexit 1\n");
    await chmod(fakeCodex, 0o755);

    const events = await collectEvents(new TerminalLocalRuntimeAdapter(), {
      env: {
        ATLAS_WORKSPACE_DEMO_LOCAL_RUNNER: "codex",
        ATLAS_CODEX_EXECUTABLE: fakeCodex,
      },
      commandRunner: async () => ({
        ok: false,
        stdout: "",
        stderr: "simulated stderr with /tmp/internal/path",
        exitCode: 7,
        timedOut: false,
      }),
    });

    const presentationText = events
      .filter((event): event is Extract<AgentEvent, { kind: "message.delta" }> => event.kind === "message.delta")
      .map((event) => event.delta)
      .join("");
    const internalText = events
      .filter((event) => event.visibility === "internal")
      .map((event) => JSON.stringify(event))
      .join("\n");
    const taskComplete = events.find((event) => event.kind === "task.complete");

    assert.match(presentationText, /could not safely run/i);
    assert.doesNotMatch(presentationText, /simulated stderr|\/tmp\/internal\/path|exit_code=7|codex/);
    assert.match(internalText, /simulated stderr/);
    assert.match(internalText, /exit_code=7/);
    assert.equal(taskComplete?.kind, "task.complete");
    assert.equal(taskComplete?.task.status, "error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mastra ai sdk runtime fails closed when Claude env is missing", async () => {
  const events = await collectRuntimeEvents(new MastraAiSdkRuntimeAdapter(), { env: {} });
  const presentationText = events
    .filter((event): event is Extract<AgentEvent, { kind: "message.delta" }> => event.kind === "message.delta")
    .map((event) => event.delta)
    .join("");
  const internalText = events
    .filter((event) => event.visibility === "internal")
    .map((event) => JSON.stringify(event))
    .join("\n");
  const taskComplete = events.find((event) => event.kind === "task.complete");

  assert.match(presentationText, /could not safely start the Mastra AI runtime/i);
  assert.doesNotMatch(presentationText, /ANTHROPIC_API_KEY|provider=|claude/i);
  assert.match(internalText, /ANTHROPIC_API_KEY/);
  assert.match(internalText, /runtime\.mastra-ai-sdk/);
  assert.equal(taskComplete?.kind, "task.complete");
  assert.equal(taskComplete?.task.status, "error");
});
