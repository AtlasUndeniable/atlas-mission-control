import { test } from "node:test";
import assert from "node:assert/strict";

import {
  capabilityPromptSummary,
  getAtlasCapabilityRegistry,
  validateAtlasCapabilityRegistry,
  type AtlasCapability,
} from "../src/lib/workspace-capabilities.ts";
import { buildWorkspaceRuntimeContext } from "../src/lib/workspace-runtime-context.ts";

const requiredCapabilityIds = [
  "call-memory-answer",
  "recent-call-topic-retrieval",
  "artifact-library-lookup",
  "internal-markdown-draft",
  "ricky-pdf-package-retrieval",
  "session-persistence-continuation",
  "qa-critic-check",
  "connector-status-inspection",
  "arbitrary-branded-pdf-generation",
  "slack-send",
  "monday-mutation",
  "typeform-mutation",
  "google-meta-ads-mutation",
  "supabase-shared-persistence",
  "user-created-skills",
];

test("capability registry validates seeded Atlas capabilities", () => {
  const registry = getAtlasCapabilityRegistry({
    now: () => new Date("2026-06-07T00:00:00.000Z"),
  });

  validateAtlasCapabilityRegistry(registry.capabilities);
  assert.equal(registry.version, 1);
  assert.deepEqual(registry.capabilities.map((capability) => capability.id), requiredCapabilityIds);
  assert.equal(registry.summary.available, 7);
  assert.equal(registry.summary.limited, 1);
  assert.equal(registry.summary.blocked, 5);
  assert.equal(registry.summary.planned, 2);
});

test("blocked and planned capabilities cannot be presented as available", () => {
  const registry = getAtlasCapabilityRegistry();
  const byId = capabilityById(registry.capabilities);
  for (const id of [
    "arbitrary-branded-pdf-generation",
    "slack-send",
    "monday-mutation",
    "typeform-mutation",
    "google-meta-ads-mutation",
  ]) {
    assert.equal(byId.get(id)?.status, "blocked");
    assert.equal(byId.get(id)?.approvalRequirement, "not_supported");
    assert.equal(byId.get(id)?.safetyLevel, "blocked");
  }
  assert.equal(byId.get("supabase-shared-persistence")?.status, "planned");
  assert.equal(byId.get("user-created-skills")?.status, "planned");

  const promptSummary = capabilityPromptSummary(registry.capabilities).join("\n");
  assert.match(promptSummary, /Slack send: blocked; do not present as available/);
  assert.match(promptSummary, /Supabase shared persistence: planned; do not present as available/);
});

test("capability registry contains no secrets or local paths", () => {
  const registryText = JSON.stringify(getAtlasCapabilityRegistry());

  assert.doesNotMatch(registryText, /\/Users\/atlasai|\.openclaw|\/private\/|\/tmp\//);
  assert.doesNotMatch(registryText, /OPENAI_API_KEY|ANTHROPIC_API_KEY|SLACK_|MONDAY_|TYPEFORM_/);
});

test("capability API payload shape is safe and status-bearing", () => {
  const body = {
    ok: true,
    ...getAtlasCapabilityRegistry({
      now: () => new Date("2026-06-07T00:00:00.000Z"),
    }),
  };

  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.capabilities));
  assert.equal(body.capabilities.some((capability) => capability.status === "blocked"), true);
  assert.equal(body.capabilities.find((capability) => capability.id === "qa-critic-check")?.status, "available");
  assert.doesNotMatch(JSON.stringify(body), /\/Users\/atlasai|\.openclaw|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

test("runtime context includes capability boundaries for agent answers", () => {
  const context = buildWorkspaceRuntimeContext({
    prompt: "What can Atlas do today?",
    title: "Capability check",
  }, { provider: "mock" });

  assert.ok(context.capabilities.length >= requiredCapabilityIds.length);
  assert.match(context.internalSummary, /capabilities=available:/);
  assert.match(context.systemPrompt, /Atlas capability registry/);
  assert.match(context.systemPrompt, /Call memory answer: available/);
  assert.match(context.systemPrompt, /Slack send: blocked; do not present as available/);
  assert.match(context.systemPrompt, /Capability truthfulness/);
  assert.doesNotMatch(context.systemPrompt, /\/Users\/atlasai|\.openclaw|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

function capabilityById(capabilities: AtlasCapability[]): Map<string, AtlasCapability> {
  return new Map(capabilities.map((capability) => [capability.id, capability]));
}
