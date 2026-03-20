"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import RevenueHero from "@/components/RevenueHero";
import ConstellationNetwork from "@/components/ConstellationNetwork";
import KpiCard from "@/components/KpiCard";
import OperationsPanel from "@/components/OperationsPanel";
import CoachingIntelPanel from "@/components/CoachingIntelPanel";
import AgentActivityFeed from "@/components/AgentActivityFeed";
import SystemPerformance from "@/components/SystemPerformance";
import PipelinePanel from "@/components/PipelinePanel";
import PlaceholderPanel from "@/components/PlaceholderPanel";
import AtlasChatBar from "@/components/AtlasChatBar";
import BootSequence from "@/components/BootSequence";
import BriefingSequence from "@/components/BriefingSequence";
import ConstellationCanvas from "@/components/ConstellationCanvas";
import MuteToggle from "@/components/MuteToggle";
import HeroBriefing from "@/components/HeroBriefing";
import ApprovalQueue from "@/components/ApprovalQueue";
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

// ===== LIVE CLOCK =====
function useLiveClock(): string {
  const [time, setTime] = useState("");
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-AU", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      const timeStr = now.toLocaleTimeString("en-AU", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      setTime(`${dateStr} · ${timeStr}`);
    };
    update();
    const interval = setInterval(update, 10000);
    return () => clearInterval(interval);
  }, []);
  return time;
}

