"use client";

import { useCountUp } from "@/hooks/useCountUp";

interface KpiCardProps {
  label: string;
  value: string | number;
  change?: number;
  connecting?: boolean;
  subtext?: string;
  accentClass?: string;
}

function AnimatedValue({ value }: { value: string | number }) {
  const numericValue = typeof value === "number" ? value : 0;
  const isNumeric = typeof value === "number";
  const counted = useCountUp(numericValue);

  if (!isNumeric) {
    return <>{value}</>;
  }

  return <>{counted}</>;
}

function ChangeBadge({ change }: { change: number }) {
  const isPositive = change >= 0;
  return (
    <span
      className="type-data"
      style={{
        fontSize: "10px",
        fontWeight: 600,
        padding: "2px 6px",
        borderRadius: "4px",
        background: isPositive ? "rgba(0,255,136,0.1)" : "rgba(255,51,68,0.1)",
        color: isPositive ? "#22C55E" : "#EF4444",
      }}
    >
      {isPositive ? "\u25B2" : "\u25BC"} {Math.abs(change).toFixed(1)}%
    </span>
  );
}

export default function KpiCard({
  label,
  value,
  change,
  connecting,
  subtext,
  accentClass = "kpi-accent-cyan",
}: KpiCardProps) {
  const isDash = value === "—" || value === "";

  return (
    <div className={`glass-card hud-corners p-5 ${accentClass}`} style={{ position: "relative" }}>
      {/* Change indicator — top right */}
      {change !== undefined && (
        <div style={{ position: "absolute", top: "10px", right: "10px" }}>
          <ChangeBadge change={change} />
        </div>
      )}

      <p style={{
        fontFamily: "var(--font-heading)",
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.15em",
        textTransform: "uppercase",
        color: "#B0B8C4",
        marginBottom: "8px",
      }}>
        {label}
      </p>

      <p style={{
        fontFamily: "var(--font-mono)",
        fontSize: "42px",
        fontWeight: 700,
        lineHeight: 1,
        color: isDash ? "#374151" : "#FFFFFF",
        letterSpacing: "-0.02em",
        marginBottom: "6px",
      }}>
        {connecting ? (
          <span className="connecting-pulse">—</span>
        ) : (
          <AnimatedValue value={value} />
        )}
      </p>
      {subtext && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280", letterSpacing: "0.05em" }}>{subtext}</p>
      )}
    </div>
  );
}
