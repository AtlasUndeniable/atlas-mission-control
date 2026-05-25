import { NextResponse } from "next/server";

import { getWorkspaceMemoryMaintenanceProjection } from "@/lib/workspace-memory-maintenance-projection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const projection = await getWorkspaceMemoryMaintenanceProjection();

  return NextResponse.json(projection);
}
