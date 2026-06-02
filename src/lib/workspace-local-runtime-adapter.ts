import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

import { buildWorkspaceRuntimeContext } from "./workspace-runtime-context.ts";
import type { AgentEvent, Artifact, Task, TaskStep } from "./workspace-demo-events";
import type { WorkspaceRuntimeContextPacket } from "./workspace-runtime-context.ts";
import type { WorkspaceReferencePacket } from "./workspace-reference-resolver.ts";

export type WorkspaceLocalRuntimeMode = "mock" | "codex" | "claude";

export interface WorkspaceLocalRuntimeInput {
  prompt: string;
  title?: string;
}

export interface WorkspaceLocalRuntimeContext {
  workspaceId: string;
  taskId: string;
  runId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  idFactory?: () => string;
  commandRunner?: TerminalCommandRunner;
  referenceResolver?: WorkspaceReferenceResolver;
}

export interface WorkspaceLocalRuntimeAdapter {
  runTask(input: WorkspaceLocalRuntimeInput, ctx: WorkspaceLocalRuntimeContext): AsyncIterable<AgentEvent>;
}

export interface TerminalLocalRuntimeAdapterOptions {
  forcedMode?: "mock";
  forcedRunner?: "codex" | "claude";
}

export interface TerminalCommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
}

export interface TerminalCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type TerminalCommandRunner = (request: TerminalCommandRequest) => Promise<TerminalCommandResult>;
export type WorkspaceReferenceResolver = (input: WorkspaceLocalRuntimeInput) => Promise<WorkspaceReferencePacket>;

interface AdapterEventContext {
  workspaceId: string;
  taskId: string;
  runId: string;
  now: () => Date;
  nextId: (prefix: string) => string;
}

interface LocalRunnerSelection {
  mode: WorkspaceLocalRuntimeMode;
  available: boolean;
  explicit: boolean;
  command: string | null;
  args: string[];
  reason: string;
}

interface LocalAdapterOutput {
  presentationText: string;
  presentationSummary: string;
  internalSummary: string;
  artifact: Artifact | null;
  usedFallback: boolean;
  error: string | null;
}

const APPROVED_LOCAL_COMMANDS = ["codex", "claude"] as const;
const DEFAULT_TIMEOUT_MS = 90_000;
const STREAM_CHUNK_SIZE = 26;

export class TerminalLocalRuntimeAdapter implements WorkspaceLocalRuntimeAdapter {
  private readonly options: TerminalLocalRuntimeAdapterOptions;

  constructor(options: TerminalLocalRuntimeAdapterOptions = {}) {
    this.options = options;
  }

