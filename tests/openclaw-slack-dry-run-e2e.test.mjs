import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runSlackDryRunE2E } from "../scripts/openclaw-slack-dry-run-e2e.mjs";

async function withConfig(fn) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-slack-dry-run-test-"));
  try {
    const configPath = join(root, "openclaw.json");
    await writeFile(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.5",
          },
        },
      },
    }), "utf8");
    await mkdir(join(root, "logs"), { recursive: true });
    await fn({ root, configPath, logFile: join(root, "logs", "dry-run.log") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Slack dry-run E2E verifies receipt, brain selection, draft, leak check, and blocked send", async () => {
  await withConfig(async ({ configPath, logFile }) => {
    const report = await runSlackDryRunE2E({
      configPath,
      logFile,
      now: () => new Date("2026-06-08T07:00:00.000Z"),
      message: "dry-run only please",
    });

    assert.equal(report.ok, true);
    assert.equal(report.eventReceived, true);
    assert.equal(report.logCreated, true);
    assert.equal(report.brainSelected, true);
    assert.equal(report.provider, "openai-codex");
    assert.equal(report.model, "gpt-5.5");
    assert.equal(report.nonEmptyDraft, true);
    assert.equal(report.sendBoundary.dryRun, true);
    assert.equal(report.sendBoundary.attempted, false);
    assert.equal(report.sendBoundary.blocked, true);
    assert.equal(report.leakFree, true);
    assert.doesNotMatch(JSON.stringify(report), /\/Users\/atlasai|\.openclaw|xox|SLACK_/);
  });
});

test("Slack dry-run E2E returns structured timeout failure without Slack send", async () => {
  await withConfig(async ({ configPath, logFile }) => {
    const report = await runSlackDryRunE2E({
      configPath,
      logFile,
      gatewayMode: "mock-timeout",
    });

    assert.equal(report.ok, true);
    assert.equal(report.nonEmptyDraft, false);
    assert.equal(report.failureDetails.failureType, "timeout");
    assert.equal(report.sendBoundary.blocked, true);
    assert.equal(report.leakFree, true);
  });
});

test("Slack dry-run E2E catches empty and provider error failure classes", async () => {
  await withConfig(async ({ configPath, logFile }) => {
    const empty = await runSlackDryRunE2E({
      configPath,
      logFile,
      gatewayMode: "mock-empty",
    });
    assert.equal(empty.failureDetails.failureType, "empty_response");

    const provider = await runSlackDryRunE2E({
      configPath,
      logFile,
      gatewayMode: "mock-provider-error",
    });
    assert.equal(provider.failureDetails.failureType, "provider_error");
    assert.equal(provider.provider, "openai-codex");
    assert.equal(provider.model, "gpt-5.5");
  });
});

test("Slack dry-run E2E fails leak check for unsafe draft content", async () => {
  await withConfig(async ({ configPath, logFile }) => {
    const report = await runSlackDryRunE2E({
      configPath,
      logFile,
      reply: "Generated draft includes xoxb-unsafe-test-token",
    });

    assert.equal(report.ok, false);
    assert.equal(report.leakFree, false);
    assert.equal(report.sendBoundary.blocked, true);
  });
});
