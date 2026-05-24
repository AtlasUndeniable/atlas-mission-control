import { NextResponse } from "next/server";

import {
  validateAgentRun,
  validateApproval,
  validateAuditRun,
  validateContentBatch,
  validateMemoryMaintenanceRun,
} from "@/lib/workspace-contracts";
import { getWorkspaceRunsProjection, WORKSPACE_RUNS_ROOT } from "@/lib/workspace-runs-projection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const projection = await getWorkspaceRunsProjection({
    root: WORKSPACE_RUNS_ROOT,
    validators: {
      agentRuns: validateAgentRun,
      auditRuns: validateAuditRun,
      contentBatches: validateContentBatch,
      approvals: validateApproval,
      memoryMaintenanceRuns: validateMemoryMaintenanceRun,
    },
  });

  return NextResponse.json({
    readOnly: true,
    generatedAt: new Date().toISOString(),
    ...projection,
  });
}
