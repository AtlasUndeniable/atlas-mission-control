/**
 * PROOF HARNESS — stateful retrieval disambiguation (F3.1).
 *
 * Replays the EXACT live failure of 2026-06-12: retrieval offered candidates
 * ("which one?"), Rhys picked "first 10k month bible", and the stateless flow
 * dropped the pick into the gateway timeout lane ("needs workspace time, no
 * verified file exists yet") — about a file already found on disk.
 *
 * Runs ENTIRELY against temp fixtures: fixture jobs ledger, fixture pending
 * store, fixture artifacts, Slack send STUB in the worker. No live ledger,
 * no Slack, no deploy. The pick path and the clean-match path share ONE
 * enqueue (enqueueRetrievalCarrier), so proving it here proves the listener
 * path; a static test pins the listener wiring.
 *
 * Run: node --test tests/retrieval-disambiguation-proof.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  clearPendingDisambiguation,
  enqueueRetrievalCarrier,
  readPendingDisambiguation,
  resolveDisambiguationPick,
  setPendingDisambiguation,
  DEFAULT_DISAMBIGUATION_TTL_MS,
} from "../openclaw-runtime/workspace/lib/slack-retrieval-pending.mjs";
import { runWorkerPass } from "../openclaw-runtime/workspace/services/workspace-worker/worker.mjs";
import { liveTimeoutHandoffText } from "../openclaw-runtime/workspace/lib/slack-listener-reply.mjs";
import { RHYS_DM_CHANNEL_ID, RHYS_USER_ID } from "../openclaw-runtime/workspace/lib/slack-rhys-dm-artifact.mjs";

const LISTENER_PATH = resolve("openclaw-runtime/workspace/services/slack-listener/listener.mjs");

// ── Fixture world ────────────────────────────────────────────────────────────
function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "disambig-proof-"));
  const exportsRoot = join(dir, "exports");
  mkdirSync(exportsRoot);
  const jobsPath = join(dir, "slack-dm-jobs.json");
  const pendingPath = join(dir, "retrieval-pending.json");
  const ledgerPath = join(dir, "artifact-deliveries.jsonl");
  const sendsLog = join(dir, "sends.log");
  return {
    dir, exportsRoot, jobsPath, pendingPath, ledgerPath, sendsLog,
    makeArtifact(name) {
      const p = join(exportsRoot, name);
      writeFileSync(p, "FIXTURE-PDF-BYTES");
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

function requestJob(id, text, overrides = {}) {
  return {
    id, assetJobId: `asset-${id}`,
    channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID,
    kind: "request", requestText: text, originalMessage: text,
    status: "received", artifactPaths: [],
    createdAt: "2026-06-12T09:00:00.000Z", updatedAt: "2026-06-12T09:00:00.000Z",
    ...overrides,
  };
}

// Worker Slack stub — every completeUploadExternal appends to sends.log.
function makeWorkerStub(world) {
  let pendingFilename = null;
  let n = 0;
  return {
    slackClient: async (method, body) => {
      if (method === "chat.postMessage") return { ok: true, ts: "1781.notice" };
      if (method === "conversations.open") return { ok: true, channel: { id: RHYS_DM_CHANNEL_ID, user: RHYS_USER_ID } };
      if (method === "files.getUploadURLExternal") {
        n += 1; pendingFilename = body.filename;
        return { ok: true, file_id: `F-DIS-${n}`, upload_url: "https://stub.invalid/upload" };
      }
      if (method === "files.completeUploadExternal") {
        writeFileSync(world.sendsLog, `${readSendsRaw(world)}${JSON.stringify({ fileId: body.files[0].id, filename: pendingFilename, caption: body.initial_comment })}\n`);
        return { ok: true, files: [{ id: body.files[0].id, shares: { private: { [RHYS_DM_CHANNEL_ID]: [{ ts: "1781.dis" }] } } }] };
      }
      if (method === "conversations.history") return { ok: true, messages: [] };
      throw new Error(`stub: unexpected ${method}`);
    },
    uploadFetch: async () => ({ ok: true }),
  };
}
function readSendsRaw(world) {
  try { return readFileSync(world.sendsLog, "utf8"); } catch { return ""; }
}

async function workerDeliver(world) {
  const stub = makeWorkerStub(world);
  return runWorkerPass({
    jobsPath: world.jobsPath,
    ledgerPath: world.ledgerPath,
    exportsDir: world.exportsRoot,
    allowedRoots: [world.exportsRoot],
    token: "stub-token",
    slackClient: stub.slackClient,
    uploadFetch: stub.uploadFetch,
  });
}

// The candidates from the live incident shape: the 10k bible + siblings.
function liveCandidates(world) {
  return [
    { artifactKey: "first-10k-month-bible-branded", title: "First 10K Month Bible", artifactPaths: [world.makeArtifact("2026-05-20-first-10k-month-bible-branded.pdf")] },
    { artifactKey: "first-10k-month-checklist-branded", title: "First 10K Month Checklist", artifactPaths: [world.makeArtifact("2026-05-22-first-10k-month-checklist-branded.pdf")] },
    { artifactKey: "lead-nurture-playbook-branded", title: "Lead Nurture Playbook", artifactPaths: [world.makeArtifact("2026-04-10-lead-nurture-playbook-branded.pdf")] },
  ];
}

const PENDING_OPTS = (world, nowIso = "2026-06-12T09:01:00.000Z") => ({
  filePath: world.pendingPath,
  now: () => new Date(nowIso),
});

// ── THE REPLAY: ambiguous -> "which one?" -> pick -> worker delivers ─────────
test("REPLAY: the live failure now resolves — pick queues the chosen file and the worker delivers it", async () => {
  const world = makeWorld();
  try {
    const candidates = liveCandidates(world);
    // 1. retrieval went ambiguous: the offer is persisted (listener ambiguous branch)
    world.writeJobs([requestJob("slackdm-offer", "find the first 10k doc and send it here", { status: "answered" })]);
    setPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID, candidates, offerJobId: "slackdm-offer" }, PENDING_OPTS(world));

    // 2. Rhys's EXACT pick arrives as a new message/job
    const pickText = "first 10k month bible";
    const jobs = world.readJobs();
    jobs.push(requestJob("slackdm-pick", pickText));
    world.writeJobs(jobs);

    // 3. the listener seam: live offer found, pick resolved
    const pending = readPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID }, PENDING_OPTS(world));
    assert.ok(pending, "the offer must be remembered");
    const pick = resolveDisambiguationPick(pickText, pending.candidates);
    assert.equal(pick.kind, "match", `the live pick must resolve (got ${JSON.stringify(pick)})`);
    assert.equal(pick.candidate.title, "First 10K Month Bible", "and to the RIGHT candidate");

    clearPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID }, PENDING_OPTS(world));
    const { carrierId } = enqueueRetrievalCarrier({
      requestJobId: "slackdm-pick",
      channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID,
      artifactPath: pick.candidate.artifactPaths[0],
      groupPaths: pick.candidate.artifactPaths,
      title: pick.candidate.title,
      message: "Found it. I attached it here.",
      fileExists: existsSync,
    }, { jobsPath: world.jobsPath });

    // 4. the live worker delivers via the single-owner path
    const summary = await workerDeliver(world);
    assert.equal(summary.delivered, 1, "the worker delivers the pick");
    const sends = world.readSends();
    assert.equal(sends.length, 1, "exactly one upload");
    assert.equal(sends[0].filename, "2026-05-20-first-10k-month-bible-branded.pdf", "the CHOSEN file, not a sibling");

    const carrier = world.readJobs().find((j) => j.id === carrierId);
    assert.equal(carrier.status, "delivered");
    // the failure text Rhys actually saw must be nowhere in this flow
    const everything = JSON.stringify(world.readJobs()) + JSON.stringify(sends);
    assert.ok(!everything.includes(liveTimeoutHandoffText()), "the timeout text never appears");
    // and the offer is consumed
    assert.equal(readPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID }, PENDING_OPTS(world)), null);
  } finally { world.cleanup(); }
});

test("REPLAY-2: a pick matching nothing clears the offer and falls through cleanly", () => {
  const world = makeWorld();
  try {
    setPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID, candidates: liveCandidates(world) }, PENDING_OPTS(world));
    const pick = resolveDisambiguationPick("actually can you check my calendar for tomorrow", liveCandidates(world));
    assert.equal(pick.kind, "none", "unrelated message must not match any candidate");
    clearPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID }, PENDING_OPTS(world));
    assert.equal(readPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID }, PENDING_OPTS(world)), null);
  } finally { world.cleanup(); }
});

test("REPLAY-3: clean single-match retrieval delivers through the worker (post-F2.1 path intact)", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("2026-06-01-vsl-framework-handover-branded.pdf");
    world.writeJobs([requestJob("slackdm-clean", "find the vsl framework handover doc and send it here")]);
    const { carrierId, usedExistingCarrier } = enqueueRetrievalCarrier({
      requestJobId: "slackdm-clean",
      channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID,
      artifactPath: pdf, groupPaths: [pdf],
      title: "VSL Framework Handover", message: "Found it. I attached it here.",
      fileExists: existsSync,
    }, { jobsPath: world.jobsPath });
    assert.equal(usedExistingCarrier, false);
    const summary = await workerDeliver(world);
    assert.equal(summary.delivered, 1);
    assert.equal(world.readSends().length, 1);
    assert.equal(world.readJobs().find((j) => j.id === carrierId).status, "delivered");
  } finally { world.cleanup(); }
});

// ── Pick resolution edges ────────────────────────────────────────────────────
test("PICK: exact echo, natural short picks, tie, and nonsense behave deterministically", () => {
  const world = makeWorld();
  try {
    const candidates = liveCandidates(world);
    assert.equal(resolveDisambiguationPick("first 10k month bible", candidates).candidate?.title, "First 10K Month Bible");
    // R2: natural single-token picks resolve — "none" here was the re-brick hole
    assert.equal(resolveDisambiguationPick("the bible", candidates).candidate?.title, "First 10K Month Bible");
    assert.equal(resolveDisambiguationPick("the bible one please", candidates).candidate?.title, "First 10K Month Bible");
    assert.equal(resolveDisambiguationPick("the checklist", candidates).candidate?.title, "First 10K Month Checklist");
    const tie = resolveDisambiguationPick("first 10k month", candidates);
    assert.equal(tie.kind, "still_ambiguous", "shared-prefix pick stays ambiguous");
    assert.equal(tie.candidates.length, 2, "narrowed to the two 10k candidates");
    assert.equal(resolveDisambiguationPick("lead nurture playbook", candidates).candidate?.title, "Lead Nurture Playbook");
    assert.equal(resolveDisambiguationPick("xyzzy", candidates).kind, "none");
  } finally { world.cleanup(); }
});

test("R2-WRONG-CANDIDATE: a generic short name can never hijack a pick that names the specific sibling", () => {
  const offers = [
    { pair: [{ artifactKey: "offer-branded", title: "Offer", artifactPaths: ["/x/offer.pdf"] }, { artifactKey: "offer-letter-template-branded", title: "Offer Letter Template", artifactPaths: ["/x/offer-letter.pdf"] }], pick: "the offer letter", want: "Offer Letter Template" },
    { pair: [{ artifactKey: "playbook-branded", title: "Playbook", artifactPaths: ["/x/pb.pdf"] }, { artifactKey: "playbook-quick-summary-branded", title: "Playbook Quick Summary", artifactPaths: ["/x/pbs.pdf"] }], pick: "the playbook summary", want: "Playbook Quick Summary" },
    { pair: [{ artifactKey: "onboarding-guide-branded", title: "Onboarding Guide", artifactPaths: ["/x/og.pdf"] }, { artifactKey: "onboarding-guide-for-new-coaches-branded", title: "Onboarding Guide for New Coaches", artifactPaths: ["/x/ogc.pdf"] }], pick: "the onboarding guide for coaches", want: "Onboarding Guide for New Coaches" },
  ];
  for (const { pair, pick, want } of offers) {
    const result = resolveDisambiguationPick(pick, pair);
    assert.equal(result.kind, "match", `${pick} must resolve`);
    assert.equal(result.candidate.title, want, `"${pick}" must pick the SPECIFIC candidate, never the generic one`);
  }
  // a bare generic token shared by both stays ambiguous — re-ask, never guess
  const bare = resolveDisambiguationPick("offer", offers[0].pair);
  assert.equal(bare.kind, "still_ambiguous");
});

test("R2-TITLE: a reused carrier delivers under the PICK's name, not the carrier's old label", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("relabel-check-branded.pdf");
    world.writeJobs([
      requestJob("slackdm-old", "old unrelated ask", { status: "needs_workspace_job", artifactPaths: [pdf], title: "Client Invoice Bundle", preferredDelivery: "manual_review" }),
      requestJob("slackdm-pick4", "relabel check"),
    ]);
    enqueueRetrievalCarrier({
      requestJobId: "slackdm-pick4", channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID,
      artifactPath: pdf, groupPaths: [pdf], title: "Relabel Check", message: "Found it.",
      fileExists: existsSync,
    }, { jobsPath: world.jobsPath });
    const carrier = world.readJobs().find((j) => j.id === "slackdm-old");
    assert.equal(carrier.title, "Relabel Check", "the resolved name wins over the stale carrier label");
  } finally { world.cleanup(); }
});

test("R2-KEY: a '|' in channel or user ids cannot collide pending keys", () => {
  const world = makeWorld();
  try {
    setPendingDisambiguation({ channel: "A|B", userId: "C", candidates: liveCandidates(world) }, PENDING_OPTS(world));
    assert.equal(readPendingDisambiguation({ channel: "A", userId: "B|C" }, PENDING_OPTS(world)), null, "crafted ids never read another key's offer");
  } finally { world.cleanup(); }
});

test("PICK: collapsed exact-name echo wins even when token scoring would tie", () => {
  const candidates = [
    { artifactKey: "q2-offer-doc", title: "Q2 Offer Doc", artifactPaths: ["/x/a.pdf"] },
    { artifactKey: "q2-offer-deck", title: "Q2 Offer Deck", artifactPaths: ["/x/b.pdf"] },
  ];
  const pick = resolveDisambiguationPick("q2 offer deck", candidates);
  assert.equal(pick.kind, "match");
  assert.equal(pick.candidate.artifactKey, "q2-offer-deck");
});

// ── State isolation + TTL ────────────────────────────────────────────────────
test("STATE: offers are keyed by channel+user — no cross-user or cross-channel leak", () => {
  const world = makeWorld();
  try {
    setPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID, candidates: liveCandidates(world) }, PENDING_OPTS(world));
    assert.equal(readPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: "U_DANTE" }, PENDING_OPTS(world)), null, "another user never sees the offer");
    assert.equal(readPendingDisambiguation({ channel: "D_OTHER", userId: RHYS_USER_ID }, PENDING_OPTS(world)), null, "another channel never sees the offer");
    assert.ok(readPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID }, PENDING_OPTS(world)));
  } finally { world.cleanup(); }
});

test("STATE: offers expire after the TTL and a new offer replaces the old one", () => {
  const world = makeWorld();
  try {
    setPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID, candidates: liveCandidates(world) }, PENDING_OPTS(world, "2026-06-12T09:00:00.000Z"));
    const afterTtl = new Date(Date.parse("2026-06-12T09:00:00.000Z") + DEFAULT_DISAMBIGUATION_TTL_MS + 1000).toISOString();
    assert.equal(readPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID }, PENDING_OPTS(world, afterTtl)), null, "expired offers are invisible");

    setPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID, candidates: [liveCandidates(world)[2]] }, PENDING_OPTS(world));
    const live = readPendingDisambiguation({ channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID }, PENDING_OPTS(world));
    assert.equal(live.candidates.length, 1, "replacement overwrote the previous offer");
  } finally { world.cleanup(); }
});

// ── No double delivery with the worker ───────────────────────────────────────
test("WORKER: pick enqueue + repeated worker passes => exactly one upload (single-owner intact)", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("double-check-branded.pdf");
    world.writeJobs([requestJob("slackdm-pick2", "the double check one")]);
    enqueueRetrievalCarrier({
      requestJobId: "slackdm-pick2", channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID,
      artifactPath: pdf, groupPaths: [pdf], title: "Double Check", message: "Found it.",
      fileExists: existsSync,
    }, { jobsPath: world.jobsPath });
    await workerDeliver(world);
    await workerDeliver(world);
    await workerDeliver(world);
    assert.equal(world.readSends().length, 1, "exactly one upload across repeated passes");
  } finally { world.cleanup(); }
});

test("WORKER: pick resolving to a group whose carrier job is already pending => ONE carrier, one upload", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeArtifact("orphan-carried-branded.pdf");
    world.writeJobs([
      requestJob("slackdm-orphan", "build me the orphan asset", { status: "needs_workspace_job", artifactPaths: [pdf], preferredDelivery: "manual_review" }),
      requestJob("slackdm-pick3", "orphan carried asset"),
    ]);
    const { carrierId, usedExistingCarrier } = enqueueRetrievalCarrier({
      requestJobId: "slackdm-pick3", channel: RHYS_DM_CHANNEL_ID, userId: RHYS_USER_ID,
      artifactPath: pdf, groupPaths: [pdf], title: "Orphan Carried", message: "Found it.",
      fileExists: existsSync,
    }, { jobsPath: world.jobsPath });
    assert.equal(usedExistingCarrier, true, "the pending orphan is reused as the carrier");
    assert.equal(carrierId, "slackdm-orphan");
    await workerDeliver(world);
    assert.equal(world.readSends().length, 1, "one upload — the carrier, not a duplicate job");
    const jobs = world.readJobs();
    assert.equal(jobs.find((j) => j.id === "slackdm-orphan").status, "delivered");
    assert.equal(jobs.find((j) => j.id === "slackdm-pick3").status, "answered", "the pick job links, never double-queues");
  } finally { world.cleanup(); }
});

// ── Static wiring: the listener actually uses all of this ────────────────────
test("STATIC: listener wires the pending seam before routing and persists offers in the ambiguous branch", () => {
  const src = readFileSync(LISTENER_PATH, "utf8");
  const seamAt = src.indexOf("readPendingDisambiguation({ channel, userId })");
  const retrievalLaneAt = src.indexOf("isRetrievalRequest(text))");
  const followupLaneAt = src.indexOf("isDeliveryRequestFollowup(text)");
  assert.ok(seamAt > -1, "pending seam exists");
  assert.ok(seamAt < retrievalLaneAt, "seam runs BEFORE the retrieval lane");
  assert.ok(seamAt < followupLaneAt, "seam runs BEFORE the delivery-followup lane");
  assert.ok(/kind === "ambiguous"[\s\S]{0,400}setPendingDisambiguation/.test(src), "ambiguous branch persists the offer");
  assert.ok(/pick\.kind === "match"[\s\S]{0,3000}enqueueRetrievalCarrier/.test(src), "a match queues via the shared single-owner enqueue");
  assert.ok(!/sendRhysDmArtifact\s*\(/.test(src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n")), "no listener-side send reintroduced");
  // R2: a new retrieval request supersedes the standing offer
  assert.ok(/pendingOffer && isRetrievalRequest\(text\)/.test(src), "new search supersedes a stale offer");
  // R2: in the match branch the offer is cleared only AFTER the enqueue
  const matchBranch = src.slice(src.indexOf('pick.kind === "match"'), src.indexOf('pick.kind === "still_ambiguous"'));
  const enqueueAt = matchBranch.indexOf("const { carrierId } = enqueueRetrievalCarrier");
  const clearAfter = matchBranch.indexOf("clearPendingDisambiguation", enqueueAt);
  assert.ok(enqueueAt > -1 && clearAfter > enqueueAt, "match path clears the offer after the enqueue, never before");
});
