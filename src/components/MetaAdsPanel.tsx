"use client";

const METRICS = [
  { label: "CTR", placeholder: "Awaiting Meta connection" },
  { label: "CPL", placeholder: "Awaiting Meta connection" },
  { label: "Conversions", placeholder: "Awaiting Meta connection" },
  { label: "Active Campaigns", placeholder: "Awaiting Meta connection" },
  { label: "Ad Sets", placeholder: "Awaiting Meta connection" },
  { label: "Frequency", placeholder: "Awaiting Meta connection" },
  { label: "Impressions (7D)", placeholder: "Awaiting Meta connection" },
  { label: "Reach (7D)", placeholder: "Awaiting Meta connection" },
];

export default function MetaAdsPanel() {
  return (
    <div className="glass-card hud-corners p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className="status-dot degraded" style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header">Meta Ads</p>
        <span className="module-tag module-tag-meta-ops">META-OPS</span>
      </div>

      <div className="space-y-3">
        {METRICS.map((m) => (
          <div key={m.label} className="flex justify-between items-center">
            <span
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "12px",
                color: "#9CA3AF",
              }}
            >
              {m.label}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "13px",
                fontWeight: 600,
                color: "rgba(255,255,255,0.15)",
              }}
            >
              {m.placeholder}
            </span>
          </div>
        ))}
      </div>

      <p
        className="mt-4 pt-3"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "9px",
          color: "rgba(255,255,255,0.18)",
          letterSpacing: "0.1em",
          textAlign: "center",
          borderTop: "1px solid rgba(0,136,255,0.06)",
        }}
      >
        AWAITING META CONNECTION
      </p>
    </div>
  );
}
