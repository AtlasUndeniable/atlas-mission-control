export type AgentEventVisibility = "internal" | "presentation";

export type AgentEventKind =
  | "message.delta"
  | "message.complete"
  | "tool.call"
  | "tool.result"
  | "artifact.created"
  | "task.step"
  | "task.complete"
  | "error";

export type MessageRole = "user" | "assistant";
export type TaskStepStatus = "pending" | "running" | "complete" | "error";
export type ArtifactType = "document" | "spreadsheet" | "audit" | "brief" | "playbook" | "markdown" | "pdf";
export type WorkspaceTaskStatus = "idle" | "running" | "complete" | "error";

interface BaseAgentEvent {
  id: string;
  runId: string;
  workspaceId: string;
  taskId: string;
  kind: AgentEventKind;
  visibility: AgentEventVisibility;
  createdAt: string;
}

export interface MessageDeltaEvent extends BaseAgentEvent {
  kind: "message.delta";
  visibility: "presentation";
  messageId: string;
  role: "assistant";
  delta: string;
}

export interface MessageCompleteEvent extends BaseAgentEvent {
  kind: "message.complete";
  visibility: "presentation";
  messageId: string;
  role: MessageRole;
  content: string;
}

export interface ToolCallEvent extends BaseAgentEvent {
  kind: "tool.call";
  visibility: "internal";
  toolName: string;
  label: string;
  inputSummary: string;
}

export interface ToolResultEvent extends BaseAgentEvent {
  kind: "tool.result";
  visibility: "internal";
  toolName: string;
  label: string;
  resultSummary: string;
}

export interface ArtifactCreatedEvent extends BaseAgentEvent {
  kind: "artifact.created";
  visibility: "presentation";
  artifact: Artifact;
}

export interface TaskStepEvent extends BaseAgentEvent {
  kind: "task.step";
  visibility: "presentation";
  step: TaskStep;
}

export interface TaskCompleteEvent extends BaseAgentEvent {
  kind: "task.complete";
  visibility: "presentation";
  task: Task;
}

export interface ErrorEvent extends BaseAgentEvent {
  kind: "error";
  visibility: AgentEventVisibility;
  message: string;
  recoverable: boolean;
}

export type AgentEvent =
  | MessageDeltaEvent
  | MessageCompleteEvent
  | ToolCallEvent
  | ToolResultEvent
  | ArtifactCreatedEvent
  | TaskStepEvent
  | TaskCompleteEvent
  | ErrorEvent;

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  complete: boolean;
}

export interface TaskStep {
  id: string;
  title: string;
  status: TaskStepStatus;
  summary?: string;
}

export interface Task {
  id: string;
  title: string;
  status: WorkspaceTaskStatus;
  completedSteps: number;
  totalSteps: number;
  steps: TaskStep[];
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  subtitle: string;
  preview: string;
}

export interface Workspace {
  id: string;
  title: string;
  projectTitle: string;
  activeTaskId?: string;
  messages: Message[];
  tasks: Task[];
  artifacts: Artifact[];
}

export interface WorkspaceEventSource {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  start(): void;
  stop(): void;
  reset(): void;
}

const WORKSPACE_ID = "workspace_undeniable_demo";
const RUN_ID = "run_atlas_workspace_demo";
const TASK_ID = "task_atlas_workspace_demo";
const ASSISTANT_MESSAGE_ID = "msg_assistant_atlas_workspace";
const USER_MESSAGE_ID = "msg_user_atlas_workspace";

const userPrompt =
  "Give Rhys a concise Atlas workspace readiness summary and call out what needs confirmation before live testing.";

const assistantReply = `Done. Atlas is ready to use as the primary Workspace test bench for Rhys, with a few boundaries to keep visible before live work.\n\n**The event seam is stable.** Mock, local Codex, and Mastra all stream through the same AgentEvent contract, so the chat thread sees presentation-safe output while Inspector keeps diagnostics internal.\n\n**Reference grounding is visible.** Workspace references now resolve before runtime output and show coverage in Inspector. Matched references can be used directly; thin references should be treated as provisional and confirmed.\n\n**External mutations stay off.** This pass does not send Slack, OpenClaw, Monday, Typeform, files, or live Supabase writes. It is safe for drafting and QA, not production delivery.\n\nNext best test: run the Ricky coach hire pay model handover prompt, check reference coverage, and confirm any missing pay-band facts before turning the draft into a real artifact.`;

