/**
 * P7a local draft artifact tests.
 * Uses temp roots only; no external sends or existing artifact archive mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  maybeWriteWorkspaceDraftArtifact,
  shouldCreateWorkspaceDraftArtifact,
} from "../src/lib/workspace-draft-artifacts.ts";

test("draft artifact intent is document-style only", () => {
  assert.equal(shouldCreateWorkspaceDraftArtifact({
    prompt: "Can you create the Ricky pay structure handover doc?",
    taskTitle: "Ricky handover",
  }), true);
  assert.equal(shouldCreateWorkspaceDraftArtifact({
    prompt: "Give me 10 ideas for next week.",
    taskTitle: "Ideas",
  }), false);
});

test("draft artifact writer saves markdown and metadata under caller root", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-draft-artifacts-"));
  try {
    const result = await maybeWriteWorkspaceDraftArtifact({
      prompt: "Can you create the Ricky pay structure handover doc?",
      content: "## Ricky pay model\n\nUse clearer bands.",
      taskTitle: "Ricky pay structure handover",
      runtimeProvider: "mastra",
      runId: "run_test",
      taskId: "task_test",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      root,
    });

    assert.ok(result);
    assert.equal(result.artifact.type, "markdown");
    assert.equal(result.metadata.type, "markdown");
    assert.equal(result.metadata.runtimeProvider, "mastra");
    assert.match(result.metadata.localPath, new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.metadata.metadataPath, /\.metadata\.json$/);
    assert.doesNotMatch(result.artifact.title, /\/Users\/atlasai|\.openclaw/);

    const markdown = await readFile(result.metadata.localPath, "utf8");
    const metadataJson = JSON.parse(await readFile(result.metadata.metadataPath, "utf8")) as {
      localPath?: string;
      userFacingName?: string;
    };
    assert.match(markdown, /# Ricky pay structure handover/);
    assert.match(markdown, /Delivery: local draft only; no external send performed/);
    assert.match(markdown, /Use clearer bands/);
    assert.equal(metadataJson.localPath, result.metadata.localPath);
    assert.equal(metadataJson.userFacingName, "Ricky pay structure handover draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