  async *runTask(input: WorkspaceLocalRuntimeInput, ctx: WorkspaceLocalRuntimeContext): AsyncIterable<AgentEvent> {
    const checkedInput = validateLocalRuntimeInput(input);
    const eventCtx = createEventContext(ctx);
    const taskTitle = checkedInput.title ?? "Run local workspace task";
    const userMessageId = `${eventCtx.runId}_user`;
    const assistantMessageId = `${eventCtx.runId}_assistant`;
    const steps: TaskStep[] = [
      { id: "step_prepare_local_runtime", title: "Prepare local runtime", status: "running" },
      { id: "step_run_local_adapter", title: "Run local adapter", status: "pending" },
      { id: "step_stream_workspace_events", title: "Stream workspace events", status: "pending" },
    ];

    yield messageComplete(eventCtx, userMessageId, "user", checkedInput.prompt);
    yield taskStep(eventCtx, steps[0]);

    const env = ctx.env ?? process.env;
    const cwd = ctx.cwd ?? env.PWD ?? ".";
    const selection = await selectLocalRunner({ cwd, env, options: this.options });
    const referencePacket = await (ctx.referenceResolver ?? resolveRuntimeReferences)(checkedInput);
    const runtimeContext = buildWorkspaceRuntimeContext(checkedInput, {
      provider: selection.mode === "mock" ? "mock" : "local-codex",
      referencePacket,
    });
    steps[0] = { ...steps[0], status: "complete", summary: selection.reason };
    steps[1] = { ...steps[1], status: "running" };
    yield taskStep(eventCtx, steps[0]);
    yield taskStep(eventCtx, steps[1]);

    const output = selection.available && selection.command
      ? await runApprovedCommand({
        input: checkedInput,
        cwd,
        env,
        selection,
        runtimeContext,
        commandRunner: ctx.commandRunner ?? runTerminalCommand,
      })
      : selection.explicit
        ? buildBlockedOutput(checkedInput, selection, {
          internalSummary: `${selection.reason}; ${runtimeContext.internalSummary}`,
        })
        : buildMockOutput(checkedInput, selection.reason, runtimeContext);

    yield {
      ...baseEvent(eventCtx),
      id: eventCtx.nextId("evt_internal"),
      kind: "tool.call",
      visibility: "internal",
      toolName: `local.${selection.mode}`,
      label: selection.available && selection.command ? "Run approved local command" : "Select local runtime",
      inputSummary: selection.available && selection.command
        ? `cwd=${cwd}; command=${selection.command}; args=${selection.args.join(" ")}; timeout_ms=${DEFAULT_TIMEOUT_MS}; ${runtimeContext.internalSummary}`
        : `${selection.reason}; ${runtimeContext.internalSummary}`,
    };

    yield {
      ...baseEvent(eventCtx),
      id: eventCtx.nextId("evt_internal"),
      kind: "tool.result",
      visibility: "internal",
      toolName: `local.${selection.mode}`,
      label: output.usedFallback ? "Safe mock fallback complete" : output.error ? "Local adapter blocked" : "Local adapter output captured",
      resultSummary: output.internalSummary,
    };

    if (output.error) {
      yield {
        ...baseEvent(eventCtx),
        id: eventCtx.nextId("evt_internal"),
        kind: "error",
        visibility: "internal",
        message: output.error,
        recoverable: true,
      };
    }

    steps[1] = {
      ...steps[1],
      status: output.error ? "error" : "complete",
      summary: output.presentationSummary,
    };
    steps[2] = { ...steps[2], status: "running" };
    yield taskStep(eventCtx, steps[1]);
    yield taskStep(eventCtx, steps[2]);

    for (const delta of splitStreamingText(output.presentationText)) {
      yield {
        ...baseEvent(eventCtx),
        id: eventCtx.nextId("evt_msg"),
        kind: "message.delta",
        visibility: "presentation",
        messageId: assistantMessageId,
        role: "assistant",
        delta,
      };
      await pause(18);
    }

    yield messageComplete(eventCtx, assistantMessageId, "assistant", output.presentationText);

    if (output.artifact) {
      yield {
        ...baseEvent(eventCtx),
        id: eventCtx.nextId("evt_artifact"),
        kind: "artifact.created",
        visibility: "presentation",
        artifact: output.artifact,
      };
    }

    steps[2] = {
      ...steps[2],
      status: "complete",
      summary: output.error
        ? "Rendered a clean presentation failure through the P1 AgentEvent contract."
        : "Rendered through the P1 AgentEvent contract.",
    };
    yield taskStep(eventCtx, steps[2]);
    yield {
      ...baseEvent(eventCtx),
      id: eventCtx.nextId("evt_task"),
      kind: "task.complete",
      visibility: "presentation",
      task: buildTask(eventCtx.taskId, taskTitle, steps),
    };
  }
}

async function resolveRuntimeReferences(input: WorkspaceLocalRuntimeInput): Promise<WorkspaceReferencePacket> {
  const { resolveWorkspaceReferences } = await import("./workspace-reference-resolver.ts");
  return resolveWorkspaceReferences({
    prompt: input.prompt,
    title: input.title,
    workspaceId: workspaceDemoRuntimeIds.workspaceId,
    project: "Undeniable",
    room: "workspace-demo",
  });
}

export function validateLocalRuntimeInput(input: WorkspaceLocalRuntimeInput): WorkspaceLocalRuntimeInput {
  if (!input || typeof input !== "object") throw new Error("Task input is required.");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("Task prompt is required.");
  if (prompt.length > 4_000) throw new Error("Task prompt must be 4000 characters or fewer.");
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
  return { prompt, title };
}

export function isApprovedLocalCommand(command: string): boolean {
  return APPROVED_LOCAL_COMMANDS.includes(command as typeof APPROVED_LOCAL_COMMANDS[number]);
}

