import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  canTransitionSlackAssetJob,
  classifySlackRequest,
  findLatestDeliveryCandidate,
  hasSlackDeliveryReceipt,
  listSlackDmJobs,
  recordSlackDmJobDelivered,
  summarizeSlackDmJob,
  transitionSlackDmJob,
  updateSlackDmJob,
  upsertSlackDmJob,
} from "./slack-dm-jobs.mjs";
import {
  approvalBlockedArtifactText,
  assetWorkflowBlockedText,
  deliveryRequestedText,
  handoffSummaryForRequest,
  workspaceAckForRequest,
} from "./slack-listener-reply.mjs";

const RICKY_REQUEST = "yo i need a doc with links to every call we have done with ricky calder, the doc should have all the transcripts on the doc and all the strategical overviews please";

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), "slack-dm-jobs-test-"));
  return {
    filePath: join(dir, "slack-dm-jobs.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("Ricky Calder document request creates one needs_workspace ledger item and one safe ack max", () => {
  const t = tempLedger();
  try {
    const first = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1779668420.123456",
      userId: "U068FRX5423",
      text: RICKY_REQUEST,
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    assert.equal(first.created, true);
    assert.equal(first.job.sourceType, "slack");
    assert.equal(first.job.sourceChannel, "D0AM2R3H6SE");
    assert.equal(first.job.sourceTs, "1779668420.123456");
    assert.equal(first.job.requester, "U068FRX5423");
    assert.equal(first.job.classification, "document_request");

    const ack = workspaceAckForRequest();
    assert.match(ack, /no verified file exists yet/i);
    assert.doesNotMatch(ack, /I'll build|bring .*back.*ready|when it's ready/i);
    assert.doesNotMatch(ack, /<@|@Rhys/i);
    assert.doesNotMatch(ack, /flag it for review/i);
    assert.doesNotMatch(ack, /circle back/i);
    assert.doesNotMatch(ack, /Mission Control|not going to try|handoff/i);

    updateSlackDmJob(first.job.id, {
      status: "needs_workspace",
      replyText: ack,
      ackText: ack,
      handoffSummary: handoffSummaryForRequest({ text: RICKY_REQUEST, classification: first.job.classification }),
    }, { filePath: t.filePath });

    const repeat = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1779668420.123456",
      userId: "U068FRX5423",
      text: RICKY_REQUEST,
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    assert.equal(repeat.created, false);
    assert.equal(listSlackDmJobs({ filePath: t.filePath }).length, 1);
    assert.equal(repeat.job.status, "needs_workspace");
  } finally {
    t.cleanup();
  }
});


test("asset job ack records queued state without treating ack as done", () => {
  const t = tempLedger();
  try {
    const { job } = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1781000000.000001",
      userId: "U068FRX5423",
      text: "create an asset for the first 10k month as an online coach and make it a pdf",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    const ack = workspaceAckForRequest({ jobId: job.assetJobId, state: "queued" });
    transitionSlackDmJob(job.id, "queued", { ackText: ack, replyText: ack }, { filePath: t.filePath });

    const [queued] = listSlackDmJobs({ filePath: t.filePath });
    assert.equal(queued.status, "queued");
    assert.match(queued.ackText, /creating the asset now/);
    assert.doesNotMatch(queued.ackText, new RegExp(job.assetJobId));
    assert.doesNotMatch(queued.ackText, /state=queued|asset job|Done\.|sent here|Slack receipt/i);
    assert.doesNotMatch(queued.ackText, /when it's ready|bring .*back.*ready/i);
  } finally {
    t.cleanup();
  }
});

test("known asset workflow ledger reaches delivered only after Slack receipt", () => {
  const t = tempLedger();
  try {
    const { job } = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1781000000.000002",
      userId: "U068FRX5423",
      text: "create an asset for their first 10k as an online coach and return the pdf",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    transitionSlackDmJob(job.id, "queued", {}, { filePath: t.filePath });
    assert.equal(canTransitionSlackAssetJob("queued", "building"), true);
    transitionSlackDmJob(job.id, "building", { workflowKey: "first-10k-online-coach" }, { filePath: t.filePath });
    transitionSlackDmJob(job.id, "artifact_ready", {
      artifactPaths: ["/Users/atlasai/.openclaw/workspace/exports/2026-05-20-first-10k-month-bible-branded.pdf"],
    }, { filePath: t.filePath });
    transitionSlackDmJob(job.id, "delivery_requested", {}, { filePath: t.filePath });

    assert.equal(hasSlackDeliveryReceipt({ channelId: "D0AM2R3H6SE", fileId: "F_TEST" }), true);
    assert.throws(() => updateSlackDmJob(job.id, { status: "delivered" }, { filePath: t.filePath }), /without a Slack file\/message receipt/);

    recordSlackDmJobDelivered(job.id, {
      deliveryResult: {
        channelId: "D0AM2R3H6SE",
        fileId: "F_TEST",
        messageTs: "1781000000.123456",
        filename: "first-10k.pdf",
      },
    }, { filePath: t.filePath });

    const [delivered] = listSlackDmJobs({ filePath: t.filePath });
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.deliveryResult.fileId, "F_TEST");
    assert.match(summarizeSlackDmJob(delivered), /Slack confirmed the delivery/);
    assert.doesNotMatch(summarizeSlackDmJob(delivered), /F_TEST|Slack receipt|asset job|state=/i);
  } finally {
    t.cleanup();
  }
});

