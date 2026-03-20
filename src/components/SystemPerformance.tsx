"use client";

import { useEffect, useState, useRef } from "react";

interface HealthMap {
  [key: string]: { status: string; latency_ms: number };
}

function latencyClass(ms: number): string {
  if (ms < 100) return "online";
  if (ms < 500) return "degraded";
  return "offline";
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

  return (
    <div className="glass-card hud-corners p-6">
      <div className="flex items-center gap-3 mb-4">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>
          System Performance
        </p>
        <span className="module-tag module-tag-system">SYSTEM</span>
      </div>
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <span className={`status-dot ${allOnline ? "online" : "degraded"}`} />
            <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>Services Online</span>
          </div>
          <span className="type-data" style={{ fontSize: "28px", fontWeight: 700, color: allOnline ? "#22C55E" : "#F59E0B" }}>
            {onlineCount}/{totalCount}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>Model</span>
          <span className="type-data" style={{ fontSize: "13px", fontWeight: 600, color: "#0088FF" }}>
            Opus 4.6
          </span>
        </div>

        <div className="pt-4 mt-4" style={{ borderTop: "1px solid rgba(0,136,255,0.1)" }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#6B7280", marginBottom: "12px" }}>Service Latency</p>
          <div className="space-y-2">
            {services.map(([name, svc]) => (
              <div key={name} className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className={`status-dot ${latencyClass(svc.latency_ms)}`} />
                  <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.75)" }} className="capitalize">{name.replace("_", " ")}</span>
                </div>
                <span
                  className={`type-data ${flashKeys.has(name) ? "latency-flash" : ""}`}
                  style={{ fontSize: "11px", color: "#9CA3AF" }}
                >
                  {svc.latency_ms}ms
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
