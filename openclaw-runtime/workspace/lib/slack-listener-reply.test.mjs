import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGatewayFailure,
  chunkSlackText,
  deliveryRequestedText,
  draftFailedHandoffText,
  extractGatewayReply,
  extractMediaPaths,
  findKnownArtifactForRequest,
  formatGatewayFailureDetails,
  gatewayFailureDetails,
  gatewayFailureSummary,
  isDeliveryRequestFollowup,
  isExplicitEmailDeliveryRequest,
  isMisdirectedDeliveryReply,
  isLikelyLongRunningRequest,
  isStatusFollowup,
  isTimeoutDebugFollowup,
  isUsefulGatewayReply,
  liveTimeoutHandoffText,
  workspaceAckForRequest,
  misroutedDeliveryReplyText,
  prepareSlackReply,
  preferredDeliveryForSlackRequest,
} from "./slack-listener-reply.mjs";

test("extractGatewayReply parses json and plain text", () => {
  assert.equal(extractGatewayReply(JSON.stringify({ payloads: [{ text: "Done" }] })), "Done");
  assert.equal(extractGatewayReply("Plain reply"), "Plain reply");
});

test("non-useful stall replies are not treated as successful output", () => {
  assert.equal(isUsefulGatewayReply("Atlas stalled mid-thought. Re-ask in a moment."), false);
  assert.equal(isUsefulGatewayReply("Done. Built and verified. Included 7 calls."), true);
});

test("prepareSlackReply turns MEDIA paths into approval-blocked artifact state", () => {
  const reply = [
    "Done. Built and verified.",
    "MEDIA:/Users/atlasai/.openclaw/workspace/exports/ricky.pdf",
    "MEDIA:/Users/atlasai/.openclaw/workspace/exports/ricky.docx",
  ].join("\n");
  const prepared = prepareSlackReply(reply);
  assert.equal(prepared.kind, "artifact_ready");
  assert.deepEqual(extractMediaPaths(reply), [
    "/Users/atlasai/.openclaw/workspace/exports/ricky.pdf",
    "/Users/atlasai/.openclaw/workspace/exports/ricky.docx",
  ]);
  assert.match(prepared.text, /It's ready, but I need approval/);
  assert.match(prepared.text, /ricky\.pdf/);
  assert.match(prepared.text, /ricky\.docx/);
  assert.doesNotMatch(prepared.text, /\/Users\/atlasai/);
  assert.doesNotMatch(prepared.text, /Mission Control/);
});

test("prepareSlackReply chunks long replies without losing content", () => {
  const longReply = Array.from({ length: 180 }, (_, index) => `Paragraph ${index + 1}: ${"useful detail ".repeat(4)}`).join("\n\n");
  const chunks = chunkSlackText(longReply, 900);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 900));
  assert.equal(chunks.join(" ").includes("Paragraph 180"), true);
  const prepared = prepareSlackReply(longReply);
  assert.deepEqual(prepared.chunks, chunkSlackText(longReply));
});

test("gatewayFailureSummary preserves redacted stderr/stdout diagnostics", () => {
  const timeout = gatewayFailureSummary({
    timedOut: true,
    errorMessage: "Command failed after 240000ms",
    stderr: "SessionWriteLockTimeoutError",
  });
  assert.match(timeout, /Live Slack agent window timed out/);
  assert.match(timeout, /SessionWriteLockTimeoutError/);

  const summary = gatewayFailureSummary({
    errorMessage: "Command failed",
    stderr: "SessionWriteLockTimeoutError at /Users/atlasai/.openclaw/workspace/state/slack-U.jsonl.lock xoxb-secret-token",
    stdout: "ignored because stderr exists",
  });
  assert.match(summary, /Gateway returned no usable reply/);
  assert.match(summary, /stderr: SessionWriteLockTimeoutError/);
  assert.doesNotMatch(summary, /\/Users\/atlasai|\.openclaw|xoxb-secret-token/);

  const stdoutOnly = gatewayFailureSummary({
    stdout: "openclaw returned an empty payload from /Users/atlasai/.openclaw/workspace",
  });
  assert.match(stdoutOnly, /stdout: openclaw returned an empty payload/);
  assert.doesNotMatch(stdoutOnly, /\/Users\/atlasai|\.openclaw/);
});

