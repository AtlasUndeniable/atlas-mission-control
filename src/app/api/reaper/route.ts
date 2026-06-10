import { NextResponse } from "next/server";
import { buildReaperData } from "@/lib/reaper";

// Read-only endpoint. There is deliberately NO POST/PUT/PATCH/DELETE handler,
// so no request can mutate, complete, delete, or send anything. The Reaper MVP
// only projects pending extracted action items for human triage.
export const dynamic = "force-dynamic";

export async function GET() {
  const data = buildReaperData();
  return NextResponse.json({
    readOnly: true,
    note: "Extracted Fireflies/Rhys action items — NOT confirmed live obligations. Triage actions are not wired in this MVP.",
    generatedAt: new Date().toISOString(),
    ...data,
  });
}
