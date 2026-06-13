/**
 * Sanitized read-only list of allowlisted cohort-audit deliverables.
 *
 *   GET /api/workspace/audits
 *     -> { readOnly, generatedAt, audits: [{ id, title, date, sizeBytes }] }
 *
 * One row per allowlisted subject, latest version only (dedup happens in the
 * allowlist helper). Returns ONLY { id, title, date, sizeBytes }: the absolute
 * `path`, `relativePath`, `previewPath`, and `subject` are stripped here so the
 * browser NEVER receives a "/Users/" or "exports/" string. `id` is the opaque
 * projection id used by the by-id file route.
 *
 * READ-ONLY: projection-backed allowlist only. No delivery/send/queue import.
 */
import { NextResponse } from "next/server";

import { getAllowedAuditArtifacts } from "../_lib/audit-allowlist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const allowed = await getAllowedAuditArtifacts();

  const audits = allowed.map((artifact) => ({
    id: artifact.id,
    // Drop a trailing cosmetic version token (e.g. "... Audit V3") — only the
    // latest version is ever listed, so the suffix is noise. Truthful: it is
    // still that latest file.
    title: artifact.title.replace(/\s+V\d+$/i, ""),
    date: artifact.date,
    sizeBytes: artifact.sizeBytes,
    // NOTE: path / relativePath / previewPath / subject intentionally omitted.
  }));

  return NextResponse.json({
    readOnly: true,
    generatedAt: new Date().toISOString(),
    audits,
  });
}