test("gateway failure details classify recent Slack failure modes", () => {
  assert.equal(classifyGatewayFailure({
    timedOut: true,
    stderr: "Command failed after 180000ms",
  }), "timeout");
  assert.equal(classifyGatewayFailure({
    stderr: "SessionWriteLockTimeoutError at /Users/atlasai/.openclaw/workspace/state/slack-U.jsonl.lock",
  }), "session_lock_timeout");
  assert.equal(classifyGatewayFailure({
    stderr: "Context overflow: estimated context size exceeds safe threshold during tool loop.",
  }), "context_overflow");
  assert.equal(classifyGatewayFailure({
    stderr: "LLM request failed: network connection error. rawError=fetch failed",
  }), "provider_error");
  assert.equal(classifyGatewayFailure({
    stderr: "disconnect reason=too_many_websockets",
  }), "rate_or_socket_limit");
  assert.equal(classifyGatewayFailure({
    reply: "",
  }), "empty_response");
});

test("gateway failure details are structured and redacted", () => {
  const details = gatewayFailureDetails({
    modelId: "openai-codex/gpt-5.5",
    stderr: "LLM request failed: fetch failed at /Users/atlasai/.openclaw/workspace/state/slack-U.jsonl.lock xoxb-secret",
  });
  assert.equal(details.failureType, "provider_error");
  assert.equal(details.provider, "openai-codex");
  assert.equal(details.model, "gpt-5.5");
  const formatted = formatGatewayFailureDetails(details);
  assert.match(formatted, /failure_type=provider_error/);
  assert.match(formatted, /provider=openai-codex/);
  assert.match(formatted, /model=gpt-5\.5/);
  assert.doesNotMatch(formatted, /\/Users\/atlasai|\.openclaw|xoxb-secret/);
});

test("draft failed fallback is user-facing and avoids internals", () => {
  const reply = draftFailedHandoffText();
  assert.match(reply, /no verified result exists yet/);
  assert.doesNotMatch(reply, /stderr|stdout|slackdm-|\/Users|operator review/i);
});

test("Slack DM document/brief requests prefer Slack DM delivery, not email", () => {
  const route = preferredDeliveryForSlackRequest({
    text: "send me a client brief for Corey",
    isSlackDm: true,
  });
  assert.equal(route.preferredDelivery, "slack_dm");
  assert.equal(isLikelyLongRunningRequest("send me a client brief for Corey"), true);
});

test("Slack DM workspace build wording does not force Mission Control delivery", () => {
  const route = preferredDeliveryForSlackRequest({
    text: "This is a workspace document update. Please build it in Atlas and bring the updated PDF back here when ready.",
    isSlackDm: true,
  });
  assert.equal(route.preferredDelivery, "slack_dm");

  const explicit = preferredDeliveryForSlackRequest({
    text: "Put this in Mission Control for review.",
    isSlackDm: true,
  });
  assert.equal(explicit.preferredDelivery, "mission_control");
});


test("explicit email request can select email delivery", () => {
  const route = preferredDeliveryForSlackRequest({
    text: "email this to me at rhys@example.com",
    isSlackDm: true,
  });
  assert.equal(route.preferredDelivery, "email");
  assert.equal(isExplicitEmailDeliveryRequest("email this to me"), true);
});

test("Slack DM media reply is routed to Rhys DM artifact helper", () => {
  const reply = [
    "Done. Built and verified.",
    "MEDIA:/Users/atlasai/.openclaw/workspace/exports/client-brief.pdf",
  ].join("\n");
  const prepared = prepareSlackReply(reply, { preferredDelivery: "slack_dm" });
  assert.equal(prepared.kind, "artifact_ready");
  assert.equal(prepared.deliveryAction, "send_rhys_dm_artifact");
  assert.deepEqual(prepared.mediaPaths, [
    "/Users/atlasai/.openclaw/workspace/exports/client-brief.pdf",
  ]);
  assert.doesNotMatch(prepared.text, /Mission Control|\/Users\/atlasai/);
});

