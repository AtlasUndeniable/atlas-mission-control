import { NextRequest, NextResponse } from "next/server";
import { setTaskStatus } from "@/lib/rhys-tasks-store";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const updated = setTaskStatus(id, "pending");
  if (!updated) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json({ task: updated });
}
