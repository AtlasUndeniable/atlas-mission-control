"use client";

import { useEffect, useState, useCallback } from "react";
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

export default function Dashboard() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchOverview = useCallback(async () => {
    try {
      setRefreshing(true);
      const res = await fetch("/api/overview");
      if (res.ok) setOverview(await res.json());
    } catch {} finally {
      setTimeout(() => setRefreshing(false), 1000);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 30000);
    return () => clearInterval(interval);
  }, [fetchOverview]);

  return (
    <div className="min-h-screen pb-20">
      {/* ===== HEADER BAR ===== */}
      <header className="sticky top-0 z-40 px-4 lg:px-6 py-3"
              style={{ background: "rgba(10, 14, 20, 0.9)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-[1600px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="status-dot online" />
            <h1 style={{ fontFamily: "var(--font-bebas)" }}
                className="text-xl tracking-[0.08em]">
              <span className="text-accent">ATLAS</span>
              <span className="text-text-secondary ml-2">Mission Control</span>
            </h1>
            {/* SWR refresh indicator */}
            {refreshing && <div className="refresh-dot ml-2" />}
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted hidden md:block">Undeniable Mentoring</span>
            <p className="text-xs text-muted"
               style={{ fontFamily: "var(--font-jetbrains)" }}>
              {new Date().toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
            </p>
          </div>
        </div>
        {/* Accent gradient line */}
        <div className="absolute bottom-0 left-0 right-0 h-px"
             style={{ background: "linear-gradient(to right, #0DFFC6, transparent 60%)" }} />
      </header>

      {/* ===== DASHBOARD CONTENT ===== */}
      <main className="px-4 lg:px-6 pt-4 max-w-[1600px] mx-auto">

        {/* Row 1: Hero + Constellation */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4">
          <div className="lg:col-span-3">
            <RevenueHero />
          </div>
          <div className="lg:col-span-1">
            <ConstellationNetwork />
          </div>
        </div>

        {/* Row 2: KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          <KpiCard
            label="Calls Booked"
            value={overview?.fireflies?.callsThisWeek ?? "—"}
            subtext="This week"
            accentClass="kpi-accent-cyan"
            delay={150}
          />
          <KpiCard
            label="Active Clients"
            value={overview?.monday?.activeClients ?? "—"}
            subtext="Monday boards"
            accentClass="kpi-accent-cyan"
            delay={200}
          />
          <KpiCard
            label="Daily Ad Spend"
            value="—"
            connecting
            subtext="Meta — Manus handles"
            accentClass="kpi-accent-amber"
            delay={250}
          />
          <KpiCard
            label="ROAS"
            value="—"
            connecting
            subtext="Meta — Manus handles"
            accentClass="kpi-accent-amber"
            delay={300}
          />
          <KpiCard
            label="Slack Channels"
            value={overview?.slack?.totalChannels ?? "—"}
            subtext="Total monitored"
            accentClass="kpi-accent-white"
            delay={350}
          />
          <KpiCard
            label="Close Rate"
            value="—"
            connecting
            subtext="GHL pipeline"
            accentClass="kpi-accent-cyan"
            delay={400}
          />
        </div>

        {/* Row 3: Main Panels (4 columns) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          {/* Column 1: Meta Ads + Pipeline */}
          <div className="space-y-4 fade-in fade-delay-7">
            <PlaceholderPanel title="Meta Ads" source="Manus handles Meta" />
            <PipelinePanel data={overview?.pipeline} />
          </div>

          {/* Column 2: Operations + Coaching */}
          <div className="space-y-4 fade-in fade-delay-8">
            <OperationsPanel data={overview?.monday ?? null} />
            <CoachingIntelPanel data={overview?.fireflies ?? null} />
          </div>

          {/* Column 3: Revenue Trend + System Perf */}
          <div className="space-y-4 fade-in fade-delay-9">
            <PlaceholderPanel title="Revenue Trend" source="Awaiting Newie integration" />
            <SystemPerformance />
          </div>

          {/* Column 4: Agent Activity + Approvals */}
          <div className="space-y-4 fade-in fade-delay-10">
            <AgentActivityFeed />
            <PlaceholderPanel
              title="Pending Approvals"
              source=""
              emptyMessage="All clear — nothing needs your approval"
            />
          </div>
        </div>
      </main>

      {/* ===== CHAT BAR (fixed bottom) ===== */}
      <AtlasChatBar />
    </div>
  );
}
