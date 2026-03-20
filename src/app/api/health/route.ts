import { NextResponse } from "next/server";

const SERVICES = {
  gateway: "http://127.0.0.1:18789/health",
  ghl: "http://127.0.0.1:4003/health",
  monday: "http://127.0.0.1:4004/health",
  fireflies: "http://127.0.0.1:4005/health",
  slack: "http://127.0.0.1:4006/health",
  call_processor: "http://127.0.0.1:4007/health",
};

async function checkService(url: string): Promise<{ status: string; latency_ms: number }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const latency_ms = Date.now() - start;
    if (res.ok) {
      return { status: "online", latency_ms };
    }
    return { status: "degraded", latency_ms };
  } catch {
    return { status: "offline", latency_ms: Date.now() - start };
  }
}

export async function GET() {
  const entries = await Promise.all(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const result = await checkService(url);
      return [name, result] as const;
    })
  );

  const health = Object.fromEntries(entries);
  return NextResponse.json(health);
}
