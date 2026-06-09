import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createAtlasCoreJob,
  listAtlasCoreJobs,
  readAtlasCoreJobProjection,
  recordAtlasCoreApproval,
  recordAtlasCoreArtifact,
  recordAtlasCoreDeliveryReceipt,
  transitionAtlasCoreJob,
} from "../src/lib/atlas-core-jobs.ts";

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-core-jobs-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function ids(...values: string[]) {
  const queue = [...values];
  return () => queue.shift() ?? "fallback";
}

async function createSlackAssetJob(root: string) {
  return createAtlasCoreJob(
    {
      projectId: "undeniable-os",
      source: {
        type: "slack",
        channelId: "D0AM2R3H6SE",
        messageTs: "1770000000.000100",
        userId: "U_RHYS",
      },
      request: {
        text: "Create a branded Undeniable asset and return it here.",
        classification: "asset_request",
        createdAt: "2026-06-09T10:00:00.000Z",
      },
      workflow: {
        key: "jess-endure-ad-cta-dm-follow-up",
        id: "jess_cta_playbook",
        adapter: "verified_artifact_workflow",
      },
    },
    {
      root,
      now: new Date("2026-06-09T10:00:00.000Z"),
      idFactory: ids("job-1", "event-create"),
    },
  );
}

test("core job store starts empty when no JSONL file exists", async () => {
  await withTempRoot(async (root) => {
    const projection = await readAtlasCoreJobProjection({ root });

    assert.equal(projection.health.present, false);
    assert.equal(projection.health.recordCount, 0);
    assert.deepEqual(projection.jobs, []);
    assert.deepEqual(projection.artifacts, []);
    assert.deepEqual(projection.deliveries, []);
    assert.deepEqual(projection.approvals, []);
  });
});

test("creates a Slack-sourced core job with project, source, request, and workflow metadata", async () => {
  await withTempRoot(async (root) => {
    const job = await createSlackAssetJob(root);

    assert.equal(job.id, "atlas_job_job-1");
    assert.equal(job.projectId, "undeniable-os");
    assert.equal(job.status, "received");
    assert.equal(job.source.type, "slack");
    assert.equal(job.source.channelId, "D0AM2R3H6SE");
    assert.equal(job.workflow?.key, "jess-endure-ad-cta-dm-follow-up");

    const projection = await readAtlasCoreJobProjection({ root });
    assert.equal(projection.health.present, true);
    assert.equal(projection.health.recordCount, 1);
    assert.equal(projection.jobs[0].request.classification, "asset_request");
  });
});

test("projects the proven lifecycle through artifact_ready and delivery receipt to delivered", async () => {
  await withTempRoot(async (root) => {
    const job = await createSlackAssetJob(root);

    await transitionAtlasCoreJob(
      { jobId: job.id, status: "queued" },
      { root, now: new Date("2026-06-09T10:00:01.000Z"), idFactory: ids("event-queued") },
    );
    await transitionAtlasCoreJob(
      { jobId: job.id, status: "building" },
      { root, now: new Date("2026-06-09T10:00:02.000Z"), idFactory: ids("event-building") },
    );
    const artifact = await recordAtlasCoreArtifact(
      {
        jobId: job.id,
        title: "Jess Endure CTA DM Follow-Up Playbook",
        kind: "pdf",
        paths: ["/Users/atlasai/.openclaw/workspace/exports/jess.pdf"],
        sourcePaths: ["/Users/atlasai/.openclaw/workspace/exports/jess.md"],
        validation: { status: "passed", checks: { pdfHeader: true, brandedSidecars: true } },
      },
      { root, now: new Date("2026-06-09T10:00:03.000Z"), idFactory: ids("artifact-1", "event-artifact") },
    );
    await transitionAtlasCoreJob(
      { jobId: job.id, status: "delivery_requested" },
      { root, now: new Date("2026-06-09T10:00:04.000Z"), idFactory: ids("event-delivery-requested") },
    );
    const delivery = await recordAtlasCoreDeliveryReceipt(
      {
        jobId: job.id,
        artifactId: artifact.id,
        destination: { type: "slack_dm", channelId: "D0AM2R3H6SE" },
        result: { channelId: "D0AM2R3H6SE", fileId: "F0BA35BNS9W" },
      },
      { root, now: new Date("2026-06-09T10:00:05.000Z"), idFactory: ids("delivery-1", "event-delivery") },
    );

    assert.equal(delivery.status, "delivered");

    const projection = await readAtlasCoreJobProjection({ root });
    const projected = projection.jobs.find((j) => j.id === job.id)!;
    assert.equal(projected.status, "delivered");
    assert.deepEqual(projected.artifactIds, [artifact.id]);
    assert.deepEqual(projected.deliveryIds, [delivery.id]);
    assert.equal(projection.artifacts[0].validation.checks.pdfHeader, true);
    assert.equal(projection.deliveries[0].result.fileId, "F0BA35BNS9W");
  });
});

test("delivered cannot be reached without a Slack delivery receipt", async () => {
  await withTempRoot(async (root) => {
    const job = await createSlackAssetJob(root);

    await assert.rejects(
      transitionAtlasCoreJob({ jobId: job.id, status: "delivered" }, { root }),
      /Use recordAtlasCoreDeliveryReceipt/,
    );

    await assert.rejects(
      recordAtlasCoreDeliveryReceipt(
        {
          jobId: job.id,
          destination: { type: "slack_dm", channelId: "D0AM2R3H6SE" },
          result: { channelId: "D0AM2R3H6SE" },
        },
        { root },
      ),
      /requires fileId or messageTs/,
    );
  });
});

test("blocked jobs preserve a safe reason and do not invent artifacts", async () => {
  await withTempRoot(async (root) => {
    const job = await createSlackAssetJob(root);

    await transitionAtlasCoreJob(
      {
        jobId: job.id,
        status: "blocked",
        safeErrorSummary: "No verified workflow exists for that asset yet.",
      },
      { root, now: new Date("2026-06-09T10:01:00.000Z"), idFactory: ids("event-blocked") },
    );

    const projection = await readAtlasCoreJobProjection({ root });
    assert.equal(projection.jobs[0].status, "blocked");
    assert.equal(projection.jobs[0].safeErrorSummary, "No verified workflow exists for that asset yet.");
    assert.deepEqual(projection.artifacts, []);
    assert.deepEqual(projection.deliveries, []);
  });
});

test("approval lane records review state against a job and filters jobs by project", async () => {
  await withTempRoot(async (root) => {
    const job = await createSlackAssetJob(root);
    await createAtlasCoreJob(
      {
        projectId: "content-engine",
        source: { type: "workspace", userId: "operator" },
        request: { text: "Draft Corey content", classification: "content_request" },
      },
      { root, now: new Date("2026-06-09T11:00:00.000Z"), idFactory: ids("job-2", "event-create-2") },
    );

    const approval = await recordAtlasCoreApproval(
      {
        projectId: "undeniable-os",
        jobId: job.id,
        channel: "workspace",
        destination: "operator_review",
        draft: "Approve this asset before client delivery.",
      },
      { root, now: new Date("2026-06-09T10:02:00.000Z"), idFactory: ids("approval-1", "event-approval") },
    );

    const undeniable = await listAtlasCoreJobs({ projectId: "undeniable-os" }, { root });
    assert.equal(undeniable.length, 1);
    assert.equal(undeniable[0].approvalIds[0], approval.id);

    const projection = await readAtlasCoreJobProjection({ root });
    assert.equal(projection.approvals[0].status, "pending");
    assert.equal(projection.approvals[0].destination, "operator_review");
  });
});
