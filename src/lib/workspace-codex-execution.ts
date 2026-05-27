import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

import {
  applyWorkspaceLocalJobControl,
  claimWorkspaceLocalWorkerJob,
  getWorkspaceLocalJobs,
  importWorkspaceLocalWorkerResult,
  WORKSPACE_LOCAL_JOBS_ROOT,
} from "./workspace-local-jobs.ts";
import type {
  WorkspaceLocalJob,
  WorkspaceLocalWorkerRequestFiles,
} from "./workspace-local-jobs.ts";
import { resolveWorkspaceLibrarianReferences } from "./workspace-librarian-references.ts";

const DEFAULT_CODEX_APP_BINARY = "/Applications/Codex.app/Contents/Resources/codex";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const SECRET_ENV_PATTERN = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|SESSION|COOKIE)/i;

export type CodexExecutionDiscovery = {
  available: boolean;
  reason: string;
  runnerPath: string | null;
  runnerArgsPreview: string[];
  manualCommand: string | null;
  packageScripts: string[];
  localBinaries: string[];
  environmentSignals: string[];
  rejectedOptions: Array<{
    source: string;
    reason: string;
  }>;
};

export type WorkspaceCodexExecutionResult = {
  ok: boolean;
  jobId: string;
  status: "manual_required" | "completed" | "failed";
  runnerAvailable: boolean;
  discovery: CodexExecutionDiscovery;
  requestFiles: WorkspaceLocalWorkerRequestFiles | null;
  resultPath: string | null;
  events: string[];
  message: string;
};

type DiscoverOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageJsonPath?: string;
};

type RunOptions = {
  jobId: string;
  root?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  timeoutMs?: number;
  idFactory?: () => string;
  discovery?: CodexExecutionDiscovery;
};

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function readPackageScripts(packageJsonPath: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !("scripts" in parsed)) return [];
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
    return Object.entries(scripts)
      .filter(([name, command]) => /codex|workspace:worker:run/i.test(`${name} ${String(command)}`))
      .map(([name, command]) => `${name}: ${String(command)}`);
  } catch {
    return [];
  }
}

function candidateCodexPaths({ cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }): Array<{ source: string; path: string }> {
  const candidates: Array<{ source: string; path: string }> = [];
  const envCandidate = env.ATLAS_CODEX_EXECUTABLE ?? env.CODEX_EXECUTABLE;
  if (envCandidate) candidates.push({ source: "environment", path: envCandidate });
  candidates.push({ source: "local binary", path: join(cwd, "node_modules", ".bin", "codex") });
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push({ source: "PATH", path: join(dir, "codex") });
  }
  candidates.push({ source: "Codex.app", path: DEFAULT_CODEX_APP_BINARY });
  return candidates;
}

function environmentSignals(env: NodeJS.ProcessEnv): string[] {
  return [
    env.CODEX_HOME ? "CODEX_HOME" : "",
    env.CODEX_CI ? "CODEX_CI" : "",
    env.CODEX_SHELL ? "CODEX_SHELL" : "",
    env.CODEX_THREAD_ID ? "CODEX_THREAD_ID" : "",
    env.ATLAS_CODEX_EXECUTABLE ? "ATLAS_CODEX_EXECUTABLE" : "",
    env.CODEX_EXECUTABLE ? "CODEX_EXECUTABLE" : "",
  ].filter(Boolean);
}

function validateCodexPath(candidatePath: string): string | null {
  if (!candidatePath.trim()) return "path is empty";
  if (!isAbsolute(candidatePath)) return "path must be absolute";
  if (basename(candidatePath) !== "codex") return "runner executable must be named codex";
  if (candidatePath.includes("\0")) return "path contains invalid characters";
  return null;
}

