"use client";

interface HeroBriefingProps {
  greeting: string;
  overview: {
    monday?: { activeClients: number };
    fireflies?: { callsThisWeek: number; callsProcessed: number };
    slack?: { totalChannels: number };
  } | null;
  servicesOnline: number;
  servicesTotal: number;
  approvalsCount: number;
  compact?: boolean;
}

export default function HeroBriefing({
  greeting,
  overview,
  servicesOnline,
  servicesTotal,
  approvalsCount,
  compact = false,
}: HeroBriefingProps) {
  const hasData = overview !== null;

  const stats = hasData
    ? [
        `${overview.fireflies?.callsThisWeek ?? 0} calls booked`,
        `${overview.monday?.activeClients ?? 0} active clients`,
        `${servicesOnline}/${servicesTotal} online`,
        approvalsCount === 0
          ? "No approvals pending"
          : `${approvalsCount} approval${approvalsCount > 1 ? "s" : ""} pending`,
      ]
    : null;

  // Compact: small status bar below header
  if (compact) {
    return (
      <div className="hero-briefing py-3 px-2" style={{ display: "flex", alignItems: "baseline", gap: "16px", flexWrap: "wrap" }}>
        <span
          className="hero-greeting-animate"
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "16px",
            fontWeight: 400,
            color: "rgba(255,255,255,0.6)",
            letterSpacing: "0.02em",
          }}
        >
          {greeting ? `${greeting}.` : "\u00A0"}
        </span>
        {hasData && (
          <span
            className="hero-stats-animate"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              color: "rgba(0,136,255,0.5)",
              letterSpacing: "0.02em",
            }}
          >
            {stats!.map((stat, i) => (
              <span key={i}>
                {i > 0 && (
                  <span style={{ margin: "0 8px", opacity: 0.4 }}>&middot;</span>
                )}
                {stat}
              </span>
            ))}
          </span>
        )}
      </div>
    );
  }

  // Full: large hero greeting (used if briefing is skipped)
  return (
    <div className="hero-briefing py-8 px-2">
      <h2
        className="hero-greeting-animate"
        style={{
          fontFamily: "var(--font-heading)",
          fontSize: "clamp(28px, 3vw, 48px)",
          fontWeight: 300,
          letterSpacing: "0.04em",
          color: "#FFFFFF",
          lineHeight: 1.2,
          marginBottom: "12px",
        }}
      >
        {greeting ? `${greeting}.` : "\u00A0"}
      </h2>
      {hasData ? (
        <p
          className="hero-stats-animate"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "clamp(13px, 1.1vw, 16px)",
            color: "rgba(0,136,255,0.6)",
            letterSpacing: "0.02em",
            lineHeight: 1.6,
          }}
        >
          {stats!.map((stat, i) => (
            <span key={i}>
              {i > 0 && (
                <span style={{ margin: "0 10px", opacity: 0.4 }}>&middot;</span>
              )}
              {stat}
            </span>
          ))}
        </p>
      ) : (
        <div className="flex gap-3 hero-stats-animate">
          <div className="shimmer" style={{ width: 400, height: 18, maxWidth: "80%" }} />
        </div>
      )}
    </div>
  );
}
