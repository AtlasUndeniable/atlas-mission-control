#!/usr/bin/env node
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  formatGatewayFailureDetails,
  gatewayFailureDetails,
  isUsefulGatewayReply,
  prepareSlackReply,
  redactSlackDiagnostic,
  splitProviderModel,
} from "../openclaw-runtime/workspace/lib/slack-listener-reply.mjs";

const DEFAULT_OPENCLAW_CONFIG = "/Users/atlasai/.openclaw/openclaw.json";
const LEAK_PATTERN = /(?:\/Users\/atlasai|\.openclaw\/|xox[baprs]-|Bearer\s+[A-Za-z0-9._-]+|SLACK_[A-Z0-9_]*=|OPENAI_API_KEY|ANTHROPIC_API_KEY)/i;

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    message: "Dry-run Slack harness: verify Atlas reply path.",
    userId: "U_DRYRUN",
    channel: "D_DRYRUN",
    configPath: DEFAULT_OPENCLAW_CONFIG,
    gatewayMode: "mock-success",
    reply: "Dry-run reply produced. Slack send is blocked by the harness.",
    json: false,
    logFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--message") options.message = argv[++index] || "";
    else if (arg === "--user-id") options.userId = argv[++index] || "";
    else if (arg === "--channel") options.channel = argv[++index] || "";
    else if (arg === "--config") options.configPath = argv[++index] || "";
    else if (arg === "--gateway-mode") options.gatewayMode = argv[++index] || "";
    else if (arg === "--reply") options.reply = argv[++index] || "";
    else if (arg === "--log-file") options.logFile = argv[++index] || "";
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readBrainFromConfig(configPath = DEFAULT_OPENCLAW_CONFIG) {
  try {
    if (!configPath || !existsSync(configPath)) return splitProviderModel("");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return splitProviderModel(config?.agents?.defaults?.model?.primary || "");
  } catch {
    return splitProviderModel("");
  }
}

function simulateGateway({ mode, reply, brain }) {
  if (mode === "mock-timeout") {
    return {
      ok: false,
      reply: "",
      timedOut: true,
      errorMessage: "Command failed after dry-run timeout",
      stderr: "dry-run timeout before a response was generated",
      stdout: "",
      brain,
    };
  }
  if (mode === "mock-empty") {
    return {
      ok: true,
      reply: "",
      timedOut: false,
      errorMessage: "",
      stderr: "",
      stdout: "",
      brain,
    };
  }
  if (mode === "mock-provider-error") {
    return {
      ok: false,
      reply: "",
      timedOut: false,
      errorMessage: "LLM request failed: network connection error",
      stderr: "rawError=fetch failed",
      stdout: "",
      brain,
    };
  }
  return {
    ok: true,
    reply,
    timedOut: false,
    errorMessage: "",
    stderr: "",
    stdout: reply,
    brain,
  };
}

export async function runSlackDryRunE2E({
  message = "Dry-run Slack harness: verify Atlas reply path.",
  userId = "U_DRYRUN",
  channel = "D_DRYRUN",
  configPath = DEFAULT_OPENCLAW_CONFIG,
  gatewayMode = "mock-success",
  reply = "Dry-run reply produced. Slack send is blocked by the harness.",
  logFile = null,
  now = () => new Date(),
} = {}) {
  const brain = readBrainFromConfig(configPath);
  const runId = `slack-dry-run-${now().toISOString().replace(/[^0-9TZ]/g, "")}`;
  const event = {
    type: "message",
    channel_type: "im",
    channel,
    user: userId,
    ts: "dry-run-ts",
    text: message,
  };
  const gateway = simulateGateway({ mode: gatewayMode, reply, brain });
  const usefulReply = isUsefulGatewayReply(gateway.reply);
  const failureDetails = usefulReply ? null : gatewayFailureDetails({
    timedOut: gateway.timedOut,
    errorMessage: gateway.errorMessage,
    stderr: gateway.stderr,
    stdout: gateway.stdout,
    reply: gateway.reply,
    provider: brain.provider,
    model: brain.model,
  });
  const prepared = usefulReply
    ? prepareSlackReply(gateway.reply, { preferredDelivery: "slack_dm" })
    : { text: formatGatewayFailureDetails(failureDetails), chunks: [], mediaPaths: [], kind: "failure" };

  const logLines = [
    `run_id=${runId} phase=received channel=${event.channel} user=${event.user}`,
    `run_id=${runId} phase=brain_selected provider=${brain.provider} model=${brain.model}`,
    usefulReply
      ? `run_id=${runId} phase=draft_ready chunks=${prepared.chunks.length}`
      : `run_id=${runId} phase=draft_failed ${formatGatewayFailureDetails(failureDetails)}`,
    `run_id=${runId} phase=send_boundary dry_run=true attempted=false blocked=true`,
  ].map((line) => redactSlackDiagnostic(line));

  let logCreated = false;
  let logLabel = "temp dry-run log";
  let targetLogFile = logFile;
  if (!targetLogFile) {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-slack-dry-run-"));
    targetLogFile = join(dir, "run.log");
  }
  await writeFile(targetLogFile, `${logLines.join("\n")}\n`, "utf8");
  logCreated = true;
  const logText = await readFile(targetLogFile, "utf8");

  const report = {
    ok: true,
    runId,
    eventReceived: true,
    logCreated,
    logLabel,
    brainSelected: brain.provider !== "unknown" && brain.model !== "unknown",
    provider: brain.provider,
    model: brain.model,
    nonEmptyDraft: usefulReply && Boolean(prepared.text?.trim()),
    responseKind: prepared.kind,
    chunks: prepared.chunks?.length || 0,
    sendBoundary: {
      dryRun: true,
      attempted: false,
      blocked: true,
      reason: "dry-run harness never calls Slack API",
    },
    failureDetails,
    leakFree: !LEAK_PATTERN.test(JSON.stringify({ ...prepared, logText, reportPreview: logLines })),
  };
  report.ok = report.eventReceived
    && report.logCreated
    && report.brainSelected
    && (report.nonEmptyDraft || Boolean(report.failureDetails))
    && report.sendBoundary.blocked
    && report.leakFree;
  return report;
}

function printHelp() {
  console.log([
    "Usage: node scripts/openclaw-slack-dry-run-e2e.mjs [--json] [--message TEXT]",
    "",
    "Simulates the Slack listener receipt -> brain selection -> draft -> send boundary path.",
    "It never calls Slack and never invokes the live OpenClaw agent.",
    "",
    "Modes:",
    "  --gateway-mode mock-success        Produce a non-empty draft. Default.",
    "  --gateway-mode mock-timeout        Verify structured timeout failure.",
    "  --gateway-mode mock-empty          Verify structured empty response failure.",
    "  --gateway-mode mock-provider-error Verify structured provider failure.",
  ].join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs();
    if (options.help) {
      printHelp();
    } else {
      const report = await runSlackDryRunE2E(options);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log([
          `ok=${report.ok}`,
          `run_id=${report.runId}`,
          `provider=${report.provider}`,
          `model=${report.model}`,
          `event_received=${report.eventReceived}`,
          `log_created=${report.logCreated}`,
          `non_empty_draft=${report.nonEmptyDraft}`,
          `send_blocked=${report.sendBoundary.blocked}`,
          `leak_free=${report.leakFree}`,
        ].join("\n"));
      }
      if (!report.ok) process.exitCode = 1;
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}
