"use client";

import { useEffect, useState } from "react";

interface HealthMap {
  [key: string]: { status: string; latency_ms: number };
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
    <div className="glass-card p-4 fade-in">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
        System Performance
      </h3>
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-text-secondary">Services Online</span>
          <span className={`text-sm font-mono font-bold ${onlineCount === totalCount ? "text-success" : "text-warning"}`}>
            {onlineCount}/{totalCount}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-text-secondary">Model</span>
          <span className="text-sm font-mono text-accent">Sonnet 4.5</span>
        </div>
        <div className="border-t border-card-border pt-2 mt-2">
          <p className="text-xs text-text-muted mb-2">Service Latency</p>
          <div className="space-y-1.5">
            {services.map(([name, svc]) => (
              <div key={name} className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className={`status-dot ${svc.status === "online" ? "online" : svc.status === "degraded" ? "degraded" : "offline"}`} />
                  <span className="text-xs text-text-secondary capitalize">{name.replace("_", " ")}</span>
                </div>
                <span className="text-xs font-mono text-text-muted">{svc.latency_ms}ms</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
