import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync } from "fs";

const QUEUE_PATH = "/tmp/atlas-approvals.json";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const action = body.action as "approve" | "deny";

  if (!["approve", "deny"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  if (existsSync(QUEUE_PATH)) {
    try {
      const raw = readFileSync(QUEUE_PATH, "utf-8");
      const approvals = JSON.parse(raw);
      const updated = approvals.map((a: { id: string; status?: string }) =>
        a.id === id ? { ...a, status: action === "approve" ? "approved" : "denied" } : a,
      );
      writeFileSync(QUEUE_PATH, JSON.stringify(updated, null, 2));
    } catch {}
  }

  return NextResponse.json({ ok: true, id, action });
}