export async function selectLocalRunner({
  cwd,
  env,
  options = {},
}: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  options?: TerminalLocalRuntimeAdapterOptions;
}): Promise<LocalRunnerSelection> {
  if (options.forcedMode === "mock") {
    return {
      mode: "mock",
      available: false,
      explicit: false,
      command: null,
      args: [],
      reason: "Safe mock runtime selected by ATLAS_WORKSPACE_DEMO_RUNTIME=mock.",
    };
  }

  const requested = options.forcedRunner ?? env.ATLAS_WORKSPACE_DEMO_LOCAL_RUNNER;
  if (requested !== "codex" && requested !== "claude") {
    return {
      mode: "mock",
      available: false,
      explicit: false,
      command: null,
      args: [],
      reason: "Safe mock mode is active. Set ATLAS_WORKSPACE_DEMO_LOCAL_RUNNER=codex or claude to opt into an approved local CLI.",
    };
  }

  const commandPath = await findExecutable(requested, env);
  if (!commandPath) {
    return {
      mode: requested,
      available: false,
      explicit: true,
      command: null,
      args: [],
      reason: `${requested} CLI was requested but no executable approved local binary was found.`,
    };
  }

  return {
    mode: requested,
    available: true,
    explicit: true,
    command: commandPath,
    args: requested === "codex"
      ? ["exec", "--cd", cwd, "--sandbox", "read-only", "--ephemeral", "-"]
      : ["-p"],
    reason: `Using approved local ${requested} CLI after explicit /workspace-demo trigger.`,
  };
}

export async function runTerminalCommand(request: TerminalCommandRequest): Promise<TerminalCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: buildSafeCommandEnv(request.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      resolveResult({
        ok: false,
        stdout: limitText(stdout),
        stderr: limitText(stderr || "Local command timed out."),
        exitCode: null,
        timedOut: true,
      });
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ ok: false, stdout: "", stderr: error.message, exitCode: null, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ok: code === 0,
        stdout: limitText(stdout),
        stderr: limitText(stderr),
        exitCode: code,
        timedOut: false,
      });
    });
    child.stdin.end(request.input);
  });
}

export const workspaceDemoRuntimeIds = {
  workspaceId: "workspace_undeniable_demo",
  taskId: "task_hybrid_local_demo",
};

function createEventContext(ctx: WorkspaceLocalRuntimeContext): AdapterEventContext {
  let index = 0;
  const idFactory = ctx.idFactory ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
  return {
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId,
    runId: ctx.runId ?? `run_local_${idFactory()}`,
    now: ctx.now ?? (() => new Date()),
    nextId: (prefix) => `${prefix}_${String(index++).padStart(3, "0")}_${idFactory()}`,
  };
}

function baseEvent(ctx: AdapterEventContext) {
  return {
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId,
    runId: ctx.runId,
    createdAt: ctx.now().toISOString(),
  };
}

function messageComplete(
  ctx: AdapterEventContext,
  messageId: string,
  role: "user" | "assistant",
  content: string,
): AgentEvent {
  return {
    ...baseEvent(ctx),
    id: ctx.nextId("evt_msg"),
    kind: "message.complete",
    visibility: "presentation",
    messageId,
    role,
    content,
  };
}

function taskStep(ctx: AdapterEventContext, step: TaskStep): AgentEvent {
  return {
    ...baseEvent(ctx),
    id: ctx.nextId("evt_step"),
    kind: "task.step",
    visibility: "presentation",
    step,
  };
}

