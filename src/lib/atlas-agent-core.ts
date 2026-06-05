import type { AgentEvent } from "./workspace-demo-events.ts";
import type {
  WorkspaceAgentToolInput,
  WorkspaceAgentToolName,
  WorkspaceAgentToolOutput,
} from "./workspace-agent-tools.ts";

export const ATLAS_AGENT_CORE_V0_LOOP = [
  "observe",
  "plan",
  "decide",
  "act",
  "reflect",
  "compress",
  "emit",
  "persist",
] as const;

export type AtlasAgentCoreLoopPhase = (typeof ATLAS_AGENT_CORE_V0_LOOP)[number];
export type AtlasAgentRunStatus = "queued" | "running" | "paused" | "waiting_for_approval" | "complete" | "failed";
export type AtlasAgentToolSafety = "read_only" | "dry_run" | "approval_required" | "blocked";
export type AtlasAgentBudgetKind = "turns" | "tool_calls" | "wall_time_ms" | "tokens" | "cost_usd";

export interface AtlasAgentRunContext {
  workspaceId: string;
  project: string;
  room: string;
  sessionId: string;
  runId: string;
  parentRunId?: string;
  userId?: string;
  createdAt: string;
}

export interface AtlasAgentBudget {
  kind: AtlasAgentBudgetKind;
  limit: number;
  used: number;
}

export interface AtlasAgentCoreStartInput {
  prompt: string;
  project: string;
  room: string;
  sessionId?: string;
  workspaceId?: string;
  budgets?: AtlasAgentBudget[];
}

export interface AtlasAgentCoreRun {
  context: AtlasAgentRunContext;
  status: AtlasAgentRunStatus;
  loopPhase: AtlasAgentCoreLoopPhase;
  budgets: AtlasAgentBudget[];
}

export interface AtlasAgentPlanStep {
  id: string;
  title: string;
  status: "pending" | "running" | "complete" | "blocked";
  dependsOn?: string[];
  toolHints?: WorkspaceAgentToolName[];
}

export interface AtlasAgentPlan {
  runId: string;
  createdAt: string;
  goal: string;
  steps: AtlasAgentPlanStep[];
  openQuestions: string[];
}

export interface AtlasAgentDecision {
  runId: string;
  phase: "decide";
  selectedStepId: string | null;
  nextAction: "answer" | "dispatch_tool" | "request_approval" | "pause" | "complete";
  rationale: string;
  safety: AtlasAgentToolSafety;
}

export interface AtlasAgentToolDispatchRequest<TInput extends WorkspaceAgentToolInput = WorkspaceAgentToolInput> {
  runId: string;
  toolName: WorkspaceAgentToolName;
  input: TInput;
  safety: AtlasAgentToolSafety;
  approvalId?: string;
  dryRun: boolean;
}

export interface AtlasAgentToolDispatchResult<TOutput extends WorkspaceAgentToolOutput = WorkspaceAgentToolOutput> {
  runId: string;
  toolName: WorkspaceAgentToolName;
  output: TOutput;
  events: AgentEvent[];
}

export interface AtlasAgentCriticResult {
  runId: string;
  verdict: "pass" | "revise" | "block";
  issues: string[];
  requiredFollowUp: string[];
}

export interface AtlasAgentPersistEnvelope {
  run: AtlasAgentCoreRun;
  events: AgentEvent[];
  plan?: AtlasAgentPlan;
  critic?: AtlasAgentCriticResult;
  compressedSummary?: string;
}

export interface AtlasAgentCore {
  startRun(input: AtlasAgentCoreStartInput): Promise<AtlasAgentCoreRun>;
  resumeRun(runId: string): Promise<AtlasAgentCoreRun>;
  appendUserMessage(runId: string, content: string): Promise<AgentEvent>;
  emitEvent(runId: string, event: AgentEvent): Promise<AgentEvent>;
  dispatchTool(request: AtlasAgentToolDispatchRequest): Promise<AtlasAgentToolDispatchResult>;
  runCritic(runId: string): Promise<AtlasAgentCriticResult>;
  persistRun(envelope: AtlasAgentPersistEnvelope): Promise<void>;
}

export function isAtlasAgentCoreLoopPhase(value: unknown): value is AtlasAgentCoreLoopPhase {
  return typeof value === "string" && ATLAS_AGENT_CORE_V0_LOOP.includes(value as AtlasAgentCoreLoopPhase);
}

export function validateAtlasAgentToolDispatchRequest(
  request: AtlasAgentToolDispatchRequest,
): { ok: true; issues: [] } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!request.runId.trim()) issues.push("runId is required.");
  if (!request.toolName.trim()) issues.push("toolName is required.");
  if (!request.input || typeof request.input !== "object") issues.push("input must be an object.");
  if (request.safety === "blocked") issues.push("blocked tools cannot be dispatched.");
  if (request.safety === "approval_required" && !request.approvalId) issues.push("approval_required dispatches require approvalId.");
  if (request.safety !== "read_only" && request.dryRun !== true) {
    issues.push("V0 dispatches must be read_only or dry_run unless a later approval executor is wired.");
  }
  return issues.length ? { ok: false, issues } : { ok: true, issues: [] };
}
