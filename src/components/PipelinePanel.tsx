"use client";

import { useEffect, useState, useRef } from "react";

// ===== TYPES =====
interface PipelineStageData {
  id: string;
  name: string;
  count: number;
  value: number;
}

interface PipelineData {
  id: string;
  name: string;
  stages: PipelineStageData[];
  totalOpportunities: number;
  totalValue: number;
}

interface PipelinesResponse {
  pipelines: PipelineData[];
  summary: {
    totalPipelines: number;
    totalOpportunities: number;
    totalValue: number;
    totalStages: number;
  };
  fetchedAt: number;
}

// ===== LEGACY TYPES (from overview prop) =====
interface LegacyStage {
  name: string;
  count?: number;
  id?: string;
}

interface LegacyPipeline {
  name: string;
  id?: string;
  stages: LegacyStage[];
  totalOpportunities?: number;
}

// ===== HELPERS =====
function formatValue(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  if (value > 0) return `$${value.toLocaleString()}`;
  return "$0";
}

function MetricRow({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: 600, color: color || "#FFFFFF" }}>
        {value}
      </span>
    </div>
  );
}

const SHORT_NAMES: Record<string, string> = {
  "lead magnet": "Lead",
  "new lead (partial)": "New Lead",
  enquired: "Enquired",
  "booked triage": "Triage",
  "booked launch": "Launch",
  "booked ia": "Booked",
  pending: "Pending",
  "closed deal": "Closed",
  "no sale": "No Sale",
  onboarding: "Onboard",
  "first 12 weeks": "12 Wk",
  "reoccurring client": "Active",
  "new booking": "New Book",
  closed: "Closed",
  reminders: "Remind",
  "payment made": "Paid",
  "contract signed": "Signed",
  "clarity call": "Clarity",
  "executive private": "Exec",
};

function shortName(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(SHORT_NAMES)) {
    if (lower.startsWith(key)) return val;
  }
  return name.length > 8 ? name.slice(0, 7) + "." : name;
}

