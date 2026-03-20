"use client";

export default function RevenueHero() {
  return (
    <div className="glass-card p-6 fade-in pulse-border">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-4">
        Revenue
      </h3>
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-4xl font-bold font-mono text-text-muted">$—</span>
        <span className="text-sm text-text-muted">MTD</span>
      </div>
      <div className="flex gap-6 text-sm">
        <div>
          <span className="text-text-muted">Projected: </span>
          <span className="font-mono text-text-muted">—</span>
        </div>
        <div>
          <span className="text-text-muted">Target: </span>
          <span className="font-mono text-text-muted">—</span>
        </div>
      </div>
      <p className="text-xs text-text-muted mt-3">Connecting... Awaiting Newie integration</p>
    </div>
  );
}
