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
  online: "#22c55e",
  offline: "#ef4444",
  degraded: "#f59e0b",
  checking: "#64748b",
};

export default function ConstellationNetwork() {
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

  function getStatus(nodeId: string): ServiceStatus {
    const key = SERVICE_MAP[nodeId];
    if (!key) return "checking";
    const svc = health[key];
    if (!svc) return "checking";
    return svc.status as ServiceStatus;
  }

  const center = NODES[0];

  return (
    <div className="glass-card p-4 h-full fade-in">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
        System Constellation
      </h3>
      <svg viewBox="0 0 400 280" className="w-full h-auto">
        {/* Connection lines from center to each node */}
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
              className={status === "online" ? "constellation-line" : ""}
              strokeOpacity={status === "online" ? 0.6 : 0.2}
            />
          );
        })}

        {/* Nodes */}
        {NODES.map((node) => {
          const status = getStatus(node.id);
          const colour = STATUS_COLOURS[status];
          const isCenter = node.id === "ATLAS";

          return (
            <g key={node.id}>
              {/* Glow for center */}
              {isCenter && (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.r + 8}
                  fill="none"
                  stroke="#06b6d4"
                  strokeWidth={1}
                  opacity={0.3}
                  className="constellation-line"
                />
              )}
              {/* Node circle */}
              <circle
                cx={node.x}
                cy={node.y}
                r={node.r}
                fill={isCenter ? "rgba(6, 182, 212, 0.15)" : "rgba(15, 20, 35, 0.9)"}
                stroke={isCenter ? "#06b6d4" : "rgba(255,255,255,0.15)"}
                strokeWidth={isCenter ? 2 : 1}
              />
              {/* Status dot */}
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
              {/* Label */}
              <text
                x={node.x}
                y={node.y + 3}
                textAnchor="middle"
                fill={isCenter ? "#06b6d4" : "#94a3b8"}
                fontSize={isCenter ? 11 : 9}
                fontWeight={isCenter ? 700 : 500}
                fontFamily="var(--font-mono)"
              >
                {node.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
