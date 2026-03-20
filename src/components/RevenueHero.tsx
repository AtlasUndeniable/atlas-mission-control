"use client";

export default function RevenueHero() {
  return (
    <div className="glass-card hero-gradient-border p-6 lg:p-8 h-full relative overflow-hidden fade-in fade-delay-1">
      {/* Watermark logo at 3% opacity */}
      <div
        className="absolute top-4 right-4 w-20 h-20 opacity-[0.03]"
        style={{
          backgroundImage: "url(https://d2xsxph8kpxj0f.cloudfront.net/310519663188771024/XmxQSFnpPg3J5HZeRBxZ5e/transparentwhiteundeniable_411fb48a.png)",
          backgroundSize: "contain",
          backgroundRepeat: "no-repeat",
        }}
      />

      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-4"
         style={{ fontFamily: "var(--font-inter)" }}>
        Revenue
      </p>

      {/* Shimmer skeleton for the big number */}
      <div className="flex items-baseline gap-3 mb-3">
        <div className="shimmer inline-block" style={{ width: 220, height: 52 }} />
        <span className="text-sm text-muted">MTD</span>
      </div>

      <div className="flex gap-8 text-sm mb-4">
        <div>
          <span className="text-muted">Projected: </span>
          <div className="shimmer inline-block align-middle" style={{ width: 80, height: 16 }} />
        </div>
        <div>
          <span className="text-muted">Target: </span>
          <div className="shimmer inline-block align-middle" style={{ width: 80, height: 16 }} />
        </div>
      </div>

      <p className="text-xs text-muted connecting-pulse">
        Revenue tracking activates when Newie connects
      </p>
    </div>
  );
}
