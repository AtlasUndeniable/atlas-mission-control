"use client";

interface KpiCardProps {
  label: string;
  value: string | number;
  change?: number;
  connecting?: boolean;
  subtext?: string;
  accentClass?: string;
  delay?: number;
}

export default function KpiCard({
  label,
  value,
  change,
  connecting,
  subtext,
  accentClass = "kpi-accent-cyan",
  delay = 0,
}: KpiCardProps) {
  return (
    <div className={`glass-card p-4 ${accentClass} fade-in ${connecting ? "pulse-border" : ""}`}
         style={{ animationDelay: `${delay}ms` }}>
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-muted mb-2"
         style={{ fontFamily: "var(--font-inter)" }}>
        {label}
      </p>
      {connecting ? (
        <div>
          <div className="shimmer" style={{ width: 100, height: 32, marginBottom: 4 }} />
          {subtext && (
            <p className="text-[0.65rem] text-muted connecting-pulse mt-1">{subtext}</p>
          )}
        </div>
      ) : (
        <div>
          <p className="text-[2.5rem] leading-none tracking-[0.05em] text-text-primary"
             style={{ fontFamily: "var(--font-bebas)" }}>
            {value}
          </p>
          {change !== undefined && (
            <p className={`text-xs mt-1 ${change >= 0 ? "text-accent" : "text-error"}`}
               style={{ fontFamily: "var(--font-jetbrains)", fontSize: "0.7rem" }}>
              {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
            </p>
          )}
          {subtext && (
            <p className="text-[0.65rem] text-muted mt-1">{subtext}</p>
          )}
        </div>
      )}
    </div>
  );
}
