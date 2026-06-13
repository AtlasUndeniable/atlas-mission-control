/**
 * Read-only by-id PDF byte route for allowlisted cohort-audit deliverables.
 *
 *   GET /api/workspace/artifacts/<id>/file            -> inline PDF
 *   GET /api/workspace/artifacts/<id>/file?download=1 -> attachment PDF
 *
 * The id is resolved by LOOKING IT UP in the allowlisted-audit set and
 * streaming THAT artifact's projection `path`. A filesystem path is NEVER
 * constructed from the id, so the id cannot traverse or escape the projection.
 * Any id not in the projection, or not in the allowlisted audit set, is 404.
 *
 * READ-ONLY: imports the projection-backed allowlist and nothing else. No
 * delivery / slack-dm / sendRhysDmArtifact / queue-writer / send-path import.
 * No write, no enqueue, no mutation. Errors return a generic { error, id } —
 * never a filesystem path, absolute path, or stack trace.
 */
import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { getAllowedAuditArtifacts } from "../../../_lib/audit-allowlist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const allowed = await getAllowedAuditArtifacts();
    const match = allowed.find((artifact) => artifact.id === id);
    if (!match) {
      // Unknown id, or an id outside the allowlisted audit set — same generic 404.
      return NextResponse.json({ error: "Artifact not found.", id }, { status: 404 });
    }

    // `match.path` is the projection's absolute path — NEVER derived from the id.
    const bytes = await readFile(match.path);

    const url = new URL(request.url);
    const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
    // Filename is derived from the allowlisted subject — no path component.
    const filename = `${match.subject}-executive-audit.pdf`;

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `${disposition}; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch {
    // Read failure (e.g. file moved). Generic body — no path, no stack.
    return NextResponse.json({ error: "Artifact unavailable.", id }, { status: 500 });
  }
}
