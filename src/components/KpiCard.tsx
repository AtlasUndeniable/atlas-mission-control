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
  return (
    <div className={`glass-card hud-corners p-6 ${accentClass} ${connecting ? "pulse-border" : ""}`} style={{ position: "relative" }}>
      {/* Change indicator or "Awaiting" badge — top right */}
      {change !== undefined && (
        <div style={{ position: "absolute", top: "12px", right: "12px" }}>
          <ChangeBadge change={change} />
        </div>
      )}
      {connecting && (
        <div style={{ position: "absolute", top: "12px", right: "12px" }}>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            letterSpacing: "0.1em",
            padding: "3px 8px",
            borderRadius: "4px",
            background: "rgba(245,158,11,0.08)",
            color: "#F59E0B",
            border: "1px solid rgba(245,158,11,0.15)",
            fontWeight: 600,
          }}>
            AWAITING
          </span>
        </div>
      )}

      <p style={{
        fontFamily: "var(--font-heading)",
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.15em",
        textTransform: "uppercase",
        color: "#9CA3AF",
        marginBottom: "12px",
      }}>
        {label}
      </p>

      {connecting ? (
        <div>
          <p style={{
            fontFamily: "var(--font-mono)",
            fontSize: "clamp(32px, 3vw, 48px)",
            fontWeight: 700,
            lineHeight: 1,
            color: "#6B7280",
            letterSpacing: "0.03em",
          }}>
            —
          </p>
          {subtext && (
            <p className="mt-2" style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280" }}>{subtext}</p>
          )}
        </div>
      ) : (
        <div>
          <p style={{
            fontFamily: "var(--font-mono)",
            fontSize: "clamp(32px, 3vw, 48px)",
            fontWeight: 700,
            lineHeight: 1,
            color: "#FFFFFF",
            letterSpacing: "0.03em",
          }}>
            <AnimatedValue value={value} />
          </p>
          {subtext && (
            <p className="mt-2" style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280" }}>{subtext}</p>
          )}
        </div>
      )}
    </div>
  );
}
