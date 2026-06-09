import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RHYS_DM_CHANNEL_ID,
  gate0_approvalDmRouting,
  runGates,
} from "./slack-gates.mjs";

const approvalDraft = [
  "jess-endure-mentoring - Jessica De Bortoli tagged you.",
  "Ask: She wants to know what CTA to say at the end of her ads.",
  "Why it matters: She is filming ads and needs a clear closing line.",
  "Draft: say 'DM me the word START and I'll send you the next step'",
  "",
  "Reply Y to approve, or tell me what to change.",
].join("\n");

test("approval-style Rhys comms draft is held when routed to Dante DM", () => {
  const result = runGates({
    text: approvalDraft,
    channelId: "D0AU05TKGMQ",
    kind: "comms-triage",
    payload: { channel: "D0AU05TKGMQ", text: approvalDraft },
  });

  assert.equal(result.pass, false);
  assert.equal(result.gate, 0);
  assert.match(result.reason, /non-Rhys DM/);
});

test("approval-style Rhys comms draft is allowed for the known Rhys DM", () => {
  const result = gate0_approvalDmRouting({
    text: approvalDraft,
    channelId: RHYS_DM_CHANNEL_ID,
  });

  assert.equal(result.pass, true);
});

test("ordinary internal Dante DM status is not blocked by approval routing guard", () => {
  const text = "Mission Control is green and the Slack asset job ledger is healthy.";
  const result = runGates({
    text,
    channelId: "D0AU05TKGMQ",
    kind: "chat",
    payload: { channel: "D0AU05TKGMQ", text },
  });

  assert.equal(result.pass, true, result.reason);
});
