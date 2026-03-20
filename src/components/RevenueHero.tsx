"use client";

export default function RevenueHero() {
  return (
    <div className="glass-card hud-corners hero-gradient-border p-8 lg:p-10 relative overflow-hidden revenue-glow" style={{ minHeight: 200 }}>
      {/* Watermark logo at 3% opacity */}
      <div
        className="absolute top-4 right-4 w-20 h-20 opacity-[0.03]"
        style={{
          backgroundImage: "url(https://d2xsxph8kpxj0f.cloudfront.net/310519663188771024/XmxQSFnpPg3J5HZeRBxZ5e/transparentwhiteundeniable_411fb48a.png)",
          backgroundSize: "contain",
          backgroundRepeat: "no-repeat",
        }}
      />

      <div className="flex items-center gap-3 mb-6">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>Revenue</p>
        <span className="module-tag module-tag-growth">GROWTH</span>
      </div>

      {/* Big revenue number placeholder */}
      <p style={{
        fontFamily: "var(--font-mono)",
        fontSize: "clamp(48px, 5vw, 72px)",
        fontWeight: 700,
        lineHeight: 1,
        color: "#6B7280",
        letterSpacing: "0.03em",
        marginBottom: "16px",
      }}>
        —
      </p>
      <span className="type-data" style={{ fontSize: "16px", color: "#6B7280" }}>MTD</span>

      <div className="flex gap-10 mt-6 mb-6">
        <div>
          <span style={{ fontFamily: "var(--font-body)", fontSize: "13px", color: "#9CA3AF" }}>Projected: </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "13px", color: "#6B7280" }}>—</span>
        </div>
        <div>
          <span style={{ fontFamily: "var(--font-body)", fontSize: "13px", color: "#9CA3AF" }}>Target: </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "13px", color: "#6B7280" }}>—</span>
        </div>
      </div>

      <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.1em", color: "#6B7280", fontStyle: "italic" }}>
        Revenue tracking activates when Newie connects
      </p>
    </div>
  );
}
