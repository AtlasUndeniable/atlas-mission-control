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

interface KnowledgeBase {
  callTranscripts?: number;
  videoTranscripts?: number;
  videoAnalysis?: number;
  documents?: number;
  totalFiles?: number;
}

interface RevenueData {
  totalRevenue?: number | null;
  mrr?: number | null;
  activeSubscribers?: number | null;
  recentPayments?: Array<{ name: string; amount: number; date: string | null }>;
  churnEvents?: number | null;
  oneOffTotal?: number | null;
  paymentsCount?: number | null;
  currency?: string;
  source?: string;
  stale?: boolean;
}

interface MetaData {
  adSpendDaily?: number | null;
  roas?: number | null;
  source?: string;
  placeholder?: boolean;
}

interface Metrics {
  generatedAt?: string;
  activeClients?: { ghl?: number | null; monday?: number };
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
    closeRate?: number | null;
  };
  calls?: {
    coaching?: {
      thisWeek?: number;
      total?: number;
      recent?: RecentCall[];
    };
    sales?: {
      last30d?: number | null;
      recent?: Array<{ title: string; date: number }>;
      source?: string;
    };
  };
  slack?: {
    totalChannels?: number;
    pendingReplies?: number;
    botMemberChannels?: number | null;
    source?: string;
  };
  meta?: MetaData;
  health?: {
    services?: Record<string, HealthService>;
    online?: number;
    total?: number;
  };
  knowledge?: KnowledgeBase;
  revenue?: RevenueData;
  rhysTasks?: {
    pending?: number;
    completed?: number;
    total?: number;
    newThisCycle?: number;
  };
  kpis?: Record<string, number | string | null>;
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
  const salesCalls = m.calls?.sales ?? {};

  // Preserve null/undefined for "unknown" metrics — UI shows "—" instead of "$0".
  const nullable = <T>(v: T | null | undefined): T | null =>
    v === null || v === undefined ? null : v;

  return {
    activeClients: {
      ghl: nullable(m.activeClients?.ghl),
      monday: m.activeClients?.monday ?? 0,
      source: "ghl:Active Clients pipeline",
    },
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
    callsBooked: {
      last30d: nullable(salesCalls.last30d),
      source: salesCalls.source ?? "fireflies (sales filter)",
    },
    pipeline: {
      pipelines: (m.ghl?.pipelines ?? []).map((p) => ({
        ...p,
        stages: p.stages.map((s) => ({ ...s })),
      })),
    },
    closeRate: nullable(m.ghl?.closeRate),
    slack: {
      totalChannels: m.slack?.totalChannels ?? 0,
      botMemberChannels: nullable(m.slack?.botMemberChannels),
      pendingReplies: m.slack?.pendingReplies ?? 0,
      source: m.slack?.source ?? "slack-bridge",
    },
    meta: {
      adSpendDaily: nullable(m.meta?.adSpendDaily),
      roas: nullable(m.meta?.roas),
      source: m.meta?.source ?? "Awaiting Meta connection",
      placeholder: m.meta?.placeholder ?? true,
    },
    calendar: {
      todaysMeetings: 0, // Calendar data not in metrics JSON yet
    },
    health: {
      online: m.health?.online ?? 0,
      total: m.health?.total ?? 0,
    },
    knowledge: {
      callTranscripts: m.knowledge?.callTranscripts ?? 0,
      videoTranscripts: m.knowledge?.videoTranscripts ?? 0,
      videoAnalysis: m.knowledge?.videoAnalysis ?? 0,
      documents: m.knowledge?.documents ?? 0,
      totalFiles: m.knowledge?.totalFiles ?? 0,
    },
    revenue: {
      totalRevenue: nullable(m.revenue?.totalRevenue),
      mrr: nullable(m.revenue?.mrr),
      activeSubscribers: nullable(m.revenue?.activeSubscribers),
      recentPayments: m.revenue?.recentPayments ?? [],
      churnEvents: nullable(m.revenue?.churnEvents),
      oneOffTotal: nullable(m.revenue?.oneOffTotal),
      paymentsCount: nullable(m.revenue?.paymentsCount),
      currency: m.revenue?.currency ?? "AUD",
      source: m.revenue?.source ?? "unknown",
      stale: m.revenue?.stale ?? false,
    },
    rhysTasks: {
      pending: m.rhysTasks?.pending ?? 0,
      completed: m.rhysTasks?.completed ?? 0,
      total: m.rhysTasks?.total ?? 0,
    },
    opportunities: m.ghl?.totalOpportunities ?? 0,
    pendingApprovals: m.slack?.pendingReplies ?? 0,
    kpis: m.kpis ?? {},
    generatedAt: m.generatedAt,
  };
}

// ===== STALENESS =====
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

function computeFreshness(generatedAt: string | undefined) {
  if (!generatedAt) {
    return { generatedAt: null, ageMinutes: null, stale: true, reason: "generatedAt missing" };
  }
  const ts = new Date(generatedAt).getTime();
  if (isNaN(ts)) {
    return { generatedAt, ageMinutes: null, stale: true, reason: "generatedAt invalid" };
  }
  const ageMs = Date.now() - ts;
  const ageMinutes = Math.round(ageMs / 60000);
  if (ageMs > STALE_THRESHOLD_MS) {
    return { generatedAt, ageMinutes, stale: true, reason: `Data is ${ageMinutes}m old (threshold: 10m)` };
  }
  return { generatedAt, ageMinutes, stale: false, reason: null };
}

// ===== ROUTE =====
export async function GET() {
  const metrics = readMetrics();

  if (!metrics) {
    return NextResponse.json({
      activeClients: { ghl: null, monday: 0, source: "metrics file missing" },
      monday: { activeClients: 0, highPriority: 0, tasksDone: 0, tasksWorking: 0, tasksStuck: 0 },
      fireflies: { callsThisWeek: 0, callsProcessed: 0, recentCalls: [] },
      callsBooked: { last30d: null, source: "metrics file missing" },
      pipeline: { pipelines: [] },
      closeRate: null,
      slack: { totalChannels: 0, botMemberChannels: null, pendingReplies: 0, source: "metrics file missing" },
      meta: { adSpendDaily: null, roas: null, source: "Awaiting Meta connection", placeholder: true },
      calendar: { todaysMeetings: 0 },
      health: { online: 0, total: 0 },
      knowledge: { callTranscripts: 0, videoTranscripts: 0, videoAnalysis: 0, documents: 0, totalFiles: 0 },
      revenue: { totalRevenue: null, mrr: null, activeSubscribers: null, recentPayments: [], churnEvents: null, oneOffTotal: null, paymentsCount: null, currency: "AUD", source: "metrics file missing", stale: true },
      rhysTasks: { pending: 0, completed: 0, total: 0 },
      opportunities: 0,
      pendingApprovals: 0,
      metricsFreshness: { generatedAt: null, ageMinutes: null, stale: true, reason: "Metrics file not found" },
    });
  }

  const data = buildOverview(metrics);
  return NextResponse.json({
    ...data,
    metricsFreshness: computeFreshness(metrics.generatedAt),
  });
}
