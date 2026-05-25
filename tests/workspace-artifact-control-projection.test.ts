/**
 * Read-only projection tests for Workspace artifact/project/collection control metadata.
 * Uses only temporary fixture files; no exports, queues, logs, or real files are mutated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getWorkspaceArtifactControlProjection } from "../src/lib/workspace-artifact-control-projection.ts";
import { workspaceArtifactControlFixtures } from "../src/lib/workspace-contract-fixtures.ts";
import {
  validateArtifactCollection,
  validateWorkspaceArtifact,
  validateWorkspaceProject,
} from "../src/lib/workspace-contracts.ts";

const validators = {
  projects: validateWorkspaceProject,
  collections: validateArtifactCollection,
  artifacts: validateWorkspaceArtifact,
};

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-artifacts-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("artifact control projection returns empty arrays when sources are absent", async () => {
  await withTempRoot(async (root) => {
    const projection = await getWorkspaceArtifactControlProjection({ root, validators });

    assert.deepEqual(projection.records.projects, []);
    assert.deepEqual(projection.records.collections, []);
    assert.deepEqual(projection.records.artifacts, []);
    assert.equal(projection.counts.totalValidRecords, 0);
    assert.equal(projection.counts.totalInvalidRecords, 0);
    assert.equal(projection.counts.sourcesPresent, 0);
    assert.equal(projection.counts.sourcesMissing, 3);
  });
});

test("artifact control projection reads JSON and JSONL metadata", async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: workspaceArtifactControlFixtures.projects }));
    await writeFile(
      join(root, "collections.jsonl"),
      workspaceArtifactControlFixtures.collections.map((collection) => JSON.stringify(collection)).join("\n"),
    );
    await writeFile(join(root, "artifacts.json"), JSON.stringify(workspaceArtifactControlFixtures.artifacts));

    const projection = await getWorkspaceArtifactControlProjection({ root, validators });

    assert.equal(projection.counts.projects, workspaceArtifactControlFixtures.projects.length);
    assert.equal(projection.counts.collections, workspaceArtifactControlFixtures.collections.length);
    assert.equal(projection.counts.artifacts, workspaceArtifactControlFixtures.artifacts.length);
    assert.equal(projection.counts.totalInvalidRecords, 0);
    assert.equal(projection.sources.collections.present, true);
  });
});

test("artifact control projection reports invalid metadata without throwing", async () => {
  await withTempRoot(async (root) => {
    await writeFile(
      join(root, "artifacts.jsonl"),
      [
        JSON.stringify(workspaceArtifactControlFixtures.artifacts[0]),
        JSON.stringify({ ...workspaceArtifactControlFixtures.artifacts[1], status: "published" }),
        "{not json",
      ].join("\n"),
    );

    const projection = await getWorkspaceArtifactControlProjection({ root, validators });

    assert.equal(projection.records.artifacts.length, 1);
    assert.equal(projection.counts.totalValidRecords, 1);
    assert.equal(projection.counts.totalInvalidRecords, 2);
    assert.match(projection.sources.artifacts.errors.map((error) => error.message).join("\n"), /WorkspaceArtifact\.status/);
  });
});
