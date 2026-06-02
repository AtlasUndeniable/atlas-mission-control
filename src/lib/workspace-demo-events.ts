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
export type ArtifactType = "document" | "spreadsheet" | "audit" | "brief" | "playbook";
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
const RUN_ID = "run_competitive_intel_demo";
const TASK_ID = "task_competitive_intel_demo";
const ASSISTANT_MESSAGE_ID = "msg_assistant_competitive_intel";
const USER_MESSAGE_ID = "msg_user_competitive_intel";

const userPrompt =
  "Pull together a competitive intel report on the AI automation agencies targeting home services. I want positioning, pricing, who they are winning against, and where the gap is for us.";

const assistantReply = `Done. I pulled the field on seven agencies in the AI automation space targeting home services. Three things stand out before the doc:\n\n**The price floor is collapsing.** Scorpion and Podium are still anchored at $5K to $25K a month retainers. Hatch and Broadly are running $1.5K to $3K a month wrappers on top of Claude and GPT. They are pulling air out of the mid-market.\n\n**None of them sell the system, they sell the chat box.** Every competitor leads with AI agent for your business. None leads with the operator brain: the automations, the briefings, and the team workflow layer. That is your door.\n\n**Nobody is fluent in coaching-business language.** Their case studies are HVAC, plumbing, and roofing. The closest is NoGood, and even they treat coaching as just another vertical. You own this room.\n\nThe full breakdown is in the doc. Want me to draft the positioning page for the website using the gap I called out, or stage a note for the team to chew on first?`;

const taskSteps: TaskStep[] = [
  { id: "step_market_scan", title: "Scan competitor positioning", status: "complete", summary: "Mapped seven AI automation agencies in the home-services lane." },
  { id: "step_pricing", title: "Compare pricing models", status: "complete", summary: "Grouped retainers, setup fees, and low-cost wrappers." },
  { id: "step_gap", title: "Find the positioning gap", status: "complete", summary: "Identified the system-vs-chat-box opening." },
  { id: "step_doc", title: "Package the report", status: "complete", summary: "Created the inline competitive-intel artifact." },
  { id: "step_next", title: "Recommend next moves", status: "complete", summary: "Prepared the website-positioning follow-up path." },
];

const finalTask: Task = {
  id: TASK_ID,
  title: "Compile competitive intelligence report",
  status: "complete",
  completedSteps: 5,
  totalSteps: 5,
  steps: taskSteps,
};

const artifact: Artifact = {
  id: "artifact_home_services_ai_report",
  type: "document",
  title: "Competitive Intelligence Report - Home Services AI",
  subtitle: "Atlas / 2 min ago / 14 pages / markdown + pdf",
  preview: "A field report on positioning, price bands, and the operator-brain gap for Undeniable.",
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
  "Brief me on this week's calls",
  "Generate a Monday board from a transcript",
  "Pull a content plan for next week",
  "Write a playbook on retention",
];

export const demoUserPrompt = userPrompt;

export const demoRhysReadyStarterPrompt = demoStarterPrompts[0];
export const demoRhysReadyTaskTitle = "Ricky coach hire pay model handover";
