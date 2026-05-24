/**
 * Read-only projection tests for /api/workspace/runs backing logic.
 * Uses only temporary fixture files; no workflow state, queues, artifacts, or logs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  validateAgentRun,
  validateApproval,
  validateAuditRun,
  validateContentBatch,
  validateMemoryMaintenanceRun,
} from "../src/lib/workspace-contracts.ts";
import { getWorkspaceRunsProjection } from "../src/lib/workspace-runs-projection.ts";
import { workspaceContractFixtures } from "../src/lib/workspace-contract-fixtures.ts";

const validators = {
  agentRuns: validateAgentRun,
  auditRuns: validateAuditRun,
  contentBatches: validateContentBatch,
  approvals: validateApproval,
  memoryMaintenanceRuns: validateMemoryMaintenanceRun,
};

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-runs-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("workspace runs projection returns empty arrays and missing health when no source files exist", async () => {
  await withTempRoot(async (root) => {
    const projection = await getWorkspaceRunsProjection({ root, validators });

    assert.deepEqual(projection.records.agentRuns, []);
    assert.deepEqual(projection.records.auditRuns, []);
    assert.deepEqual(projection.records.contentBatches, []);
    assert.deepEqual(projection.records.approvals, []);
    assert.deepEqual(projection.records.memoryMaintenanceRuns, []);
    assert.equal(projection.counts.totalValidRecords, 0);
    assert.equal(projection.counts.totalInvalidRecords, 0);
    assert.equal(projection.counts.sourcesPresent, 0);
    assert.equal(projection.counts.sourcesMissing, 5);
    assert.equal(projection.sources.agentRuns.present, false);
  });
});

test("workspace runs projection reads valid JSON and JSONL source files", async () => {
  await withTempRoot(async (root) => {
    await writeFile(
      join(root, "agent-runs.jsonl"),
      [
        JSON.stringify(workspaceContractFixtures.agentRuns[0]),
        JSON.stringify(workspaceContractFixtures.agentRuns[1]),
      ].join("\n"),
    );
    await writeFile(join(root, "audit-runs.json"), JSON.stringify({ auditRuns: workspaceContractFixtures.auditRuns }));
    await writeFile(join(root, "approvals.json"), JSON.stringify(workspaceContractFixtures.approvals));

    const projection = await getWorkspaceRunsProjection({ root, validators });

    assert.equal(projection.records.agentRuns.length, 2);
    assert.equal(projection.records.auditRuns.length, 2);
    assert.equal(projection.records.approvals.length, 1);
    assert.equal(projection.counts.totalValidRecords, 5);
    assert.equal(projection.counts.totalInvalidRecords, 0);
    assert.equal(projection.sources.agentRuns.present, true);
    assert.equal(projection.sources.agentRuns.recordCount, 2);
    assert.equal(projection.sources.agentRuns.validRecordCount, 2);
    assert.equal(typeof projection.sources.agentRuns.lastModified, "string");
  });
});

test("workspace runs projection skips partially invalid source records and reports health", async () => {
  await withTempRoot(async (root) => {
    await writeFile(
      join(root, "agent-runs.jsonl"),
      [
        JSON.stringify(workspaceContractFixtures.agentRuns[0]),
        JSON.stringify({ ...workspaceContractFixtures.agentRuns[1], id: "", status: "done" }),
        "{not json",
      ].join("\n"),
    );

    const projection = await getWorkspaceRunsProjection({ root, validators });

    assert.equal(projection.records.agentRuns.length, 1);
    assert.equal(projection.counts.totalValidRecords, 1);
    assert.equal(projection.counts.totalInvalidRecords, 2);
    assert.equal(projection.sources.agentRuns.recordCount, 3);
    assert.equal(projection.sources.agentRuns.invalidRecordCount, 2);
    assert.match(projection.sources.agentRuns.errors.map((error) => error.message).join("\n"), /AgentRun\.id/);
  });
});

test("workspace runs projection normalises mixed workflow types", async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, "agent-runs.json"), JSON.stringify({ records: workspaceContractFixtures.agentRuns }));
    await writeFile(join(root, "content-batches.jsonl"), JSON.stringify(workspaceContractFixtures.contentBatches[0]));
    await writeFile(
      join(root, "memory-maintenance-runs.json"),
      JSON.stringify(workspaceContractFixtures.memoryMaintenanceRuns),
    );

    const projection = await getWorkspaceRunsProjection({ root, validators });

    assert.equal(projection.counts.agentRuns, 4);
    assert.equal(projection.counts.contentBatches, 1);
    assert.equal(projection.counts.memoryMaintenanceRuns, 1);
    assert.equal(projection.counts.totalValidRecords, 6);
    assert.deepEqual(
      projection.records.agentRuns.map((run) => run.workflow).sort(),
      ["audit", "audit", "content_batch", "memory_maintenance"],
    );
    assert.equal(projection.records.contentBatches[0].publishingBlocked, true);
    assert.equal(projection.records.memoryMaintenanceRuns[0].counts.appliedChanges, 0);
  });
});
