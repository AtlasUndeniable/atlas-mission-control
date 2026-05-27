#!/usr/bin/env node

import {
  discoverCodexExecutionOptions,
  runWorkspaceCodexExecution,
} from "../src/lib/workspace-codex-execution.ts";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--job") args.jobId = argv[++index];
    else if (item === "--discover") args.discover = true;
    else if (item === "--help" || item === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function printHelp() {
  console.log([
    "Usage: npm run workspace:worker:run-codex -- --job <local_job_id>",
    "",
    "Runs one ready or staged local Workspace job through a safe local Codex CLI if available.",
    "This is explicit terminal-only execution: no daemon, watch mode, browser run button, Slack, Supabase, Monday, Typeform, OpenClaw config mutation, or file deletion.",
    "If no safe local Codex runner is available, it prepares the request package and prints the exact manual command instead.",
  ].join("\n"));
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.discover) {
    const discovery = await discoverCodexExecutionOptions();
    console.log(JSON.stringify({
      ok: true,
      localOnly: true,
      runnerAvailable: discovery.available,
      reason: discovery.reason,
      runnerPath: discovery.runnerPath,
      runnerArgsPreview: discovery.runnerArgsPreview,
      packageScripts: discovery.packageScripts,
      localBinaries: discovery.localBinaries,
      environmentSignals: discovery.environmentSignals,
      rejectedOptions: discovery.rejectedOptions,
    }, null, 2));
    process.exit(0);
  }

  if (!args.jobId) throw new Error("--job is required. This command intentionally runs one explicit job only.");

  const result = await runWorkspaceCodexExecution({ jobId: args.jobId });
  console.log(JSON.stringify({
    ok: result.ok,
    localOnly: true,
    terminalOnly: true,
    oneShot: true,
    noDaemon: true,
    noExternalDelivery: true,
    jobId: result.jobId,
    status: result.status,
    runnerAvailable: result.runnerAvailable,
    message: result.message,
    requestFiles: result.requestFiles,
    resultPath: result.resultPath,
    manualCommand: result.discovery.manualCommand,
    discovered: {
      reason: result.discovery.reason,
      runnerPath: result.discovery.runnerPath,
      runnerArgsPreview: result.discovery.runnerArgsPreview,
      packageScripts: result.discovery.packageScripts,
      localBinaries: result.discovery.localBinaries,
      environmentSignals: result.discovery.environmentSignals,
      rejectedOptions: result.discovery.rejectedOptions,
    },
    events: result.events,
  }, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    localOnly: true,
    terminalOnly: true,
    oneShot: true,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
