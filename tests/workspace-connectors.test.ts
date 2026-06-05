/**
 * Atlas Connector Control Plane registry tests.
 * These tests use injected health/config probes only; they do not call Slack,
 * Monday, Fireflies, Google, Meta, Typeform, Supabase, or production systems.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getWorkspaceConnectorRegistry,
  type WorkspaceConnectorId,
} from "../src/lib/workspace-connectors.ts";

const NOW = new Date("2026-06-05T08:00:00.000Z");

function connectorById(
  connectors: Awaited<ReturnType<typeof getWorkspaceConnectorRegistry>>["connectors"],
  id: WorkspaceConnectorId,
) {
  const connector = connectors.find((item) => item.id === id);
  assert.ok(connector, `Expected ${id} connector`);
  return connector;
}

test("registry reports online local bridges with approval-gated actions", async () => {
  const registry = await getWorkspaceConnectorRegistry({
    now: () => NOW,
    fileExists: async (path) => path.includes("service-account") || path.includes("google-auth") || path.includes("typeform-parser"),
    healthCheck: async (url) => ({
      ok: true,
      configured: true,
      service: url.includes("4006") ? "atlas-slack-bridge" : url.includes("4004") ? "atlas-monday-bridge" : "atlas-fireflies-bridge",
      latencyMs: 12,
      summary: "Local health check passed.",
    }),
  });

  assert.equal(registry.generatedAt, NOW.toISOString());
  assert.equal(registry.summary.online, 3);

  const slack = connectorById(registry.connectors, "slack");
  assert.equal(slack.status, "online");
  assert.equal(slack.capabilities.read.state, "available");
  assert.equal(slack.capabilities.send.state, "approval_gated");

  const monday = connectorById(registry.connectors, "monday");
  assert.equal(monday.capabilities.write.state, "approval_gated");
  assert.match(monday.capabilities.write.items.join(" "), /does not expose/);

  const fireflies = connectorById(registry.connectors, "fireflies");
  assert.equal(fireflies.capabilities.read.state, "available");
  assert.match(fireflies.capabilities.read.items.join(" "), /transcript/i);
});

test("Google Ads and Meta Ads are truthfully marked not wired", async () => {
  const registry = await getWorkspaceConnectorRegistry({
    now: () => NOW,
    fileExists: async () => false,
    healthCheck: async () => ({
      ok: false,
      configured: null,
      service: null,
      latencyMs: null,
      summary: "Local health check did not respond.",
    }),
  });

  const googleAds = connectorById(registry.connectors, "google-ads");
  const metaAds = connectorById(registry.connectors, "meta-ads");

  assert.equal(googleAds.status, "not_wired");
  assert.equal(googleAds.safetyLevel, "blocked");
  assert.equal(googleAds.capabilities.write.state, "blocked");
  assert.equal(metaAds.status, "not_wired");
  assert.equal(metaAds.capabilities.read.state, "not_wired");
});

test("registry output does not leak local paths or secrets", async () => {
  const registry = await getWorkspaceConnectorRegistry({
    now: () => NOW,
    fileExists: async () => true,
    healthCheck: async () => ({
      ok: true,
      configured: true,
      service: "atlas-local-bridge",
      latencyMs: 4,
      summary: "Local health check passed.",
    }),
  });
  const serialized = JSON.stringify(registry);

  assert.doesNotMatch(serialized, /\/Users\/atlasai/);
  assert.doesNotMatch(serialized, /\.openclaw/);
  assert.doesNotMatch(serialized, /service-account\.json/);
  assert.doesNotMatch(serialized, /TOKEN|API_KEY|SECRET/i);
});

test("not configured bridges expose blocker and fix hint without enabling actions", async () => {
  const registry = await getWorkspaceConnectorRegistry({
    now: () => NOW,
    fileExists: async () => false,
    healthCheck: async () => ({
      ok: true,
      configured: false,
      service: "atlas-slack-bridge",
      latencyMs: 9,
      summary: "Local health check passed.",
    }),
  });

  const slack = connectorById(registry.connectors, "slack");
  assert.equal(slack.status, "not_configured");
  assert.equal(slack.capabilities.read.state, "not_exposed");
  assert.match(slack.blocker ?? "", /not configured/);
  assert.match(slack.fixHint ?? "", /tokens/i);
});
