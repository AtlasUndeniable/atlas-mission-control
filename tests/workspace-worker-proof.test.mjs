/**
 * PROOF HARNESS for the workspace delivery worker (DONE conditions 1-4).
 * Runs ENTIRELY against fixtures in a temp dir: copied ledger shapes, fake
 * artifact files, and a Slack send STUB. It never reads or writes
 * /Users/atlasai/.openclaw/data/*, never touches live exports, never sends
 * a real Slack message.
 * Run: node --test tests/workspace-worker-proof.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  attemptJournalPath,
  findWorkerCandidates,
  runWorkerPass,
  workerDeliveryIdForJob,
} from "../openclaw-runtime/workspace/services/workspace-worker/worker.mjs";
import { hasSlackDeliveryReceipt } from "../openclaw-runtime/workspace/lib/slack-dm-jobs.mjs";
import { RHYS_DM_CHANNEL_ID, RHYS_USER_ID } from "../openclaw-runtime/workspace/lib/slack-rhys-dm-artifact.mjs";

const WORKER_PATH = resolve("openclaw-runtime/workspace/services/workspace-worker/worker.mjs");

// ── Fixture world ────────────────────────────────────────────────────────────
function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "wkr-proof-"));
  const exportsRoot = join(dir, "exports");
  mkdirSync(exportsRoot);
  const jobsPath = join(dir, "slack-dm-jobs.json");
  const ledgerPath = join(dir, "artifact-deliveries.jsonl");
  return {
    dir,
    exportsRoot,
    jobsPath,
    ledgerPath,
    makeArtifact(name, content = "FIXTURE-PDF-BYTES") {
      const p = join(exportsRoot, name);
      writeFileSync(p, content);
      return p;
    },
    writeJobs(jobs) { writeFileSync(jobsPath, JSON.stringify(jobs, null, 2)); },
    readJobs() { return JSON.parse(readFileSync(jobsPath, "utf8")); },
    seedLedgerReceipt(deliveryId, receipt) {
      appendFileSync(ledgerPath, `${JSON.stringify({
        eventId: "seeded", eventAt: "2026-06-11T00:00:00.000Z",
        eventType: "delivery_state", deliveryId, status: "delivered", ...receipt,
      })}\n`);
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function orphanJob(overrides = {}) {
  return {
    id: `slackdm-${RHYS_DM_CHANNEL_ID}-1781000000.000001`,
    assetJobId: "asset-fixture01",
    channel: RHYS_DM_CHANNEL_ID,
    userId: RHYS_USER_ID,
    requestText: "build me the fixture asset pdf",
    status: "artifact_ready",
    preferredDelivery: "slack_dm",
    title: "Fixture Asset",
    createdAt: "2026-06-11T01:00:00.000Z",
    updatedAt: "2026-06-11T01:00:05.000Z",
    ...overrides,
  };
}

// ── Slack send stub ──────────────────────────────────────────────────────────
function makeSlackStub({ failSends = 0, delayMs = 0, hooks = {}, historyMessages = null } = {}) {
  const calls = [];
  let remainingFailures = failSends;
  let uploadCounter = 0;
  return {
    calls,
    sendCount: () => calls.filter((c) => c === "files.completeUploadExternal").length,
    slackClient: async (method, body) => {
      calls.push(method);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (hooks[method]) await hooks[method](body);
      if (method === "conversations.open") {
        return { ok: true, channel: { id: RHYS_DM_CHANNEL_ID, user: RHYS_USER_ID } };
      }
      if (method === "files.getUploadURLExternal") {
        if (remainingFailures > 0) { remainingFailures -= 1; throw new Error("files.getUploadURLExternal failed: simulated_outage"); }
        uploadCounter += 1;
        return { ok: true, file_id: `F-STUB-${uploadCounter}`, upload_url: "https://stub.invalid/upload" };
      }
      if (method === "files.completeUploadExternal") {
        const id = body.files[0].id;
        return { ok: true, files: [{ id, shares: { private: { [RHYS_DM_CHANNEL_ID]: [{ ts: `1781.${id}` }] } } }] };
      }
      if (method === "conversations.history") return { ok: true, messages: historyMessages || [] };
      throw new Error(`stub: unexpected slack method ${method}`);
    },
    uploadFetch: async () => ({ ok: true }),
  };
}

function workerOpts(world, stub, extra = {}) {
  return {
    jobsPath: world.jobsPath,
    ledgerPath: world.ledgerPath,
    exportsDir: world.exportsRoot,
    allowedRoots: [world.exportsRoot],
    token: "stub-token",
    slackClient: stub.slackClient,
    uploadFetch: stub.uploadFetch,
    ...extra,
  };
}

// ── DONE CONDITION 1: standalone delivery with no live request in scope ─────
test("DONE-1: orphan with artifact on disk and no receipt is delivered, receipted, transitioned", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    const stub = makeSlackStub();

    const summary = await runWorkerPass(workerOpts(world, stub));

    assert.equal(summary.delivered, 1);
    assert.equal(stub.sendCount(), 1);
    const job = world.readJobs()[0];
    assert.equal(job.status, "delivered");
    assert.ok(hasSlackDeliveryReceipt(job.deliveryResult), "real receipt required");
    assert.equal(job.deliveryResult.channelId, RHYS_DM_CHANNEL_ID);
    assert.ok(job.deliveryResult.fileId && job.deliveryResult.messageTs);
    assert.equal(job.deliveredBy, "workspace-worker:send");
    // Receipt also recorded in the artifact ledger by the gated send itself.
    const ledger = readFileSync(world.ledgerPath, "utf8");
    assert.match(ledger, /"status":"delivered"/);
    // TR-6: Rhys-facing copy carries no paths or internal ids.
    assert.ok(!/\/Users\//.test(job.replyText) && !/slackdm-|asset-[0-9a-f]/.test(job.replyText));
  } finally { world.cleanup(); }
});

// ── DONE CONDITION 2: exactly once — sequential and cross-process race ──────
test("DONE-2a: running the pass twice delivers exactly once", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    const stub = makeSlackStub();

    const first = await runWorkerPass(workerOpts(world, stub));
    const second = await runWorkerPass(workerOpts(world, stub));

    assert.equal(first.delivered, 1);
    assert.equal(second.delivered + second.reconciled, 0, "second pass must be a no-op");
    assert.equal(stub.sendCount(), 1, "EXACTLY one send across both passes");
    assert.equal(world.readJobs()[0].status, "delivered");
  } finally { world.cleanup(); }
});

test("DONE-2b: two concurrent worker PROCESSES race on the same job — exactly one send", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    const sendsLog = join(world.dir, "sends.log");

    const driverPath = join(world.dir, "driver.mjs");
    writeFileSync(driverPath, `
import { appendFileSync } from "node:fs";
import { runWorkerPass } from ${JSON.stringify(WORKER_PATH)};
const [jobsPath, ledgerPath, exportsRoot, sendsLog] = process.argv.slice(2);
let n = 0;
const slackClient = async (method, body) => {
  if (method === "conversations.open") return { ok: true, channel: { id: ${JSON.stringify(RHYS_DM_CHANNEL_ID)}, user: ${JSON.stringify(RHYS_USER_ID)} } };
  if (method === "files.getUploadURLExternal") {
    await new Promise((r) => setTimeout(r, 200)); // widen the race window between claim and send
    n += 1; return { ok: true, file_id: "F-" + process.pid + "-" + n, upload_url: "https://stub.invalid/upload" };
  }
  if (method === "files.completeUploadExternal") {
    appendFileSync(sendsLog, JSON.stringify({ pid: process.pid, fileId: body.files[0].id }) + "\\n");
    return { ok: true, files: [{ id: body.files[0].id, shares: { private: { ${JSON.stringify(RHYS_DM_CHANNEL_ID)}: [{ ts: "1781.race" }] } } }] };
  }
  if (method === "conversations.history") return { ok: true, messages: [] };
  throw new Error("unexpected " + method);
};
const summary = await runWorkerPass({
  jobsPath, ledgerPath, allowedRoots: [exportsRoot], token: "stub",
  slackClient, uploadFetch: async () => ({ ok: true }),
});
console.log(JSON.stringify(summary));
`);

    const runDriver = () => new Promise((resolveP, rejectP) => {
      execFile(process.execPath, [driverPath, world.jobsPath, world.ledgerPath, world.exportsRoot, sendsLog],
        { timeout: 30_000 }, (err, stdout) => err ? rejectP(err) : resolveP(JSON.parse(stdout.trim().split("\n").pop())));
    });

    const [a, b] = await Promise.all([runDriver(), runDriver()]);

    let sendLines = [];
    try { sendLines = readFileSync(sendsLog, "utf8").trim().split("\n").filter(Boolean); } catch {}
    assert.equal(sendLines.length, 1, `EXACTLY one send under race (got ${sendLines.length}; A=${JSON.stringify(a)} B=${JSON.stringify(b)})`);
    assert.equal(a.delivered + b.delivered, 1, "exactly one process delivers");
    assert.equal(world.readJobs()[0].status, "delivered");
  } finally { world.cleanup(); }
});

// ── DONE CONDITION 3: the post-SIGTERM orphan is recovered, no second request ─
test("DONE-3: 'building' orphan (post-SIGTERM state) is recovered with NO second user request", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("orphaned-after-sigterm-branded.pdf");
    // The exact bug state: build outlived its request; file on disk; job
    // stranded non-terminal; no receipt; nothing else will ever touch it.
    world.writeJobs([orphanJob({
      id: `slackdm-${RHYS_DM_CHANNEL_ID}-1781000000.000099`,
      status: "building",
      artifactPaths: [pdf],
      safeErrorSummary: "failure_type=timeout | summary=Live Slack agent window timed out",
    })]);
    const stub = makeSlackStub();

    const summary = await runWorkerPass(workerOpts(world, stub));

    assert.equal(summary.delivered, 1, "orphan must be delivered by the worker alone");
    assert.equal(stub.sendCount(), 1);
    const job = world.readJobs()[0];
    assert.equal(job.status, "delivered");
    assert.ok(hasSlackDeliveryReceipt(job.deliveryResult));
    // Honest late-delivery copy, TR-6 clean.
    assert.match(job.replyText, /finished after my last reply/);
  } finally { world.cleanup(); }
});

// ── DONE CONDITION 4: idempotent + crash-safe ────────────────────────────────
test("DONE-4a: fresh foreign claim is respected; stale claim is reclaimed and delivered once", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    const freshClaim = { id: "other-worker-claim", at: new Date().toISOString() };
    world.writeJobs([orphanJob({ artifactPaths: [pdf], deliveryClaim: freshClaim })]);
    const stub = makeSlackStub();

    // Fresh foreign claim → skip, zero sends.
    const skipped = await runWorkerPass(workerOpts(world, stub));
    assert.equal(skipped.delivered, 0);
    assert.equal(skipped.conflicts, 1);
    assert.equal(stub.sendCount(), 0);

    // Stale claim → reclaim under the PRODUCTION TTL. The claim is made
    // deterministically stale by backdating it — relying on claimTtlMs:1 and
    // wall-clock elapsement flakes on fast runs (two passes in the same ms).
    const jobs = world.readJobs();
    jobs[0].deliveryClaim = { id: "other-worker-claim", at: new Date(Date.now() - 11 * 60_000).toISOString() };
    world.writeJobs(jobs);
    const recovered = await runWorkerPass(workerOpts(world, stub));
    assert.equal(recovered.delivered, 1);
    assert.equal(stub.sendCount(), 1);
    assert.equal(world.readJobs()[0].status, "delivered");
  } finally { world.cleanup(); }
});

test("DONE-4b: crash AFTER send, BEFORE finalize — reconciled from ledger receipt with ZERO resends", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    const job = orphanJob({ artifactPaths: [pdf], deliveryClaim: { id: "dead-worker", at: "2026-06-11T00:00:00.000Z" } });
    world.writeJobs([job]);
    // The send-side truth a dead worker left behind: receipt in the artifact
    // ledger for this job's deterministic deliveryId, job never finalized.
    const receipt = { channelId: RHYS_DM_CHANNEL_ID, fileId: "F-PRIOR-SEND", messageTs: "1781.prior" };
    world.seedLedgerReceipt(workerDeliveryIdForJob(job), receipt);
    const stub = makeSlackStub();

    const summary = await runWorkerPass(workerOpts(world, stub, { claimTtlMs: 1 }));

    assert.equal(summary.reconciled, 1, "must finalize from the prior receipt");
    assert.equal(summary.delivered, 0);
    assert.equal(stub.sendCount(), 0, "must NOT send again");
    const finalized = world.readJobs()[0];
    assert.equal(finalized.status, "delivered");
    assert.deepEqual(finalized.deliveryResult, receipt);
    assert.equal(finalized.deliveredBy, "workspace-worker:reconcile");
  } finally { world.cleanup(); }
});

test("DONE-4c: transient send failure releases the claim; next pass delivers — never strands", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    const stub = makeSlackStub({ failSends: 1 });

    const failed = await runWorkerPass(workerOpts(world, stub));
    assert.equal(failed.failures, 1);
    const afterFail = world.readJobs()[0];
    assert.equal(afterFail.status, "artifact_ready", "status unchanged, still deliverable");
    assert.equal(afterFail.deliveryClaim, null, "claim released on failure");
    assert.equal(afterFail.workerAttempts, 1);

    const recovered = await runWorkerPass(workerOpts(world, stub));
    assert.equal(recovered.delivered, 1);
    assert.equal(stub.sendCount(), 1);
    assert.equal(world.readJobs()[0].status, "delivered");
  } finally { world.cleanup(); }
});

test("DONE-4d: poisoned job parks visibly after max attempts — never silently stranded, never spins", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    const stub = makeSlackStub({ failSends: 99 });

    await runWorkerPass(workerOpts(world, stub, { maxAttempts: 3 }));
    await runWorkerPass(workerOpts(world, stub, { maxAttempts: 3 }));
    const third = await runWorkerPass(workerOpts(world, stub, { maxAttempts: 3 }));

    assert.equal(third.parked, 1);
    const job = world.readJobs()[0];
    assert.equal(job.status, "blocked_needs_approval", "visible operator state, not silent strand");
    assert.match(job.safeErrorSummary, /operator review required/);
    assert.equal(stub.sendCount(), 0);

    // And the parked job is NOT picked up again (no spin).
    const fourth = await runWorkerPass(workerOpts(world, stub, { maxAttempts: 3 }));
    assert.equal(fourth.candidates, 0);
  } finally { world.cleanup(); }
});

// ── Boundaries: what the worker must NEVER touch ─────────────────────────────
test("boundaries: delivered/approval-gated/non-DM-preference/receiptless-file jobs are untouched", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    const jobs = [
      orphanJob({ id: "j-delivered", status: "delivered", artifactPaths: [pdf], deliveryResult: { channelId: RHYS_DM_CHANNEL_ID, fileId: "F1" } }),
      orphanJob({ id: "j-approval-gate", status: "blocked_needs_approval", artifactPaths: [pdf] }),
      orphanJob({ id: "j-email-pref", preferredDelivery: "email", artifactPaths: [pdf] }),
      orphanJob({ id: "j-no-files", artifactPaths: [] }),
      orphanJob({ id: "j-file-missing", artifactPaths: [join(world.exportsRoot, "never-written.pdf")] }),
      orphanJob({ id: "j-wrong-channel", channel: "C999CLIENT", artifactPaths: [pdf] }),
      orphanJob({ id: "j-has-receipt", status: "artifact_ready", artifactPaths: [pdf], deliveryResult: { channelId: RHYS_DM_CHANNEL_ID, messageTs: "1.2" } }),
    ];
    world.writeJobs(jobs);
    const stub = makeSlackStub();

    assert.equal(findWorkerCandidates(jobs).length, 0);
    const summary = await runWorkerPass(workerOpts(world, stub));
    assert.equal(summary.candidates, 0);
    assert.equal(stub.sendCount(), 0);
    assert.deepEqual(world.readJobs().map((j) => j.status), jobs.map((j) => j.status), "no job status changed");
  } finally { world.cleanup(); }
});

test("boundaries: the gated send's root guard stays live through the worker (outside-root artifact parks, never sends)", async () => {
  const world = makeWorld();
  try {
    const outside = join(world.dir, "outside-root.pdf");
    writeFileSync(outside, "OUTSIDE");
    world.writeJobs([orphanJob({ artifactPaths: [outside] })]);
    const stub = makeSlackStub();

    await runWorkerPass(workerOpts(world, stub, { maxAttempts: 1 }));
    assert.equal(stub.sendCount(), 0, "root guard must reject before any Slack call");
    assert.equal(world.readJobs()[0].status, "blocked_needs_approval");
  } finally { world.cleanup(); }
});

test("safety: a corrupt jobs file is never overwritten by the worker", async () => {
  const world = makeWorld();
  try {
    writeFileSync(world.jobsPath, "{not-json!!");
    const stub = makeSlackStub();
    const summary = await runWorkerPass(workerOpts(world, stub));
    assert.equal(summary.scanned, 0);
    assert.equal(readFileSync(world.jobsPath, "utf8"), "{not-json!!", "corrupt file preserved byte-for-byte");
  } finally { world.cleanup(); }
});

// ── Review hardening regressions (adversarial findings, each pinned) ────────
test("audit: exports scan is fixture-scoped and NEVER a delivery source", async () => {
  const world = makeWorld();
  try {
    world.makeArtifact("untracked-orphan-export-branded.pdf"); // no job references it
    world.writeJobs([orphanJob({ id: "j-unrelated", status: "received", artifactPaths: [] })]);
    const stub = makeSlackStub();
    const summary = await runWorkerPass(workerOpts(world, stub));
    assert.equal(summary.untrackedExportGroups, 1, "audit must count exactly the fixture export");
    assert.equal(summary.candidates, 0);
    assert.equal(stub.sendCount(), 0, "an untracked export must NEVER be delivered (audit-only)");
  } finally { world.cleanup(); }
});

test("hardening: claim stolen mid-send aborts BEFORE the user-visible upload (no double DM)", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    const stub = makeSlackStub({ hooks: {
      "files.getUploadURLExternal": async () => {
        // A competing worker steals the claim while our send is in flight.
        const jobs = world.readJobs();
        jobs[0].deliveryClaim = { id: "competing-worker", at: new Date().toISOString() };
        world.writeJobs(jobs);
      },
    } });
    const summary = await runWorkerPass(workerOpts(world, stub));
    assert.equal(summary.aborted, 1, "must abort on claim loss");
    assert.equal(stub.sendCount(), 0, "completeUploadExternal must never fire after claim loss");
    assert.notEqual(world.readJobs()[0].status, "delivered");
  } finally { world.cleanup(); }
});

test("hardening: claim is heartbeat-renewed during a slow send so the TTL cannot expire mid-flight", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    const claimTtlMs = 250;
    let claimAgeAtUpload = null;
    const stub = makeSlackStub({ delayMs: 120, hooks: {
      "files.completeUploadExternal": async () => {
        const claim = world.readJobs()[0].deliveryClaim;
        claimAgeAtUpload = Date.now() - Date.parse(claim.at);
      },
    } });
    const summary = await runWorkerPass(workerOpts(world, stub, { claimTtlMs }));
    assert.equal(summary.delivered, 1);
    assert.ok(claimAgeAtUpload !== null && claimAgeAtUpload < claimTtlMs,
      `claim must be freshly renewed at the user-visible call (age ${claimAgeAtUpload}ms vs TTL ${claimTtlMs}ms)`);
  } finally { world.cleanup(); }
});

test("hardening: Slack accepted but the receipt append failed — delivered once, NEVER retried as a failed send", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    writeFileSync(world.ledgerPath, "");
    chmodSync(world.ledgerPath, 0o444); // receipt append will throw AFTER Slack accepts
    const stub = makeSlackStub();

    const first = await runWorkerPass(workerOpts(world, stub));
    assert.equal(first.delivered, 1, "post-complete recovery must count as delivered");
    assert.equal(first.failures + first.parked, 0, "post-complete errors are NEVER retryable failures");
    const job = world.readJobs()[0];
    assert.equal(job.status, "delivered");
    assert.equal(job.deliveredBy, "workspace-worker:post-complete-recovery");
    assert.ok(hasSlackDeliveryReceipt(job.deliveryResult));

    const second = await runWorkerPass(workerOpts(world, stub));
    assert.equal(second.candidates, 0);
    assert.equal(stub.sendCount(), 1, "exactly one send despite the bookkeeping failure");
  } finally { chmodSync(world.ledgerPath, 0o644); world.cleanup(); }
});

test("hardening: interrupted send (attempt journaled, no receipt anywhere) recovers from Slack history with ZERO resends", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    const job = orphanJob({ artifactPaths: [pdf], deliveryClaim: { id: "dead-worker", at: "2026-06-11T00:00:00.000Z" } });
    world.writeJobs([job]);
    const attemptAt = new Date(Date.now() - 60_000).toISOString();
    appendFileSync(attemptJournalPath(world.ledgerPath),
      `${JSON.stringify({ deliveryId: workerDeliveryIdForJob(job), jobId: job.id, claimId: "dead-worker", filename: "fixture-asset-branded.pdf", at: attemptAt })}\n`);
    const stub = makeSlackStub({ historyMessages: [
      { ts: String(Date.now() / 1000), files: [{ id: "F-PRIOR-CRASH", name: "fixture-asset-branded.pdf" }] },
    ] });

    const summary = await runWorkerPass(workerOpts(world, stub, { claimTtlMs: 1 }));
    assert.equal(summary.recoveredFromHistory, 1);
    assert.equal(stub.sendCount(), 0, "must NOT resend a delivery found in history");
    const finalized = world.readJobs()[0];
    assert.equal(finalized.status, "delivered");
    assert.equal(finalized.deliveryResult.fileId, "F-PRIOR-CRASH");
  } finally { world.cleanup(); }
});

test("hardening: a dry-run mock receipt in the ledger never finalizes a job", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    const job = orphanJob({ artifactPaths: [pdf] });
    world.writeJobs([job]);
    world.seedLedgerReceipt(workerDeliveryIdForJob(job), {
      channelId: RHYS_DM_CHANNEL_ID, fileId: "mock-file-id", messageTs: "mock-message-ts",
      metadata: { dryRun: true },
    });
    const stub = makeSlackStub();
    const summary = await runWorkerPass(workerOpts(world, stub));
    assert.equal(summary.reconciled, 0, "mock receipt must not reconcile");
    assert.equal(summary.delivered, 1, "a real send must happen instead");
    assert.equal(stub.sendCount(), 1);
    assert.notEqual(world.readJobs()[0].deliveryResult.fileId, "mock-file-id");
  } finally { world.cleanup(); }
});

test("safety: corruption appearing mid-pass aborts the pass without writing anything", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    world.writeJobs([orphanJob({ artifactPaths: [pdf] })]);
    const stub = makeSlackStub();
    const corruptingFileExists = (p) => { writeFileSync(world.jobsPath, "{broken-mid-pass"); return true; };
    await assert.rejects(
      runWorkerPass(workerOpts(world, stub, { fileExists: corruptingFileExists })),
      /refusing to write/,
    );
    assert.equal(readFileSync(world.jobsPath, "utf8"), "{broken-mid-pass", "corrupt file preserved");
    assert.equal(stub.sendCount(), 0);
  } finally { world.cleanup(); }
});

test("boundaries: pre-existing delivered jobs are byte-identical after a pass (receipts never re-modified)", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("fixture-asset-branded.pdf");
    const deliveredJob = orphanJob({
      id: "j-fully-delivered", status: "delivered",
      artifactPaths: [pdf],
      deliveryResult: { channelId: RHYS_DM_CHANNEL_ID, fileId: "F-DONE", messageTs: "1781.done" },
      deliveredAt: "2026-06-10T00:00:00.000Z",
    });
    world.writeJobs([deliveredJob]);
    const stub = makeSlackStub();
    await runWorkerPass(workerOpts(world, stub));
    assert.deepEqual(world.readJobs()[0], deliveredJob, "full record must be untouched, not just status");
    assert.equal(stub.sendCount(), 0);
  } finally { world.cleanup(); }
});
