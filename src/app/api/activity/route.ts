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

// Lines that are noise — skip them
const NOISE_PATTERNS = [
  /No new Rhys calls to process/i,
  /Polling Fireflies for new transcripts/i,
  /Polling every \d+ minutes/i,
  /Call processor health endpoint/i,
  /Bridges: Fireflies/i,
  /ATLAS Call Processor starting/i,
  /socket mode connected/i,
  /users resolved:/i,
];

function isNoise(line: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(line));
}

function inferStatus(line: string, emoji: string): string {
  if (emoji.includes("✅") || emoji.includes("🚀")) return "success";
  if (emoji.includes("❌") || emoji.includes("💀")) return "error";
  if (emoji.includes("⚠️")) return "warning";
  if (/\bsent\b/i.test(line) || /\bdelivered\b/i.test(line) || /\bprocessed\b/i.test(line)) return "success";
  if (/\berror\b/i.test(line) || /\bfailed\b/i.test(line) || /\brejected\b/i.test(line)) return "error";
  return "info";
}

function parseLogEntries(content: string, source: string): Array<{ timestamp: string; action: string; status: string; source: string }> {
  const lines = content.split("\n").filter(Boolean);
  const entries: Array<{ timestamp: string; action: string; status: string; source: string }> = [];

  for (const line of lines) {
    if (isNoise(line)) continue;

    // Pattern 1: ISO timestamp [component] message (gateway log)
    const match2 = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{2}:\d{2})\s*\[([^\]]*)\]\s*(.+)/);
    // Pattern 2: [dd/mm/yyyy, time] emoji message (call processor, slack bridge)
    const match1 = line.match(/\[([^\]]+)\]\s*(.+)/);
    // Pattern 3: ISO timestamp followed by plain text (gateway briefing output)
    const match3 = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{2}:\d{2})\s+(.+)/);

    let timestamp = "";
    let action = "";
    let status = "info";

    if (match2) {
      const ts = new Date(match2[1]);
      timestamp = ts.toLocaleString("en-AU", { timeZone: "Australia/Brisbane", hour: "2-digit", minute: "2-digit", hour12: true });
      const component = match2[2];
      const msg = match2[3];
      action = `[${component}] ${msg}`;
      status = inferStatus(msg, "");
    } else if (match1) {
      timestamp = match1[1];
      const raw = match1[2];
      const emoji = raw.match(/^([^\w\s]*)/)?.[1] || "";
      action = raw.replace(/^[^\w\s]*\s*/, "");
      status = inferStatus(action, emoji);
    } else if (match3) {
      const ts = new Date(match3[1]);
      timestamp = ts.toLocaleString("en-AU", { timeZone: "Australia/Brisbane", hour: "2-digit", minute: "2-digit", hour12: true });
      action = match3[2];
      status = inferStatus(action, "");
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
      const tail = content.slice(-8000);
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
