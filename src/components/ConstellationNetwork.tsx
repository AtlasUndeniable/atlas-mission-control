"use client";

import { useEffect, useState, useMemo, useRef } from "react";

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

// Data transfer pulse: a dot that travels along a connection line
function DataPulse({ x1, y1, x2, y2, delay, dur }: { x1: number; y1: number; x2: number; y2: number; delay: number; dur: number }) {
  return (
    <circle r="2" fill="#0088FF" opacity="0">
      <animateMotion
        path={`M${x1},${y1} L${x2},${y2}`}
        dur={`${dur}s`}
        begin={`${delay}s`}
        repeatCount="indefinite"
      />
      <animate attributeName="opacity" values="0;0.7;0.7;0" dur={`${dur}s`} begin={`${delay}s`} repeatCount="indefinite" />
      <animate attributeName="r" values="1.5;2.5;1.5" dur={`${dur}s`} begin={`${delay}s`} repeatCount="indefinite" />
    </circle>
  );
}

export default function ConstellationNetwork() {
  const [health, setHealth] = useState<HealthMap>({});
  const [tooltip, setTooltip] = useState<{ id: string; x: number; y: number } | null>(null);
  const particles = useMemo(() => generateParticles(12), []);
  const prevHealthRef = useRef<HealthMap>({});

  // Stable pulse seeds per node (so pulses don't re-randomise on re-render)
  const pulseSeeds = useMemo(() => {
    return NODES.slice(1).map((_, i) => ({
      delay1: (i * 2.3) % 5,
      delay2: (i * 3.7 + 1.5) % 7,
      dur1: 1.8 + (i % 3) * 0.4,
      dur2: 2.2 + (i % 4) * 0.3,
    }));
  }, []);

  useEffect(() => {
    async function fetchHealth() {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const data = await res.json();
          prevHealthRef.current = health;
          setHealth(data);
        }
      } catch {}
    }
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#B0B8C4" }}>
          System Constellation
        </p>
        <span className="module-tag module-tag-system">SYSTEM</span>
      </div>
      <svg
        viewBox="0 0 400 280"
        className="w-full h-auto max-h-[240px]"
        onMouseLeave={() => setTooltip(null)}
      >
        <defs>
          <radialGradient id="atlasRadialGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0088FF" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#0088FF" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="nodeGlowGreen" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#00FF88" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#00FF88" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="nodeGlowRed" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FF3344" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#FF3344" stopOpacity="0" />
          </radialGradient>
          {/* Line glow filter */}
          <filter id="lineGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

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

        {/* Connection lines — glow layer (behind) */}
        {NODES.slice(1).map((node) => {
          const status = getStatus(node.id);
          const isOnline = status === "online";
          if (!isOnline) return null;
          return (
            <line
              key={`glow-${node.id}`}
              x1={center.x}
              y1={center.y}
              x2={node.x}
              y2={node.y}
              stroke="#0088FF"
              strokeWidth={3}
              strokeOpacity={0.08}
              filter="url(#lineGlow)"
            />
          );
        })}

        {/* Connection lines — main */}
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
              stroke={isOffline ? colour : "#0088FF"}
              strokeWidth={isOnline ? 1 : 0.6}
              className={isOnline ? "constellation-flow" : isOffline ? "constellation-offline" : ""}
              strokeOpacity={isOnline ? 0.45 : 0.12}
            />
          );
        })}

        {/* Data transfer pulses along connections (online only) */}
        {NODES.slice(1).map((node, i) => {
          const status = getStatus(node.id);
          if (status !== "online") return null;
          const seeds = pulseSeeds[i];
          return (
            <g key={`pulses-${node.id}`}>
              {/* Outbound pulse: ATLAS -> service */}
              <DataPulse
                x1={center.x} y1={center.y}
                x2={node.x} y2={node.y}
                delay={seeds.delay1} dur={seeds.dur1}
              />
              {/* Inbound pulse: service -> ATLAS */}
              <DataPulse
                x1={node.x} y1={node.y}
                x2={center.x} y2={center.y}
                delay={seeds.delay2} dur={seeds.dur2}
              />
            </g>
          );
        })}

        {/* Nodes */}
        {NODES.map((node) => {
          const status = getStatus(node.id);
          const colour = STATUS_COLOURS[status];
          const isCenter = node.id === "ATLAS";
          const isOnline = status === "online";
          const isOffline = status === "offline";

          return (
            <g
              key={node.id}
              style={{ cursor: "pointer" }}
              className={isCenter ? "atlas-node-breathing" : ""}
              onMouseEnter={() => setTooltip({ id: node.id, x: node.x, y: node.y })}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* ATLAS center glow rings */}
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

              {/* Service node ambient glow (green pulse or red pulse) */}
              {!isCenter && (isOnline || isOffline) && (
                <circle
                  cx={node.x} cy={node.y}
                  r={node.r + 8}
                  fill={isOnline ? "url(#nodeGlowGreen)" : "url(#nodeGlowRed)"}
                  className={isOnline ? "node-pulse-green" : "node-pulse-red"}
                />
              )}

              {/* Node ring — colour reflects status */}
              <circle
                cx={node.x} cy={node.y} r={node.r}
                fill={isCenter ? "rgba(0, 136, 255, 0.08)" : "rgba(5, 5, 16, 0.9)"}
                stroke={isCenter ? "#0088FF" : isOnline ? "rgba(0, 255, 136, 0.2)" : isOffline ? "rgba(255, 51, 68, 0.3)" : "rgba(255,255,255,0.08)"}
                strokeWidth={isCenter ? 1.5 : isOffline ? 1 : 0.7}
              />

              {/* Status dot (top-right corner) */}
              {!isCenter && (
                <>
                  {/* Glow behind status dot */}
                  <circle
                    cx={node.x + node.r - 4} cy={node.y - node.r + 4} r={7}
                    fill={colour} opacity={0.15}
                    className={isOnline ? "node-dot-glow" : isOffline ? "node-dot-glow-red" : ""}
                  />
                  <circle cx={node.x + node.r - 4} cy={node.y - node.r + 4} r={4} fill={colour}>
                    {isOnline && (
                      <animate attributeName="opacity" values="1;0.5;1" dur="2.5s" repeatCount="indefinite" />
                    )}
                    {isOffline && (
                      <animate attributeName="opacity" values="1;0.3;1" dur="0.8s" repeatCount="indefinite" />
                    )}
                  </circle>
                </>
              )}

              {/* Label */}
              <text
                x={node.x} y={node.y + 3}
                textAnchor="middle"
                fill={isCenter ? "#0088FF" : isOffline ? "rgba(255,51,68,0.7)" : "rgba(255,255,255,0.55)"}
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

        {/* Tooltip */}
        {tooltip && (
          <foreignObject x={tooltip.x - 60} y={tooltip.y - 50} width={120} height={40}>
            <div className="tooltip text-center">
              <span style={{ color: "rgba(255,255,255,0.65)" }}>{tooltip.id}</span>
              <span className="ml-2" style={{ color: STATUS_COLOURS[getStatus(tooltip.id)] }}>{getStatus(tooltip.id)}</span>
              <span className="ml-2 type-data" style={{ color: "rgba(255,255,255,0.40)", fontSize: "9px" }}>{getLatency(tooltip.id)}ms</span>
            </div>
          </foreignObject>
        )}
      </svg>
    </div>
  );
}
