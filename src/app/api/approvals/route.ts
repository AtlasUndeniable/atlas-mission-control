import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";

const QUEUE_PATH = "/Users/atlasai/.openclaw/data/approvals.json";

export async function GET() {
  if (existsSync(QUEUE_PATH)) {
    try {
      const raw = readFileSync(QUEUE_PATH, "utf-8");
      const approvals = JSON.parse(raw).filter(
        (a: { status?: string }) => !a.status || a.status === "pending",
      );
      return NextResponse.json({ approvals });
    } catch {
      return NextResponse.json({ approvals: [] });
    }
  }
  return NextResponse.json({ approvals: [] });
}