test("unknown asset workflow blocks honestly from the ledger", () => {
  const t = tempLedger();
  try {
    const { job } = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1781000000.000003",
      userId: "U068FRX5423",
      text: "create a generic branded PDF for a new offer we have never defined",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    transitionSlackDmJob(job.id, "queued", {}, { filePath: t.filePath });
    const reply = assetWorkflowBlockedText({
      jobId: job.assetJobId,
      reason: "I checked the asset registry, but I do not have a verified workflow for that asset yet.",
    });
    transitionSlackDmJob(job.id, "blocked", {
      replyText: reply,
      safeErrorSummary: "No verified Slack asset workflow matched this request.",
    }, { filePath: t.filePath });

    const [blocked] = listSlackDmJobs({ filePath: t.filePath });
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.replyText, /do not have a verified workflow/);
    assert.doesNotMatch(blocked.replyText, /asset-|asset job|state=|Done|attached|sent here/i);
  } finally {
    t.cleanup();
  }
});

test("status follow-up summaries report current asset job state immediately", () => {
  const t = tempLedger();
  try {
    const { job } = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1781000000.000004",
      userId: "U068FRX5423",
      text: "create an asset for the first 10k month as an online coach",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    transitionSlackDmJob(job.id, "queued", {}, { filePath: t.filePath });
    assert.match(summarizeSlackDmJob(listSlackDmJobs({ filePath: t.filePath })[0]), /queued from your Slack request/);

    transitionSlackDmJob(job.id, "building", { workflowKey: "first-10k-online-coach" }, { filePath: t.filePath });
    const summary = summarizeSlackDmJob(listSlackDmJobs({ filePath: t.filePath })[0]);
    assert.match(summary, /building it with/);
    assert.match(summary, /first-10k-online-coach/);
    assert.doesNotMatch(summary, /asset job|state=|live Slack reply window|operator review/i);
  } finally {
    t.cleanup();
  }
});

test("send it here maps to latest workspace request without repeating handoff", () => {
  const t = tempLedger();
  try {
    const first = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1779694536.697969",
      userId: "U068FRX5423",
      text: "create me a branded doc that gives people a score board for paid ads",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });
    updateSlackDmJob(first.job.id, {
      status: "needs_workspace",
      replyText: workspaceAckForRequest(),
      ackText: workspaceAckForRequest(),
    }, { filePath: t.filePath });

    const followup = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1779694772.445279",
      userId: "U068FRX5423",
      text: "yeah can you complete it and then send the completed doc here?",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    const candidate = findLatestDeliveryCandidate({
      channel: "D0AM2R3H6SE",
      userId: "U068FRX5423",
      excludeId: followup.job.id,
    }, { filePath: t.filePath });
    assert.equal(candidate.id, first.job.id);

    const reply = deliveryRequestedText();
    updateSlackDmJob(candidate.id, {
      status: "delivery_requested",
      deliveryRequestJobId: followup.job.id,
    }, { filePath: t.filePath });
    updateSlackDmJob(followup.job.id, {
      status: "delivery_requested",
      relatedJobId: candidate.id,
      replyText: reply,
    }, { filePath: t.filePath });

    const jobs = listSlackDmJobs({ filePath: t.filePath });
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find((job) => job.id === first.job.id).status, "delivery_requested");
    assert.equal(jobs.find((job) => job.id === followup.job.id).status, "delivery_requested");
    assert.doesNotMatch(reply, /Mission Control|handoff|@Rhys/i);
  } finally {
    t.cleanup();
  }
});

