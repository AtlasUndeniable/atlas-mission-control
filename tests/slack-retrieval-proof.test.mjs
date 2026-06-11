/**
 * PROOF HARNESS for the read-only retrieval lane.
 * Runs ENTIRELY against temp fixtures: a fake exports/ dir, fake ledger rows,
 * a Slack SEND STUB, and a files.list STUB. It never reads or writes
 * /Users/atlasai/.openclaw/data/*, never touches live exports, never sends a
 * real Slack message.
 * Run: node --test tests/slack-retrieval-proof.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveRetrieval,
  runRetrievalLane,
  extractRetrievalTerms,
  prettyName,
} from "../openclaw-runtime/workspace/lib/slack-retrieval.mjs";
import { scanExportArtifactGroups } from "../openclaw-runtime/workspace/lib/artifact-delivery.mjs";
import { selectPreferredArtifactPath } from "../openclaw-runtime/workspace/lib/slack-rhys-dm-artifact.mjs";
import { classifySlackRequest } from "../openclaw-runtime/workspace/lib/slack-dm-jobs.mjs";
import {
  isRetrievalRequest,
  isDeliveryRequestFollowup,
  isLikelyLongRunningRequest,
} from "../openclaw-runtime/workspace/lib/slack-listener-reply.mjs";
import { findSlackAssetWorkflowForRequest } from "../openclaw-runtime/workspace/lib/slack-asset-workflows.mjs";

const VSL_REQUEST = "i have sent clients a vsl framework before in slack as a hand. over doc. find it and send it to me";

// ── Fixture world ────────────────────────────────────────────────────────────
function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "retr-proof-"));
  const exportsRoot = join(dir, "exports");
  mkdirSync(exportsRoot);
  return {
    dir, exportsRoot,
    makeFile(name, content = "PDF") { const p = join(exportsRoot, name); writeFileSync(p, content); return p; },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function makeSendStub() {
  const sends = [];
  return {
    sends,
    sendArtifact: async ({ artifactPath, title, message }) => {
      sends.push({ artifactPath, title, message });
      return { channelId: "D0AM2R3H6SE", fileId: `F-${sends.length}`, messageTs: `1781.${sends.length}`, filename: artifactPath.split("/").pop(), text: message };
    },
  };
}

function makeFilesListStub({ ok = true, files = [], scopeMissing = false } = {}) {
  return async () => (ok ? { ok: true, files } : { ok: false, scope_missing: scopeMissing });
}

function laneOpts(world, sendStub, extra = {}) {
  return {
    channel: "D0AM2R3H6SE",
    userId: "U068FRX5423",
    scanExports: () => scanExportArtifactGroups({ exportsDir: world.exportsRoot }),
    readLedger: () => [],
    listBotFiles: makeFilesListStub(),
    selectArtifactPath: selectPreferredArtifactPath,
    sendArtifact: sendStub.sendArtifact,
    ...extra,
  };
}

// ── DONE-4: the exact live-failed request routes to retrieval, returns the real file
test("DONE-4: the live VSL request routes to retrieval and delivers the real Ryan Bennett VSL handover", async () => {
  const world = makeWorld();
  try {
    // The real export family that exists on the live box.
    world.makeFile("2026-04-12-ryan-bennett-vsl-handover-branded.pdf");
    world.makeFile("2026-04-12-ryan-bennett-vsl-handover.docx");
    world.makeFile("2026-04-12-ryan-bennett-vsl-handover.html");
    // Decoys that share ONE weak term ("framework") but are not the VSL doc.
    world.makeFile("2026-04-12-staff-onboarding-operations-framework.pdf");

    // Routing: classifier + predicate both say retrieval, not document_request/block.
    assert.equal(classifySlackRequest(VSL_REQUEST), "retrieval");
    assert.equal(isRetrievalRequest(VSL_REQUEST), true);

    const sendStub = makeSendStub();
    const result = await runRetrievalLane({ text: VSL_REQUEST, ...laneOpts(world, sendStub) });

    assert.equal(result.kind, "delivered");
    assert.equal(sendStub.sends.length, 1);
    assert.match(sendStub.sends[0].artifactPath, /ryan-bennett-vsl-handover-branded\.pdf$/, "PDF preferred, the real VSL doc");
    assert.equal(result.receipt.channelId, "D0AM2R3H6SE");
    assert.ok(result.receipt.fileId && result.receipt.messageTs, "real receipt recorded");
    // TR-6: no paths/ids in the user-facing message.
    assert.ok(!/\/Users\//.test(sendStub.sends[0].message) && !/slackdm-|asset-[0-9a-f]/.test(sendStub.sends[0].message));
  } finally { world.cleanup(); }
});

// ── DONE-3a: match delivers via the gated send
test("retrieval match delivers exactly one file through the gated send", async () => {
  const world = makeWorld();
  try {
    world.makeFile("2026-04-20-retention-playbook-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "send me the retention playbook i shared with clients before",
      ...laneOpts(world, sendStub),
    });
    assert.equal(result.kind, "delivered");
    assert.equal(sendStub.sends.length, 1);
    assert.match(sendStub.sends[0].artifactPath, /retention-playbook-branded\.pdf$/);
  } finally { world.cleanup(); }
});

// ── DONE-3b: no match asks to build, NEVER fabricates
test("no match returns honest 'couldn't find it, build one?' and sends nothing", async () => {
  const world = makeWorld();
  try {
    world.makeFile("2026-04-20-retention-playbook-branded.pdf"); // unrelated
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "find the underwater basket weaving compliance manual i sent before",
      ...laneOpts(world, sendStub),
    });
    assert.equal(result.kind, "not_found");
    assert.equal(sendStub.sends.length, 0, "must NEVER fabricate a file");
    assert.match(result.reply, /couldn't find a doc matching that\. want me to build one\?/i);
  } finally { world.cleanup(); }
});

test("no match: a single WEAK term hit (score 1) is NOT delivered — threshold holds", async () => {
  const world = makeWorld();
  try {
    // Shares exactly ONE term ("retention") with the request — score 1, which
    // is below MIN_MATCH_SCORE. With the threshold this is a no-match; without
    // it, this same fixture would be wrongly delivered (mutation guard).
    world.makeFile("2026-04-20-retention-playbook-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "find the retention bible i sent before",
      ...laneOpts(world, sendStub),
    });
    assert.equal(result.kind, "not_found", "one weak shared term must not clear the match threshold");
    assert.equal(sendStub.sends.length, 0);
  } finally { world.cleanup(); }
});

// ── DONE-3c: ambiguous lists candidates and asks which
test("ambiguous match lists real candidates and asks which (no send)", async () => {
  const world = makeWorld();
  try {
    // Two equally strong matches on "q2 client audit".
    world.makeFile("2026-04-18-q2-client-audit-jess-branded.pdf");
    world.makeFile("2026-04-19-q2-client-audit-corey-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "find the q2 client audit i sent before and send it",
      ...laneOpts(world, sendStub),
    });
    assert.equal(result.kind, "ambiguous");
    assert.equal(sendStub.sends.length, 0);
    assert.ok(result.candidates.length >= 2);
    assert.match(result.reply, /which one\?/i);
    // TR-6: candidate list shows human names, not paths.
    assert.ok(!/\/Users\//.test(result.reply));
  } finally { world.cleanup(); }
});

// ── DONE-2: Slack files.list scope handling
test("files.list missing_scope degrades gracefully to exports+ledger (still delivers)", async () => {
  const world = makeWorld();
  try {
    world.makeFile("2026-04-12-ryan-bennett-vsl-handover-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: VSL_REQUEST,
      ...laneOpts(world, sendStub, { listBotFiles: makeFilesListStub({ ok: false, scopeMissing: true }) }),
    });
    assert.equal(result.kind, "delivered", "exports remain authoritative when files:read is absent");
    assert.equal(result.slackScopeMissing, true);
    assert.equal(sendStub.sends.length, 1);
  } finally { world.cleanup(); }
});

test("files.list throwing never crashes the lane (degrades to exports)", async () => {
  const world = makeWorld();
  try {
    world.makeFile("2026-04-12-ryan-bennett-vsl-handover-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: VSL_REQUEST,
      ...laneOpts(world, sendStub, { listBotFiles: async () => { throw new Error("network down"); } }),
    });
    assert.equal(result.kind, "delivered");
    assert.equal(result.slackScopeMissing, true);
  } finally { world.cleanup(); }
});

// ── DONE-2 (ledger source): ledger-recorded artifact is retrievable
test("an artifact recorded only in the ledger (still on disk) is retrievable", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeFile("2026-05-01-pricing-teardown-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "pull up the pricing teardown you made before",
      ...laneOpts(world, sendStub, {
        scanExports: () => [], // not in the export scan
        readLedger: () => [
          { eventType: "artifact_created", title: "Pricing Teardown vs Scorpion", artifactPaths: [pdf], artifactCreatedAt: "2026-05-01T00:00:00Z" },
        ],
      }),
    });
    assert.equal(result.kind, "delivered");
    assert.equal(sendStub.sends.length, 1);
    assert.match(sendStub.sends[0].artifactPath, /pricing-teardown-branded\.pdf$/);
  } finally { world.cleanup(); }
});

test("a ledger row whose file is GONE from disk is not deliverable (no fabrication)", async () => {
  const world = makeWorld();
  try {
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "pull up the pricing teardown you made before",
      ...laneOpts(world, sendStub, {
        scanExports: () => [],
        readLedger: () => [
          { eventType: "artifact_created", title: "Pricing Teardown vs Scorpion", artifactPaths: ["/gone/pricing-teardown-branded.pdf"], artifactCreatedAt: "2026-05-01T00:00:00Z" },
        ],
        fileExists: () => false,
      }),
    });
    assert.equal(result.kind, "not_found");
    assert.equal(sendStub.sends.length, 0);
  } finally { world.cleanup(); }
});

// ── F1 gap #1: delivery-followup must not intercept a NEW-referent request ──
test("GAP-1: 'find the vsl framework I sent... send it to me' routes to retrieval, NOT delivery-followup", () => {
  // The request DOES superficially match the bare delivery-followup pattern...
  assert.equal(isDeliveryRequestFollowup(VSL_REQUEST), true);
  // ...but retrieval takes precedence in the listener because isRetrievalRequest fires.
  assert.equal(isRetrievalRequest(VSL_REQUEST), true);
  // A bare anaphoric "send it to me here" with NO retrieval verb stays delivery-followup.
  assert.equal(isRetrievalRequest("just send it to me here"), false);
  assert.equal(isDeliveryRequestFollowup("just send it to me here"), true);
});

// ── F1 gap #2: first-10k matcher handles plural "coaches" ──
test("GAP-2: first-10k workflow matches plural 'coaches'", () => {
  assert.ok(findSlackAssetWorkflowForRequest("build the first 10k playbook pdf for online coaches"), "plural coaches must match");
  assert.equal(findSlackAssetWorkflowForRequest("build the first 10k playbook pdf for online coaches").key, "first-10k-online-coach");
  // singular still works
  assert.ok(findSlackAssetWorkflowForRequest("first 10k asset for an online coach"));
});

// ── F1 gap #3: isLikelyLongRunningRequest picks up framework/playbook cues ──
test("GAP-3: long-running detector covers 'framework' and 'playbook' cues", () => {
  assert.equal(isLikelyLongRunningRequest("make jess a cta playbook for her ads and dm follow up"), true);
  assert.equal(isLikelyLongRunningRequest("build a vsl framework for ryan"), true);
});

// ── Boundary: a build request must NOT be hijacked into retrieval ──
test("boundary: build requests are NOT retrieval (no over-capture)", () => {
  assert.equal(isRetrievalRequest("create a pricing playbook pdf for new clients"), false);
  assert.equal(isRetrievalRequest("find the top objections in the calls and build a summary doc"), false);
  assert.equal(classifySlackRequest("create a pricing playbook pdf for new clients"), "asset_request");
});

// ── Resolver unit guards ──
test("resolver: term extraction drops stopwords/verbs and keeps document identity", () => {
  const terms = extractRetrievalTerms(VSL_REQUEST);
  assert.ok(terms.includes("vsl"));
  assert.ok(terms.includes("framework"));
  assert.ok(!terms.includes("find") && !terms.includes("send") && !terms.includes("the"));
});

test("resolver: empty/garbage request resolves to none, never a false match", () => {
  const r = resolveRetrieval({ text: "hey", exportGroups: [{ artifactKey: "x-vsl-handover", artifactPaths: ["/x.pdf"] }] });
  assert.equal(r.status, "none");
});

test("resolver: prettyName is TR-6 (no date prefix, no path, no -branded suffix)", () => {
  const name = prettyName({ artifactKey: "2026-04-12-ryan-bennett-vsl-handover-branded", artifactPaths: ["/x.pdf"] });
  assert.equal(name, "Ryan Bennett Vsl Handover");
  assert.ok(!/\d{4}-/.test(name) && !/branded/i.test(name));
});

// ── Review hardening regressions (adversarial findings, each pinned) ────────
test("REVIEW: named retrievals WITHOUT a 'before/already' cue route to retrieval (under-capture fixed)", () => {
  const cases = [
    "find the vsl framework i sent the client",
    "find the vsl framework i sent",
    "send me the vsl handover doc i shared with clients",
    "find the vsl framework i gave a client",
    "pull up the vsl framework",
    "can you locate the onboarding sop",
  ];
  for (const text of cases) {
    assert.equal(isRetrievalRequest(text), true, `must be retrieval: "${text}"`);
    assert.equal(classifySlackRequest(text), "retrieval", `must classify retrieval: "${text}"`);
  }
  // Builds stay builds.
  assert.equal(isRetrievalRequest("find the top objections in the calls and build a summary doc"), false);
  assert.equal(isRetrievalRequest("search the transcripts and create a report on churn reasons"), false);
  assert.equal(isRetrievalRequest("build me a competitor teardown pdf for gym owners"), false);
});

test("REVIEW: the SAME file in BOTH exports and ledger (different title) is ONE candidate — delivered, not ambiguous", async () => {
  const world = makeWorld();
  try {
    const pdf = world.makeFile("2026-04-12-ryan-bennett-vsl-handover-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: VSL_REQUEST,
      ...laneOpts(world, sendStub, {
        // Production shape: export scan AND a ledger row with a human title
        // both describe the SAME on-disk file.
        readLedger: () => [
          { eventType: "artifact_created", title: "VSL Framework Handover (Ryan Bennett, Apex)", artifactPaths: [pdf], artifactCreatedAt: "2026-04-12T00:00:00Z" },
        ],
      }),
    });
    assert.equal(result.kind, "delivered", "one real file must never be 'which one?' against itself");
    assert.equal(sendStub.sends.length, 1);
  } finally { world.cleanup(); }
});

test("REVIEW: preview-image groups (cover-preview-001.png) never compete with the real document", async () => {
  const world = makeWorld();
  try {
    world.makeFile("2026-05-25-ricky-calder-call-library-branded.pdf");
    world.makeFile("2026-05-25-ricky-calder-call-library-branded-cover-preview-001.png");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "find the ricky calder call library i made before and send it",
      ...laneOpts(world, sendStub),
    });
    assert.equal(result.kind, "delivered", "preview png must not force ambiguity");
    assert.match(sendStub.sends[0].artifactPath, /call-library-branded\.pdf$/);
  } finally { world.cleanup(); }
});

test("REVIEW: nonsense short-fragment requests cannot reach a confident match (scoring tightened)", async () => {
  const world = makeWorld();
  try {
    world.makeFile("2026-05-02-client-retention-playbook-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "find the lien tent thing i sent before",
      ...laneOpts(world, sendStub),
    });
    assert.equal(result.kind, "not_found", "substring bleed must not score a match");
    assert.equal(sendStub.sends.length, 0);
  } finally { world.cleanup(); }
});

test("REVIEW: mixed 'find existing AND build new' delivers the existing file with an honest separate-ask note", async () => {
  const world = makeWorld();
  try {
    world.makeFile("2026-04-20-retention-playbook-branded.pdf");
    const sendStub = makeSendStub();
    const result = await runRetrievalLane({
      text: "find the retention playbook i sent before and build an updated version",
      ...laneOpts(world, sendStub),
    });
    assert.equal(result.kind, "delivered", "the retrieval half is served immediately");
    assert.match(sendStub.sends[0].artifactPath, /retention-playbook-branded\.pdf$/);
    assert.match(sendStub.sends[0].message, /own request.*build lane/i, "build half acknowledged honestly, not promised");
    assert.ok(!/\/Users\//.test(sendStub.sends[0].message));
  } finally { world.cleanup(); }
});

test("REVIEW: status follow-ups with retrieval verbs keep their status_check kind (listener guard input)", async () => {
  const { isStatusFollowup } = await import("../openclaw-runtime/workspace/lib/slack-listener-reply.mjs");
  // These fire BOTH predicates; the listener's job.kind !== "status_check"
  // guard routes them to the status lane. Pin that the kind tag fires.
  assert.equal(isStatusFollowup("any update - did you find the vsl doc i sent before?"), true);
  assert.equal(isStatusFollowup("can you find out the status of that doc i asked for"), true);
});
