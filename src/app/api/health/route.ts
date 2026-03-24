import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";

const METRICS_FILE = "/Users/atlasai/.openclaw/data/dashboard-metrics.json";

export async function GET() {
  // Try reading from metrics engine output first
  if (existsSync(METRICS_FILE)) {
    try {
      const raw = readFileSync(METRICS_FILE, "utf-8");
      const m = JSON.parse(raw);
      if (m.health?.services) return NextResponse.json(m.health.services);
    } catch {
      // Fall through to direct checks
    }
  }

  // Fallback: direct health checks (no phantom knowledge:4008)
  const SERVICES: Record<string, string> = {
    gateway: "http://127.0.0.1:18789/health",
    ghl: "http://127.0.0.1:4003/health",
    monday: "http://127.0.0.1:4004/health",
    fireflies: "http://127.0.0.1:4005/health",
    slack: "http://127.0.0.1:4006/health",
    call_processor: "http://127.0.0.1:4007/health",
  };

  const entries = await Promise.all(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const start = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return [
          name,
          {
            status: res.ok ? "online" : "degraded",
            latency_ms: Date.now() - start,
          },
        ] as const;
      } catch {
        return [
          name,
          { status: "offline", latency_ms: Date.now() - start },
        ] as const;
      }
    })
  );

  return NextResponse.json(Object.fromEntries(entries));
}