// ===== CONVERT LEGACY PROP TO INTERNAL FORMAT =====
function convertLegacyData(data: unknown): PipelineData[] | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const raw = (d.pipelines || d) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  return raw.map((p: unknown) => {
    const pObj = p as LegacyPipeline;
    const stages = (pObj.stages || []).map((s: LegacyStage) => ({
      id: s.id || "",
      name: String(s.name || "Unknown"),
      count: typeof s.count === "number" ? s.count : 0,
      value: 0,
    }));
    return {
      id: pObj.id || "",
      name: String(pObj.name || "Pipeline"),
      stages,
      totalOpportunities: typeof pObj.totalOpportunities === "number" ? pObj.totalOpportunities : 0,
      totalValue: 0,
    };
  });
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ===== COMPONENT =====
export default function PipelinePanel({ data: propData }: { data: unknown }) {
  const [liveData, setLiveData] = useState<PipelinesResponse | null>(null);
  const lastFetchRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchPipelines() {
      const now = Date.now();
      // Skip if cached data is fresh
      if (now - lastFetchRef.current < CACHE_TTL && liveData) return;

      try {
        const res = await fetch("/api/pipelines", { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json?.pipelines) {
          setLiveData(json);
          lastFetchRef.current = Date.now();
        }
      } catch {
        // Bridge unreachable — keep showing whatever we have
      }
    }

    fetchPipelines();
    const interval = setInterval(fetchPipelines, CACHE_TTL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Use live data if available, fall back to overview prop, then empty
  const pipelines: PipelineData[] =
    liveData?.pipelines ??
    convertLegacyData(propData) ??
    [];

  const hasLiveData = !!liveData?.pipelines;

  if (pipelines.length === 0) {
    return (
      <div className="glass-card hud-corners p-5">
        <div className="flex items-center gap-3 mb-4">
          <span className="status-dot degraded" style={{ width: "6px", height: "6px" }} />
          <p className="type-section-header">Pipeline</p>
          <span className="module-tag module-tag-growth">GROWTH</span>
        </div>
        <div className="flex flex-col items-center justify-center py-6">
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "36px",
              fontWeight: 700,
              color: "rgba(255,255,255,0.1)",
              marginBottom: "12px",
            }}
          >
            &mdash;
          </p>
          <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#6B7280", fontStyle: "italic" }}>
            Awaiting GHL pipeline data
          </p>
        </div>
      </div>
    );
  }

  const mainPipeline = pipelines.find((p) => p.name === "SALES") || pipelines[0];
  const totalOpps = liveData?.summary?.totalOpportunities ?? pipelines.reduce((sum, p) => sum + p.totalOpportunities, 0);
  const totalValue = liveData?.summary?.totalValue ?? pipelines.reduce((sum, p) => sum + p.totalValue, 0);
  const stageCount = mainPipeline.stages.length;
  const maxCount = Math.max(...mainPipeline.stages.map((s) => s.count), 1);

  return (
    <div className="glass-card hud-corners p-5">
      <div className="flex items-center gap-3 mb-2">
        <span className="status-dot online" style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header">Pipeline</p>
        <span className="module-tag module-tag-growth">GROWTH</span>
      </div>

      {/* Aggregate metrics */}
      <div className="mb-4 space-y-0.5">
        <MetricRow label="Active Opportunities" value={totalOpps} color="#0088FF" />
        {hasLiveData && totalValue > 0 && (
          <MetricRow label="Pipeline Value" value={formatValue(totalValue)} color="#00FF88" />
        )}
        <MetricRow label="Pipelines" value={pipelines.length} />
        <MetricRow label="Stages" value={stageCount} />
      </div>

      {/* Funnel visualisation */}
      <div className="pt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            color: "#6B7280",
            marginBottom: "12px",
            letterSpacing: "0.05em",
          }}
        >
          {mainPipeline.name}
        </p>
        <div className="flex gap-1.5 overflow-x-auto">
          {mainPipeline.stages.map((stage, i) => {
            const count = stage.count;
            const barHeight = count > 0 ? Math.max(20, (count / maxCount) * 48) : 4;
            const opacity = 1 - (i / mainPipeline.stages.length) * 0.5;
            return (
              <div key={stage.id || i} className="flex-1 min-w-0 text-center" title={`${stage.name}: ${count} opps${stage.value > 0 ? ` · ${formatValue(stage.value)}` : ""}`}>
                <p
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "13px",
                    fontWeight: 700,
                    color: count > 0 ? "#FFFFFF" : "rgba(255,255,255,0.15)",
                    marginBottom: "4px",
                  }}
                >
                  {count}
                </p>
                <div
                  style={{
                    height: `${barHeight}px`,
                    background: `rgba(0, 136, 255, ${opacity * 0.3})`,
                    borderRadius: "3px",
                    marginBottom: "6px",
                    transition: "height 0.5s ease",
                  }}
                />
                <p
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "9px",
                    color: "#9CA3AF",
                    lineHeight: 1.2,
                  }}
                >
                  {shortName(stage.name)}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Other pipelines */}
      {pipelines.length > 1 && (
        <div className="pt-3 mt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
          {pipelines
            .filter((p) => p.name !== mainPipeline.name)
            .map((p) => (
              <div key={p.id || p.name} className="flex justify-between items-center py-1">
                <span
                  style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.75)" }}
                  className="truncate"
                >
                  {p.name}
                </span>
                <div className="flex items-center gap-3">
                  {hasLiveData && p.totalValue > 0 && (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#00FF88" }}>
                      {formatValue(p.totalValue)}
                    </span>
                  )}
                  <span className="type-data" style={{ fontSize: "11px", color: "#6B7280" }}>
                    {p.totalOpportunities} leads
                  </span>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