export async function discoverCodexExecutionOptions(options: DiscoverOptions = {}): Promise<CodexExecutionDiscovery> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const packageJsonPath = options.packageJsonPath ?? join(cwd, "package.json");
  const packageScripts = await readPackageScripts(packageJsonPath);
  const rejectedOptions: CodexExecutionDiscovery["rejectedOptions"] = [];
  const localBinaries: string[] = [];

  if (env.ATLAS_WORKSPACE_CODEX_RUNNER_DISABLED === "1") {
    return {
      available: false,
      reason: "Codex execution is disabled by ATLAS_WORKSPACE_CODEX_RUNNER_DISABLED=1.",
      runnerPath: null,
      runnerArgsPreview: [],
      manualCommand: null,
      packageScripts,
      localBinaries,
      environmentSignals: environmentSignals(env),
      rejectedOptions,
    };
  }

  for (const candidate of candidateCodexPaths({ cwd, env })) {
    const pathError = validateCodexPath(candidate.path);
    if (pathError) {
      rejectedOptions.push({ source: candidate.source, reason: `${candidate.path}: ${pathError}` });
      continue;
    }
    if (!await isExecutable(candidate.path)) {
      rejectedOptions.push({ source: candidate.source, reason: `${candidate.path}: not executable or not present` });
      continue;
    }
    localBinaries.push(candidate.path);
  }

  const runnerPath = unique(localBinaries)[0] ?? null;
  const runnerArgsPreview = runnerPath
    ? ["exec", "--cd", cwd, "--sandbox", "read-only", "--ephemeral", "--output-last-message", "<result-md>", "-"]
    : [];
  return {
    available: Boolean(runnerPath),
    reason: runnerPath
      ? "Found a local Codex CLI with the non-interactive exec command available for explicit terminal use."
      : "No executable local Codex CLI was found.",
    runnerPath,
    runnerArgsPreview,
    manualCommand: null,
    packageScripts,
    localBinaries: unique(localBinaries),
    environmentSignals: environmentSignals(env),
    rejectedOptions,
  };
}

export function buildSanitizedCodexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safeEnv: Partial<NodeJS.ProcessEnv> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERN.test(key)) continue;
    safeEnv[key] = value;
  }
  return {
    ...safeEnv,
    CODEX_WORKSPACE_EXECUTION_ADAPTER: "atlas-workspace-local-v0",
  } as NodeJS.ProcessEnv;
}

function buildCodexPrompt({
  job,
  requestMarkdown,
  files,
}: {
  job: WorkspaceLocalJob;
  requestMarkdown: string;
  files: WorkspaceLocalWorkerRequestFiles;
}): string {
  return [
    "You are running a local, explicit, one-shot Workspace Codex execution adapter.",
    "",
    "Safety gates:",
    "- Work on this one Workspace job only.",
    "- Do not run a daemon, watcher, server, background job, or recurring task.",
    "- Do not send, publish, DM, email, Slack, Monday, Typeform, Supabase, or mutate OpenClaw config.",
    "- Do not delete files.",
    "- Return only the final Workspace result as Markdown.",
    "",
    `Job: ${job.id} - ${job.title}`,
    `The adapter will capture your final response at: ${files.resultMarkdownPath}`,
    "",
    requestMarkdown,
  ].join("\n");
}

function buildManualCommand({
  runnerPath,
  cwd,
  files,
}: {
  runnerPath: string | null;
  cwd: string;
  files: WorkspaceLocalWorkerRequestFiles;
}): string {
  const codex = runnerPath ?? "codex";
  return [
    shellQuote(codex),
    "exec",
    "--cd",
    shellQuote(cwd),
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--output-last-message",
    shellQuote(files.resultMarkdownPath),
    "-",
    "<",
    shellQuote(files.requestMarkdownPath),
  ].join(" ");
}

