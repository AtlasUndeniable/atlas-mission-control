/**
 * Read-only projection tests for Workspace artifact/project/collection control metadata.
 * Uses only temporary fixture files; no exports, queues, logs, or real files are mutated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function projectionOptions(root: string, fixtureFallbackCount = 0) {
  return {
    root,
    metadataRoots: [join(root, "archives")],
    exportRoots: [join(root, "archives"), join(root, "exports")],
    deliveryLedgerPath: join(root, "artifact-deliveries.jsonl"),
    fixtureFallbackCount,
    validators,
  };
}

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
    const projection = await getWorkspaceArtifactControlProjection(projectionOptions(root));

    assert.deepEqual(projection.records.projects, []);
    assert.deepEqual(projection.records.collections, []);
    assert.deepEqual(projection.records.artifacts, []);
    assert.equal(projection.counts.totalValidRecords, 0);
    assert.equal(projection.counts.totalInvalidRecords, 0);
    assert.equal(projection.counts.sourcesPresent, 0);
    assert.equal(projection.counts.sourcesMissing, 3);
    assert.equal(projection.discovery.counts.realMetadataRecordsFound, 0);
  });
});

test("artifact control projection reports fixture fallback count without reading fixtures", async () => {
  await withTempRoot(async (root) => {
    const projection = await getWorkspaceArtifactControlProjection(projectionOptions(root, workspaceArtifactControlFixtures.artifacts.length));

    assert.equal(projection.records.artifacts.length, 0);
    assert.equal(projection.discovery.counts.fixtureFallbackCount, workspaceArtifactControlFixtures.artifacts.length);
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

    const projection = await getWorkspaceArtifactControlProjection(projectionOptions(root));

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

    const projection = await getWorkspaceArtifactControlProjection(projectionOptions(root));

    assert.equal(projection.records.artifacts.length, 1);
    assert.equal(projection.counts.totalValidRecords, 1);
    assert.equal(projection.counts.totalInvalidRecords, 2);
    assert.match(projection.sources.artifacts.errors.map((error) => error.message).join("\n"), /WorkspaceArtifact\.status/);
  });
});

async function writeRealArtifactPackage(root: string, options?: {
  folder?: string;
  deliveryId?: string;
  artifactId?: string;
  missingPdf?: boolean;
}) {
  const archiveDir = join(root, "archives", options?.folder ?? "undeniable-os/call-archives/example/example-package");
  await mkdir(archiveDir, { recursive: true });
  const artifactStem = options?.artifactId ?? "example-call-archive";
  const pdfPath = join(archiveDir, `${artifactStem}.pdf`);
  const mdPath = join(archiveDir, `${artifactStem}.md`);
  const metadataPath = join(archiveDir, `${artifactStem}.metadata.json`);
  if (!options?.missingPdf) await writeFile(pdfPath, "pdf");
  await writeFile(mdPath, "# archive");
  await writeFile(metadataPath, JSON.stringify({
    artifactId: artifactStem,
    projectId: "undeniable-os",
    collectionId: "call-archives",
    personClientId: "example-person",
    title: "Example call archive",
    requestedBy: "Rhys",
    outputPaths: {
      pdf: pdfPath,
      markdown: mdPath,
      metadata: metadataPath,
    },
    status: "generated_pending_review",
    workspaceProjection: { ready: true },
    sourceInclusionPolicy: "Fixture metadata sidecar for read-only projection tests.",
    deliveryLedger: { deliveryId: options?.deliveryId ?? "art_test_delivery" },
  }));
  await writeFile(join(root, "artifact-deliveries.jsonl"), JSON.stringify({
    eventId: "event_test",
    eventType: "artifact_created",
    deliveryId: options?.deliveryId ?? "art_test_delivery",
    artifactPaths: [pdfPath, mdPath, metadataPath],
    title: "Example call archive",
    requestedBy: "Rhys",
    source: `workspace-controlled:${artifactStem}`,
    artifactCreatedAt: "2026-05-25T04:20:05.492Z",
  }));
  return { archiveDir, pdfPath, mdPath, metadataPath };
}

test("artifact control projection normalises valid real metadata sidecars", async () => {
  await withTempRoot(async (root) => {
    await writeRealArtifactPackage(root);

    const projection = await getWorkspaceArtifactControlProjection(projectionOptions(root));

    assert.equal(projection.discovery.metadataSidecars.validRecordCount, 1);
    assert.equal(projection.discovery.counts.realMetadataRecordsFound, 1);
    assert.equal(projection.discovery.counts.exportFilesMatched, 2);
    assert.equal(projection.records.projects.some((project) => project.id === "project_undeniable_os"), true);
    assert.equal(projection.records.collections.some((collection) => collection.id === "collection_call_archives"), true);
    assert.equal(projection.records.artifacts[0].artifactId, "art_test_delivery");
    assert.equal(projection.records.artifacts[0].collectionId, "collection_call_archives");
  });
});

test("artifact control projection reports missing output file paths", async () => {
  await withTempRoot(async (root) => {
    await writeRealArtifactPackage(root, { missingPdf: true });

    const projection = await getWorkspaceArtifactControlProjection(projectionOptions(root));

    assert.equal(projection.records.artifacts.length, 1);
    assert.equal(projection.discovery.counts.missingSidecars, 1);
  });
});

test("artifact control projection reports orphan exports without sidecars", async () => {
  await withTempRoot(async (root) => {
    const exportDir = join(root, "exports");
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, "orphan.pdf"), "pdf");

    const projection = await getWorkspaceArtifactControlProjection(projectionOptions(root));

    assert.equal(projection.discovery.counts.realMetadataRecordsFound, 0);
    assert.equal(projection.discovery.counts.orphanExports, 1);
  });
});

test("artifact control projection dedupes duplicate artifact ids and reports ambiguity", async () => {
  await withTempRoot(async (root) => {
    await writeRealArtifactPackage(root, { folder: "a", deliveryId: "art_duplicate", artifactId: "duplicate-a" });
    await writeRealArtifactPackage(root, { folder: "b", deliveryId: "art_duplicate", artifactId: "duplicate-b" });

    const projection = await getWorkspaceArtifactControlProjection(projectionOptions(root));

    assert.equal(projection.discovery.counts.duplicateArtifactIds, 1);
    assert.equal(projection.discovery.counts.ambiguousArtifactIds, 1);
    assert.equal(projection.records.artifacts.filter((artifact) => artifact.artifactId === "art_duplicate").length, 1);
  });
});
