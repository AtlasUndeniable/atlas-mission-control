import { NextResponse } from "next/server";

import {
  AUDIT_RUNS_DIR,
  getAuditRuns,
  summariseAuditRuns,
} from "../_lib/audit-runs-projection";

// Read-only endpoint. Deliberately NO POST/PUT/PATCH/DELETE — this surface can
// only project durable L2 audit run records for human review. Nothing here
// posts to Slack, DMs Rhys, or delivers to a client; the run workflow ends at
// `ready_for_review` for Workspace review.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const runs = await getAuditRuns();
  return NextResponse.json({
    readOnly: true,
    note:
      "Durable L2 audit run records. Workflow ends at ready_for_review for Workspace review. Nothing is posted/DM'd/delivered from this surface.",
    generatedAt: new Date().toISOString(),
    root: AUDIT_RUNS_DIR,
    summary: summariseAuditRuns(runs),
    runs,
  });
}