test("ready artifact plus send it here becomes approval-blocked delivery, not Mission Control", () => {
  const t = tempLedger();
  try {
    const ready = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1779694665.906239",
      userId: "U068FRX5423",
      text: "send it to me here",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });
    updateSlackDmJob(ready.job.id, {
      status: "artifact_ready",
      artifactPaths: ["/Users/atlasai/.openclaw/workspace/exports/paid-ads-scoreboard.pdf"],
    }, { filePath: t.filePath });

    const followup = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1779694772.445279",
      userId: "U068FRX5423",
      text: "just send it here",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    const candidate = findLatestDeliveryCandidate({
      channel: "D0AM2R3H6SE",
      userId: "U068FRX5423",
      excludeId: followup.job.id,
    }, { filePath: t.filePath });
    const reply = approvalBlockedArtifactText({ artifactPaths: candidate.artifactPaths });
    updateSlackDmJob(candidate.id, {
      status: "blocked_needs_approval",
      deliveryRequestJobId: followup.job.id,
      safeErrorSummary: "No approved Rhys-DM file delivery helper wired for automatic send.",
    }, { filePath: t.filePath });

    assert.equal(candidate.id, ready.job.id);
    assert.match(reply, /It's ready, but I need approval/);
    assert.match(reply, /paid-ads-scoreboard\.pdf/);
    assert.doesNotMatch(reply, /Mission Control|@Rhys/i);
    assert.match(summarizeSlackDmJob(listSlackDmJobs({ filePath: t.filePath })[0]), /approval/);
  } finally {
    t.cleanup();
  }
});

test("failure path is visible in reportable ledger state without filler", () => {
  const t = tempLedger();
  try {
    const { job } = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1779669000.000001",
      userId: "U068FRX5423",
      text: "reply to Caelan",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    updateSlackDmJob(job.id, {
      status: "failed",
      safeErrorSummary: "Gateway timed out before a usable reply.",
      replyText: "I picked this up, but it outgrew the live Slack reply window.",
    }, { filePath: t.filePath });

    const [failed] = listSlackDmJobs({ filePath: t.filePath });
    assert.equal(failed.status, "failed");
    assert.equal(failed.safeErrorSummary, "Gateway timed out before a usable reply.");
    assert.match(summarizeSlackDmJob(failed), /workspace time/);
    assert.match(summarizeSlackDmJob(failed), /no verified result exists yet/);
    assert.doesNotMatch(summarizeSlackDmJob(failed), /Gateway timed out|slackdm-|operator review/i);
    assert.doesNotMatch(failed.replyText, /flag it for review|circle back/i);
  } finally {
    t.cleanup();
  }
});

test("misrouted gateway replies stay visible as workspace job with Slack DM preference", () => {
  const t = tempLedger();
  try {
    const { job } = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1779669000.000002",
      userId: "U068FRX5423",
      text: "send me a client brief",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });

    updateSlackDmJob(job.id, {
      status: "needs_workspace_job",
      preferredDelivery: "slack_dm",
      safeErrorSummary: "Gateway selected email instead of the Slack DM delivery path.",
    }, { filePath: t.filePath });

    const [routed] = listSlackDmJobs({ filePath: t.filePath });
    assert.equal(routed.status, "needs_workspace_job");
    assert.equal(routed.preferredDelivery, "slack_dm");
    assert.match(summarizeSlackDmJob(routed), /Slack DM/);
  } finally {
    t.cleanup();
  }
});

