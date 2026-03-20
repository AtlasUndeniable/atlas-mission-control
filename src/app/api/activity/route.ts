import { NextResponse } from "next/server";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

function getLogPaths(): string[] {
  const paths: string[] = [];

  // 1. Today's OpenClaw log
  const logDir = "/tmp/openclaw";
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
      .sort()
      .reverse();
    if (files.length > 0) {
      paths.push(join(logDir, files[0]));
    }
  } catch {}

  // 2. Gateway log
  const gatewayLog = "/Users/atlasai/.openclaw/logs/gateway.log";
  if (existsSync(gatewayLog)) paths.push(gatewayLog);

  // 3. Call processor log
  const callLog = "/Users/atlasai/.openclaw/logs/call-processor.log";
  if (existsSync(callLog)) paths.push(callLog);

  // 4. Slack bridge log
  const slackLog = "/Users/atlasai/.openclaw/logs/slack-bridge.log";
  if (existsSync(slackLog)) paths.push(slackLog);

  return paths;
}

function parseLogEntries(content: string, source: string): Array<{ timestamp: string; action: string; status: string; source: string }> {
  const lines = content.split("\n").filter(Boolean);
  const entries: Array<{ timestamp: string; action: string; status: string; source: string }> = [];

  for (const line of lines) {
    // Pattern 1: [date] emoji message
    const match1 = line.match(/\[([^\]]+)\]\s*(.+)/);
    // Pattern 2: ISO timestamp [component] message
    const match2 = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{2}:\d{2})\s*\[([^\]]*)\]\s*(.+)/);

    let timestamp = "";
    let action = "";
    let status = "info";

    if (match2) {
      const ts = new Date(match2[1]);
      timestamp = ts.toLocaleString("en-AU", { timeZone: "Australia/Brisbane", hour: "2-digit", minute: "2-digit", hour12: true });
      action = `[${match2[2]}] ${match2[3]}`;
    } else if (match1) {
      timestamp = match1[1];
      action = match1[2].replace(/^[^\w\s]*\s*/, "");
      const emoji = match1[2].match(/^([^\w\s]*)/)?.[1] || "";
      if (emoji.includes("✅") || emoji.includes("🚀")) status = "success";
      else if (emoji.includes("❌") || emoji.includes("💀")) status = "error";
      else if (emoji.includes("⚠️")) status = "warning";
    } else {
      continue;
    }

    entries.push({ timestamp, action, status, source });
  }

  return entries;
}

export async function GET() {
  const logPaths = getLogPaths();
  const allEntries: Array<{ timestamp: string; action: string; status: string; source: string }> = [];

  for (const logPath of logPaths) {
    try {
      const content = readFileSync(logPath, "utf8");
      const tail = content.slice(-4000);
      const source = logPath.includes("gateway") ? "gateway"
        : logPath.includes("call-processor") ? "processor"
        : logPath.includes("slack") ? "slack"
        : "openclaw";
      const entries = parseLogEntries(tail, source);
      allEntries.push(...entries.slice(-10));
    } catch {}
  }

  // Return last 20 entries
  return NextResponse.json(allEntries.slice(-20));
}
