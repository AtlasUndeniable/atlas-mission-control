import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";

const METRICS_FILE = "/Users/atlasai/.openclaw/data/dashboard-metrics.json";
const QUEUE_FILE = "/Users/atlasai/.openclaw/data/slack-queue.json";

// ===== TYPES =====
interface StuckItem {
  name: string;
  board: string;
}

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
  duration?: number;
}

interface HealthService {
  status: string;
  latency_ms: number;
}

interface QueueItem {
  id: string;
  channel: string;
  channelName: string;
  sender: string;
  senderName: string;
  originalMessage: string;
  draftReply: string | null;
  timestamp: number;
  messageTs: string;
  status: string;
}

interface Metrics {
  version?: string;
  generatedAt?: string;
  activeClients?: { ghl?: number; salesLeads?: number; monday?: number };
  revenue?: { ghlClosedWon?: number; ghlClosedCount?: number };
  monday?: {
    activeBoardCount?: number;
    totalTasks?: number;
    highPriority?: number;
    tasksDone?: number;
    tasksWorking?: number;
    tasksStuck?: number;
    tasksNotStarted?: number;
    stuckItems?: StuckItem[];
  };
  ghl?: {
    pipelines?: Pipeline[];
    totalOpportunities?: number;
    totalContacts?: number;
    closeRate?: number;
    closedWon?: number;
    closedWonValue?: number;
  };
  calls?: {
    coaching?: {
      thisWeek?: number;
      last24h?: number;
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

// ===== READ FILES (no API calls) =====
function readMetrics(): Metrics | null {
  try {
    if (existsSync(METRICS_FILE)) {
      return JSON.parse(readFileSync(METRICS_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function readApprovals(): QueueItem[] {
  try {
    if (existsSync(QUEUE_FILE)) {
      const items: QueueItem[] = JSON.parse(readFileSync(QUEUE_FILE, "utf-8"));
      return items.filter((i) => i.status === "pending" || i.status === "needs_draft");
    }
  } catch {}
  return [];
}

// ===== BUILD BRIEFING FROM METRICS JSON =====
function buildBriefing(m: Metrics) {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-AU", { weekday: "long" });
  const timestamp = now.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const mon = m.monday ?? {};
  const ghl = m.ghl ?? {};
  const calls = m.calls?.coaching ?? {};
  const health = m.health ?? {};
  const kpis = m.kpis ?? {};
  const approvals = readApprovals();

  // Build pipeline opportunity list from stage data
  const allPipelines = ghl.pipelines ?? [];
  const enrichedOpps: Array<{ name: string; stage: string }> = [];
  let earlyStageCount = 0;
  const earlyStageNames = ["new booking", "lead magnet", "enquired", "new lead"];

  for (const p of allPipelines) {
    for (const s of p.stages) {
      if (s.count > 0) {
        // Add a representative entry per stage with count
        enrichedOpps.push({ name: `${s.count} in ${p.name}`, stage: s.name });
        if (earlyStageNames.some((n) => s.name.toLowerCase().includes(n))) {
          earlyStageCount += s.count;
        }
      }
    }
  }

  // Services
  const services = health.services ?? {};
  const serviceEntries = Object.entries(services);
  const servicesOnline = serviceEntries.filter(([, v]) => v.status === "online").length;
  const servicesTotal = serviceEntries.length || 6;

  // Stuck tasks with board names
  const stuckTasks = (mon.stuckItems ?? []).map((item) => ({
    name: item.name,
    boardName: item.board,
    priority: "High",
  }));

  return {
    timestamp,
    dayOfWeek,
    todaysMeetings: 0, // Calendar data not in metrics JSON yet
    revenue: {
      closedWon: m.revenue?.ghlClosedWon ?? 0,
      closedCount: m.revenue?.ghlClosedCount ?? 0,
      mtd: m.revenue?.ghlClosedWon ?? 0,
      projected: 0,
      breakTarget: 850000,
    },
    kpis: {
      callsBooked: calls.thisWeek ?? kpis.callsCoachingThisWeek ?? 0,
      activeClients: m.activeClients?.monday ?? kpis.activeClientsMonday ?? 0,
      dailyAdSpend: 0,
      roas: 0,
      slackChannels: m.slack?.totalChannels ?? 0,
      closeRate: kpis.closeRate ?? ghl.closeRate ?? 0,
      totalContacts: kpis.totalContacts ?? ghl.totalContacts ?? 0,
      totalOpportunities: kpis.totalOpportunities ?? ghl.totalOpportunities ?? 0,
      tasksInProgress: kpis.tasksInProgress ?? mon.tasksWorking ?? 0,
      taskCompletion: kpis.taskCompletion ?? 0,
    },
    monday: {
      summary: {
        activeClients: mon.activeBoardCount ?? 0,
        highPriority: mon.highPriority ?? 0,
        critical: 0,
        inProgress: mon.tasksWorking ?? 0,
        stuck: mon.tasksStuck ?? 0,
        notStarted: mon.tasksNotStarted ?? 0,
        done: mon.tasksDone ?? 0,
        totalTasks: mon.totalTasks ?? 0,
      },
      stuckTasks: stuckTasks.slice(0, 5),
      inProgressTasks: [], // Not tracked at item level in metrics
    },
    pipeline: {
      totalOpen: ghl.totalOpportunities ?? 0,
      opportunities: enrichedOpps.slice(0, 10),
      earlyStage: earlyStageCount,
    },
    calls: {
      thisWeek: calls.thisWeek ?? 0,
      processed: calls.total ?? 0,
      recent: (calls.recent ?? []).map((c) => c.title),
    },
    slack: {
      totalChannels: m.slack?.totalChannels ?? 0,
    },
    approvals: approvals.map((a) => ({
      type: "slack",
      channel: a.channelName,
      replyingTo: a.senderName,
      originalMessage: a.originalMessage?.slice(0, 200),
      draftReply: a.draftReply?.slice(0, 200),
    })),
    services: {
      online: servicesOnline,
      total: servicesTotal,
      allGreen: servicesOnline === servicesTotal,
    },
    activity: [], // Activity log reads from files, not needed for briefing speed
  };
}

// ===== ROUTE =====
export async function GET() {
  const metrics = readMetrics();

  if (!metrics) {
    return NextResponse.json(
      {
        timestamp: new Date().toLocaleTimeString("en-AU", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
        dayOfWeek: new Date().toLocaleDateString("en-AU", { weekday: "long" }),
        todaysMeetings: 0,
        revenue: { closedWon: 0, closedCount: 0, mtd: 0, projected: 0, breakTarget: 850000 },
        kpis: {
          callsBooked: 0, activeClients: 0, dailyAdSpend: 0, roas: 0,
          slackChannels: 0, closeRate: 0, totalContacts: 0, totalOpportunities: 0,
          tasksInProgress: 0, taskCompletion: 0,
        },
        monday: { summary: null, stuckTasks: [], inProgressTasks: [] },
        pipeline: { totalOpen: 0, opportunities: [], earlyStage: 0 },
        calls: { thisWeek: 0, processed: 0, recent: [] },
        slack: { totalChannels: 0 },
        approvals: [],
        services: { online: 0, total: 6, allGreen: false },
        activity: [],
      },
      { status: 200 }
    );
  }

  const data = buildBriefing(metrics);
  return NextResponse.json(data);
}
