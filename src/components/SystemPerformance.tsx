"use client";

import { useEffect, useState } from "react";

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

  const services = Object.entries(health);
  const onlineCount = services.filter(([, v]) => v.status === "online").length;
  const totalCount = services.length || 6;

  return (
    <div className="glass-card p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-4"
         style={{ fontFamily: "var(--font-inter)" }}>
        System Performance
      </p>
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-xs text-text-secondary">Services Online</span>
          <span className={`text-2xl tracking-[0.05em] ${onlineCount === totalCount ? "text-accent" : "text-warning"}`}
                style={{ fontFamily: "var(--font-bebas)" }}>
            {onlineCount}/{totalCount}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-xs text-text-secondary">Model</span>
          <span className="text-sm text-accent" style={{ fontFamily: "var(--font-jetbrains)" }}>
            Sonnet 4.5
          </span>
        </div>

        <div className="border-t border-white/[0.06] pt-3 mt-3">
          <p className="text-[0.65rem] text-muted mb-2 uppercase tracking-[0.1em]">Service Latency</p>
          <div className="space-y-1.5">
            {services.map(([name, svc]) => (
              <div key={name} className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className={`status-dot ${latencyClass(svc.latency_ms)}`} />
                  <span className="text-xs text-text-secondary capitalize">{name.replace("_", " ")}</span>
                </div>
                <span className="text-[0.65rem] text-muted" style={{ fontFamily: "var(--font-jetbrains)" }}>
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
