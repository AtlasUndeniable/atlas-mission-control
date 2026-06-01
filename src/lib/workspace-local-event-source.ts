import type { AgentEvent, WorkspaceEventSource } from "./workspace-demo-events";

export interface LocalWorkspaceEventSourceInput {
  prompt: string;
  title?: string;
}

export interface LocalWorkspaceEventSourceOptions {
  endpoint: string;
  input: LocalWorkspaceEventSourceInput;
}

export class LocalWorkspaceEventSource implements WorkspaceEventSource {
  private listeners = new Set<(event: AgentEvent) => void>();
  private controller: AbortController | null = null;
  private running = false;

  constructor(private readonly options: LocalWorkspaceEventSourceOptions) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    void this.readEventStream(this.controller);
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
  }

  reset(): void {
    this.stop();
  }

  private async readEventStream(controller: AbortController): Promise<void> {
    try {
      const response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.options.input),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        this.emitClientError(`Local adapter request failed with status ${response.status}.`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          this.emitLine(line);
        }
      }

      if (buffer.trim()) this.emitLine(buffer);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.emitClientError(error instanceof Error ? error.message : "Local adapter stream failed.");
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      this.running = false;
    }
  }

  private emitLine(line: string): void {
    if (!line.trim()) return;
    const event = JSON.parse(line) as AgentEvent;
    this.listeners.forEach((listener) => listener(event));
  }

  private emitClientError(message: string): void {
    const now = new Date().toISOString();
    const event: AgentEvent = {
      id: `evt_local_client_error_${Date.now()}`,
      workspaceId: "workspace_undeniable_demo",
      taskId: "task_hybrid_local_demo",
      runId: "run_local_client_error",
      kind: "error",
      visibility: "internal",
      createdAt: now,
      message,
      recoverable: true,
    };
    this.listeners.forEach((listener) => listener(event));
  }
}