function runCodexProcess({
  runnerPath,
  args,
  cwd,
  env,
  input,
  timeoutMs,
}: {
  runnerPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(runnerPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectProcess(new Error(`Codex execution timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectProcess(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveProcess({ stdout, stderr });
      else rejectProcess(new Error(`Codex exited with code ${code ?? "unknown"}. ${stderr || stdout}`.trim()));
    });
    child.stdin.end(input);
  });
}

async function ensureResultWritten(resultPath: string): Promise<void> {
  const info = await stat(resultPath);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Codex did not write a non-empty result file at ${resultPath}.`);
  }
}

export async function runWorkspaceCodexExecution(options: RunOptions): Promise<WorkspaceCodexExecutionResult> {
  const root = options.root ?? WORKSPACE_LOCAL_JOBS_ROOT;
  const cwd = resolve(options.cwd ?? process.cwd());
  const projection = await getWorkspaceLocalJobs({ root });
  const initialJob = projection.records.find((record) => record.id === options.jobId);
  if (!initialJob) throw new Error(`Local job ${options.jobId} was not found.`);
  if (!["ready_for_worker", "worker_staged"].includes(initialJob.status)) {
    throw new Error(`Local job ${initialJob.id} is ${initialJob.status}; mark it ready or stage it before running Codex.`);
  }

  let job = initialJob;
  let files = projection.workerRequestsByJob[job.id] ?? null;
  if (job.status === "ready_for_worker") {
    const librarianReferences = await resolveWorkspaceLibrarianReferences(job);
    const claim = await claimWorkspaceLocalWorkerJob({
      jobId: job.id,
      adapter: "codex",
      root,
      librarianReferences,
      now: options.now,
      idFactory: options.idFactory,
    });
    files = claim.files;
    const refreshed = await getWorkspaceLocalJobs({ root });
    job = refreshed.records.find((record) => record.id === options.jobId) ?? job;
  }
  if (!files) throw new Error(`Local job ${job.id} has no staged Codex request files.`);

  const discovery = options.discovery ?? await discoverCodexExecutionOptions({ cwd, env: options.env });
  discovery.manualCommand = buildManualCommand({ runnerPath: discovery.runnerPath, cwd, files });
  if (!discovery.available || !discovery.runnerPath) {
    return {
      ok: false,
      jobId: job.id,
      status: "manual_required",
      runnerAvailable: false,
      discovery,
      requestFiles: files,
      resultPath: null,
      events: [],
      message: "No safe local Codex runner is available. Request files were prepared; run the printed manual command from a trusted terminal/session.",
    };
  }

  const requestMarkdown = await readFile(files.requestMarkdownPath, "utf8");
  const prompt = buildCodexPrompt({ job, requestMarkdown, files });
  const args = [
    "exec",
    "--cd",
    cwd,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--output-last-message",
    files.resultMarkdownPath,
    "-",
  ];
  const events: string[] = [];

  await applyWorkspaceLocalJobControl(
    {
      jobId: job.id,
      action: "execution_started",
      adapter: "codex",
      requestFiles: files,
      note: `Started explicit terminal Codex execution via ${discovery.runnerPath}.`,
    },
    { root, now: options.now, idFactory: options.idFactory },
  );
  events.push("execution_started");

  try {
    await runCodexProcess({
      runnerPath: discovery.runnerPath,
      args,
      cwd,
      env: buildSanitizedCodexEnv(options.env),
      input: prompt,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    await ensureResultWritten(files.resultMarkdownPath);
    const imported = await importWorkspaceLocalWorkerResult({
      jobId: job.id,
      resultPath: files.resultMarkdownPath,
      root,
      now: options.now,
      idFactory: options.idFactory,
    });
    events.push(...imported.events.map((event) => event.action));
    await applyWorkspaceLocalJobControl(
      {
        jobId: job.id,
        action: "execution_completed",
        adapter: "codex",
        resultPath: files.resultMarkdownPath,
        note: "Explicit Codex execution completed and imported locally. No external delivery was attempted.",
      },
      { root, now: options.now, idFactory: options.idFactory },
    );
    events.push("execution_completed");

    return {
      ok: true,
      jobId: job.id,
      status: "completed",
      runnerAvailable: true,
      discovery,
      requestFiles: files,
      resultPath: files.resultMarkdownPath,
      events,
      message: "Codex execution completed and the result was imported into the local Workspace job.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await applyWorkspaceLocalJobControl(
      {
        jobId: job.id,
        action: "execution_failed",
        adapter: "codex",
        errorMessage: message,
        note: "Explicit Codex execution failed closed. No external delivery was attempted.",
      },
      { root, now: options.now, idFactory: options.idFactory },
    );
    events.push("execution_failed");
    return {
      ok: false,
      jobId: job.id,
      status: "failed",
      runnerAvailable: true,
      discovery,
      requestFiles: files,
      resultPath: existsSync(files.resultMarkdownPath) ? files.resultMarkdownPath : null,
      events,
      message,
    };
  }
}
