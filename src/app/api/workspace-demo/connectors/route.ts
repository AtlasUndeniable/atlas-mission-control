import { NextResponse } from "next/server";

import { getWorkspaceConnectorRegistry } from "@/lib/workspace-connectors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const registry = await getWorkspaceConnectorRegistry();
  return NextResponse.json({ ok: true, ...registry });
}
