import { NextResponse } from "next/server";

import { readWorkspaceDraftArtifactPreview } from "@/lib/workspace-draft-artifacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const artifact = await readWorkspaceDraftArtifactPreview(id);
    if (!artifact) {
      return NextResponse.json(
        { ok: false, error: "Artifact not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, artifact });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact preview failed.";
    const status = /unsafe|escaped/i.test(message) ? 400 : 500;
    return NextResponse.json(
      { ok: false, error: status === 400 ? "Invalid artifact id." : "Artifact preview failed." },
      { status },
    );
  }
}