export default function Dashboard() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [health, setHealth] = useState<HealthMap>({});
  const [refreshing, setRefreshing] = useState(false);
  const [constellationOpacity, setConstellationOpacity] = useState(0);
  const [phase, setPhase] = useState<Phase>("boot");
  const sound = useSoundContext();
  const greeting = useGreeting();
  const clock = useLiveClock();

  const dashboardReady = phase === "dashboard";

  // ===== ON MOUNT: Check sessionStorage for returning visitors =====
  useEffect(() => {
    if (sessionStorage.getItem("atlas-booted") === "1") {
      // Check if briefing was recent (< 30 min)
      const lastBriefing = parseInt(localStorage.getItem("atlas-last-briefing") || "0");
      if (Date.now() - lastBriefing < 30 * 60 * 1000) {
        setPhase("dashboard");
      } else {
        // Show boot but skip to briefing quickly? No — just skip all for returning visitors.
        setPhase("dashboard");
      }
      setConstellationOpacity(1);
    }
  }, []);

  // Constellation visible whenever we're past initial boot
  useEffect(() => {
    if (phase !== "boot") setConstellationOpacity(1);
  }, [phase]);

  // ===== FETCH DATA EARLY — during boot, parallel to init lines =====
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
    // Fetch immediately on mount (not waiting for boot to finish)
    fetchOverview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch periodically once dashboard is visible
  useEffect(() => {
    if (!dashboardReady) return;
    const interval = setInterval(fetchOverview, 30000);
    return () => clearInterval(interval);
  }, [dashboardReady, fetchOverview]);

  // Fetch health data early too
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

  // ===== Start ambient on first user interaction (returning visitors) =====
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

  // Boot skip → straight to dashboard
  const handleBootSkip = useCallback(() => {
    setPhase("dashboard");
    setConstellationOpacity(1);
    sessionStorage.setItem("atlas-booted", "1");
    localStorage.setItem("atlas-last-briefing", String(Date.now()));
    sound.startAmbient();
  }, [sound]);

  // Boot init lines done → briefing phase
  const handleInitLinesComplete = useCallback(() => {
    setPhase("briefing");
    setConstellationOpacity(1);
    sessionStorage.setItem("atlas-booted", "1");
  }, []);

  // Briefing done → dashboard
  const handleBriefingComplete = useCallback(() => {
    setPhase("dashboard");
    localStorage.setItem("atlas-last-briefing", String(Date.now()));
  }, []);

  // ===== DERIVED STATE =====
  const healthEntries = Object.values(health);
  const servicesOnline = healthEntries.filter((s) => s.status === "online").length;
  const servicesTotal = healthEntries.length || 7;

  // Briefing data (passed to BriefingSequence)
  const briefingData = useMemo(() => ({
    callsBooked: overview?.fireflies?.callsThisWeek,
    activeClients: overview?.monday?.activeClients,
    callsProcessed: overview?.fireflies?.callsProcessed,
    servicesOnline,
    totalServices: servicesTotal,
    pendingApprovals: 0, // from approvals API in future
    slackChannels: overview?.slack?.totalChannels,
  }), [overview, servicesOnline, servicesTotal]);

  // Panel reveal class helper — stagger 80ms per panel
  const pr = useMemo(() => (i: number) =>
    dashboardReady ? `panel-reveal panel-reveal-${i}` : "opacity-0",
  [dashboardReady]);

  return (
    <div className="min-h-screen pb-20 ambient-bg">
      {/* ===== CONSTELLATION BACKGROUND ===== */}
      <ConstellationCanvas opacity={constellationOpacity} />

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
      <header className={`sticky top-0 z-40 px-4 lg:px-6 py-3 ${pr(0)}`}
              style={{ background: "rgba(5, 5, 16, 0.9)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-[1440px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="status-dot online" />
            <h1 className="text-sm font-bold tracking-[0.3em] uppercase text-glow"
                style={{ fontFamily: "var(--font-heading)", color: "#0088FF" }}>
              ATLAS
            </h1>
            <span className="text-xs tracking-[0.15em] uppercase"
                  style={{ fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.40)" }}>
              Mission Control
            </span>
            {refreshing && <div className="refresh-dot ml-2" />}
          </div>

          <div className="flex items-center gap-4">
            <span className="hidden md:block"
                  style={{ fontFamily: "var(--font-mono)", fontSize: "9px", letterSpacing: "0.15em", color: "rgba(255,255,255,0.40)" }}>
              Undeniable Mentoring
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", letterSpacing: "0.15em", color: "rgba(255,255,255,0.40)" }}>
              {clock}
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" className="hidden lg:block">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-px"
             style={{ background: "linear-gradient(90deg, transparent, rgba(0,136,255,0.4), transparent)" }} />
      </header>

      {/* ===== DASHBOARD GRID ===== */}
      <main className="dashboard-grid max-w-[1440px] mx-auto relative z-[2]">

        {/* Row 0: Compact status bar (post-briefing summary) */}
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

        {/* Row 1: Revenue Hero (3 cols) + System Constellation (1 col) */}
        <div className={`revenue-hero ${pr(1)}`} onMouseEnter={sound.playHover}>
          <RevenueHero />
        </div>
        <div className={`system-constellation ${pr(1)}`} onMouseEnter={sound.playHover}>
          <ConstellationNetwork />
        </div>

        {/* Row 2: KPI Cards (6 across) */}
        <div className={`kpi-row ${pr(2)}`}>
          <KpiCard label="Calls Booked" value={overview?.fireflies?.callsThisWeek ?? "—"} subtext="This week" accentClass="kpi-accent-cyan" />
          <KpiCard label="Active Clients" value={overview?.monday?.activeClients ?? "—"} subtext="Monday boards" accentClass="kpi-accent-cyan" />
          <KpiCard label="Daily Ad Spend" value="—" connecting subtext="Meta — Manus handles" accentClass="kpi-accent-amber" />
          <KpiCard label="ROAS" value="—" connecting subtext="Meta — Manus handles" accentClass="kpi-accent-amber" />
          <KpiCard label="Slack Channels" value={overview?.slack?.totalChannels ?? "—"} subtext="Total monitored" accentClass="kpi-accent-white" />
          <KpiCard label="Close Rate" value="—" connecting subtext="GHL pipeline" accentClass="kpi-accent-cyan" />
        </div>

        {/* Row 3-4: Main Panels (4 columns) */}
        <div className={`space-y-5 ${pr(8)}`} onMouseEnter={sound.playHover}>
          <PlaceholderPanel title="Meta Ads" source="Meta Ads dashboard connects when Manus integration is live" tag="growth" />
          <PipelinePanel data={overview?.pipeline} />
        </div>
        <div className={`space-y-5 ${pr(9)}`} onMouseEnter={sound.playHover}>
          <OperationsPanel data={overview?.monday ?? null} />
          <CoachingIntelPanel data={overview?.fireflies ?? null} />
        </div>
        <div className={`space-y-5 ${pr(10)}`} onMouseEnter={sound.playHover}>
          <PlaceholderPanel title="Trend" source="Revenue chart appears when Newie connects" tag="growth" />
          <SystemPerformance />
        </div>
        <div className={`space-y-5 ${pr(11)}`} onMouseEnter={sound.playHover}>
          <ApprovalQueue />
          <AgentActivityFeed />
        </div>
      </main>

      {/* ===== MUTE TOGGLE ===== */}
      <MuteToggle />

      {/* ===== CHAT BAR (fixed bottom) ===== */}
      <AtlasChatBar soundEngine={sound} />
    </div>
  );
}
