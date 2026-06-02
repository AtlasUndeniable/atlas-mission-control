/**
 * P6c read-only Workspace agent tool contract tests.
 * Uses temp fixtures only; no Slack/OpenClaw/Monday/Typeform/Supabase/browser/write tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  WORKSPACE_AGENT_TOOL_NAMES,
  WORKSPACE_AGENT_TOOL_SCHEMAS,
  createWorkspaceAgentToolEvents,
  executeWorkspaceAgentTool,
  prepareWorkspaceAgentToolExecutions,
  validateWorkspaceAgentToolInput,
} from "../src/lib/workspace-agent-tools.ts";
import type { WorkspaceReferenceResolverOptions } from "../src/lib/workspace-reference-resolver.ts";

async function fixtureRoots(): Promise<{
  root: string;
  referenceOptions: WorkspaceReferenceResolverOptions;
  artifactControlRoot: string;
  artifactMetadataRoot: string;
  artifactExportRoot: string;
  workspaceDemoArtifactRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-agent-tools-"));
  const contextPacksRoot = join(root, "librarian-context-packs");
  const reportsRoot = join(root, "librarian-reports");
  const reviewQueueRoot = join(root, "librarian-review-queue");
  const stateCurrentPath = join(root, "state-current.md");
  const artifactControlRoot = join(root, "artifact-control");
  const artifactMetadataRoot = join(root, "archives");
  const artifactExportRoot = join(root, "exports");
  const workspaceDemoArtifactRoot = join(root, "workspace-demo-artifacts");
  await Promise.all([
    mkdir(contextPacksRoot, { recursive: true }),
    mkdir(reportsRoot, { recursive: true }),
    mkdir(reviewQueueRoot, { recursive: true }),
    mkdir(artifactControlRoot, { recursive: true }),
    mkdir(artifactMetadataRoot, { recursive: true }),
    mkdir(artifactExportRoot, { recursive: true }),
    mkdir(workspaceDemoArtifactRoot, { recursive: true }),
  ]);
  return {
    root,
    referenceOptions: {
      contextPacksRoot,
      reportsRoot,
      reviewQueueRoot,
      stateCurrentPath,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
    },
    artifactControlRoot,
    artifactMetadataRoot,
    artifactExportRoot,
    workspaceDemoArtifactRoot,
  };
}

test("tool schemas are read-only and validate expected inputs", () => {
  assert.deepEqual(WORKSPACE_AGENT_TOOL_NAMES, [
    "search_memory",
    "find_artifact",
    "get_reference_packet",
    "summarize_calls",
  ]);
  assert.equal(Object.values(WORKSPACE_AGENT_TOOL_SCHEMAS).every((schema) => schema.readOnly), true);
  assert.equal(Object.keys(WORKSPACE_AGENT_TOOL_SCHEMAS).some((name) => /write|send|mutate|browser|web|slack|monday|typeform|supabase/i.test(name)), false);

  assert.equal(validateWorkspaceAgentToolInput("search_memory", { query: "Ricky", limit: 3 }).ok, true);
  assert.equal(validateWorkspaceAgentToolInput("find_artifact", { query: "latest Ricky", type: "markdown" }).ok, true);
  assert.equal(validateWorkspaceAgentToolInput("get_reference_packet", { prompt: "Ricky pay", project: "Undeniable", room: "workspace-demo" }).ok, true);
  assert.equal(validateWorkspaceAgentToolInput("summarize_calls", { query: "recent calls" }).ok, true);
  assert.equal(validateWorkspaceAgentToolInput("search_memory", { query: "", limit: 99 }).ok, false);
});

test("search_memory returns safe redacted handles and no local paths", async () => {
  const fixtures = await fixtureRoots();
  try {
    await writeFile(join(fixtures.referenceOptions.reportsRoot!, "ricky-calder-source-match.md"), [
      "# Ricky Calder Source Match",
      "Ricky Calder coach hire pay model handover notes mention clearer bands.",
      `Source path: ${join(fixtures.root, "private", "ricky-call.md")}`,
    ].join("\n"));

    const execution = await executeWorkspaceAgentTool("search_memory", {
      query: "Ricky Calder pay handover",
      project: "Undeniable",
      room: "workspace-demo",
      limit: 5,
    }, { referenceOptions: fixtures.referenceOptions });

    assert.equal(execution.output.tool, "search_memory");
    assert.equal(execution.output.coverage, "matched");
    assert.ok(execution.output.results.some((result) => result.handle.includes("ricky-calder-source-match")));
    assert.doesNotMatch(JSON.stringify(execution.output), /\/Users\/atlasai|\/private|atlas-workspace-agent-tools/);
    assert.ok(execution.output.sourceRootsUsed.includes("librarian-reports"));
    assert.equal(execution.output.audit.mutationsAllowed, false);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("find_artifact returns safe workspace-demo artifact handles without mutating files", async () => {
  const fixtures = await fixtureRoots();
  try {
    const artifactId = "artifact_demo_ricky_pay_handover_abc123";
    await writeFile(join(fixtures.workspaceDemoArtifactRoot, `${artifactId}.md`), [
      "# Ricky Calder pay structure handover",
      "Draft notes for coach hire pay bands and pyramid structure.",
    ].join("\n"));
    await writeFile(join(fixtures.workspaceDemoArtifactRoot, `${artifactId}.metadata.json`), JSON.stringify({
      id: artifactId,
      title: "Ricky Calder pay structure handover",
      type: "markdown",
      createdAt: "2026-06-01T00:00:00.000Z",
      taskTitle: "Ricky Calder pay structure handover",
      runtimeProvider: "mock",
      requestedFormat: "handover",
      intentReason: "Handover deliverable requested.",
      localPath: join(fixtures.workspaceDemoArtifactRoot, `${artifactId}.md`),
      metadataPath: join(fixtures.workspaceDemoArtifactRoot, `${artifactId}.metadata.json`),
      userFacingName: "Ricky Calder pay structure handover draft",
    }));
    const before = (await readdir(fixtures.workspaceDemoArtifactRoot)).sort();

    const execution = await executeWorkspaceAgentTool("find_artifact", {
      query: "Find the latest Ricky artifact",
      project: "Undeniable",
      room: "workspace-demo",
    }, {
      artifactControlRoot: fixtures.artifactControlRoot,
      artifactMetadataRoots: [fixtures.artifactMetadataRoot],
      artifactExportRoots: [fixtures.artifactExportRoot],
      workspaceDemoArtifactRoot: fixtures.workspaceDemoArtifactRoot,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
    });
    const after = (await readdir(fixtures.workspaceDemoArtifactRoot)).sort();

    assert.deepEqual(after, before);
    assert.equal(execution.output.tool, "find_artifact");
    assert.equal(execution.output.coverage, "matched");
    assert.equal(execution.output.artifacts[0]?.handle, artifactId);
    assert.equal(execution.output.artifacts[0]?.source, "workspace-demo-artifact");
    assert.doesNotMatch(JSON.stringify(execution.output), /\/Users\/atlasai|atlas-workspace-agent-tools|localPath|metadataPath/);
    assert.equal(execution.output.audit.readOnly, true);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("summarize_calls reports thin coverage honestly when call references are limited", async () => {
  const fixtures = await fixtureRoots();
  try {
    await writeFile(join(fixtures.referenceOptions.reportsRoot!, "daily-delta-2026-06-01.md"), [
      "# Daily Delta 2026-06-01",
      "Recent calls trend toward clearer handovers and tighter pricing language.",
      "Only summary notes are available here; full transcript coverage was not run.",
    ].join("\n"));

    const execution = await executeWorkspaceAgentTool("summarize_calls", {
      query: "What are the top 5 trends from recent calls?",
      project: "Undeniable",
      room: "workspace-demo",
    }, { referenceOptions: fixtures.referenceOptions });

    assert.equal(execution.output.tool, "summarize_calls");
    assert.equal(execution.output.coverage, "thin");
    assert.match(execution.output.limitation, /Limited call\/context references/i);
    assert.ok(execution.output.trends.length >= 1);
    assert.doesNotMatch(JSON.stringify(execution.output), /full transcript recall|\/Users\/atlasai|atlas-workspace-agent-tools/);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("tool calls and results are internal AgentEvents with safe summaries", async () => {
  const fixtures = await fixtureRoots();
  try {
    const execution = await executeWorkspaceAgentTool("get_reference_packet", {
      prompt: "Give me 10 content ideas for next week.",
      project: "Undeniable",
      room: "workspace-demo",
    }, { referenceOptions: fixtures.referenceOptions });
    let id = 0;
    const [callEvent, resultEvent] = createWorkspaceAgentToolEvents({
      workspaceId: "workspace_undeniable_demo",
      taskId: "task_test",
      runId: "run_test",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      nextId: (prefix) => `${prefix}_${id++}`,
    }, execution);

    assert.equal(callEvent.kind, "tool.call");
    assert.equal(resultEvent.kind, "tool.result");
    assert.equal(callEvent.visibility, "internal");
    assert.equal(resultEvent.visibility, "internal");
    assert.doesNotMatch(`${callEvent.inputSummary}\n${resultEvent.resultSummary}`, /\/Users\/atlasai|atlas-workspace-agent-tools/);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("prompt planner runs expected read-only tools without creating artifact intent", async () => {
  const fixtures = await fixtureRoots();
  try {
    const trendTools = await prepareWorkspaceAgentToolExecutions({
      prompt: "What are the top 5 trends from recent calls?",
    }, { referenceOptions: fixtures.referenceOptions });
    assert.deepEqual(trendTools.map((execution) => execution.toolName), [
      "get_reference_packet",
      "summarize_calls",
      "search_memory",
    ]);

    const artifactTools = await prepareWorkspaceAgentToolExecutions({
      prompt: "Find the latest Ricky artifact.",
    }, {
      referenceOptions: fixtures.referenceOptions,
      artifactControlRoot: fixtures.artifactControlRoot,
      artifactMetadataRoots: [fixtures.artifactMetadataRoot],
      artifactExportRoots: [fixtures.artifactExportRoot],
      workspaceDemoArtifactRoot: fixtures.workspaceDemoArtifactRoot,
    });
    assert.deepEqual(artifactTools.map((execution) => execution.toolName), [
      "get_reference_packet",
      "find_artifact",
    ]);

    const contentIdeaTools = await prepareWorkspaceAgentToolExecutions({
      prompt: "Give me 10 content ideas for next week.",
    }, { referenceOptions: fixtures.referenceOptions });
    assert.deepEqual(contentIdeaTools.map((execution) => execution.toolName), ["get_reference_packet"]);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

