import { test } from "node:test";
import assert from "node:assert/strict";

import {
  capabilityPromptSummary,
  getAtlasCapabilityRegistry,
  registryPromptSummary,
  validateAtlasCapabilityRegistry,
  validateAtlasRegistry,
  type AtlasCapability,
} from "../src/lib/workspace-capabilities.ts";
import { buildWorkspaceRuntimeContext } from "../src/lib/workspace-runtime-context.ts";

const requiredCapabilityIds = [
  "memory-search-recall",
  "call-memory-answer",
  "recent-call-topic-retrieval",
  "librarian-maintenance-reporting",
  "artifact-library-lookup",
  "internal-markdown-draft",
  "ricky-pdf-package-retrieval",
  "audit-pdf-renderer-workflow",
  "brand-voice-guidance-retrieval",
  "slack-draft-reply-workflow",
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
  validateAtlasRegistry(registry);
  assert.equal(registry.version, 1);
  assert.deepEqual(registry.capabilities.map((capability) => capability.id), requiredCapabilityIds);
  assert.equal(registry.summary.available, 8);
  assert.equal(registry.summary.limited, 5);
  assert.equal(registry.summary.blocked, 5);
  assert.equal(registry.summary.planned, 2);
  assert.equal(registry.skills.length, 8);
  assert.equal(registry.toolBindings.length, 12);
  assert.equal(registry.safetyPolicies.length, 6);
});

test("discovered substrate is represented as safe capabilities, skills, and bindings", () => {
  const registry = getAtlasCapabilityRegistry();
  const skillIds = new Set(registry.skills.map((skill) => skill.id));
  const bindingIds = new Set(registry.toolBindings.map((binding) => binding.id));
  const sourceLabels = new Set(registry.discoveredSubstrate.map((sourceRef) => sourceRef.label));

  assert.ok(skillIds.has("memory-librarian"));
  assert.ok(skillIds.has("audit-document-workflow"));
  assert.ok(skillIds.has("strategist-guidance"));
  assert.ok(skillIds.has("slack-reply-draft"));
  assert.ok(bindingIds.has("workspace-search-memory"));
  assert.ok(bindingIds.has("workspace-summarize-calls"));
  assert.ok(bindingIds.has("audit-pdf-renderer"));
  assert.ok(bindingIds.has("slack-listener-reply-runtime"));
  assert.ok(sourceLabels.has("Layered memory vault"));
  assert.ok(sourceLabels.has("Librarian reports"));
  assert.ok(sourceLabels.has("Audit subagent"));
  assert.ok(sourceLabels.has("Strategist subagent"));
  assert.ok(sourceLabels.has("Slack reply runtime"));
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
  assert.equal(byId.get("slack-draft-reply-workflow")?.status, "limited");
  assert.equal(byId.get("audit-pdf-renderer-workflow")?.status, "limited");

  const promptSummary = capabilityPromptSummary(registry.capabilities).join("\n");
  assert.match(promptSummary, /Slack send: blocked; do not present as available/);
  assert.match(promptSummary, /Supabase shared persistence: planned; do not present as available/);
  assert.doesNotMatch(promptSummary, /Slack send: available/);
  assert.doesNotMatch(promptSummary, /Arbitrary branded PDF generation: available/);
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
  assert.ok(Array.isArray(body.skills));
  assert.ok(Array.isArray(body.toolBindings));
  assert.ok(Array.isArray(body.safetyPolicies));
  assert.equal(body.capabilities.some((capability) => capability.status === "blocked"), true);
  assert.equal(body.capabilities.find((capability) => capability.id === "qa-critic-check")?.status, "available");
  assert.equal(body.skills?.find((skill) => skill.id === "memory-librarian")?.status, "available");
  assert.equal(body.toolBindings?.find((binding) => binding.id === "slack-listener-reply-runtime")?.status, "limited");
  assert.doesNotMatch(JSON.stringify(body), /\/Users\/atlasai|\.openclaw|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

test("runtime context includes capability boundaries for agent answers", () => {
  const context = buildWorkspaceRuntimeContext({
    prompt: "What can Atlas do today?",
    title: "Capability check",
  }, { provider: "mock" });

  assert.ok(context.capabilities.length >= requiredCapabilityIds.length);
  assert.ok(context.skills.some((skill) => skill.id === "memory-librarian"));
  assert.ok(context.toolBindings.some((binding) => binding.id === "workspace-search-memory"));
  assert.ok(context.safetyPolicies.some((policy) => policy.id === "external-send-block"));
  assert.match(context.internalSummary, /capabilities=available:/);
  assert.match(context.systemPrompt, /Atlas capability registry/);
  assert.match(context.systemPrompt, /Call memory answer: available/);
  assert.match(context.systemPrompt, /Memory Librarian: available/);
  assert.match(context.systemPrompt, /Path and secret redaction: read_only/);
  assert.match(context.systemPrompt, /Slack send: blocked; do not present as available/);
  assert.match(context.systemPrompt, /Capability truthfulness/);
  assert.doesNotMatch(context.systemPrompt, /\/Users\/atlasai|\.openclaw|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

test("registry prompt summary includes skills and safe tool binding truthfulness", () => {
  const summary = registryPromptSummary(getAtlasCapabilityRegistry()).join("\n");

  assert.match(summary, /Discovered Atlas skills:/);
  assert.match(summary, /Memory Librarian: available/);
  assert.match(summary, /Slack listener reply runtime: limited/);
  assert.match(summary, /External send block: blocked/);
  assert.doesNotMatch(summary, /\/Users\/atlasai|\.openclaw|OPENAI_API_KEY|ANTHROPIC_API_KEY|SLACK_/);
});

function capabilityById(capabilities: AtlasCapability[]): Map<string, AtlasCapability> {
  return new Map(capabilities.map((capability) => [capability.id, capability]));
}