async function runApprovedCommand({
  input,
  cwd,
  env,
  selection,
  runtimeContext,
  commandRunner,
}: {
  input: WorkspaceLocalRuntimeInput;
  cwd: string;
  env: NodeJS.ProcessEnv;
  selection: LocalRunnerSelection;
  runtimeContext: WorkspaceRuntimeContextPacket;
  commandRunner: TerminalCommandRunner;
}): Promise<LocalAdapterOutput> {
  if (!selection.command) return buildMockOutput(input, selection.reason, runtimeContext);
  const commandInput = buildCommandPrompt(input, runtimeContext);
  const result = await commandRunner({
    command: selection.command,
    args: selection.args,
    cwd,
    env: buildSafeCommandEnv(env),
    input: commandInput,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  if (!result.ok || !result.stdout.trim()) {
    return buildBlockedOutput(input, selection, {
      internalSummary: [
        `${selection.mode} command failed closed.`,
        `command=${selection.command}`,
        `args=${selection.args.join(" ")}`,
        `cwd=${cwd}`,
        `exit_code=${String(result.exitCode)}`,
        `timed_out=${String(result.timedOut)}`,
        `stderr=${limitText(result.stderr || "No stderr.")}`,
        runtimeContext.internalSummary,
      ].join("; "),
      error: `Approved ${selection.mode} command failed closed. Exit code: ${String(result.exitCode)}. ${result.timedOut ? "Timed out. " : ""}${limitText(result.stderr || "No stderr.")}`,
    });
  }

  const presentationText = normalizePresentationText(result.stdout);
  return {
    presentationText,
    presentationSummary: `Captured output from approved local ${selection.mode} CLI.`,
    internalSummary: [
      `${selection.mode} exited ${String(result.exitCode)} with ${result.stdout.length} stdout characters.`,
      `command=${selection.command}`,
      `args=${selection.args.join(" ")}`,
      `cwd=${cwd}`,
      result.stderr ? `stderr=${limitText(result.stderr)}` : "stderr=<empty>",
      runtimeContext.internalSummary,
    ].join("; "),
    artifact: buildArtifact(input, presentationText, selection.mode),
    usedFallback: false,
    error: null,
  };
}

function buildMockOutput(
  input: WorkspaceLocalRuntimeInput,
  reason: string,
  runtimeContext = buildWorkspaceRuntimeContext(input, { provider: "mock" }),
): LocalAdapterOutput {
  const presentationText = [
    "Local adapter V0 is running in safe mock mode.",
    "",
    `I received the workspace task: **${input.prompt}**`,
    "",
    "Here is the local pass I would hand back to the Manus-style thread:",
    "",
    "- Framed the request as a local-only workspace task.",
    "- Kept command details internal so the chat receives only presentation-safe output.",
    "- Produced a small artifact summary and completed the task chip through the same AgentEvent contract.",
    "",
    "No Slack, Monday, Typeform, OpenClaw, production Supabase, or Mastra calls were made.",
  ].join("\n");

  return {
    presentationText,
    presentationSummary: "Safe mock local runner produced presentation output.",
    internalSummary: `${reason}; ${runtimeContext.internalSummary}`,
    artifact: buildArtifact(input, presentationText, "mock"),
    usedFallback: true,
    error: null,
  };
}

function buildBlockedOutput(
  input: WorkspaceLocalRuntimeInput,
  selection: LocalRunnerSelection,
  options: { internalSummary?: string; error?: string } = {},
): LocalAdapterOutput {
  const presentationText = [
    "I could not safely run the requested real local adapter.",
    "",
    "The workspace did not call any external systems, and the command details were kept internal for the Inspector.",
    "",
    "Set up the approved local runner and try the task again when you want the real CLI path.",
  ].join("\n");
  return {
    presentationText,
    presentationSummary: `Real local ${selection.mode} runner failed closed.`,
    internalSummary: options.internalSummary ?? selection.reason,
    artifact: null,
    usedFallback: false,
    error: options.error ?? selection.reason,
  };
}

function buildArtifact(input: WorkspaceLocalRuntimeInput, content: string, source: WorkspaceLocalRuntimeMode): Artifact {
  return {
    id: `artifact_local_${source}_${slugify(input.title ?? input.prompt)}`,
    type: "brief",
    title: input.title ?? "Local Adapter Result",
    subtitle: `Atlas / local ${source} runner / presentation summary`,
    preview: content.replace(/\s+/g, " ").slice(0, 160),
  };
}

function buildTask(taskId: string, title: string, steps: TaskStep[]): Task {
  const completedSteps = steps.filter((step) => step.status === "complete").length;
  return {
    id: taskId,
    title,
    status: completedSteps === steps.length ? "complete" : "error",
    completedSteps,
    totalSteps: steps.length,
    steps,
  };
}

function buildCommandPrompt(input: WorkspaceLocalRuntimeInput, runtimeContext: WorkspaceRuntimeContextPacket): string {
  return [
    runtimeContext.systemPrompt,
    "",
    `Task: ${input.prompt}`,
  ].join("\n");
}

function splitStreamingText(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const part of text.split(/(\s+)/)) {
    current += part;
    if (current.length >= STREAM_CHUNK_SIZE || part.includes("\n")) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function normalizePresentationText(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return "Local adapter completed without presentation output.";
  return cleaned.length > 6_000 ? `${cleaned.slice(0, 6_000)}\n\n[Output truncated for the demo thread.]` : cleaned;
}

function limitText(text: string): string {
  return text.length > 12_000 ? text.slice(0, 12_000) : text;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "result";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

async function findExecutable(command: "codex" | "claude", env: NodeJS.ProcessEnv): Promise<string | null> {
  const envKey = command === "codex" ? "ATLAS_CODEX_EXECUTABLE" : "ATLAS_CLAUDE_EXECUTABLE";
  const candidates = [
    env[envKey],
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command)),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!isApprovedLocalCommand(command)) continue;
    if (!isAbsolute(candidate)) continue;
    if (basename(candidate) !== command) continue;
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
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

function buildSafeCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: env.HOME,
    PATH: env.PATH,
    SHELL: env.SHELL,
    TERM: env.TERM,
    NODE_ENV: env.NODE_ENV,
    CODEX_HOME: env.CODEX_HOME,
    ATLAS_WORKSPACE_DEMO_LOCAL_ADAPTER: "1",
  };
}
