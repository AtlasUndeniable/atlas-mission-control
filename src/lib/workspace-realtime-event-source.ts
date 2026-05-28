import type { AgentEvent, WorkspaceEventSource } from "./workspace-demo-events";

type RealtimeSourceStatus = "idle" | "running" | "stopped" | "unavailable";

export interface RealtimeWorkspaceEventSourceConfig {
  workspaceId: string;
  taskId: string;
  runId: string;
}

export class RealtimeWorkspaceEventSource implements WorkspaceEventSource {
  private listeners = new Set<(event: AgentEvent) => void>();
  private status: RealtimeSourceStatus = "idle";
  private unavailableReason = "Supabase Realtime event source is not configured in this local P2 pass.";

  constructor(private readonly config: RealtimeWorkspaceEventSourceConfig) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.status === "running") return;
    this.status = "unavailable";
    this.emitUnavailable();
  }

  stop(): void {
    this.status = "stopped";
  }

  reset(): void {
    this.stop();
  }

  getState(): { status: RealtimeSourceStatus; reason?: string } {
    return this.status === "unavailable"
      ? { status: this.status, reason: this.unavailableReason }
      : { status: this.status };
  }

  private emitUnavailable(): void {
    const event: AgentEvent = {
      id: "evt_realtime_unavailable",
      workspaceId: this.config.workspaceId,
      taskId: this.config.taskId,
      runId: this.config.runId,
      kind: "error",
      visibility: "internal",
      createdAt: new Date().toISOString(),
      message: this.unavailableReason,
      recoverable: true,
    };

    this.listeners.forEach((listener) => listener(event));
  }
}

export function createRealtimeWorkspaceEventSource(
  config: RealtimeWorkspaceEventSourceConfig,
): WorkspaceEventSource {
  return new RealtimeWorkspaceEventSource(config);
}