test("Gmail and Mission Control replies are blocked for default Slack DM delivery", () => {
  assert.equal(isMisdirectedDeliveryReply({
    preferredDelivery: "slack_dm",
    reply: "Email didn’t send. Gmail auth needs reauth.",
  }), true);
  assert.equal(isMisdirectedDeliveryReply({
    preferredDelivery: "slack_dm",
    reply: "Files are ready in Mission Control. Approve the delivery path.",
  }), true);
  assert.equal(isMisdirectedDeliveryReply({
    preferredDelivery: "email",
    reply: "Email didn’t send. Gmail auth needs reauth.",
  }), false);
  assert.doesNotMatch(misroutedDeliveryReplyText(), /reauth|Mission Control-only/i);
});

test("isStatusFollowup catches short status pings", () => {
  assert.equal(isStatusFollowup("HOW YOU GOING WITH THAT REQUEST?"), true);
  assert.equal(isStatusFollowup("any update on that?"), true);
  assert.equal(isStatusFollowup("what does that actually mean?"), true);
  assert.equal(isStatusFollowup("please build a doc"), false);
});

test("isLikelyLongRunningRequest catches document and transcript builds", () => {
  assert.equal(isLikelyLongRunningRequest("make a doc with links to every call and all transcripts"), true);
  assert.equal(isLikelyLongRunningRequest("run an executive audit for this Typeform"), true);
  assert.equal(isLikelyLongRunningRequest("send me a client brief"), true);
  assert.equal(isLikelyLongRunningRequest("there are probably examples in other calls that could give exact number on what each band should be paid for each client. find them, add a recommendation for ricky and add the visual as a pyramid"), true);
  assert.equal(isLikelyLongRunningRequest("reply to Caelan"), false);
});

test("timeout follow-ups are recognized and avoid internal job copy", () => {
  assert.equal(isTimeoutDebugFollowup("Can we fix this timeout issue?"), true);
  assert.equal(isTimeoutDebugFollowup("I picked this up, but it outgrew the live Slack reply window. I have logged it for operator review as slackdm-D0AM2R3H6SE-1780276979.763729."), true);
  const reply = liveTimeoutHandoffText();
  assert.match(reply, /workspace time/);
  assert.doesNotMatch(reply, /slackdm-|operator review|outgrew/i);
});

test("isDeliveryRequestFollowup catches Rhys asking for the file here", () => {
  assert.equal(isDeliveryRequestFollowup("yeah just send it to me here"), true);
  assert.equal(isDeliveryRequestFollowup("put it here"), true);
  assert.equal(isDeliveryRequestFollowup("yeah can you complete it and then send the completed doc here?"), true);
  assert.equal(isDeliveryRequestFollowup("create a doc and send it tomorrow"), false);
});

test("asset handoff copy never promises delivery without a verified artifact", () => {
  for (const reply of [
    workspaceAckForRequest(),
    liveTimeoutHandoffText(),
    draftFailedHandoffText(),
    deliveryRequestedText(),
  ]) {
    assert.doesNotMatch(reply, /I'll build|bring .*back.*ready|will bring|when it's ready/i);
    assert.doesNotMatch(reply, /operator review|slackdm-|\/Users\/atlasai/i);
  }
  assert.match(workspaceAckForRequest(), /no verified file exists yet/i);
  assert.match(deliveryRequestedText(), /delivery cannot happen until an artifact exists/i);
});

test("isStatusFollowup catches Rhys asking for the missing asset", () => {
  assert.equal(isStatusFollowup("and the asset I asked for before that?"), true);
  assert.equal(isStatusFollowup("what about the doc I asked for?"), true);
  assert.equal(isStatusFollowup("where is the file we asked for"), true);
});

test("known First 10K coaching asset requests map to verified artifact package", () => {
  const artifact = findKnownArtifactForRequest("i want to create an asset for their first 10k as an online coach with offer pricing content sales retention and pdf");
  assert.equal(artifact?.key, "first-10k-online-coach");
  assert.match(artifact.artifactPath, /first-10k-month-bible-branded\.pdf$/);
  assert.match(artifact.message, /verified First \$10K Month branded asset/);
  assert.equal(findKnownArtifactForRequest("create a generic branded pdf for a random client"), null);
});
