import { NextResponse } from "next/server";

import {
  workspaceDemoRuntimeIds,
  type WorkspaceLocalRuntimeInput,
} from "@/lib/workspace-local-runtime-adapter";
import {
  appendWorkspaceLocalSessionEvent,
  createWorkspaceLocalSessionId,
  DEFAULT_WORKSPACE_PROJECT,
  DEFAULT_WORKSPACE_ROOM,
} from "@/lib/workspace-local-sessions";
import {
  createWorkspaceRuntimeAdapter,
  resolveWorkspaceRuntimeProvider,
} from "@/lib/workspace-runtime-provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WorkspaceLocalRunRequest extends WorkspaceLocalRuntimeInput {
  project: string;
  room: string;
  sessionId: string;
}

function parseInput(body: unknown): WorkspaceLocalRunRequest {
  if (!body || typeof body !== "object") throw new Error("Request body must be a JSON object.");
  const record = body as Record<string, unknown>;
  return {
    prompt: typeof record.prompt === "string" ? record.prompt : "",
    title: typeof record.title === "string" ? record.title : undefined,
    project: typeof record.project === "string" && record.project.trim() ? record.project : DEFAULT_WORKSPACE_PROJECT,
    room: typeof record.room === "string" && record.room.trim() ? record.room : DEFAULT_WORKSPACE_ROOM,
    sessionId: typeof record.sessionId === "string" && record.sessionId.trim() ? record.sessionId : createWorkspaceLocalSessionId(),
  };
}

function errorEvent(message: string) {
  return {
    id: `evt_local_route_error_${Date.now()}`,
    workspaceId: workspaceDemoRuntimeIds.workspaceId,
    taskId: workspaceDemoRuntimeIds.taskId,
    runId: "run_local_route_error",
    kind: "error",
    visibility: "internal",
    createdAt: new Date().toISOString(),
    message,
    recoverable: true,
  };
}

export async function POST(request: Request) {
  let input: WorkspaceLocalRunRequest;
  try {
    input = parseInput(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        localOnly: true,
        error: error instanceof Error ? error.message : "Invalid local adapter request.",
      },
      { status: 400 },
    );
  }

  const provider = resolveWorkspaceRuntimeProvider(process.env);
  const adapter = createWorkspaceRuntimeAdapter(provider);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of adapter.runTask(input, {
          workspaceId: workspaceDemoRuntimeIds.workspaceId,
          taskId: workspaceDemoRuntimeIds.taskId,
        })) {
          await appendWorkspaceLocalSessionEvent({
            sessionId: input.sessionId,
            project: input.project,
            room: input.room,
            title: input.title ?? "Workspace session",
            event,
          });
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify(errorEvent(error instanceof Error ? error.message : "Local adapter failed."))}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-atlas-workspace-runtime": provider,
    },
  });
}
