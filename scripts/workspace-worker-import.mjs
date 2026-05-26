#!/usr/bin/env node

import {
  applyWorkspaceLocalJobControl,
  importWorkspaceLocalWorkerResult,
} from "../src/lib/workspace-local-jobs.ts";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--job") args.jobId = argv[++index];
    else if (item === "--result") args.resultPath = argv[++index];
    else if (item === "--help" || item === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function printHelp() {
  console.log([
    "Usage: npm run workspace:worker:import -- --job <local_job_id> --result <path>",
    "",
    "Imports a local result file into the Workspace job thread.",
    "The result is stored locally only; nothing is delivered, sent, published, or written to external systems.",
  ].join("\n"));
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

try {
  if (!args.jobId) throw new Error("--job is required.");
  if (!args.resultPath) throw new Error("--result is required.");

  const result = await importWorkspaceLocalWorkerResult({
    jobId: args.jobId,
    resultPath: args.resultPath,
  });

  console.log(JSON.stringify({
    ok: true,
    localOnly: true,
    nonExecuting: true,
    jobId: result.job.id,
    status: "completed_local",
    resultPath: result.resultPath,
    events: result.events.map((event) => event.action),
  }, null, 2));
} catch (error) {
  if (args.jobId) {
    await applyWorkspaceLocalJobControl({
      jobId: args.jobId,
      action: "worker_failed",
      adapter: "codex",
      errorMessage: error instanceof Error ? error.message : String(error),
      note: "Local worker import failed. No external side effect was attempted.",
    }).catch(() => undefined);
  }

  console.error(JSON.stringify({
    ok: false,
    localOnly: true,
    nonExecuting: true,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
