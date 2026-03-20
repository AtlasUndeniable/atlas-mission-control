import { NextResponse } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function getTodayLogPath(): string | null {
  const logDir = "/tmp/openclaw";
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
      .sort()
      .reverse();
    if (files.length > 0) {
      return join(logDir, files[0]);
    }
  } catch {}

  // Fallback: gateway log
  const gatewayLog = "/Users/atlasai/.openclaw/logs/gateway.log";
  try {
    readFileSync(gatewayLog, "utf8");
    return gatewayLog;
  } catch {}

  return null;
}

function parseLogEntries(content: string): Array<{ timestamp: string; action: string; status: string }> {
  const lines = content.split("\n").filter(Boolean);
  const entries: Array<{ timestamp: string; action: string; status: string }> = [];

  for (const line of lines) {
    // Match patterns like [20/03/2026, 1:15:44 pm] 🚀 ATLAS Call Processor starting
    const match = line.match(/\[([^\]]+)\]\s*(.+)/);
    if (match) {
      const action = match[2].replace(/^[^\w\s]*\s*/, ""); // strip leading emoji
      const emoji = match[2].match(/^([^\w\s]*)/)?.[1] || "";
      let status = "info";
      if (emoji.includes("✅") || emoji.includes("🚀")) status = "success";
      else if (emoji.includes("❌") || emoji.includes("💀")) status = "error";
      else if (emoji.includes("⚠️")) status = "warning";

      entries.push({ timestamp: match[1], action, status });
    }
  }

  return entries.slice(-20);
}

export async function GET() {
  const logPath = getTodayLogPath();

  if (!logPath) {
    return NextResponse.json([]);
  }

  try {
    const content = readFileSync(logPath, "utf8");
    // Read last 5000 chars to keep it fast
    const tail = content.slice(-5000);
    const entries = parseLogEntries(tail);
    return NextResponse.json(entries);
  } catch {
    return NextResponse.json([]);
  }
}
