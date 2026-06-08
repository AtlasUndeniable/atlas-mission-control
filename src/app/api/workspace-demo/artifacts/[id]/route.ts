import { NextResponse } from "next/server";

import {
  readWorkspaceDraftArtifactDocx,
  readWorkspaceDraftArtifactPdf,
  readWorkspaceDraftArtifactPreview,
} from "@/lib/workspace-draft-artifacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("format") === "pdf") {
      const pdf = await readWorkspaceDraftArtifactPdf(id);
      if (!pdf) {
        return NextResponse.json(
          { ok: false, error: "PDF artifact not found." },
          { status: 404 },
        );
      }
      const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
      const body = Uint8Array.from(pdf.bytes).buffer;
      return new Response(body, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `${disposition}; filename="${pdf.filename}"`,
          "cache-control": "no-store",
        },
      });
    }
    if (url.searchParams.get("format") === "docx") {
      const docx = await readWorkspaceDraftArtifactDocx(id);
      if (!docx) {
        return NextResponse.json(
          { ok: false, error: "DOCX artifact not found." },
          { status: 404 },
        );
      }
      const body = Uint8Array.from(docx.bytes).buffer;
      return new Response(body, {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": `attachment; filename="${docx.filename}"`,
          "cache-control": "no-store",
        },
      });
    }

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
