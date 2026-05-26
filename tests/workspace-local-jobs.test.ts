/**
 * Local Workspace job intake tests.
 * Uses only temporary directories; no Workspace runtime queues, exports, workers, or client channels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyWorkspaceLocalJobControl,
  buildWorkspaceLocalWorkerPackage,
  claimWorkspaceLocalWorkerJob,
  createWorkspaceLocalJob,
  formatWorkspaceLocalWorkerPackage,
  getWorkspaceLocalJobs,
  importWorkspaceLocalWorkerResult,
  inferWorkspaceLocalJobWorkflow,
  validateWorkspaceLocalJobControlInput,
  validateWorkspaceLocalJobInput,
  WORKSPACE_LOCAL_JOB_CONTROLS_FILE,
  WORKSPACE_LOCAL_JOBS_FILE,
} from "../src/lib/workspace-local-jobs.ts";
import { resolveWorkspaceLibrarianReferences } from "../src/lib/workspace-librarian-references.ts";

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-local-jobs-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withTempLibrarianRoots(fn: (roots: {
  contextPacksRoot: string;
  reportsRoot: string;
  reviewQueueRoot: string;
  stateCurrentPath: string;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-librarian-"));
  const contextPacksRoot = join(root, "librarian-context-packs");
  const reportsRoot = join(root, "librarian-reports");
  const reviewQueueRoot = join(root, "librarian-review-queue");
  const stateCurrentPath = join(root, "state-current.md");
  try {
    await Promise.all([
      mkdir(contextPacksRoot, { recursive: true }),
      mkdir(reportsRoot, { recursive: true }),
      mkdir(reviewQueueRoot, { recursive: true }),
    ]);
    await fn({ contextPacksRoot, reportsRoot, reviewQueueRoot, stateCurrentPath });
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

test("workspace local job control validation rejects invalid local moves", () => {
  assert.equal(validateWorkspaceLocalJobControlInput({ jobId: "job_1", action: "update" }).ok, false);
  assert.equal(validateWorkspaceLocalJobControlInput({ jobId: "job_1", action: "launch_worker" }).ok, false);
  assert.equal(validateWorkspaceLocalJobControlInput({ jobId: "job_1", action: "update", room: "slack" }).ok, false);
  assert.equal(validateWorkspaceLocalJobControlInput({ jobId: "job_1", action: "update", project: "supabase-prod" }).ok, false);
  assert.equal(validateWorkspaceLocalJobControlInput({ jobId: "job_1", action: "result_imported" }).ok, false);
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

test("workspace local job controls edit, reassign, archive, and delete through additive JSONL", async () => {
  await withTempRoot(async (root) => {
    const job = await createWorkspaceLocalJob(
      {
        prompt: "Draft a local audit control packet",
        project: "l2-audits",
        room: "audits",
        requesterRole: "rhys",
        intendedWorkflow: "audit",
      },
      {
        root,
        now: new Date("2026-05-26T01:02:03.000Z"),
        idFactory: () => "control-target",
      },
    );

    await applyWorkspaceLocalJobControl(
      {
        jobId: job.id,
        action: "update",
        title: "Renamed local draft",
        prompt: "Edited local prompt only",
        project: "content-engine",
        room: "content",
        intendedWorkflow: "content_batch",
      },
      {
        root,
        now: new Date("2026-05-26T02:00:00.000Z"),
        idFactory: () => "update-control",
      },
    );

    let projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.records.length, 1);
    assert.equal(projection.records[0].title, "Renamed local draft");
    assert.equal(projection.records[0].prompt, "Edited local prompt only");
    assert.equal(projection.records[0].project, "content-engine");
    assert.equal(projection.records[0].room, "content");
    assert.equal(projection.records[0].intendedWorkflow, "content_batch");
    assert.equal(projection.records[0].execution.state, "not_executing");
    assert.equal(projection.health.recordCount, 1);
    assert.equal(projection.controlHealth.validRecordCount, 1);

    await applyWorkspaceLocalJobControl(
      { jobId: job.id, action: "archive" },
      {
        root,
        now: new Date("2026-05-26T03:00:00.000Z"),
        idFactory: () => "archive-control",
      },
    );

    projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.records.length, 0);
    assert.equal(projection.archivedRecords.length, 1);
    assert.equal(projection.archivedRecords[0].status, "archived");
    assert.equal(projection.archivedRecords[0].title, "Renamed local draft");
    assert.equal(projection.health.archivedRecordCount, 1);

    await applyWorkspaceLocalJobControl(
      { jobId: job.id, action: "delete" },
      {
        root,
        now: new Date("2026-05-26T04:00:00.000Z"),
        idFactory: () => "delete-control",
      },
    );

    projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.records.length, 0);
    assert.equal(projection.archivedRecords.length, 0);
    assert.equal(projection.health.deletedRecordCount, 1);
    assert.equal(projection.health.controlRecordCount, 3);
  });
});

test("workspace worker handoff events project ready status, packages, and manual results", async () => {
  await withTempRoot(async (root) => {
    const job = await createWorkspaceLocalJob(
      {
        prompt: "Draft a local worker handoff package",
        project: "undeniable-os",
        room: "home",
        requesterRole: "rhys",
        intendedWorkflow: "ask_atlas",
      },
      {
        root,
        now: new Date("2026-05-26T01:02:03.000Z"),
        idFactory: () => "worker-target",
      },
    );
    const contextSummary = {
      generatedAt: "2026-05-26T01:30:00.000Z",
      localJobs: { active: 1, archived: 0, controls: 0 },
      artifacts: { total: 2, recentTitles: ["Read-only audit artifact"], latestAuditTitle: "Read-only audit artifact" },
      memory: { status: "ready", contextPacks: 3, reviewItems: 1 },
      runs: { validRecords: 4, sourcesPresent: 2 },
      approvals: { pending: 1, slackVisible: 1, taskReviews: 0 },
      readiness: {
        localJobSource: join(root, WORKSPACE_LOCAL_JOBS_FILE),
        artifactRecords: 2,
        externalSystems: "not_connected" as const,
      },
    };
    const workerPackage = buildWorkspaceLocalWorkerPackage({
      job,
      contextSummary,
      now: new Date("2026-05-26T02:00:00.000Z"),
      idFactory: () => "package-id",
    });

    assert.match(formatWorkspaceLocalWorkerPackage(workerPackage), /no external send/i);

    await applyWorkspaceLocalJobControl(
      { jobId: job.id, action: "ready_for_worker" },
      {
        root,
        now: new Date("2026-05-26T02:01:00.000Z"),
        idFactory: () => "ready-control",
      },
    );
    await applyWorkspaceLocalJobControl(
      { jobId: job.id, action: "worker_package_created", workerPackage },
      {
        root,
        now: new Date("2026-05-26T02:02:00.000Z"),
        idFactory: () => "package-control",
      },
    );
    await applyWorkspaceLocalJobControl(
      {
        jobId: job.id,
        action: "result_imported",
        resultTitle: "Manual local answer",
        resultBody: "This is a pasted worker-style result, stored locally only.",
      },
      {
        root,
        now: new Date("2026-05-26T02:03:00.000Z"),
        idFactory: () => "result-control",
      },
    );

    const baseLines = (await readFile(join(root, WORKSPACE_LOCAL_JOBS_FILE), "utf8")).trim().split("\n");
    assert.equal(baseLines.length, 1);

    const projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.records.length, 1);
    assert.equal(projection.records[0].status, "completed_local");
    assert.equal(projection.eventsByJob[job.id].map((event) => event.action).join(","), "ready_for_worker,worker_package_created,result_imported");
    assert.equal(projection.workerPackagesByJob[job.id].packageId, "local_worker_package_package-id");
    assert.equal(projection.resultsByJob[job.id].length, 1);
    assert.equal(projection.resultsByJob[job.id][0].title, "Manual local answer");
    assert.equal(projection.resultsByJob[job.id][0].status, "result_imported");
    assert.equal(projection.health.controlRecordCount, 3);
  });
});

test("workspace librarian resolver returns concise read-only references from existing outputs", async () => {
  await withTempLibrarianRoots(async (roots) => {
    await writeFile(
      join(roots.contextPacksRoot, "context-pack-workflow-memory-knowledge.json"),
      JSON.stringify({
        id: "memory-knowledge",
        kind: "workflow",
        generatedAt: "2026-05-26T09:43:56.202Z",
        spec: {
          seeds: ["knowledge/INDEX"],
          keywords: ["memory", "knowledge", "librarian"],
        },
        members: {},
      }),
    );
    await writeFile(
      join(roots.contextPacksRoot, "context-pack-user-rhys.md"),
      "# Context Pack: rhys\n\n> Generated by the Memory Librarian.\n\n**Members:** concise existing pack.\n",
    );
    await writeFile(
      join(roots.reportsRoot, "memory-maintenance-2026-05-26.json"),
      JSON.stringify({
        generatedAt: "2026-05-26T09:43:49.282Z",
        stats: { notesScanned: 10, wikilinksResolved: 9 },
      }),
    );
    await writeFile(roots.stateCurrentPath, "# ATLAS Live Service State\n\nLatest Librarian outputs are under tools/librarian-*.\n");

    const references = await resolveWorkspaceLibrarianReferences(
      {
        title: "Memory training request",
        prompt: "Use memory knowledge context for this training session",
        project: "memory-knowledge",
        room: "training",
        requesterRole: "rhys",
        intendedWorkflow: "training_session",
      },
      { ...roots, maxReferences: 3 },
    );

    assert.equal(references.length, 3);
    assert.equal(references[0].type, "librarian-context-pack");
    assert.match(references[0].title, /memory-knowledge/);
    assert.match(references[0].summary ?? "", /memory/);
    assert.ok(references.every((reference) => reference.sourcePath.startsWith(roots.contextPacksRoot) || reference.sourcePath.startsWith(roots.reportsRoot) || reference.sourcePath === roots.stateCurrentPath));
  });
});

test("workspace codex worker adapter claims, exports, and imports through local files", async () => {
  await withTempRoot(async (root) => {
    const job = await createWorkspaceLocalJob(
      {
        prompt: "Stage this local job for Codex adapter verification",
        project: "undeniable-os",
        room: "home",
        requesterRole: "rhys",
        intendedWorkflow: "ask_atlas",
      },
      {
        root,
        now: new Date("2026-05-26T01:02:03.000Z"),
        idFactory: () => "codex-adapter-target",
      },
    );

    await applyWorkspaceLocalJobControl(
      { jobId: job.id, action: "ready_for_worker" },
      {
        root,
        now: new Date("2026-05-26T02:00:00.000Z"),
        idFactory: () => "ready-adapter-control",
      },
    );

    const claim = await claimWorkspaceLocalWorkerJob({
      jobId: job.id,
      adapter: "codex",
      root,
      librarianReferences: [
        {
          title: "Fixture Rhys context pack",
          type: "librarian-context-pack",
          sourcePath: "/tmp/context-pack-user-rhys.md",
          summary: "Existing Librarian output only.",
          relevanceReason: "Matches Rhys/home/Undeniable job context.",
          updatedAt: "2026-05-26T02:00:00.000Z",
        },
      ],
      now: new Date("2026-05-26T02:01:00.000Z"),
      idFactory: () => "claim-adapter",
    });

    assert.equal(claim.files.adapter, "codex");
    assert.match(await readFile(claim.files.requestMarkdownPath, "utf8"), /Write the final result/i);
    assert.match(await readFile(claim.files.requestMarkdownPath, "utf8"), /Fixture Rhys context pack/);
    assert.match(await readFile(claim.files.requestJsonPath, "utf8"), /workspace-worker-results/);

    let projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.records[0].status, "worker_staged");
    assert.equal(projection.workerRequestsByJob[job.id].requestJsonPath, claim.files.requestJsonPath);
    assert.equal(projection.librarianReferencesByJob[job.id][0].title, "Fixture Rhys context pack");
    assert.deepEqual(
      projection.eventsByJob[job.id].map((event) => event.action),
      ["ready_for_worker", "worker_claimed", "worker_staged"],
    );

    await writeFile(claim.files.resultMarkdownPath, "# Codex adapter result\n\nLocal adapter result body only.", "utf8");
    const imported = await importWorkspaceLocalWorkerResult({
      jobId: job.id,
      resultPath: claim.files.resultMarkdownPath,
      root,
      now: new Date("2026-05-26T02:02:00.000Z"),
      idFactory: () => "import-adapter",
    });

    assert.deepEqual(imported.events.map((event) => event.action), ["worker_result_written", "result_imported"]);
    projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.records[0].status, "completed_local");
    assert.equal(projection.workerResultPathsByJob[job.id][0], claim.files.resultMarkdownPath);
    assert.equal(projection.resultsByJob[job.id][0].title, "Codex adapter result");
    assert.match(projection.resultsByJob[job.id][0].body, /Local adapter result body only/);

    const baseLines = (await readFile(join(root, WORKSPACE_LOCAL_JOBS_FILE), "utf8")).trim().split("\n");
    assert.equal(baseLines.length, 1);
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

test("workspace local job reader skips malformed and invalid control records safely", async () => {
  await withTempRoot(async (root) => {
    const job = await createWorkspaceLocalJob(
      {
        prompt: "Create a content batch draft",
        project: "content-engine",
        room: "content",
        requesterRole: "corey",
        intendedWorkflow: "content_batch",
      },
      { root, idFactory: () => "valid-control-source" },
    );

    await writeFile(
      join(root, WORKSPACE_LOCAL_JOB_CONTROLS_FILE),
      [
        "{not json",
        JSON.stringify({ schemaVersion: 1, id: "bad", jobId: job.id, action: "update", createdAt: "nope", source: "workspace-control" }),
        JSON.stringify({
          schemaVersion: 1,
          id: "good",
          jobId: job.id,
          action: "update",
          createdAt: "2026-05-26T02:00:00.000Z",
          source: "workspace-control",
          patch: { title: "Valid projected rename" },
        }),
      ].join("\n"),
    );

    const projection = await getWorkspaceLocalJobs({ root });
    assert.equal(projection.controlHealth.recordCount, 3);
    assert.equal(projection.controlHealth.validRecordCount, 1);
    assert.equal(projection.controlHealth.invalidRecordCount, 2);
    assert.equal(projection.records[0].title, "Valid projected rename");
  });
});

test("workspace local job workflow inference covers core Workspace intents", () => {
  assert.equal(inferWorkspaceLocalJobWorkflow("Run an audit QA packet"), "audit");
  assert.equal(inferWorkspaceLocalJobWorkflow("Create a weekly content batch"), "content_batch");
  assert.equal(inferWorkspaceLocalJobWorkflow("Build a call archive from this transcript"), "call_archive");
  assert.equal(inferWorkspaceLocalJobWorkflow("Brain dump and train Atlas on this"), "training_session");
});
