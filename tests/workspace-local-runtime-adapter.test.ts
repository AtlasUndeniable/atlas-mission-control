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
import type { AgentEvent } from "../src/lib/workspace-demo-events.ts";

async function collectEvents(adapter: TerminalLocalRuntimeAdapter, options: {
  env?: NodeJS.ProcessEnv;
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
    assert.ok(events.some((event) => event.kind === "message.delta"));
    assert.ok(events.some((event) => event.kind === "artifact.created"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
