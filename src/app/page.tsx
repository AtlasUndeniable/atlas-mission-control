"use client";

import { useEffect, useState } from "react";
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
  contacts: unknown;
  slack: {
    totalChannels: number;
  };
}

export default function Dashboard() {
  const [overview, setOverview] = useState<OverviewData | null>(null);

  useEffect(() => {
    async function fetchOverview() {
      try {
        const res = await fetch("/api/overview");
        if (res.ok) setOverview(await res.json());
      } catch {}
    }
    fetchOverview();
    const interval = setInterval(fetchOverview, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen p-4 lg:p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-accent" style={{ boxShadow: "0 0 8px #06b6d4" }} />
          <h1 className="text-lg font-bold tracking-tight">
            <span className="text-accent">ATLAS</span>
            <span className="text-text-secondary ml-2 font-normal">Mission Control</span>
          </h1>
        </div>
        <p className="text-xs font-mono text-text-muted">
          {new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>

      {/* Row 1: Hero Section */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4">
        <div className="lg:col-span-3">
          <RevenueHero />
        </div>
        <div className="lg:col-span-1">
          <ConstellationNetwork />
        </div>
      </div>

      {/* Row 2: KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
        <KpiCard
          label="Calls Booked"
          value={overview?.fireflies?.callsThisWeek ?? "—"}
          subtext="This week"
        />
        <KpiCard
          label="Active Clients"
          value={overview?.monday?.activeClients ?? "—"}
          subtext="Monday boards"
        />
        <KpiCard label="Daily Ad Spend" value="—" connecting subtext="Meta — Manus handles" />
        <KpiCard label="ROAS" value="—" connecting subtext="Meta — Manus handles" />
        <KpiCard
          label="Slack Channels"
          value={overview?.slack?.totalChannels ?? "—"}
          subtext="Total monitored"
        />
        <KpiCard label="Close Rate" value="—" connecting subtext="GHL pipeline" />
      </div>

      {/* Row 3: Main Panels (4 columns, 2 rows) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {/* Column 1 */}
        <div className="space-y-4">
          <PlaceholderPanel title="Meta Ads" source="Manus handles Meta" />
          <PipelinePanel data={overview?.pipeline} />
        </div>

        {/* Column 2 */}
        <div className="space-y-4">
          <OperationsPanel data={overview?.monday ?? null} />
          <CoachingIntelPanel data={overview?.fireflies ?? null} />
        </div>

        {/* Column 3 */}
        <div className="space-y-4">
          <PlaceholderPanel title="Revenue Trend" source="Awaiting Newie integration" />
          <SystemPerformance />
        </div>

        {/* Column 4 */}
        <div className="space-y-4">
          <AgentActivityFeed />
          <PlaceholderPanel title="Pending Approvals" source="No pending approvals" />
        </div>
      </div>

      {/* Row 4: Atlas Chat Bar */}
      <AtlasChatBar />
    </div>
  );
}
