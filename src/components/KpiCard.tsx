"use client";

interface KpiCardProps {
  label: string;
  value: string | number;
  change?: number;
  connecting?: boolean;
  subtext?: string;
}

export default function KpiCard({ label, value, change, connecting, subtext }: KpiCardProps) {
  return (
    <div className={`glass-card p-4 fade-in ${connecting ? "pulse-border" : ""}`}>
      <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
        {label}
      </p>
      {connecting ? (
        <div>
          <p className="text-lg font-mono text-text-muted">Connecting...</p>
          {subtext && (
            <p className="text-xs text-text-muted mt-1">{subtext}</p>
          )}
        </div>
      ) : (
        <div>
          <p className="text-2xl font-bold font-mono text-text-primary">{value}</p>
          {change !== undefined && (
            <p className={`text-xs font-mono mt-1 ${change >= 0 ? "text-success" : "text-error"}`}>
              {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
            </p>
          )}
          {subtext && (
            <p className="text-xs text-text-muted mt-1">{subtext}</p>
          )}
        </div>
      )}
    </div>
  );
}
