"use client";

export default function RevenueTrendPanel() {
  return (
    <div className="glass-card hud-corners p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className="status-dot degraded" style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header">Revenue Trend</p>
      </div>

      {/* Empty state — no fake chart */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "110px",
          borderRadius: "6px",
          border: "1px dashed rgba(255,255,255,0.06)",
        }}
      >
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            color: "rgba(255,255,255,0.20)",
            letterSpacing: "0.05em",
            textAlign: "center",
          }}
        >
          Revenue tracking coming soon
        </p>
      </div>

      <p
        className="mt-3"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "9px",
          color: "rgba(255,255,255,0.15)",
          letterSpacing: "0.1em",
          textAlign: "center",
        }}
      >
        PENDING &mdash; ACTIVATES WITH NEWIE
      </p>
    </div>
  );
}
