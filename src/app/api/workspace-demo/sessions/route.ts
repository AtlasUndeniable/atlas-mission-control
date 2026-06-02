import { NextResponse } from "next/server";

import {
  DEFAULT_WORKSPACE_PROJECT,
  DEFAULT_WORKSPACE_ROOM,
  getLatestWorkspaceLocalSession,
  hydrateWorkspaceLocalSession,
  updateWorkspaceLocalSessionSelection,
} from "@/lib/workspace-local-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sessionScopeFromUrl(url: URL) {
  return {
    project: url.searchParams.get("project") || DEFAULT_WORKSPACE_PROJECT,
    room: url.searchParams.get("room") || DEFAULT_WORKSPACE_ROOM,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const scope = sessionScopeFromUrl(url);
  const sessionId = url.searchParams.get("sessionId");
  const snapshot = sessionId
    ? await hydrateWorkspaceLocalSession({ ...scope, sessionId })
    : await getLatestWorkspaceLocalSession(scope);

  return NextResponse.json({
    ok: true,
    localOnly: true,
    session: snapshot,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, localOnly: true, error: "Invalid JSON body." }, { status: 400 });
  }

  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const action = typeof record.action === "string" ? record.action : "";
  if (action !== "selectArtifact") {
    return NextResponse.json({ ok: false, localOnly: true, error: "Unsupported session action." }, { status: 400 });
  }

  const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
  const project = typeof record.project === "string" ? record.project : DEFAULT_WORKSPACE_PROJECT;
  const room = typeof record.room === "string" ? record.room : DEFAULT_WORKSPACE_ROOM;
  const selectedArtifactId = typeof record.selectedArtifactId === "string" ? record.selectedArtifactId : null;

  try {
    const metadata = await updateWorkspaceLocalSessionSelection({
      sessionId,
      project,
      room,
      selectedArtifactId,
    });
    return NextResponse.json({ ok: true, localOnly: true, metadata });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        localOnly: true,
        error: error instanceof Error ? error.message : "Workspace session update failed.",
      },
      { status: 400 },
    );
  }
}
