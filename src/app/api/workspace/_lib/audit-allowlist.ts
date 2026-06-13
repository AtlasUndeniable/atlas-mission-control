/**
 * Allowlisted cohort-audit deliverables surfaced in /workspace.
 *
 * Single source of truth for BOTH the sanitized list route
 * (/api/workspace/audits) and the by-id byte route
 * (/api/workspace/artifacts/[id]/file), so the file route can only ever serve
 * exactly what the list exposes — no divergence, no bypass.
 *
 * Rules enforced here:
 *   - only artifacts the real projection classifies as inferredWorkflow "audit"
 *   - only PDFs
 *   - only the explicit ALLOWED_AUDIT_SUBJECTS below (nothing else, ever)
 *   - exactly ONE row per subject: the newest by modifiedAt (latest version)
 *
 * READ-ONLY: imports the projection and nothing else. No delivery/send/queue
 * import, no write, no mutation.
 */
import { getWorkspaceArtifacts, type WorkspaceArtifact } from "./artifact-projection";

// Confirmed cohort-deliverable subjects. These are audits Rhys's system
// produced FOR his prospects; he reviews them. Anything not in this list is
// never exposed by either route.
export const ALLOWED_AUDIT_SUBJECTS = [
  "will-jensen-coaching",
  "lean-strong-collective",
] as const;

export interface AllowedAuditArtifact {
  id: string;
  title: string;
  date: string; // ISO, from the projection's modifiedAt
  sizeBytes: number;
  // Server-only fields — the list route MUST strip these before responding so
  // the browser never receives an absolute path or an "exports/" string.
  path: string;
  subject: string;
}

// Each allowed audit lives at exports/audits/<date>-<subject>-executive-audit[-suffix].pdf
// (suffix = optional version/variant token, e.g. -v3). The match is ANCHORED to
// that exact shape — not a loose substring — so a stray PDF in another folder, or
// one whose path merely CONTAINS a subject string, can never be surfaced, and a
// path containing two subject strings cannot shadow the wrong one. format==="PDF"
// and inferredWorkflow==="audit" are additional upstream guards in the caller.
// ALLOWED_AUDIT_SUBJECTS are trusted constants ([a-z-] only), so they are
// regex-safe to interpolate.
function subjectOf(relativePath: string): string | null {
  const lower = relativePath.toLowerCase();
  for (const subject of ALLOWED_AUDIT_SUBJECTS) {
    const pattern = new RegExp(
      `^audits/\\d{4}-\\d{2}-\\d{2}-${subject}-executive-audit(?:-[a-z0-9]+)*\\.pdf$`,
    );
    if (pattern.test(lower)) return subject;
  }
  return null;
}

/**
 * The deduped, allowlisted, latest-version-per-subject set of audit PDFs.
 * Returns FULL objects (including the absolute `path`) for server-side use;
 * the list route strips `path`/`subject` before serializing to the client.
 */
export async function getAllowedAuditArtifacts(): Promise<AllowedAuditArtifact[]> {
  const artifacts: WorkspaceArtifact[] = await getWorkspaceArtifacts();
  const newestBySubject = new Map<string, AllowedAuditArtifact>();

  for (const a of artifacts) {
    if (a.inferredWorkflow !== "audit") continue; // identity is workflow, not kind
    if (a.format !== "PDF") continue; // no .md / .docx
    const subject = subjectOf(a.relativePath);
    if (!subject) continue; // not allowlisted

    const candidate: AllowedAuditArtifact = {
      id: a.id,
      title: a.title,
      date: a.modifiedAt,
      sizeBytes: a.sizeBytes,
      path: a.path,
      subject,
    };
    const prev = newestBySubject.get(subject);
    if (!prev || Date.parse(candidate.date) > Date.parse(prev.date)) {
      newestBySubject.set(subject, candidate); // keep the latest version only
    }
  }

  return [...newestBySubject.values()].sort(
    (x, y) => Date.parse(y.date) - Date.parse(x.date),
  );
}
