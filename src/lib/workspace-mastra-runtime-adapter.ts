import { randomUUID } from "node:crypto";

import type { AgentEvent, Task, TaskStep } from "./workspace-demo-events.ts";
import type {
  WorkspaceLocalRuntimeAdapter,
  WorkspaceLocalRuntimeContext,
  WorkspaceLocalRuntimeInput,
} from "./workspace-local-runtime-adapter.ts";
import { validateLocalRuntimeInput } from "./workspace-local-runtime-adapter.ts";
import { buildWorkspaceRuntimeContext } from "./workspace-runtime-context.ts";
import { removeLeadingAssistantProcessPromise } from "./workspace-agent-cognition.ts";
import {
  createWorkspaceAgentToolEvents,
  prepareWorkspaceAgentToolExecutions,
  runtimeReferencePacketFromToolExecutions,
} from "./workspace-agent-tools.ts";
import { createWorkspaceReferenceInspectorPacket, type WorkspaceReferencePacket } from "./workspace-reference-resolver.ts";
import {
  maybeWriteWorkspaceDraftArtifact,
  summarizeWorkspaceDraftArtifactForChat,
  type WorkspaceDraftArtifactResult,
} from "./workspace-draft-artifacts.ts";
import {
  describeQaChecks,
  describeSourceCategories,
  isWorkspaceAnalyticalMemoryQuestion,
  runWorkspaceAnalyticalQa,
} from "./workspace-agentic-qa.ts";
import type { WorkspaceRunPhase, WorkspaceRunPhaseName, WorkspaceRunPhaseStatus } from "./workspace-demo-events.ts";

type DynamicImport = (specifier: string) => Promise<unknown>;

type AiSdkStreamText = (options: {
  model: unknown;
  prompt: string;
  system?: string;
  onError?: (event: { error: unknown }) => void | Promise<void>;
}) => Promise<{
  textStream?: AsyncIterable<string>;
  text?: Promise<string> | string;
}>;

type AnthropicProviderFactory = (apiKeyOptions?: { apiKey?: string }) => (modelId: string) => unknown;

type MastraDependencyCheck =
  | {
      ok: true;
      streamText: AiSdkStreamText;
      model: unknown;
      modelId: string;
    }
  | {
      ok: false;
      reason: string;
    };

interface AdapterEventContext {
  workspaceId: string;
  taskId: string;
  runId: string;
  now: () => Date;
  nextId: (prefix: string) => string;
}

const dynamicImport: DynamicImport = (specifier) => new Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-20250514";
const MASSTRA_STREAM_TIMEOUT_MS = 90_000;
const STREAM_CHUNK_SIZE = 28;

