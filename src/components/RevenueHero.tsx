"use client";

import { useEffect, useState } from "react";

interface RevenueData {
  totalRevenue: number;
  mrr: number;
  activeSubscribers: number;
  paymentsCount: number;
  currency: string;
}

function formatAUD(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatHeroAmount(amount: number): string {
  return `$${amount.toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default function RevenueHero() {
  const [target, setTarget] = useState(850000);
  const [revenue, setRevenue] = useState<RevenueData | null>(null);

  useEffect(() => {
    fetch("/api/overview")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.revenue) setRevenue(d.revenue);
        if (d?.kpis?.breakTarget) setTarget(d.kpis.breakTarget);
      })
      .catch(() => {});
  }, []);

  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const daysInYear = (now.getFullYear() % 4 === 0) ? 366 : 365;

  const hasData = revenue !== null && revenue.totalRevenue > 0;
  const totalRevenue = revenue?.totalRevenue ?? 0;
  const projectedEOY = hasData ? Math.round((totalRevenue / dayOfYear) * daysInYear) : 0;
  const progressPct = hasData ? Math.min((totalRevenue / target) * 100, 100) : 0;

  return (
    <div className="glass-card hud-corners p-6 lg:p-8 relative overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-3 mb-1">
        <p className="type-section-header">Year-to-Date Revenue</p>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            fontWeight: 600,
            color: "rgba(255,255,255,0.35)",
            letterSpacing: "0.05em",
          }}
        >
          JAN 1 &mdash; NOW
        </span>
      </div>

      {/* Hero amount */}
      <div className="flex items-baseline gap-4 mt-3 mb-1">
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "clamp(44px, 5vw, 64px)",
            fontWeight: 700,
            lineHeight: 1,
            color: hasData ? "#ffffff" : "rgba(255,255,255,0.12)",
            letterSpacing: "-0.02em",
          }}
        >
          {hasData ? formatHeroAmount(totalRevenue) : "\u2014"}
        </p>
        {hasData && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "14px",
              fontWeight: 500,
              color: "rgba(0,200,255,0.6)",
            }}
          >
            AUD
          </span>
        )}
      </div>
      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "rgba(255,255,255,0.40)",
          marginBottom: "20px",
        }}
      >
        {hasData
          ? `${revenue!.paymentsCount} payments \u00B7 ${revenue!.activeSubscribers} active subscribers \u00B7 MRR ${formatAUD(revenue!.mrr)}`
          : "Awaiting first transaction"}
      </p>

      {/* Projected EOM + progress bar */}
      <div style={{ maxWidth: "520px" }}>
        <div className="flex justify-between items-baseline mb-2">
          <span
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.1em",
              color: "rgba(255,255,255,0.25)",
              textTransform: "uppercase",
            }}
          >
            Projected EOY
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "16px",
              fontWeight: 700,
              color: hasData ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.12)",
            }}
          >
            {hasData ? formatAUD(projectedEOY) : "\u2014"}
          </span>
        </div>
        <div className="progress-bar" style={{ height: "6px" }}>
          <div
            className="progress-bar-fill"
            style={{
              width: `${progressPct}%`,
              background: hasData
                ? progressPct >= 100
                  ? "rgba(0,255,136,0.7)"
                  : "rgba(0,136,255,0.6)"
                : "rgba(0,136,255,0.2)",
              transition: "width 1s ease-out",
            }}
          />
        </div>
        <div className="flex justify-between mt-1.5">
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "rgba(255,255,255,0.25)" }}>$0</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "rgba(255,255,255,0.25)" }}>
            {target >= 1_000_000 ? `${(target / 1_000_000).toFixed(1)}M` : `${(target / 1_000).toFixed(0)}K`} TARGET
          </span>
        </div>
      </div>

      {/* Status */}
      <p
        className="mt-4"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "9px",
          letterSpacing: "0.1em",
          color: hasData ? "rgba(0,200,255,0.35)" : "rgba(255,255,255,0.15)",
        }}
      >
        {hasData ? "LIVE \u2014 NEWIE + GHL" : "AWAITING FIRST TRANSACTION"}
      </p>
    </div>
  );
}
