/**
 * COMBINED-SYSTEM PROOF for the listener/worker double-delivery race fix
 * (single-owner delivery, 2026-06-11) plus the two P2s:
 *   (i)  Slack-history-verify failures are counted and PARK visibly after
 *        max attempts; the daemon refuses to start without required scopes.
 *   (ii) every send input derives from the POST-CLAIM claimResult.job,
 *        never the pre-claim candidate snapshot.
 *
 * The "listener" side here is a simulator that performs EXACTLY the ledger
 * writes the rewritten listener performs (same lib calls, same fields, same
 * order) — bound to reality by the STATIC single-owner test, which proves
 * the real listener.mjs has no artifact-send call sites left at all.
 *
 * Runs ENTIRELY against fixtures in a temp dir: fake artifact files, a
 * Slack send STUB writing to a sends log, lib calls pointed at fixture
 * paths. It never reads or writes /Users/atlasai/.openclaw/data/*, never
 * touches live exports, never sends a real Slack message, never deploys.
 * Run: node --test tests/listener-worker-combined-proof.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  attemptJournalPath,
  findRecentFilenameReceipt,
  preflightWorkerScopes,
  runWorkerPass,
  workerDeliveryIdForJob,
  REQUIRED_WORKER_SCOPES,
} from "../openclaw-runtime/workspace/services/workspace-worker/worker.mjs";
import {
  findCarrierJobForArtifactGroup,
  hasSlackDeliveryReceipt,
  transitionSlackDmJob,
  updateSlackDmJob,
} from "../openclaw-runtime/workspace/lib/slack-dm-jobs.mjs";
import { RHYS_DM_CHANNEL_ID, RHYS_USER_ID } from "../openclaw-runtime/workspace/lib/slack-rhys-dm-artifact.mjs";

const WORKER_PATH = resolve("openclaw-runtime/workspace/services/workspace-worker/worker.mjs");
const LISTENER_PATH = resolve("openclaw-runtime/workspace/services/slack-listener/listener.mjs");

// ── Fixture world ────────────────────────────────────────────────────────────
function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "combined-proof-"));
  const exportsRoot = join(dir, "exports");
  mkdirSync(exportsRoot);
  const jobsPath = join(dir, "slack-dm-jobs.json");
  const ledgerPath = join(dir, "artifact-deliveries.jsonl");
  const sendsLog = join(dir, "sends.log");
  return {
    dir, exportsRoot, jobsPath, ledgerPath, sendsLog,
    makeArtifact(name, content = "FIXTURE-PDF-BYTES") {
      const p = join(exportsRoot, name);
      writeFileSync(p, content);
      return p;
    },
    writeJobs(jobs) { writeFileSync(jobsPath, JSON.stringify(jobs, null, 2)); },
    readJobs() { return JSON.parse(readFileSync(jobsPath, "utf8")); },
    readSends() {
      try { return readFileSync(sendsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
      catch { return []; }
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function baseJob(overrides = {}) {
  return {
    id: `slackdm-${RHYS_DM_CHANNEL_ID}-1781100000.000001`,
    assetJobId: "asset-combined01",
    channel: RHYS_DM_CHANNEL_ID,
    userId: RHYS_USER_ID,
    kind: "request",
    requestText: "build me the combined fixture asset pdf",
    status: "queued",
    preferredDelivery: "slack_dm",
    title: "Combined Fixture Asset",
    artifactPaths: [],
    createdAt: "2026-06-11T01:00:00.000Z",
    updatedAt: "2026-06-11T01:00:05.000Z",
    ...overrides,
  };
}

// Slack stub whose ONLY observable side effect is the sends log — every
// files.completeUploadExternal (the user-visible upload) appends one line.
function makeSlackStub(world, { historyError = null, failUploads = 0 } = {}) {
  let uploadCounter = 0;
  let pendingFilename = null;
  let remainingFailures = failUploads;
  const notices = [];
  return {
    notices,
    slackClient: async (method, body) => {
      if (method === "chat.postMessage") {
        notices.push({ channel: body.channel, text: body.text });
        return { ok: true, ts: "1781.notice" };
      }
      if (method === "conversations.open") {
        return { ok: true, channel: { id: RHYS_DM_CHANNEL_ID, user: RHYS_USER_ID } };
      }
      if (method === "files.getUploadURLExternal") {
        if (remainingFailures > 0) { remainingFailures -= 1; throw new Error("files.getUploadURLExternal failed: simulated_outage"); }
        uploadCounter += 1;
        pendingFilename = body.filename;
        return { ok: true, file_id: `F-CMB-${process.pid}-${uploadCounter}`, upload_url: "https://stub.invalid/upload" };
      }
      if (method === "files.completeUploadExternal") {
        const id = body.files[0].id;
        appendFileSync(world.sendsLog, `${JSON.stringify({
          pid: process.pid, fileId: id, filename: pendingFilename,
          title: body.files[0].title, caption: body.initial_comment,
        })}\n`);
        return { ok: true, files: [{ id, shares: { private: { [RHYS_DM_CHANNEL_ID]: [{ ts: `1781.${id}` }] } } }] };
      }
      if (method === "conversations.history") {
        if (historyError) throw new Error(historyError);
        return { ok: true, messages: [] };
      }
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

// ── Listener simulator — the EXACT ledger writes the rewritten listener makes ─
// Asset lane (listener.mjs site 3): building → artifact_ready (paths + pref)
// → delivery_requested (+ deliveryMessage). STOPS. No send.
function listenerSimAssetLaneEnqueue(world, jobId, { artifactPaths, title, message }) {
  const filePath = world.jobsPath;
  transitionSlackDmJob(jobId, "building", { buildStartedAt: new Date().toISOString() }, { filePath });
  transitionSlackDmJob(jobId, "artifact_ready", {
    title,
    artifactPaths,
    artifactReadyAt: new Date().toISOString(),
    preferredDelivery: "slack_dm",
  }, { filePath });
  try {
    transitionSlackDmJob(jobId, "delivery_requested", {
      deliveryRequestedAt: new Date().toISOString(),
      deliveryMessage: message,
    }, { filePath });
  } catch (transitionErr) {
    // Mirror of the listener's tolerance: the worker delivering inside the
    // window makes this transition illegal — that is success, not an error.
    const current = JSON.parse(readFileSync(filePath, "utf8")).find((j) => j.id === jobId);
    if (current?.status !== "delivered") throw transitionErr;
  }
}

// Delivery-followup lane (listener.mjs site 2): explicit go-ahead recorded,
// worker owns the upload.
function listenerSimFollowupEnqueue(world, deliveryJobId, requestJobId) {
  const filePath = world.jobsPath;
  const now = new Date().toISOString();
  updateSlackDmJob(deliveryJobId, {
    status: "delivery_requested",
    preferredDelivery: "slack_dm",
    deliveryRequestedAt: now,
    deliveryRequestJobId: requestJobId,
    deliveryMessage: "Done. I attached the file here.",
    workerAttempts: 0,
    workerVerifyFailures: 0,
  }, { filePath });
}

// ── STATIC single-owner: the real listener has NO artifact-send path left ───
test("STATIC: listener.mjs has zero artifact-send call sites; the worker is the only sender", () => {
  const listenerSrc = readFileSync(LISTENER_PATH, "utf8");
  const codeLines = listenerSrc.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  const code = codeLines.join("\n");
  assert.ok(!/sendRhysDmArtifact\s*\(/.test(code), "listener must not CALL sendRhysDmArtifact");
  assert.ok(!/\bsendRhysDmArtifact\b/.test(code), "listener must not even import sendRhysDmArtifact");
  assert.ok(!/\brecordSlackDmJobDelivered\b/.test(code), "listener must never mark jobs delivered itself");
  assert.ok(/delivery_requested/.test(code), "listener still queues delivery for the worker");

  const workerSrc = readFileSync(WORKER_PATH, "utf8");
  assert.ok(/sendRhysDmArtifact\s*\(/.test(workerSrc), "worker owns the gated send");
});

// ── THE COMBINED RACE: listener enqueues delivery_requested while two worker
//    processes poll the same window — EXACTLY ONE send, total, ever. ─────────
test("COMBINED-RACE: listener enqueue + two polling worker processes in the same window => exactly one send", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("combined-race-asset-branded.pdf");
    world.writeJobs([baseJob()]);

    // Worker driver: polls runWorkerPass in a tight loop (~StartInterval
    // compressed) so passes overlap the listener's enqueue mid-window.
    const driverPath = join(world.dir, "worker-driver.mjs");
    writeFileSync(driverPath, `
import { appendFileSync } from "node:fs";
import { runWorkerPass } from ${JSON.stringify(WORKER_PATH)};
const [jobsPath, ledgerPath, exportsRoot, sendsLog, passesArg] = process.argv.slice(2);
let uploadCounter = 0;
let pendingFilename = null;
const slackClient = async (method, body) => {
  if (method === "chat.postMessage") return { ok: true, ts: "1781.notice" };
  if (method === "conversations.open") return { ok: true, channel: { id: ${JSON.stringify(RHYS_DM_CHANNEL_ID)}, user: ${JSON.stringify(RHYS_USER_ID)} } };
  if (method === "files.getUploadURLExternal") {
    await new Promise((r) => setTimeout(r, 80)); // widen the claim→send window
    uploadCounter += 1; pendingFilename = body.filename;
    return { ok: true, file_id: "F-" + process.pid + "-" + uploadCounter, upload_url: "https://stub.invalid/upload" };
  }
  if (method === "files.completeUploadExternal") {
    appendFileSync(sendsLog, JSON.stringify({ pid: process.pid, fileId: body.files[0].id, filename: pendingFilename, caption: body.initial_comment }) + "\\n");
    return { ok: true, files: [{ id: body.files[0].id, shares: { private: { ${JSON.stringify(RHYS_DM_CHANNEL_ID)}: [{ ts: "1781.race" }] } } }] };
  }
  if (method === "conversations.history") return { ok: true, messages: [] };
  throw new Error("unexpected " + method);
};
const totals = { delivered: 0, reconciled: 0, conflicts: 0 };
for (let i = 0; i < Number(passesArg); i += 1) {
  const summary = await runWorkerPass({
    jobsPath, ledgerPath, exportsDir: exportsRoot, allowedRoots: [exportsRoot], token: "stub",
    slackClient, uploadFetch: async () => ({ ok: true }),
  });
  totals.delivered += summary.delivered;
  totals.reconciled += summary.reconciled;
  totals.conflicts += summary.conflicts;
  await new Promise((r) => setTimeout(r, 40));
}
console.log(JSON.stringify(totals));
`);

    const runDriver = () => new Promise((resolveP, rejectP) => {
      execFile(process.execPath, [driverPath, world.jobsPath, world.ledgerPath, world.exportsRoot, world.sendsLog, "12"],
        { timeout: 60_000 }, (err, stdout) => err ? rejectP(err) : resolveP(JSON.parse(stdout.trim().split("\n").pop())));
    });

    // Fire both polling workers, then the listener publishes the job INTO
    // the open window (mid-poll, like a real build finishing mid-interval).
    const workers = [runDriver(), runDriver()];
    await new Promise((r) => setTimeout(r, 150));
    listenerSimAssetLaneEnqueue(world, baseJob().id, {
      artifactPaths: [pdf],
      title: "Combined Fixture Asset",
      message: "Here is the verified Combined Fixture Asset.",
    });
    const [a, b] = await Promise.all(workers);

    const sends = world.readSends();
    assert.equal(sends.length, 1,
      `EXACTLY one send across listener+workers (got ${sends.length}; A=${JSON.stringify(a)} B=${JSON.stringify(b)})`);
    assert.equal(a.delivered + b.delivered, 1, "exactly one worker process delivers");
    const job = world.readJobs()[0];
    assert.equal(job.status, "delivered");
    assert.ok(hasSlackDeliveryReceipt(job.deliveryResult), "real receipt on the job");
    assert.match(job.deliveredBy, /^workspace-worker:/, "the worker — never the listener — delivered");
    assert.equal(sends[0].caption, "Here is the verified Combined Fixture Asset.",
      "the workflow's caption rode along via job.deliveryMessage");
  } finally { world.cleanup(); }
});

// ── P2-ii: send inputs come from the POST-CLAIM record, never the candidate ──
test("P2-POST-CLAIM: job mutated between scan and claim — worker sends the post-claim file/caption, once", async () => {
  const world = makeWorld();
  try {
    const pdfOld = world.makeArtifact("stale-pre-claim-branded.pdf");
    const pdfNew = world.makeArtifact("fresh-post-claim-branded.pdf");
    world.writeJobs([baseJob({
      status: "delivery_requested",
      artifactPaths: [pdfOld],
      title: "Stale Title",
      deliveryMessage: "stale caption",
    })]);

    // The scan sees pdfOld; before the claim lands, the "listener" rewrites
    // the job (new artifact, caption, title) — exactly the scan→claim window.
    let swapped = false;
    const fileExists = (p) => {
      if (!swapped) {
        swapped = true;
        const jobs = world.readJobs();
        jobs[0] = { ...jobs[0], artifactPaths: [pdfNew], title: "Fresh Title", deliveryMessage: "fresh caption" };
        world.writeJobs(jobs);
      }
      return true;
    };

    const stub = makeSlackStub(world);
    const summary = await runWorkerPass(workerOpts(world, stub, { fileExists }));

    const sends = world.readSends();
    assert.equal(summary.delivered, 1);
    assert.equal(sends.length, 1, "exactly one send");
    assert.equal(sends[0].filename, basename(pdfNew), "must upload the POST-claim artifact, not the stale candidate's");
    assert.equal(sends[0].caption, "fresh caption", "must use the POST-claim caption");
    assert.match(sends[0].title, /Fresh Title/, "must use the POST-claim title");
  } finally { world.cleanup(); }
});

// ── P2-i (a): history-verify failures count and PARK visibly ─────────────────
test("P2-VERIFY-PARK: repeated history-verify failures park the job visibly after max attempts, zero sends", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("verify-park-asset-branded.pdf");
    const job = baseJob({ status: "delivery_requested", artifactPaths: [pdf] });
    world.writeJobs([job]);
    // A prior attempt with no receipt forces the verify path every pass.
    appendFileSync(attemptJournalPath(world.ledgerPath),
      `${JSON.stringify({ deliveryId: workerDeliveryIdForJob(job), jobId: job.id, claimId: "dead-worker", filename: basename(pdf), at: "2026-06-11T00:30:00.000Z" })}\n`);
    const stub = makeSlackStub(world, { historyError: "conversations.history failed: missing_scope" });

    const first = await runWorkerPass(workerOpts(world, stub, { maxAttempts: 3 }));
    const second = await runWorkerPass(workerOpts(world, stub, { maxAttempts: 3 }));
    assert.equal(first.failures + second.failures, 2, "verify failures are counted, not ignored");
    assert.equal(world.readJobs()[0].workerVerifyFailures, 2, "failure count persists on the job");
    assert.equal(world.readJobs()[0].deliveryClaim, null, "claim released between passes");

    const third = await runWorkerPass(workerOpts(world, stub, { maxAttempts: 3 }));
    assert.equal(third.parked, 1, "third failure parks");
    const parked = world.readJobs()[0];
    assert.equal(parked.status, "blocked_needs_approval", "VISIBLE operator state, not a silent retry loop");
    assert.match(parked.safeErrorSummary, /could not verify whether an earlier send already reached Rhys/);
    assert.equal(parked.workerVerifyFailures, 3);
    assert.equal(world.readSends().length, 0, "NEVER sends while unable to verify a possible prior send");

    const fourth = await runWorkerPass(workerOpts(world, stub, { maxAttempts: 3 }));
    assert.equal(fourth.candidates, 0, "parked job is not picked up again");
  } finally { world.cleanup(); }
});

// ── P2-i (b): scope preflight refuses to run ─────────────────────────────────
test("P2-PREFLIGHT: missing conversations.history/files scopes => the pass refuses to run, zero claims, zero sends", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("preflight-asset-branded.pdf");
    world.writeJobs([baseJob({ status: "delivery_requested", artifactPaths: [pdf] })]);
    const before = JSON.stringify(world.readJobs());

    const verdict = await preflightWorkerScopes({ getScopes: async () => ["im:write", "files:write"] });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.missing, ["im:history"], "exactly the missing scope is named");

    const stub = makeSlackStub(world);
    const refused = await runWorkerPass(workerOpts(world, stub, {
      preflight: { getScopes: async () => ["im:write", "files:write"] },
    }));
    assert.equal(refused.preflight.ok, false);
    assert.equal(refused.scanned, 0, "nothing scanned");
    assert.equal(refused.candidates, 0, "nothing claimed");
    assert.equal(world.readSends().length, 0, "nothing sent");
    assert.equal(JSON.stringify(world.readJobs()), before, "jobs ledger byte-identical");

    // Unprovable scopes (auth.test unreachable) also refuse — never assume.
    const unprovable = await preflightWorkerScopes({ getScopes: async () => { throw new Error("auth.test unreachable"); } });
    assert.equal(unprovable.ok, false);
    assert.deepEqual(unprovable.missing, REQUIRED_WORKER_SCOPES);
    assert.match(unprovable.error, /unreachable/);

    // Full set passes.
    const good = await preflightWorkerScopes({ getScopes: async () => [...REQUIRED_WORKER_SCOPES, "chat:write"] });
    assert.equal(good.ok, true);
  } finally { world.cleanup(); }
});

test("P2-PREFLIGHT-DAEMON: worker.mjs as a process refuses to start without a provable token (exit 78, no network)", async () => {
  const result = await new Promise((resolveP) => {
    execFile(process.execPath, [WORKER_PATH], {
      timeout: 30_000,
      env: { ...process.env, SLACK_BOT_TOKEN: "" },
    }, (err, stdout) => resolveP({ code: err?.code ?? 0, stdout: String(stdout) }));
  });
  assert.equal(result.code, 78, "EX_CONFIG refusal");
  assert.match(result.stdout, /REFUSING TO RUN/);
  assert.match(result.stdout, /im:history/);
});

// ── SAME-ASSET GUARD: two pending jobs, one file — Rhys gets it once ─────────
test("SAME-ASSET: two pending jobs referencing the same artifact => exactly one upload, both jobs terminal", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("shared-asset-branded.pdf");
    world.writeJobs([
      baseJob({ id: `slackdm-${RHYS_DM_CHANNEL_ID}-1781100000.000010`, status: "delivery_requested", artifactPaths: [pdf], createdAt: "2026-06-11T01:00:00.000Z" }),
      baseJob({ id: `slackdm-${RHYS_DM_CHANNEL_ID}-1781100000.000020`, status: "delivery_requested", artifactPaths: [pdf], createdAt: "2026-06-11T01:00:01.000Z" }),
    ]);
    const stub = makeSlackStub(world);

    const summary = await runWorkerPass(workerOpts(world, stub));

    const sends = world.readSends();
    assert.equal(sends.length, 1, "the shared file is uploaded EXACTLY once");
    assert.equal(summary.delivered, 1);
    assert.equal(summary.reconciled, 1, "the second job reconciles onto the first send's receipt");
    const jobs = world.readJobs();
    assert.deepEqual(jobs.map((j) => j.status), ["delivered", "delivered"], "both asks satisfied");
    assert.equal(jobs[0].deliveryResult.fileId, jobs[1].deliveryResult.fileId, "one Slack file serves both");
    const vias = jobs.map((j) => j.deliveredBy).sort();
    assert.deepEqual(vias, ["workspace-worker:duplicate-path-reconcile", "workspace-worker:send"]);
  } finally { world.cleanup(); }
});

// ── FOLLOW-UP LANE: the follow-up authorizes; the worker delivers ────────────
test("COMBINED-FOLLOWUP: orphan not deliverable until the follow-up enqueues it; then the worker sends once with the follow-up caption", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("followup-orphan-branded.pdf");
    const orphan = baseJob({
      id: `slackdm-${RHYS_DM_CHANNEL_ID}-1781100000.000030`,
      status: "needs_workspace_job",
      preferredDelivery: "manual_review",
      artifactPaths: [pdf],
      safeErrorSummary: "failure_type=timeout | summary=Live Slack agent window timed out",
    });
    world.writeJobs([orphan]);
    const stub = makeSlackStub(world);

    // Before the follow-up: not a candidate (no slack_dm preference).
    const idle = await runWorkerPass(workerOpts(world, stub));
    assert.equal(idle.candidates, 0);
    assert.equal(world.readSends().length, 0);

    // Rhys says "send it here" — the listener records the go-ahead and stops.
    listenerSimFollowupEnqueue(world, orphan.id, "slackdm-followup-request-job");

    const active = await runWorkerPass(workerOpts(world, stub));
    assert.equal(active.delivered, 1);
    const sends = world.readSends();
    assert.equal(sends.length, 1, "exactly one send, made by the worker");
    assert.equal(sends[0].caption, "Done. I attached the file here.");
    const job = world.readJobs()[0];
    assert.equal(job.status, "delivered");
    assert.equal(job.deliveryRequestJobId, "slackdm-followup-request-job", "audit trail links the follow-up");
  } finally { world.cleanup(); }
});

// ── SAME-ASSET under PROCESS concurrency: two jobs, one file, two workers ───
test("SAME-ASSET-CONCURRENT: two jobs sharing one file + two racing worker processes => exactly one upload", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("shared-concurrent-branded.pdf");
    world.writeJobs([
      baseJob({ id: `slackdm-${RHYS_DM_CHANNEL_ID}-1781100000.000040`, status: "delivery_requested", artifactPaths: [pdf], createdAt: "2026-06-11T01:00:00.000Z" }),
      baseJob({ id: `slackdm-${RHYS_DM_CHANNEL_ID}-1781100000.000041`, status: "delivery_requested", artifactPaths: [pdf], createdAt: "2026-06-11T01:00:01.000Z" }),
    ]);

    const driverPath = join(world.dir, "concurrent-driver.mjs");
    writeFileSync(driverPath, `
import { appendFileSync } from "node:fs";
import { runWorkerPass } from ${JSON.stringify(WORKER_PATH)};
const [jobsPath, ledgerPath, exportsRoot, sendsLog] = process.argv.slice(2);
let n = 0; let pendingFilename = null;
const slackClient = async (method, body) => {
  if (method === "chat.postMessage") return { ok: true, ts: "1781.notice" };
  if (method === "conversations.open") return { ok: true, channel: { id: ${JSON.stringify(RHYS_DM_CHANNEL_ID)}, user: ${JSON.stringify(RHYS_USER_ID)} } };
  if (method === "files.getUploadURLExternal") {
    await new Promise((r) => setTimeout(r, 120)); // hold the window open so both processes are mid-send together
    n += 1; pendingFilename = body.filename;
    return { ok: true, file_id: "F-" + process.pid + "-" + n, upload_url: "https://stub.invalid/upload" };
  }
  if (method === "files.completeUploadExternal") {
    appendFileSync(sendsLog, JSON.stringify({ pid: process.pid, fileId: body.files[0].id, filename: pendingFilename }) + "\\n");
    return { ok: true, files: [{ id: body.files[0].id, shares: { private: { ${JSON.stringify(RHYS_DM_CHANNEL_ID)}: [{ ts: "1781.cc" }] } } }] };
  }
  if (method === "conversations.history") return { ok: true, messages: [] };
  throw new Error("unexpected " + method);
};
for (let i = 0; i < 6; i += 1) {
  await runWorkerPass({ jobsPath, ledgerPath, exportsDir: exportsRoot, allowedRoots: [exportsRoot], token: "stub", slackClient, uploadFetch: async () => ({ ok: true }) });
  await new Promise((r) => setTimeout(r, 30));
}
console.log("done");
`);
    const runDriver = () => new Promise((resolveP, rejectP) => {
      execFile(process.execPath, [driverPath, world.jobsPath, world.ledgerPath, world.exportsRoot, world.sendsLog],
        { timeout: 60_000 }, (err) => err ? rejectP(err) : resolveP(null));
    });
    await Promise.all([runDriver(), runDriver()]);

    const sends = world.readSends();
    assert.equal(sends.length, 1, `one file, one upload — even across racing processes (got ${sends.length})`);
    const jobs = world.readJobs();
    assert.deepEqual(jobs.map((j) => j.status), ["delivered", "delivered"], "both jobs reach terminal state");
    assert.equal(jobs[0].deliveryResult.fileId, jobs[1].deliveryResult.fileId, "one Slack file serves both");
  } finally { world.cleanup(); }
});

// ── Park is VISIBLE to Rhys: the standing promise gets corrected ─────────────
test("PARK-NOTIFY: a job that parks tells Rhys honestly (one notice, zero uploads)", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("park-notify-branded.pdf");
    world.writeJobs([baseJob({ status: "delivery_requested", artifactPaths: [pdf] })]);
    const stub = makeSlackStub(world, { failUploads: 99 });

    const summary = await runWorkerPass(workerOpts(world, stub, { maxAttempts: 1 }));

    assert.equal(summary.parked, 1);
    assert.equal(world.readJobs()[0].status, "blocked_needs_approval");
    assert.equal(world.readSends().length, 0, "no upload happened");
    assert.equal(stub.notices.length, 1, "exactly one park notice to Rhys");
    assert.equal(stub.notices[0].channel, RHYS_DM_CHANNEL_ID);
    assert.match(stub.notices[0].text, /has not been sent/);
    assert.ok(!/\/Users\//.test(stub.notices[0].text) && !/slackdm-/.test(stub.notices[0].text), "TR-6 clean");
  } finally { world.cleanup(); }
});

// ── Carrier matching is by artifact GROUP, not exact path ───────────────────
test("CARRIER-GROUP: a pending job carrying a sibling format of the resolved group IS the carrier (kills the two-filename double-send)", () => {
  const mdJob = baseJob({ id: "j-md", status: "needs_workspace_job", artifactPaths: ["/x/exports/vsl-handover.md"] });
  const otherJob = baseJob({ id: "j-other", status: "queued", artifactPaths: ["/x/exports/unrelated.pdf"] });
  const deliveredJob = baseJob({ id: "j-done", status: "delivered", artifactPaths: ["/x/exports/vsl-handover.md"] });
  const groupPaths = ["/x/exports/vsl-handover.pdf", "/x/exports/vsl-handover.md"];

  const carrier = findCarrierJobForArtifactGroup([deliveredJob, otherJob, mdJob], {
    channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID, excludeId: "j-new", groupPaths,
  });
  assert.equal(carrier?.id, "j-md", "the .md orphan is the carrier for the .pdf-preferring group");

  assert.equal(findCarrierJobForArtifactGroup([deliveredJob, otherJob], {
    channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID, excludeId: "j-new", groupPaths,
  }), null, "delivered jobs and non-overlapping jobs are never carriers");
});

// ── Non-Rhys wall: queued-looking jobs for anyone but Rhys are never sent ───
test("BOUNDARY: delivery_requested for a non-Rhys user/channel is never claimed or sent by the worker", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("not-rhys-asset-branded.pdf");
    world.writeJobs([
      baseJob({ id: "j-wrong-user", status: "delivery_requested", userId: "U_DANTE", artifactPaths: [pdf] }),
      baseJob({ id: "j-wrong-channel", status: "delivery_requested", channel: "D_OTHER_DM", artifactPaths: [pdf] }),
    ]);
    const stub = makeSlackStub(world);
    const summary = await runWorkerPass(workerOpts(world, stub));
    assert.equal(summary.candidates, 0, "neither job is a candidate");
    assert.equal(world.readSends().length, 0, "nothing is ever uploaded for non-Rhys jobs");
    assert.deepEqual(world.readJobs().map((j) => j.status), ["delivery_requested", "delivery_requested"], "untouched for operator triage");
  } finally { world.cleanup(); }
});

// ── Same-asset guard unit edges: old receipts never block a real re-ask ──────
test("SAME-ASSET edges: a receipt OLDER than the job never matches; dry-run/mock receipts never match", () => {
  const receiptEvent = (overrides = {}) => ({
    eventType: "delivery_state", status: "delivered", deliveryId: "art_x",
    channelId: RHYS_DM_CHANNEL_ID, fileId: "F-OLD", messageTs: "1781.old",
    eventAt: "2026-06-10T00:00:00.000Z", metadata: { filename: "doc.pdf" },
    ...overrides,
  });
  // Receipt predates the job → Rhys asked again later → must NOT match.
  assert.equal(findRecentFilenameReceipt([receiptEvent()], "doc.pdf", "2026-06-11T00:00:00.000Z"), null);
  // Receipt after the job was created → satisfies the ask → matches.
  assert.ok(findRecentFilenameReceipt([receiptEvent({ eventAt: "2026-06-11T02:00:00.000Z" })], "doc.pdf", "2026-06-11T00:00:00.000Z"));
  // Mock/dry-run receipts never match.
  assert.equal(findRecentFilenameReceipt([receiptEvent({ eventAt: "2026-06-11T02:00:00.000Z", fileId: "mock-file-id" })], "doc.pdf", "2026-06-11T00:00:00.000Z"), null);
  assert.equal(findRecentFilenameReceipt([receiptEvent({ eventAt: "2026-06-11T02:00:00.000Z", metadata: { filename: "doc.pdf", dryRun: true } })], "doc.pdf", "2026-06-11T00:00:00.000Z"), null);
});