export class MastraAiSdkRuntimeAdapter implements WorkspaceLocalRuntimeAdapter {
  async *runTask(input: WorkspaceLocalRuntimeInput, ctx: WorkspaceLocalRuntimeContext): AsyncIterable<AgentEvent> {
    const checkedInput = validateLocalRuntimeInput(input);
    const eventCtx = createEventContext(ctx, "run_mastra");
    const toolExecutions = await prepareWorkspaceAgentToolExecutions(checkedInput, {
      now: eventCtx.now,
      referenceResolver: (toolInput) => {
        if (ctx.referenceResolver) {
          return ctx.referenceResolver({ prompt: toolInput.prompt, title: checkedInput.title });
        }
        return resolveRuntimeReferences({ prompt: toolInput.prompt, title: checkedInput.title });
      },
    });
    const referencePacket = runtimeReferencePacketFromToolExecutions(toolExecutions)
      ?? await (ctx.referenceResolver ?? resolveRuntimeReferences)(checkedInput);
    const runtimeContext = buildWorkspaceRuntimeContext(checkedInput, {
      provider: "mastra",
      referencePacket,
      agentTools: toolExecutions,
    });
    const messageId = `${eventCtx.runId}_assistant`;
    const steps: TaskStep[] = [
      { id: "step_prepare_mastra_runtime", title: "Prepare Mastra runtime", status: "running" },
      { id: "step_stream_ai_sdk_output", title: "Stream AI SDK output", status: "pending" },
      { id: "step_complete_agent_event_run", title: "Complete AgentEvent run", status: "pending" },
    ];

    yield messageComplete(eventCtx, `${eventCtx.runId}_user`, "user", checkedInput.prompt);
    const shouldRunQaLoop = isWorkspaceAnalyticalMemoryQuestion(checkedInput.prompt);
    if (shouldRunQaLoop) {
      yield runPhaseEvent(eventCtx, {
        name: "observe",
        title: "Observe request",
        status: "complete",
        summary: "Classified as an analytical Workspace question; artifact creation remains gated by explicit deliverable intent.",
        checked: ["Prompt intent", "Artifact intent boundary", "Read-only retrieval eligibility"],
        sourceCategories: [],
        qa: null,
        finalAnswer: null,
        nextAction: "Retrieve safe local evidence before drafting.",
      });
    }
    yield taskStep(eventCtx, steps[0]);

    const env = ctx.env ?? process.env;
    const dependencyCheck = await resolveMastraDependencies(env);

    for (const execution of toolExecutions) {
      const [callEvent, resultEvent] = createWorkspaceAgentToolEvents(eventCtx, execution);
      yield callEvent;
      yield resultEvent;
    }
    yield referenceInspectorEvent(eventCtx, referencePacket);
    if (shouldRunQaLoop) {
      yield runPhaseEvent(eventCtx, {
        name: "retrieve",
        title: "Retrieve evidence",
        status: "complete",
        summary: referencePacket.references.length
          ? `Resolved ${referencePacket.references.length} Workspace reference label${referencePacket.references.length === 1 ? "" : "s"}.`
          : "No usable Workspace source labels were resolved; final answer must state thin coverage.",
        checked: describeQaChecks(runtimeContext).filter((item) => !/^Ran critic checks/i.test(item)),
        sourceCategories: describeSourceCategories(runtimeContext),
        qa: null,
        finalAnswer: null,
        nextAction: "Draft with source labels and visible coverage limits.",
      });
    }

    yield {
      ...baseEvent(eventCtx),
      id: eventCtx.nextId("evt_internal"),
      kind: "tool.call",
      visibility: "internal",
      toolName: "runtime.mastra-ai-sdk",
      label: "Select Mastra/Vercel AI SDK runtime",
      inputSummary: dependencyCheck.ok
        ? `provider=anthropic; model=${dependencyCheck.modelId}; timeout_ms=${MASSTRA_STREAM_TIMEOUT_MS}; ${runtimeContext.internalSummary}`
        : `${dependencyCheck.reason}; ${runtimeContext.internalSummary}`,
    };

    if (!dependencyCheck.ok) {
      const presentationText = [
        "I could not safely start the Mastra AI runtime.",
        "",
        "The workspace kept provider details internal and did not call any external systems.",
        "",
        "Configure the AI SDK dependencies and model environment when you want this runtime to go live.",
      ].join("\n");

      yield {
        ...baseEvent(eventCtx),
        id: eventCtx.nextId("evt_internal"),
        kind: "tool.result",
        visibility: "internal",
        toolName: "runtime.mastra-ai-sdk",
        label: "Mastra runtime unavailable",
        resultSummary: `${dependencyCheck.reason}; ${runtimeContext.internalSummary}`,
      };
      yield {
        ...baseEvent(eventCtx),
        id: eventCtx.nextId("evt_internal"),
        kind: "error",
        visibility: "internal",
        message: dependencyCheck.reason,
        recoverable: true,
      };

      steps[0] = { ...steps[0], status: "error", summary: "Mastra runtime failed closed before provider execution." };
      steps[1] = { ...steps[1], status: "complete", summary: "Streamed a clean presentation failure." };
      steps[2] = { ...steps[2], status: "complete", summary: "Completed the AgentEvent run without external sends." };
      yield taskStep(eventCtx, steps[0]);
      yield taskStep(eventCtx, steps[1]);
      yield* streamAssistantText(eventCtx, messageId, presentationText);
      yield messageComplete(eventCtx, messageId, "assistant", presentationText);
      yield taskStep(eventCtx, steps[2]);
      yield taskComplete(eventCtx, checkedInput.title ?? "Run Mastra AI SDK workspace task", steps);
      return;
    }

    steps[0] = {
      ...steps[0],
      status: "complete",
      summary: "Mastra/Vercel AI SDK runtime resolved with Claude provider.",
    };
    steps[1] = { ...steps[1], status: "running" };
    yield taskStep(eventCtx, steps[0]);
    yield taskStep(eventCtx, steps[1]);

    let content = "";
    let streamError: unknown = null;
    try {
      const response = await withTimeout(
        dependencyCheck.streamText({
          model: dependencyCheck.model,
          system: runtimeContext.systemPrompt,
          prompt: checkedInput.prompt,
          onError: ({ error }) => {
            streamError = error;
          },
        }),
        MASSTRA_STREAM_TIMEOUT_MS,
      );

      if (response.textStream) {
        for await (const delta of response.textStream) {
          content += delta;
        }
      } else if (response.text) {
        content = typeof response.text === "string" ? response.text : await response.text;
      }

      content = sanitizeMastraPresentationText(normalizePresentationText(content));
      if (!content) {
        throw new Error(streamError ? readErrorMessage(streamError) : "AI SDK returned no presentation text.");
      }
      if (shouldRunQaLoop) {
        yield runPhaseEvent(eventCtx, {
          name: "answer_draft",
          title: "Draft answer",
          status: "complete",
          summary: "Drafted an answer and held it for critic review before showing it in chat.",
          checked: ["Draft answer shape", "Source label placement", "No artifact emitted before QA"],
          sourceCategories: describeSourceCategories(runtimeContext),
          qa: null,
          finalAnswer: null,
          nextAction: "Run critic checks before final response.",
        });
        const qaResult = runWorkspaceAnalyticalQa({
          prompt: checkedInput.prompt,
          draftText: content,
          runtimeContext,
          artifactPlanned: false,
        });
        content = qaResult.finalText;
        const issueMessages = qaResult.initialIssues.map((issue) => `${issue.code}: ${issue.message}`);
        yield runPhaseEvent(eventCtx, {
          name: "critic_check",
          title: "Critic check",
          status: qaResult.passed ? "complete" : "warning",
          summary: qaResult.passed
            ? qaResult.revised
              ? "Critic found issues and revised the answer once."
              : "Critic passed with no issues."
            : "Critic still found coverage risk after one revision.",
          checked: qaResult.checked,
          sourceCategories: qaResult.sourceCategories,
          qa: {
            passed: qaResult.passed,
            issues: issueMessages.length ? issueMessages : ["No critic issues found."],
            revised: qaResult.revised,
          },
          finalAnswer: null,
          nextAction: qaResult.nextAction,
        });
        yield runPhaseEvent(eventCtx, {
          name: "final",
          title: "Final answer",
          status: qaResult.passed ? "complete" : "warning",
          summary: qaResult.revised
            ? "Critic revised the analytical answer before final response."
            : "Critic passed the analytical answer before final response.",
          checked: qaResult.checked,
          sourceCategories: qaResult.sourceCategories,
          qa: {
            passed: qaResult.passed,
            issues: qaResult.remainingIssues.map((issue) => `${issue.code}: ${issue.message}`),
            revised: qaResult.revised,
          },
          finalAnswer: content,
          nextAction: qaResult.nextAction,
        });
      }
      const draftArtifact = await maybeWriteWorkspaceDraftArtifact({
        prompt: checkedInput.prompt,
        content,
        taskTitle: checkedInput.title ?? "Run Mastra AI SDK workspace task",
        runtimeProvider: "mastra",
        runId: eventCtx.runId,
        taskId: eventCtx.taskId,
        now: eventCtx.now,
        root: ctx.draftArtifactRoot,
      });
      const chatContent = draftArtifact ? summarizeWorkspaceDraftArtifactForChat(draftArtifact) : content;
      yield* streamAssistantText(eventCtx, messageId, chatContent);

      yield {
        ...baseEvent(eventCtx),
        id: eventCtx.nextId("evt_internal"),
        kind: "tool.result",
        visibility: "internal",
        toolName: "runtime.mastra-ai-sdk",
        label: "Mastra runtime streamed output",
        resultSummary: `provider=anthropic; model=${dependencyCheck.modelId}; output_chars=${content.length}; ${runtimeContext.internalSummary}`,
      };

      steps[1] = { ...steps[1], status: "complete", summary: "Streamed assistant output through AgentEvent deltas." };
      steps[2] = { ...steps[2], status: "complete", summary: "Completed the AgentEvent run." };
      yield taskStep(eventCtx, steps[1]);
      yield messageComplete(eventCtx, messageId, "assistant", chatContent);
      if (draftArtifact) {
        yield draftArtifactInspectorEvent(eventCtx, draftArtifact);
        yield {
          ...baseEvent(eventCtx),
          id: eventCtx.nextId("evt_artifact"),
          kind: "artifact.created",
          visibility: "presentation",
          artifact: draftArtifact.artifact,
        };
      }
      yield taskStep(eventCtx, steps[2]);
      yield taskComplete(eventCtx, checkedInput.title ?? "Run Mastra AI SDK workspace task", steps);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Mastra runtime failed.";
      const presentationText = [
        "I could not safely complete the Mastra AI runtime request.",
        "",
        "The provider error details were kept internal for the Inspector.",
      ].join("\n");

      yield {
        ...baseEvent(eventCtx),
        id: eventCtx.nextId("evt_internal"),
        kind: "tool.result",
        visibility: "internal",
        toolName: "runtime.mastra-ai-sdk",
        label: "Mastra runtime failed closed",
        resultSummary: `provider=anthropic; model=${dependencyCheck.modelId}; error=${message}; ${runtimeContext.internalSummary}`,
      };
      yield {
        ...baseEvent(eventCtx),
        id: eventCtx.nextId("evt_internal"),
        kind: "error",
        visibility: "internal",
        message,
        recoverable: true,
      };

      steps[1] = { ...steps[1], status: "error", summary: "Mastra runtime failed closed." };
      steps[2] = { ...steps[2], status: "complete", summary: "Rendered a clean presentation failure." };
      yield taskStep(eventCtx, steps[1]);
      yield* streamAssistantText(eventCtx, messageId, presentationText);
      yield messageComplete(eventCtx, messageId, "assistant", presentationText);
      yield taskStep(eventCtx, steps[2]);
      yield taskComplete(eventCtx, checkedInput.title ?? "Run Mastra AI SDK workspace task", steps);
    }
  }
}

