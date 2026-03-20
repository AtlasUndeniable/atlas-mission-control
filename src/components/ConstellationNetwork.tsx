"use client";

import { useEffect, useState, useMemo } from "react";

type ServiceStatus = "online" | "offline" | "degraded" | "checking";

interface HealthMap {
  [key: string]: { status: string; latency_ms: number };
}

const NODES = [
  { id: "ATLAS", x: 200, y: 140, r: 28 },
  { id: "CLAUDE", x: 80, y: 50, r: 18 },
  { id: "SLACK", x: 320, y: 50, r: 18 },
  { id: "GHL", x: 50, y: 160, r: 18 },
  { id: "MONDAY", x: 350, y: 160, r: 18 },
  { id: "FIREFLIES", x: 100, y: 245, r: 18 },
  { id: "CALENDAR", x: 300, y: 245, r: 18 },
];

const SERVICE_MAP: Record<string, string> = {
  ATLAS: "gateway",
  CLAUDE: "gateway",
  SLACK: "slack",
  GHL: "ghl",
  MONDAY: "monday",
  FIREFLIES: "fireflies",
  CALENDAR: "gateway",
};

const STATUS_COLOURS: Record<ServiceStatus, string> = {
  online: "#00FF88",
  offline: "#FF3344",
  degraded: "#FFB800",
  checking: "rgba(255,255,255,0.25)",
};

function generateParticles(count: number) {
  const particles = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: 20 + (i * 137.5) % 360,
      y: 20 + (i * 97.3) % 240,
      delay: (i * 0.7) % 4,
      size: 1 + (i % 3) * 0.5,
    });
  }
  return particles;
}

export default function ConstellationNetwork() {
  const [health, setHealth] = useState<HealthMap>({});
  const [tooltip, setTooltip] = useState<{ id: string; x: number; y: number } | null>(null);
  const particles = useMemo(() => generateParticles(12), []);

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

  function getStatus(nodeId: string): ServiceStatus {
    const key = SERVICE_MAP[nodeId];
    if (!key) return "checking";
    const svc = health[key];
    if (!svc) return "checking";
    return svc.status as ServiceStatus;
  }

  function getLatency(nodeId: string): number {
    const key = SERVICE_MAP[nodeId];
    return health[key]?.latency_ms ?? 0;
  }

  const center = NODES[0];

  return (
    <div className="glass-card hud-corners p-4 relative">
      <div className="flex items-center gap-3 mb-3">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>
          System Constellation
        </p>
        <span className="module-tag module-tag-system">SYSTEM</span>
      </div>
      <svg
        viewBox="0 0 400 280"
        className="w-full h-auto max-h-[240px]"
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Background floating particles */}
        {particles.map((p, i) => (
          <circle
            key={`particle-${i}`}
            cx={p.x}
            cy={p.y}
            r={p.size}
            fill="#0088FF"
            opacity={0}
            className="constellation-particle"
            style={{ animationDelay: `${p.delay}s` }}
          />
        ))}

        {/* Connection lines with flowing dash animation */}
        {NODES.slice(1).map((node) => {
          const status = getStatus(node.id);
          const colour = STATUS_COLOURS[status];
          const isOffline = status === "offline";
          const isOnline = status === "online";
          return (
            <line
              key={`line-${node.id}`}
              x1={center.x}
              y1={center.y}
              x2={node.x}
              y2={node.y}
              stroke={isOnline ? "#0088FF" : colour}
              strokeWidth={0.8}
              className={isOnline ? "constellation-flow" : isOffline ? "constellation-offline" : ""}
              strokeOpacity={isOnline ? 0.5 : 0.15}
            />
          );
        })}

        {/* Nodes */}
        {NODES.map((node) => {
          const status = getStatus(node.id);
          const colour = STATUS_COLOURS[status];
          const isCenter = node.id === "ATLAS";

          return (
            <g
              key={node.id}
              style={{ cursor: "pointer" }}
              className={isCenter ? "atlas-node-breathing" : ""}
              onMouseEnter={() => setTooltip({ id: node.id, x: node.x, y: node.y })}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Pulsing glow rings for ATLAS */}
              {isCenter && (
                <>
                  <circle cx={node.x} cy={node.y} r={node.r + 18}
                    fill="none" stroke="#0088FF" strokeWidth={0.5} className="atlas-glow" />
                  <circle cx={node.x} cy={node.y} r={node.r + 12}
                    fill="none" stroke="#0088FF" strokeWidth={1} className="atlas-glow"
                    style={{ animationDelay: "0.5s" }} />
                  <circle cx={node.x} cy={node.y} r={node.r + 6}
                    fill="none" stroke="#0088FF" strokeWidth={0.5} opacity={0.3}
                    className="constellation-line" />
                  <circle cx={node.x} cy={node.y} r={node.r + 20}
                    fill="url(#atlasRadialGlow)" className="atlas-glow" />
                </>
              )}
              {/* Node circle */}
              <circle
                cx={node.x} cy={node.y} r={node.r}
                fill={isCenter ? "rgba(0, 136, 255, 0.08)" : "rgba(5, 5, 16, 0.9)"}
                stroke={isCenter ? "#0088FF" : "rgba(0, 136, 255, 0.12)"}
                strokeWidth={isCenter ? 1.5 : 0.5}
              />
              {/* Status dot */}
              {!isCenter && (
                <circle cx={node.x + node.r - 4} cy={node.y - node.r + 4} r={4} fill={colour}>
                  {status === "online" && (
                    <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
                  )}
                </circle>
              )}
              {/* Glow behind status dot for online */}
              {!isCenter && status === "online" && (
                <circle cx={node.x + node.r - 4} cy={node.y - node.r + 4} r={6} fill={colour} opacity={0.2} />
              )}
              {/* Label */}
              <text
                x={node.x} y={node.y + 3}
                textAnchor="middle"
                fill={isCenter ? "#0088FF" : "rgba(255,255,255,0.55)"}
                fontSize={isCenter ? 11 : 8}
                fontWeight={isCenter ? 700 : 400}
                fontFamily="var(--font-mono)"
                letterSpacing="0.15em"
              >
                {node.id}
              </text>
            </g>
          );
        })}

        <defs>
          <radialGradient id="atlasRadialGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0088FF" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#0088FF" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Tooltip */}
        {tooltip && (
          <foreignObject x={tooltip.x - 60} y={tooltip.y - 50} width={120} height={40}>
            <div className="tooltip text-center">
              <span style={{ color: "rgba(255,255,255,0.65)" }}>{tooltip.id}</span>
              <span className="ml-2" style={{ color: "#0088FF" }}>{getStatus(tooltip.id)}</span>
              <span className="ml-2 type-data" style={{ color: "rgba(255,255,255,0.40)", fontSize: "9px" }}>{getLatency(tooltip.id)}ms</span>
            </div>
          </foreignObject>
        )}
      </svg>
    </div>
  );
}
