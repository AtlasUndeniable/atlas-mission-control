"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";

import RevenueHero from "@/components/RevenueHero";
import ConstellationNetwork from "@/components/ConstellationNetwork";
import KpiCard from "@/components/KpiCard";
import OperationsPanel from "@/components/OperationsPanel";
import CoachingIntelPanel from "@/components/CoachingIntelPanel";
import AgentActivityFeed from "@/components/AgentActivityFeed";
import SystemPerformance from "@/components/SystemPerformance";
import PipelinePanel from "@/components/PipelinePanel";
import MetaAdsPanel from "@/components/MetaAdsPanel";
import RevenueTrendPanel from "@/components/RevenueTrendPanel";
import AtlasChatBar from "@/components/AtlasChatBar";
import BootSequence from "@/components/BootSequence";
import BriefingSequence from "@/components/BriefingSequence";
import ConstellationCanvas from "@/components/ConstellationCanvas";
import MuteToggle from "@/components/MuteToggle";
import HeroBriefing from "@/components/HeroBriefing";
import ApprovalQueue from "@/components/ApprovalQueue";
import CommsToast from "@/components/CommsToast";
import { useSoundContext } from "@/components/SoundEngine";

interface OverviewData {
  monday: {
    activeClients: number;
    highPriority: number;
    tasksDone: number;
    tasksWorking: number;
    tasksStuck: number;
  };
  fireflies: {
    callsThisWeek: number;
    callsProcessed: number;
    recentCalls: Array<{ title: string; date: number }>;
  };
  pipeline: unknown;
  slack: {
    totalChannels: number;
  };
  calendar?: {
    todaysMeetings: number;
  };
  kpis?: {
    activeClients: number;
    callsBookedThisWeek: number;
    closeRate: number;
    totalContacts: number;
    totalOpportunities: number;
    tasksInProgress: number;
    taskCompletion: number;
    servicesOnline: number;
    servicesTotal: number;
  };
  generatedAt?: string;
}

interface HealthMap {
  [key: string]: { status: string; latency_ms: number };
}

type Phase = "boot" | "briefing" | "dashboard";

