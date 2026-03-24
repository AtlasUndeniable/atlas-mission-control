"use client";

export default function RevenueHero() {
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  return (
    <div className="glass-card hud-corners p-6 lg:p-8 relative overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-3 mb-1">
        <p className="type-section-header">Month-to-Date Revenue</p>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            fontWeight: 600,
            color: "rgba(255,255,255,0.35)",
            letterSpacing: "0.05em",
          }}
        >
          DAY {dayOfMonth} OF {daysInMonth}
        </span>
      </div>

      {/* Pending state — no fake numbers */}
      <div className="flex items-baseline gap-4 mt-3 mb-1">
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "clamp(44px, 5vw, 64px)",
            fontWeight: 700,
            lineHeight: 1,
            color: "rgba(255,255,255,0.12)",
            letterSpacing: "-0.02em",
          }}
        >
          &mdash;
        </p>
      </div>
      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "rgba(255,255,255,0.40)",
          marginBottom: "20px",
        }}
      >
        Connecting revenue sources
      </p>

      {/* Projected EOM — hidden when no data */}
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
            Projected EOM
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "16px",
              fontWeight: 700,
              color: "rgba(255,255,255,0.12)",
            }}
          >
            &mdash;
          </span>
        </div>
        <div className="progress-bar" style={{ height: "6px" }}>
          <div
            className="progress-bar-fill"
            style={{ width: "0%", background: "rgba(0,136,255,0.2)" }}
          />
        </div>
        <div className="flex justify-between mt-1.5">
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "rgba(255,255,255,0.25)" }}>$0</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "rgba(255,255,255,0.25)" }}>
            $850K TARGET
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
          color: "rgba(255,255,255,0.15)",
        }}
      >
        PENDING &mdash; ACTIVATES WITH NEWIE
      </p>
    </div>
  );
}