test("classification covers main Slack request families", () => {
  assert.equal(classifySlackRequest(RICKY_REQUEST), "document_request");
  assert.equal(classifySlackRequest("send me a client brief"), "document_request");
  assert.equal(classifySlackRequest("run an audit for this Typeform"), "audit_request");
  assert.equal(classifySlackRequest("make 10 content hooks"), "content_request");
  assert.equal(classifySlackRequest("look up the latest notes"), "general_research");
});

test("parked workspace jobs summarize honestly without future-delivery promises", () => {
  const t = tempLedger();
  try {
    const { job } = upsertSlackDmJob({
      channel: "D0AM2R3H6SE",
      messageTs: "1780917689.297859",
      userId: "U068FRX5423",
      text: "create an asset for the first 10k month and return it as a pdf",
      sessionId: "slack-U068FRX5423",
    }, { filePath: t.filePath });
    updateSlackDmJob(job.id, {
      status: "needs_workspace",
      replyText: workspaceAckForRequest(),
      ackText: workspaceAckForRequest(),
    }, { filePath: t.filePath });

    const summary = summarizeSlackDmJob(listSlackDmJobs({ filePath: t.filePath })[0]);
    assert.match(summary, /no verified file exists yet/i);
    assert.doesNotMatch(summary, /bring .*back.*ready|when it's ready/i);
  } finally {
    t.cleanup();
  }
});

test("cross-writer serialization: listener-side helpers and worker-side mutateQueue never lose updates", async () => {
  const { execFile } = await import("node:child_process");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "dm-jobs-lock-"));
  try {
    const jobsPath = join(dir, "slack-dm-jobs.json");
    const ROUNDS = 25;
    writeFileSync(jobsPath, JSON.stringify([
      { id: "job-a", status: "received", counter: 0 },
      { id: "job-b", status: "received", counter: 0 },
    ], null, 2));

    const libDir = fileURLToPath(new URL(".", import.meta.url));
    // Child A: listener-style sync mutator (updateSlackDmJob, locked critical section).
    const driverA = join(dir, "driver-a.mjs");
    writeFileSync(driverA, `
import { updateSlackDmJob } from ${JSON.stringify(join(libDir, "slack-dm-jobs.mjs"))};
const jobsPath = process.argv[2];
for (let i = 1; i <= ${ROUNDS}; i += 1) {
  updateSlackDmJob("job-a", { counter: i, sideA: "round-" + i }, { filePath: jobsPath });
}
`);
    // Child B: worker-style async mutateQueue on the SAME file.
    const driverB = join(dir, "driver-b.mjs");
    writeFileSync(driverB, `
import { mutateQueue } from ${JSON.stringify(join(libDir, "queue-writer.mjs"))};
const jobsPath = process.argv[2];
for (let i = 1; i <= ${ROUNDS}; i += 1) {
  await mutateQueue((queue) => queue.map((j) => j.id === "job-b" ? { ...j, counter: i, sideB: "round-" + i } : j), { queuePath: jobsPath });
}
`);
    const run = (driver) => new Promise((resolveP, rejectP) => {
      execFile(process.execPath, [driver, jobsPath], { timeout: 60_000 },
        (err, stdout, stderr) => err ? rejectP(new Error(`${err.message}\n${stderr}`)) : resolveP());
    });

    await Promise.all([run(driverA), run(driverB)]);

    const final = JSON.parse(readFileSync(jobsPath, "utf8"));
    const jobA = final.find((j) => j.id === "job-a");
    const jobB = final.find((j) => j.id === "job-b");
    assert.equal(final.length, 2, "no job lost");
    assert.equal(jobA.counter, ROUNDS, "listener-side final write must survive worker-side writes");
    assert.equal(jobB.counter, ROUNDS, "worker-side final write must survive listener-side writes");
    assert.equal(jobA.sideA, `round-${ROUNDS}`);
    assert.equal(jobB.sideB, `round-${ROUNDS}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
