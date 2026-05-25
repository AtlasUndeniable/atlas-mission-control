/**
 * Read-only projection tests for librarian output consumed by Atlas Workspace.
 * Tests use temp directories only; no memory notes, exports, reports, or queues are mutated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getWorkspaceMemoryMaintenanceProjection } from "../src/lib/workspace-memory-maintenance-projection.ts";

async function withTempRoots(fn: (roots: { reports: string; contextPacks: string; reviewQueue: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-librarian-"));
  const roots = {
    reports: join(root, "reports"),
    contextPacks: join(root, "context-packs"),
    reviewQueue: join(root, "review-queue"),
  };

  try {
    await fn(roots);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function projectionOptions(roots: { reports: string; contextPacks: string; reviewQueue: string }) {
  return {
    reportsDir: roots.reports,
    contextPacksDir: roots.contextPacks,
    reviewQueueDir: roots.reviewQueue,
  };
}

test("memory maintenance projection returns not_ready when librarian output directories are absent", async () => {
  await withTempRoots(async (roots) => {
    const projection = await getWorkspaceMemoryMaintenanceProjection(projectionOptions(roots));

    assert.equal(projection.status, "not_ready");
    assert.equal(projection.summary.notesScanned, 0);
    assert.equal(projection.summary.contextPacksGenerated, 0);
    assert.equal(projection.summary.reviewQueueItems, 0);
    assert.equal(projection.sources.memoryReports.present, false);
    assert.equal(projection.sources.reviewQueue.present, false);
  });
});

test("memory maintenance projection reads valid report summaries without exposing bodies", async () => {
  await withTempRoots(async (roots) => {
    await Promise.all([
      mkdir(roots.reports, { recursive: true }),
      mkdir(roots.contextPacks, { recursive: true }),
      mkdir(roots.reviewQueue, { recursive: true }),
    ]);
    await writeFile(join(roots.reports, "memory-maintenance-2026-05-24.json"), JSON.stringify({
      generatedAt: "2026-05-24T23:16:37.333Z",
      stats: {
        noteCount: 5755,
        brokenLinks: 761,
        orphanCount: 143,
      },
      structure: {
        weak: [{ id: "weak-1" }, { id: "weak-2" }],
      },
      hubs: [{ id: "hub-1" }],
    }));
    await writeFile(join(roots.reports, "artifact-hygiene-2026-05-24.json"), JSON.stringify({
      generatedAt: "2026-05-24T23:17:00.000Z",
      counts: {
        exportFilesScanned: 260,
        exportFilesMatched: 8,
        orphanExports: 252,
        exportsMissingMetadata: 4,
      },
    }));
    await writeFile(join(roots.contextPacks, "context-pack-user-rhys.json"), JSON.stringify({
      id: "rhys",
      kind: "user",
      generatedAt: "2026-05-24T23:18:00.000Z",
      members: {
        canonical: ["knowledge/people/rhys-livingstone"],
        graphConnected: ["ATLAS", "STATUS"],
        tagMatched: ["skills/audit"],
        keywordInferred: ["memory/PARA/Projects/example"],
      },
    }));

    const projection = await getWorkspaceMemoryMaintenanceProjection(projectionOptions(roots));

    assert.equal(projection.status, "ready");
    assert.equal(projection.summary.notesScanned, 5755);
    assert.equal(projection.summary.brokenLinks, 761);
    assert.equal(projection.summary.orphanNotes, 143);
    assert.equal(projection.summary.weakNodes, 2);
    assert.equal(projection.summary.highDegreeHubs, 1);
    assert.equal(projection.summary.orphanExports, 252);
    assert.equal(projection.summary.exportsMissingMetadata, 4);
    assert.equal(projection.summary.contextPacksGenerated, 1);
    assert.equal(projection.reports.contextPacks[0].totalMembers, 5);
    assert.equal("members" in projection.reports.contextPacks[0], false);
  });
});

test("memory maintenance projection handles malformed report files safely", async () => {
  await withTempRoots(async (roots) => {
    await mkdir(roots.reports, { recursive: true });
    await writeFile(join(roots.reports, "memory-maintenance-2026-05-24.json"), "{not json");

    const projection = await getWorkspaceMemoryMaintenanceProjection(projectionOptions(roots));

    assert.equal(projection.status, "error");
    assert.equal(projection.sources.memoryReports.present, true);
    assert.equal(projection.sources.memoryReports.invalidRecordCount, 1);
    assert.match(projection.sources.memoryReports.errors[0].message, /JSON/);
  });
});

test("memory maintenance projection summarizes review queue risky suggestions", async () => {
  await withTempRoots(async (roots) => {
    await mkdir(roots.reviewQueue, { recursive: true });
    await writeFile(join(roots.reviewQueue, "review-queue-2026-05-24.json"), JSON.stringify({
      generatedAt: "2026-05-24T23:16:39.551Z",
      total: 3,
      suggestions: [
        { id: "connect-1", type: "connect-orphan", severity: "approval-required", status: "pending" },
        { id: "archive-1", type: "quarantine-export-candidate", severity: "warning", status: "pending" },
        { id: "note-1", type: "add-link", severity: "info", status: "done" },
      ],
    }));

    const projection = await getWorkspaceMemoryMaintenanceProjection(projectionOptions(roots));

    assert.equal(projection.status, "ready");
    assert.equal(projection.summary.reviewQueueItems, 3);
    assert.equal(projection.summary.riskySuggestions, 2);
    assert.equal(projection.reports.reviewQueue?.pendingItems, 2);
    assert.equal(projection.reports.reviewQueue?.topSuggestionTypes[0].type, "connect-orphan");
  });
});