async function resolveRuntimeReferences(input: WorkspaceLocalRuntimeInput) {
  const { resolveWorkspaceReferences } = await import("./workspace-reference-resolver.ts");
  return resolveWorkspaceReferences({
    prompt: input.prompt,
    title: input.title,
    workspaceId: "workspace_undeniable_demo",
    project: "Undeniable",
    room: "workspace-demo",
  });
}

async function resolveMastraDependencies(env: NodeJS.ProcessEnv): Promise<MastraDependencyCheck> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: "ATLAS_WORKSPACE_DEMO_RUNTIME=mastra requires ANTHROPIC_API_KEY for the default Claude provider.",
    };
  }

  try {
    const [aiModule, anthropicModule, mastraModule] = await Promise.all([
      dynamicImport("ai"),
      dynamicImport("@ai-sdk/anthropic"),
      dynamicImport("@mastra/core"),
    ]);
    const streamText = readFunctionExport<AiSdkStreamText>(aiModule, "streamText");
    const createAnthropic = readFunctionExport<AnthropicProviderFactory>(anthropicModule, "createAnthropic");
    assertModuleLoaded(mastraModule, "@mastra/core");
    const modelId = env.ATLAS_WORKSPACE_DEMO_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
    return {
      ok: true,
      streamText,
      model: createAnthropic({ apiKey })(modelId),
      modelId,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Mastra/Vercel AI SDK dependencies are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readFunctionExport<T extends (...args: never[]) => unknown>(moduleValue: unknown, exportName: string): T {
  if (!moduleValue || typeof moduleValue !== "object") {
    throw new Error(`${exportName} module did not load.`);
  }
  const value = (moduleValue as Record<string, unknown>)[exportName];
  if (typeof value !== "function") throw new Error(`${exportName} export is missing.`);
  return value as T;
}

function assertModuleLoaded(moduleValue: unknown, packageName: string): void {
  if (!moduleValue || typeof moduleValue !== "object") {
    throw new Error(`${packageName} did not load.`);
  }
}

export function sanitizeMastraPresentationText(text: string): string {
  const cleaned = text
    .replace(/<AgentEvent\b(?=[^>]*visibility=["']internal["'])[^>]*>[\s\S]*?<\/AgentEvent>/gi, "")
    .replace(/<task\.step\b[^>]*>[\s\S]*?<\/task\.step>/gi, "")
    .replace(/<\/?(?:AgentEvent|message\.delta|message\.complete|task\.step|task\.complete)\b[^>]*>/gi, "")
    .replace(/```json\s*\{[\s\S]*?"visibility"\s*:\s*"internal"[\s\S]*?```\s*/gi, "")
    .replace(/(?:\/Users\/[^\s"'`),;]+|\/private\/[^\s"'`),;]+|\/tmp\/[^\s"'`),;]+|\.openclaw\/[^\s"'`),;]+)/g, "[Workspace internal path]")
    .replace(/^(#{1,4}\s*)?Coverage\s*\/\s*Confidence\s*$/gim, "## Confidence / coverage")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return removeLeadingAssistantProcessPromise(cleaned);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
  }
  return "Mastra runtime failed.";
}

function createEventContext(ctx: WorkspaceLocalRuntimeContext, runPrefix: string): AdapterEventContext {
  let index = 0;
  const idFactory = ctx.idFactory ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
  return {
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId,
    runId: ctx.runId ?? `${runPrefix}_${idFactory()}`,
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

function messageDelta(ctx: AdapterEventContext, messageId: string, delta: string): AgentEvent {
  return {
    ...baseEvent(ctx),
    id: ctx.nextId("evt_msg"),
    kind: "message.delta",
    visibility: "presentation",
    messageId,
    role: "assistant",
    delta,
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

function referenceInspectorEvent(ctx: AdapterEventContext, packet: WorkspaceReferencePacket): AgentEvent {
  return {
    ...baseEvent(ctx),
    id: ctx.nextId("evt_internal"),
    kind: "tool.result",
    visibility: "internal",
    toolName: "workspace.references",
    label: "Workspace references resolved",
    resultSummary: JSON.stringify(createWorkspaceReferenceInspectorPacket(packet)),
  };
}

function draftArtifactInspectorEvent(ctx: AdapterEventContext, draftArtifact: WorkspaceDraftArtifactResult): AgentEvent {
  return {
    ...baseEvent(ctx),
    id: ctx.nextId("evt_internal"),
    kind: "tool.result",
    visibility: "internal",
    toolName: "workspace.artifacts",
    label: "Local draft artifact saved",
    resultSummary: JSON.stringify(draftArtifact.metadata),
  };
}

function runPhaseEvent(
  ctx: AdapterEventContext,
  phase: Omit<WorkspaceRunPhase, "id"> & {
    name: WorkspaceRunPhaseName;
    status: WorkspaceRunPhaseStatus;
  },
): AgentEvent {
  return {
    ...baseEvent(ctx),
    id: ctx.nextId("evt_phase"),
    kind: "run.phase",
    visibility: "presentation",
    phase: {
      id: `${ctx.runId}:${phase.name}`,
      ...phase,
      checked: phase.checked.map(redactPresentationPath),
      sourceCategories: phase.sourceCategories.map((item) => item.replace(/[^a-zA-Z0-9 _.-]+/g, "").slice(0, 80)),
      finalAnswer: phase.finalAnswer ? redactPresentationPath(phase.finalAnswer) : null,
    },
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

function redactPresentationPath(text: string): string {
  return text.replace(/(?:\/Users\/[^\s"'`),;]+|\/private\/[^\s"'`),;]+|\/tmp\/[^\s"'`),;]+|\.openclaw\/[^\s"'`),;]+)/g, "[Workspace internal path]");
}

function taskComplete(ctx: AdapterEventContext, title: string, steps: TaskStep[]): AgentEvent {
  return {
    ...baseEvent(ctx),
    id: ctx.nextId("evt_task"),
    kind: "task.complete",
    visibility: "presentation",
    task: buildTask(ctx.taskId, title, steps),
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

async function* streamAssistantText(ctx: AdapterEventContext, messageId: string, text: string): AsyncIterable<AgentEvent> {
  for (const delta of splitStreamingText(text)) {
    yield messageDelta(ctx, messageId, delta);
    await pause(18);
  }
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
  if (!cleaned) return "";
  return cleaned.length > 6_000 ? `${cleaned.slice(0, 6_000)}\n\n[Output truncated for the demo thread.]` : cleaned;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Mastra runtime timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
