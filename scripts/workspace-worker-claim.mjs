#!/usr/bin/env node

import {
  getWorkspaceLocalJobs,
  claimWorkspaceLocalWorkerJob,
} from "../src/lib/workspace-local-jobs.ts";
import { resolveWorkspaceLibrarianReferences } from "../src/lib/workspace-librarian-references.ts";

function parseArgs(argv) {
  const args = { adapter: "codex" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--job") args.jobId = argv[++index];
    else if (item === "--adapter") args.adapter = argv[++index];
    else if (item === "--help" || item === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function printHelp() {
  console.log([
    "Usage: npm run workspace:worker:claim -- --job <local_job_id> --adapter codex",
    "",
    "Claims one ready_for_worker local Workspace job and writes a request package to disk.",
    "No worker, model, Slack, Supabase, Monday, Typeform, OpenClaw config, or external send is invoked.",
  ].join("\n"));
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const projection = await getWorkspaceLocalJobs();
  const job = args.jobId
    ? projection.records.find((record) => record.id === args.jobId)
    : projection.records.find((record) => record.status === "ready_for_worker");
  if (!job) throw new Error(args.jobId ? `Local job ${args.jobId} was not found.` : "No ready local worker job was found.");
  const librarianReferences = await resolveWorkspaceLibrarianReferences(job);

  const result = await claimWorkspaceLocalWorkerJob({
    jobId: args.jobId,
    adapter: args.adapter,
    librarianReferences,
  });

  console.log(JSON.stringify({
    ok: true,
    localOnly: true,
    nonExecuting: true,
    jobId: result.job.id,
    status: "worker_staged",
    requestJsonPath: result.files.requestJsonPath,
    requestMarkdownPath: result.files.requestMarkdownPath,
    resultJsonPath: result.files.resultJsonPath,
    resultMarkdownPath: result.files.resultMarkdownPath,
    librarianReferences: result.request.librarianReferences,
    events: result.events.map((event) => event.action),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    localOnly: true,
    nonExecuting: true,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
