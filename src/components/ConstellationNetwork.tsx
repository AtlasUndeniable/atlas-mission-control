"use client";

import { useEffect, useState } from "react";

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
  online: "#0DFFC6",
  offline: "#FF4D4D",
  degraded: "#FFB224",
  checking: "#8B8FA3",
};

export default function ConstellationNetwork() {
  const [health, setHealth] = useState<HealthMap>({});
  const [tooltip, setTooltip] = useState<{ id: string; x: number; y: number } | null>(null);

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
    <div className="glass-card p-4 h-full fade-in fade-delay-2 relative">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-3"
         style={{ fontFamily: "var(--font-inter)" }}>
        System Constellation
      </p>
      <svg
        viewBox="0 0 400 280"
        className="w-full h-auto"
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Connection lines with flowing dash animation */}
        {NODES.slice(1).map((node) => {
          const status = getStatus(node.id);
          const colour = STATUS_COLOURS[status];
          return (
            <line
              key={`line-${node.id}`}
              x1={center.x}
              y1={center.y}
              x2={node.x}
              y2={node.y}
              stroke={colour}
              strokeWidth={1.5}
              className={status === "online" ? "constellation-flow" : ""}
              strokeOpacity={status === "online" ? 0.5 : 0.15}
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
              onMouseEnter={() => setTooltip({ id: node.id, x: node.x, y: node.y })}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Pulsing glow ring for ATLAS */}
              {isCenter && (
                <>
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r + 14}
                    fill="none"
                    stroke="#0DFFC6"
                    strokeWidth={1}
                    className="atlas-glow"
                  />
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r + 8}
                    fill="none"
                    stroke="#0DFFC6"
                    strokeWidth={0.5}
                    opacity={0.3}
                    className="constellation-line"
                  />
                </>
              )}
              {/* Node circle */}
              <circle
                cx={node.x}
                cy={node.y}
                r={node.r}
                fill={isCenter ? "rgba(13, 255, 198, 0.08)" : "rgba(10, 14, 20, 0.9)"}
                stroke={isCenter ? "#0DFFC6" : "rgba(255,255,255,0.1)"}
                strokeWidth={isCenter ? 1.5 : 0.5}
              />
              {/* Status dot */}
              {!isCenter && (
                <circle
                  cx={node.x + node.r - 4}
                  cy={node.y - node.r + 4}
                  r={4}
                  fill={colour}
                >
                  {status === "online" && (
                    <animate
                      attributeName="opacity"
                      values="1;0.4;1"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  )}
                </circle>
              )}
              {/* Glow behind status dot for online */}
              {!isCenter && status === "online" && (
                <circle
                  cx={node.x + node.r - 4}
                  cy={node.y - node.r + 4}
                  r={6}
                  fill={colour}
                  opacity={0.2}
                />
              )}
              {/* Label */}
              <text
                x={node.x}
                y={node.y + 3}
                textAnchor="middle"
                fill={isCenter ? "#0DFFC6" : "#8B8FA3"}
                fontSize={isCenter ? 11 : 8}
                fontWeight={isCenter ? 700 : 500}
                fontFamily="var(--font-jetbrains)"
                letterSpacing="0.05em"
              >
                {node.id}
              </text>
            </g>
          );
        })}

        {/* Tooltip */}
        {tooltip && (
          <foreignObject
            x={tooltip.x - 60}
            y={tooltip.y - 50}
            width={120}
            height={40}
          >
            <div className="tooltip text-center">
              <span className="text-text-secondary">{tooltip.id}</span>
              <span className="ml-2 text-accent">{getStatus(tooltip.id)}</span>
              <span className="ml-2 text-muted">{getLatency(tooltip.id)}ms</span>
            </div>
          </foreignObject>
        )}
      </svg>
    </div>
  );
}