// ===== GREETING ENGINE =====
function useGreeting(): string {
  const [greeting, setGreeting] = useState("");
  useEffect(() => {
    const update = () => {
      const h = new Date().getHours();
      if (h >= 5 && h < 12) setGreeting("Good morning, Rhys");
      else if (h >= 12 && h < 17) setGreeting("Good afternoon, Rhys");
      else if (h >= 17 && h < 21) setGreeting("Good evening, Rhys");
      else setGreeting("Burning the midnight oil, Rhys?");
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, []);
  return greeting;
}

// ===== UPTIME COUNTER =====
function useUptime(): string {
  const [uptime, setUptime] = useState("UP 0d 00:00:00");
  const startRef = useRef(Date.now());
  useEffect(() => {
    const update = () => {
      const elapsed = Date.now() - startRef.current;
      const totalSec = Math.floor(elapsed / 1000);
      const days = Math.floor(totalSec / 86400);
      const hrs = Math.floor((totalSec % 86400) / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      const pad = (n: number) => String(n).padStart(2, "0");
      setUptime(`UP ${days}d ${pad(hrs)}:${pad(mins)}:${pad(secs)}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);
  return uptime;
}

// ===== ROTATING STATUS MESSAGES =====
function useRotatingStatus(overview: OverviewData | null, servicesOnline: number, servicesTotal: number): string {
  const [msg, setMsg] = useState("All systems operational");
  const idxRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const messages: string[] = [];
      if (servicesOnline === servicesTotal && servicesTotal > 0) {
        messages.push("All integrations connected");
      } else if (servicesTotal > 0) {
        messages.push(`${servicesTotal - servicesOnline} service${servicesTotal - servicesOnline > 1 ? "s" : ""} degraded`);
      }
      if (overview?.fireflies?.callsThisWeek) {
        messages.push(`${overview.fireflies.callsThisWeek} calls processed this week`);
      }
      if (overview?.monday?.activeClients) {
        messages.push(`${overview.monday.activeClients} client boards active`);
      }
      if (overview?.slack?.totalChannels) {
        messages.push(`Monitoring ${overview.slack.totalChannels} Slack channels`);
      }
      if (overview?.monday?.tasksStuck && overview.monday.tasksStuck > 0) {
        messages.push(`${overview.monday.tasksStuck} stuck item${overview.monday.tasksStuck > 1 ? "s" : ""} flagged`);
      }
      if (messages.length === 0) messages.push("Initialising...");
      idxRef.current = (idxRef.current + 1) % messages.length;
      setMsg(messages[idxRef.current]);
    };
    tick();
    const interval = setInterval(tick, 8000);
    return () => clearInterval(interval);
  }, [overview, servicesOnline, servicesTotal]);
  return msg;
}

// ===== NAMED SERVICES for header =====
const HEADER_SERVICES = [
  { key: "gateway", label: "CLAUDE" },
  { key: "slack", label: "SLACK" },
  { key: "ghl", label: "GHL" },
  { key: "monday", label: "MONDAY" },
  { key: "fireflies", label: "FIREFLIES" },
];

export default function Dashboard() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [health, setHealth] = useState<HealthMap>({});
  const [refreshing, setRefreshing] = useState(false);
  const [constellationOpacity, setConstellationOpacity] = useState(0);
  const [phase, setPhase] = useState<Phase>("boot");
  const sound = useSoundContext();
  const greeting = useGreeting();
  const uptime = useUptime();
  const dashboardReady = phase === "dashboard";

  const healthEntries = Object.values(health);
  const servicesOnline = healthEntries.filter((s) => s.status === "online").length;
  const servicesTotal = healthEntries.length || 7;

  const rotatingStatus = useRotatingStatus(overview, servicesOnline, servicesTotal);

  // ===== ON MOUNT: Check sessionStorage for returning visitors =====
  useEffect(() => {
    if (sessionStorage.getItem("atlas-booted") === "1") {
      setPhase("dashboard");
      setConstellationOpacity(1);
    }
  }, []);

  useEffect(() => {
    if (phase !== "boot") setConstellationOpacity(1);
  }, [phase]);

  // ===== FETCH DATA =====
  const fetchOverview = useCallback(async () => {
    try {
      setRefreshing(true);
      const res = await fetch("/api/overview");
      if (res.ok) {
        const data = await res.json();
        setOverview(data);
        if (dashboardReady) sound.playDataRefresh();
      }
    } catch {} finally {
      setTimeout(() => setRefreshing(false), 1000);
    }
  }, [sound, dashboardReady]);

  useEffect(() => {
    fetchOverview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dashboardReady) return;
    const interval = setInterval(fetchOverview, 30000);
    return () => clearInterval(interval);
  }, [dashboardReady, fetchOverview]);

  useEffect(() => {
    async function fetchHealth() {
      try {
        const res = await fetch("/api/health");
        if (res.ok) setHealth(await res.json());
      } catch {}
    }
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!dashboardReady) return;
    const startOnClick = () => {
      sound.startAmbient();
      window.removeEventListener("click", startOnClick);
      window.removeEventListener("keydown", startOnClick);
    };
    window.addEventListener("click", startOnClick, { once: true });
    window.addEventListener("keydown", startOnClick, { once: true });
    return () => {
      window.removeEventListener("click", startOnClick);
      window.removeEventListener("keydown", startOnClick);
    };
  }, [dashboardReady, sound]);

  // ===== PHASE TRANSITIONS =====
  const handleBootSkip = useCallback(() => {
    setPhase("dashboard");
    setConstellationOpacity(1);
    sessionStorage.setItem("atlas-booted", "1");
    localStorage.setItem("atlas-last-briefing", String(Date.now()));
    sound.startAmbient();
  }, [sound]);

  const handleInitLinesComplete = useCallback(() => {
    setPhase("briefing");
    setConstellationOpacity(1);
    sessionStorage.setItem("atlas-booted", "1");
  }, []);

  const handleBriefingComplete = useCallback(() => {
    setPhase("dashboard");
    localStorage.setItem("atlas-last-briefing", String(Date.now()));
  }, []);

  // ===== DERIVED STATE =====
  const briefingData = useMemo(() => ({
    callsBooked: overview?.fireflies?.callsThisWeek,
    activeClients: overview?.monday?.activeClients,
    callsProcessed: overview?.fireflies?.callsProcessed,
    servicesOnline,
    totalServices: servicesTotal,
    pendingApprovals: 0,
    slackChannels: overview?.slack?.totalChannels,
    todaysMeetings: overview?.calendar?.todaysMeetings,
    tasksStuck: overview?.monday?.tasksStuck,
    tasksWorking: overview?.monday?.tasksWorking,
    tasksDone: overview?.monday?.tasksDone,
    highPriority: overview?.monday?.highPriority,
    recentCalls: overview?.fireflies?.recentCalls,
    pipeline: overview?.pipeline as {
      pipelines?: Array<{
        name: string;
        totalOpportunities?: number;
        stages?: Array<{ name: string; count?: number }>;
      }>;
    },
  }), [overview, servicesOnline, servicesTotal]);

  // Close rate from metrics engine KPIs
  const closeRate = overview?.kpis?.closeRate != null ? `${overview.kpis.closeRate}%` : "—";

  const pr = useMemo(() => (i: number) =>
    dashboardReady ? `panel-reveal panel-reveal-${i}` : "opacity-0",
  [dashboardReady]);

  return (
    <div className="min-h-screen pb-20 ambient-bg">
      {/* ===== CONSTELLATION BACKGROUND — heavily dimmed in dashboard ===== */}
      <ConstellationCanvas opacity={constellationOpacity} dimmed={dashboardReady} />

      {/* ===== CRT SCAN LINE OVERLAY ===== */}
      <div className="crt-scanlines" />

      {/* ===== BOOT SEQUENCE ===== */}
      {phase === "boot" && (
        <BootSequence
          onComplete={handleBootSkip}
          onInitLinesComplete={handleInitLinesComplete}
          soundEngine={sound}
          onConstellationFadeIn={() => setConstellationOpacity(1)}
        />
      )}

      {/* ===== BRIEFING SEQUENCE ===== */}
      {phase === "briefing" && (
        <BriefingSequence
          onComplete={handleBriefingComplete}
          soundEngine={sound}
          data={briefingData}
        />
      )}

      {/* ===== HEADER BAR ===== */}
      <header
        className={`sticky top-0 z-40 px-4 lg:px-6 py-2.5 ${pr(0)}`}
        style={{ background: "rgba(5, 5, 16, 0.92)", backdropFilter: "blur(16px)" }}
      >
        <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-4">
          {/* Left: Logo + Undeniable icon */}
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <h1
              className="text-sm font-bold tracking-[0.3em] uppercase text-glow"
              style={{ fontFamily: "var(--font-heading)", color: "#0088FF", fontSize: "15px" }}
            >
              ATLAS
            </h1>
            <div style={{ width: "1px", height: "14px", background: "rgba(255,255,255,0.1)" }} />
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>

          {/* Centre: Named service dots + rotating status */}
          <div className="flex items-center gap-5 flex-1 justify-center overflow-hidden">
            <div className="header-services">
              {HEADER_SERVICES.map((svc) => {
                const isOnline = health[svc.key]?.status === "online";
                return (
                  <div key={svc.key} className="header-svc">
                    <span className={`header-svc-dot ${isOnline ? "on" : "off"}`} />
                    <span>{svc.label}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ width: "1px", height: "12px", background: "rgba(255,255,255,0.08)" }} />
            <span className="header-status-text">{rotatingStatus}</span>
          </div>

          {/* Right: Uptime + Lock + Volume + Refresh indicator */}
          <div className="flex items-center gap-4 flex-shrink-0">
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                letterSpacing: "0.08em",
                color: "rgba(255,255,255,0.3)",
              }}
            >
              {uptime}
            </span>
            <MuteToggle inline />
            {refreshing && <div className="refresh-dot" />}
          </div>
        </div>
        <div
          className="absolute bottom-0 left-0 right-0 h-px"
          style={{ background: "linear-gradient(90deg, transparent, rgba(0,136,255,0.3), transparent)" }}
        />
      </header>

      {/* ===== DASHBOARD CONTENT ===== */}
      <main className="dashboard-grid max-w-[1440px] mx-auto relative z-[2]">
        {/* Row 0: Greeting bar */}
        <div className={`hero-briefing-row ${pr(0)}`}>
          <HeroBriefing
            greeting={greeting}
            overview={overview}
            servicesOnline={servicesOnline}
            servicesTotal={servicesTotal}
            approvalsCount={0}
            compact
          />
        </div>

        {/* Row 1: Revenue Hero (3fr) + Constellation (1fr) */}
        <div className={`hero-row ${pr(1)}`}>
          <RevenueHero />
          <ConstellationNetwork />
        </div>

        {/* Row 2: 6 KPI Cards */}
        <div className={`kpi-row ${pr(2)}`}>
          <KpiCard
            label="Calls Booked"
            value={overview?.fireflies?.callsThisWeek ?? "—"}
            subtext="This week"
            accentClass="kpi-accent-cyan"
          />
          <KpiCard
            label="Active Clients"
            value={overview?.monday?.activeClients ?? "—"}
            subtext="Monday boards"
            accentClass="kpi-accent-cyan"
          />
          <KpiCard
            label="Daily Ad Spend"
            value="—"
            subtext="Awaiting Manus"
            accentClass="kpi-accent-amber"
          />
          <KpiCard
            label="ROAS"
            value="—"
            subtext="Awaiting Manus"
            accentClass="kpi-accent-amber"
          />
          <KpiCard
            label="Slack Channels"
            value={overview?.slack?.totalChannels ?? "—"}
            subtext="Monitored"
            accentClass="kpi-accent-white"
          />
          <KpiCard
            label="Close Rate"
            value={closeRate}
            subtext="SALES pipeline"
            accentClass="kpi-accent-green"
          />
        </div>

        {/* Row 3+: 4-Column Panel Grid (Manus layout) */}
        <div className={`panel-grid ${pr(3)}`}>
          {/* Column 1: Meta Ads + Pipeline */}
          <div className="space-y-4">
            <MetaAdsPanel />
            <PipelinePanel data={overview?.pipeline} />
          </div>

          {/* Column 2: Operations + Coaching Intel */}
          <div className="space-y-4">
            <OperationsPanel data={overview?.monday ?? null} />
            <CoachingIntelPanel data={overview?.fireflies ?? null} />
          </div>

          {/* Column 3: Revenue Trend + System Performance */}
          <div className="space-y-4">
            <RevenueTrendPanel />
            <SystemPerformance />
          </div>

          {/* Column 4: Agent Activity + Approvals */}
          <div className="space-y-4">
            <AgentActivityFeed />
            <ApprovalQueue />
          </div>
        </div>
      </main>

      {/* ===== COMMS TOAST NOTIFICATIONS ===== */}
      {dashboardReady && <CommsToast />}

      {/* ===== CHAT BAR ===== */}
      <AtlasChatBar soundEngine={sound} />
    </div>
  );
}
