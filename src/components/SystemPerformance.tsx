"use client";

import { useEffect, useState, useRef } from "react";

interface HealthMap {
  [key: string]: { status: string; latency_ms: number };
}

function latencyColor(ms: number): string {
  if (ms < 100) return "#22C55E";
  if (ms < 500) return "#F59E0B";
  return "#EF4444";
}

function latencyDotClass(ms: number): string {
  if (ms < 100) return "online";
  if (ms < 500) return "degraded";
  return "offline";
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

export default function SystemPerformance() {
  const [health, setHealth] = useState<HealthMap>({});
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set());
  const prevHealth = useRef<HealthMap>({});

  useEffect(() => {
    async function fetchHealth() {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const data = await res.json();
          const changed = new Set<string>();
          for (const [key, val] of Object.entries(data)) {
            const prev = prevHealth.current[key];
            if (prev && (prev as { latency_ms: number }).latency_ms !== (val as { latency_ms: number }).latency_ms) {
              changed.add(key);
            }
          }
          prevHealth.current = data;
          if (changed.size > 0) {
            setFlashKeys(changed);
            setTimeout(() => setFlashKeys(new Set()), 600);
          }
          setHealth(data);
        }
      } catch {}
    }
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  const services = Object.entries(health);
  const onlineCount = services.filter(([, v]) => v.status === "online").length;
  const totalCount = services.length || 7;
  const allOnline = onlineCount === totalCount;

  // Compute average latency
  const avgLatency = services.length > 0
    ? Math.round(services.reduce((sum, [, v]) => sum + v.latency_ms, 0) / services.length)
    : 0;

  // Compute uptime percentage (simple: online/total * 100)
  const uptimePct = totalCount > 0 ? ((onlineCount / totalCount) * 100).toFixed(1) : "0.0";

  return (
    <div className="glass-card hud-corners p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className={`status-dot ${allOnline ? "online" : "degraded"}`} style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header">System Performance</p>
        <span className="module-tag module-tag-system">SYSTEM</span>
        <span
          className="type-data"
          style={{ fontSize: "11px", fontWeight: 600, color: allOnline ? "#22C55E" : "#F59E0B", marginLeft: "auto" }}
        >
          {onlineCount}/{totalCount}
        </span>
      </div>

      {/* Summary metrics */}
      <div className="space-y-0.5 mb-3">
        <MetricRow label="Model" value="Opus 4.6" color="#0088FF" />
        <MetricRow label="Avg Response" value={`${avgLatency}ms`} color={latencyColor(avgLatency)} />
        <MetricRow label="Uptime" value={`${uptimePct}%`} color="#22C55E" />
      </div>

      {/* Service grid */}
      <div className="pt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            fontWeight: 700,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: "#6B7280",
            marginBottom: "8px",
          }}
        >
          Services
        </p>
        <div className="space-y-1">
          {services.map(([name, svc]) => (
            <div key={name} className="flex justify-between items-center py-0.5">
              <div className="flex items-center gap-2">
                <span
                  className={`status-dot ${latencyDotClass(svc.latency_ms)}`}
                  style={{ width: "5px", height: "5px" }}
                />
                <span
                  style={{ fontFamily: "var(--font-body)", fontSize: "11px", color: "rgba(255,255,255,0.75)" }}
                  className="capitalize"
                >
                  {name.replace("_", " ")}
                </span>
              </div>
              <span
                className={`type-data ${flashKeys.has(name) ? "latency-flash" : ""}`}
                style={{ fontSize: "10px", color: "#6B7280" }}
              >
                {svc.latency_ms}ms
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Credit usage placeholder */}
      <div className="pt-3 mt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
        <div className="flex justify-between items-center mb-2">
          <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>API Credits</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "rgba(255,255,255,0.35)" }}>
            &mdash; / &mdash;
          </span>
        </div>
        <div className="progress-bar" style={{ height: "4px" }}>
          <div className="progress-bar-fill" style={{ width: "0%", background: "rgba(0,136,255,0.2)" }} />
        </div>
        <p
          className="mt-1.5"
          style={{ fontFamily: "var(--font-mono)", fontSize: "9px", color: "rgba(255,255,255,0.15)", letterSpacing: "0.08em" }}
        >
          Credit tracking not connected
        </p>
      </div>
    </div>
  );
}
