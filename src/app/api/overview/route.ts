import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";

const METRICS_FILE = "/Users/atlasai/.openclaw/data/dashboard-metrics.json";

// ===== TYPES =====
interface PipelineStage {
  id: string;
  name: string;
  position: number;
  count: number;
  value: number;
}

interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  totalOpportunities: number;
}

interface RecentCall {
  title: string;
  date: number;
}

interface HealthService {
  status: string;
  latency_ms: number;
}

interface Metrics {
  generatedAt?: string;
  activeClients?: { ghl?: number; monday?: number };
  monday?: {
    activeBoardCount?: number;
    highPriority?: number;
    tasksDone?: number;
    tasksWorking?: number;
    tasksStuck?: number;
  };
  ghl?: {
    pipelines?: Pipeline[];
    totalOpportunities?: number;
  };
  calls?: {
    coaching?: {
      thisWeek?: number;
      total?: number;
      recent?: RecentCall[];
    };
  };
  slack?: { totalChannels?: number };
  health?: {
    services?: Record<string, HealthService>;
    online?: number;
    total?: number;
  };
  kpis?: Record<string, number>;
}

// ===== READ METRICS (no API calls) =====
function readMetrics(): Metrics | null {
  try {
    if (existsSync(METRICS_FILE)) {
      return JSON.parse(readFileSync(METRICS_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function buildOverview(m: Metrics) {
  const mon = m.monday ?? {};
  const calls = m.calls?.coaching ?? {};

  return {
    monday: {
      activeClients: mon.activeBoardCount ?? 0,
      highPriority: mon.highPriority ?? 0,
      tasksDone: mon.tasksDone ?? 0,
      tasksWorking: mon.tasksWorking ?? 0,
      tasksStuck: mon.tasksStuck ?? 0,
    },
    fireflies: {
      callsThisWeek: calls.thisWeek ?? 0,
      callsProcessed: calls.total ?? 0,
      recentCalls: (calls.recent ?? []).slice(0, 3).map((c) => ({
        title: c.title,
        date: c.date,
      })),
    },
    pipeline: {
      pipelines: (m.ghl?.pipelines ?? []).map((p) => ({
        ...p,
        stages: p.stages.map((s) => ({ ...s })),
      })),
    },
    slack: {
      totalChannels: m.slack?.totalChannels ?? 0,
    },
    calendar: {
      todaysMeetings: 0, // Calendar data not in metrics JSON yet
    },
    kpis: m.kpis ?? {},
    generatedAt: m.generatedAt,
  };
}

// ===== ROUTE =====
export async function GET() {
  const metrics = readMetrics();

  if (!metrics) {
    return NextResponse.json({
      monday: { activeClients: 0, highPriority: 0, tasksDone: 0, tasksWorking: 0, tasksStuck: 0 },
      fireflies: { callsThisWeek: 0, callsProcessed: 0, recentCalls: [] },
      pipeline: { pipelines: [] },
      slack: { totalChannels: 0 },
      calendar: { todaysMeetings: 0 },
    });
  }

  const data = buildOverview(metrics);
  return NextResponse.json(data);
}