const taskSteps: TaskStep[] = [
  { id: "step_runtime", title: "Check runtime seam", status: "complete", summary: "Confirmed mock, local Codex, and Mastra share the AgentEvent stream." },
  { id: "step_references", title: "Review Workspace references", status: "complete", summary: "Checked reference coverage and safe Inspector handles." },
  { id: "step_visibility", title: "Verify presentation safety", status: "complete", summary: "Kept provider diagnostics, paths, and command details internal." },
  { id: "step_boundaries", title: "Confirm no external sends", status: "complete", summary: "Left Slack, OpenClaw, Monday, Typeform, files, and Supabase writes untouched." },
  { id: "step_next", title: "Prepare Ricky smoke", status: "complete", summary: "Ready to test the Ricky coach hire pay model handover prompt." },
];

const finalTask: Task = {
  id: TASK_ID,
  title: "Atlas workspace readiness session",
  status: "complete",
  completedSteps: 5,
  totalSteps: 5,
  steps: taskSteps,
};

const artifact: Artifact = {
  id: "artifact_atlas_workspace_readiness",
  type: "brief",
  title: "Atlas Workspace Readiness Note",
  subtitle: "Atlas / demo session / presentation-safe brief",
  preview: "A short readiness note for Rhys covering runtime, references, and no-send boundaries.",
};

function now(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function splitTokens(text: string): string[] {
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    current += word;
    if (current.length >= 24 || word.includes("\n")) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function createCompetitiveIntelReplayEvents(): AgentEvent[] {
  let index = 0;
  const event = <T extends Omit<AgentEvent, "id" | "runId" | "workspaceId" | "taskId" | "createdAt">>(payload: T): T & BaseAgentEvent => ({
    ...payload,
    id: `evt_${String(index).padStart(3, "0")}`,
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    createdAt: now(index++ * 100),
  });

  return [
    event({ kind: "message.complete", visibility: "presentation", messageId: USER_MESSAGE_ID, role: "user", content: userPrompt }),
    event({ kind: "tool.call", visibility: "internal", toolName: "librarian.search", label: "Search competitor memory", inputSummary: "Query existing Undeniable market notes and prior reports." }),
    event({ kind: "tool.result", visibility: "internal", toolName: "librarian.search", label: "Memory references found", resultSummary: "Found positioning notes, pricing references, and prior audit language." }),
    event({ kind: "tool.call", visibility: "internal", toolName: "browser.research", label: "Check agency claims", inputSummary: "Review public competitor pages for price and positioning claims." }),
    event({ kind: "tool.result", visibility: "internal", toolName: "browser.research", label: "Research complete", resultSummary: "Collected seven agency profiles and offer patterns." }),
    ...splitTokens(assistantReply).map((delta) => event({ kind: "message.delta", visibility: "presentation", messageId: ASSISTANT_MESSAGE_ID, role: "assistant" as const, delta })),
    event({ kind: "message.complete", visibility: "presentation", messageId: ASSISTANT_MESSAGE_ID, role: "assistant", content: assistantReply }),
    event({ kind: "artifact.created", visibility: "presentation", artifact }),
    ...taskSteps.map((step) => event({ kind: "task.step", visibility: "presentation", step })),
    event({ kind: "task.complete", visibility: "presentation", task: finalTask }),
  ];
}

export class MockWorkspaceEventSource implements WorkspaceEventSource {
  private listeners = new Set<(event: AgentEvent) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private readonly events: AgentEvent[];

  constructor(events: AgentEvent[] = createCompetitiveIntelReplayEvents()) {
    this.events = events;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.events.forEach((event, index) => {
      const delay = index < 5 ? index * 260 : 1100 + (index - 5) * 42;
      const timer = setTimeout(() => {
        if (!this.running) return;
        this.listeners.forEach((listener) => listener(event));
        if (index === this.events.length - 1) this.running = false;
      }, delay);
      this.timers.push(timer);
    });
  }

  stop(): void {
    this.running = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  reset(): void {
    this.stop();
  }
}

export const demoWorkspace: Workspace = {
  id: WORKSPACE_ID,
  title: "Atlas 1.0",
  projectTitle: "Undeniable",
  activeTaskId: TASK_ID,
  messages: [],
  tasks: [],
  artifacts: [],
};

export const demoStarterPrompts = [
  "Update the Ricky coach hire pay model handover with clearer bands and a pyramid structure.",
  "Draft an audit for a new coaching client",
  "Review recent call themes",
  "Draft a Monday board from available notes",
  "Pull a content plan for next week",
  "Summarize training notes",
];

export const demoUserPrompt = userPrompt;

export const demoRhysReadyStarterPrompt = demoStarterPrompts[0];
export const demoRhysReadyTaskTitle = "Ricky coach hire pay model handover";
