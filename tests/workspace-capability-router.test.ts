import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBlockedCapabilityAnswer,
  routeWorkspaceCapability,
} from "../src/lib/workspace-capability-router.ts";

test("recent call prompt selects recent call topic retrieval", () => {
  const plan = routeWorkspaceCapability({
    prompt: "What topics came up in my recent calls and call logs?",
    title: "Recent call memory",
  });

  assert.equal(plan.intent, "recent_call_topic_retrieval");
  assert.equal(plan.capabilityId, "recent-call-topic-retrieval");
  assert.equal(plan.skillId, "call-retrieval");
  assert.equal(plan.allowed, true);
  assert.ok(plan.toolBindingIds.includes("workspace-summarize-calls"));
});

test("Ricky PDF prompt selects supported Ricky package retrieval", () => {
  const plan = routeWorkspaceCapability({
    prompt: "Update the Ricky Calder coach hire pay model handover and return it as a PDF.",
    title: "Ricky Calder pay structure handover",
  });

  assert.equal(plan.intent, "ricky_pdf_package_retrieval");
  assert.equal(plan.capabilityId, "ricky-pdf-package-retrieval");
  assert.equal(plan.skillId, "artifact-retrieval");
  assert.equal(plan.allowed, true);
  assert.equal(plan.artifactIntent.shouldCreate, true);
  assert.equal(plan.artifactIntent.requestedFormat, "pdf");
  assert.ok(plan.toolBindingIds.includes("ricky-package-resolver"));
});

test("generic branded PDF prompt selects blocked arbitrary PDF capability", () => {
  const plan = routeWorkspaceCapability({
    prompt: "Create a polished branded PDF for this new client model.",
    title: "Client model PDF",
  });
  const answer = buildBlockedCapabilityAnswer(plan);

  assert.equal(plan.intent, "arbitrary_pdf_generation");
  assert.equal(plan.capabilityId, "arbitrary-branded-pdf-generation");
  assert.equal(plan.allowed, false);
  assert.match(plan.blockedReason ?? "", /blocked/i);
  assert.match(answer, /Arbitrary branded PDF generation is blocked/);
  assert.doesNotMatch(JSON.stringify(plan), /\/Users\/atlasai|\.openclaw|SLACK_|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

test("Slack send prompt selects blocked Slack send capability", () => {
  const plan = routeWorkspaceCapability({
    prompt: "Send this answer to Rhys in Slack.",
    title: "Slack send",
  });

  assert.equal(plan.intent, "slack_send");
  assert.equal(plan.capabilityId, "slack-send");
  assert.equal(plan.allowed, false);
  assert.equal(plan.safetyLevel, "blocked");
  assert.ok(plan.safetyPolicyIds.includes("external-send-block"));
});

test("analytical prompt mentioning pdf and playbooks does not select artifact creation", () => {
  const plan = routeWorkspaceCapability({
    prompt: "Predictable strategies to get first 10k using learned knowledge, call logs, playbooks, and pdf.",
    title: "Workspace analysis",
  });

  assert.equal(plan.capabilityId, "call-memory-answer");
  assert.equal(plan.allowed, true);
  assert.equal(plan.artifactIntent.shouldCreate, false);
});
