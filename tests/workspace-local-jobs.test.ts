/**
 * Local Workspace job intake tests.
 * Uses only temporary directories; no Workspace runtime queues, exports, workers, or client channels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createWorkspaceLocalJob,
  getWorkspaceLocalJobs,
  inferWorkspaceLocalJobWorkflow,
  validateWorkspaceLocalJobInput,
  WORKSPACE_LOCAL_JOBS_FILE,
} from "../src/lib/workspace-local-jobs.ts";

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-local-jobs-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("workspace local jobs projection returns empty health when the JSONL file is absent", async () => {
  await withTempRoot(async (root) => {
    const projection = await getWorkspaceLocalJobs({ root });

    assert.equal(projection.health.present, false);
    assert.equal(projection.health.recordCount, 0);
    assert.equal(projection.health.validRecordCount, 0);
    assert.deepEqual(projection.records, []);
  });
});

test("workspace local job input validation rejects blank prompts and invalid workflows", () => {
  assert.deepEqual(validateWorkspaceLocalJobInput({ prompt: "   " }).ok, false);

  const invalidWorkflow = validateWorkspaceLocalJobInput({
    prompt: "Create a local draft",
    project: "undeniable-os",
    room: "home",
    requesterRole: "rhys",
    intendedWorkflow: "run_real_worker",
  });

  assert.equal(invalidWorkflow.ok, false);
});

test("workspace local job intake appends a local-only queued record", async () => {
  await withTempRoot(async (root) => {
    const job = await createWorkspaceLocalJob(
      {
        prompt: "Start an L2 audit draft for a new local intake",
        project: "l2-audits",
        room: "audits",
        requesterRole: "rhys",
        intendedWorkflow: "audit",
      },
      {
        root,
        now: new Date("2026-05-26T01:02:03.000Z"),
        idFactory: () => "test-id",
      },
    );

    assert.equal(job.id, "local_job_test-id");
    assert.equal(job.status, "queued_local");
    assert.equal(job.source, "workspace");
    assert.equal(job.execution.state, "not_executing");
    assert.match(job.execution.reason, /No worker, model, delivery, or external platform/);

    const projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.health.present, true);
    assert.equal(projection.health.recordCount, 1);
    assert.equal(projection.health.validRecordCount, 1);
    assert.equal(projection.records[0].id, "local_job_test-id");
  });
});

test("workspace local job reader skips malformed and invalid records safely", async () => {
  await withTempRoot(async (root) => {
    await createWorkspaceLocalJob(
      {
        prompt: "Create a content batch draft",
        project: "content-engine",
        room: "content",
        requesterRole: "corey",
        intendedWorkflow: "content_batch",
      },
      { root, idFactory: () => "valid-record" },
    );
    await writeFile(
      join(root, WORKSPACE_LOCAL_JOBS_FILE),
      [
        "{not json",
        JSON.stringify({ id: "", source: "workspace", status: "queued_local" }),
        JSON.stringify((await getWorkspaceLocalJobs({ root })).records[0]),
      ].join("\n"),
    );

    const projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.health.recordCount, 3);
    assert.equal(projection.health.validRecordCount, 1);
    assert.equal(projection.health.invalidRecordCount, 2);
    assert.equal(projection.records.length, 1);
  });
});

test("workspace local job workflow inference covers core Workspace intents", () => {
  assert.equal(inferWorkspaceLocalJobWorkflow("Run an audit QA packet"), "audit");
  assert.equal(inferWorkspaceLocalJobWorkflow("Create a weekly content batch"), "content_batch");
  assert.equal(inferWorkspaceLocalJobWorkflow("Build a call archive from this transcript"), "call_archive");
  assert.equal(inferWorkspaceLocalJobWorkflow("Brain dump and train Atlas on this"), "training_session");
});
