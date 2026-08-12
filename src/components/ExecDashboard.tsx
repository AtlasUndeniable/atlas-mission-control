"use client";

/**
 * Executive board (/exec) — Rhys only.
 *
 * THE BAR (7/13): only metrics that are fresh and right; fewer is better; every
 * tile shows its data's as-of time. Prior dashboards died on stale and wrong
 * numbers, so a feed that cannot prove it is current shows STALE and NO figure.
 * A missing number is recoverable; a confident wrong one is not.
 *
 * All six tiles come from /api/exec/metrics, which reads the local ghl-bridge.
 * The browser never touches GoHighLevel.
 */

import { useCallback, useEffect, useState } from "react";

// ===== types mirroring /api/exec/metrics =====

interface Freshness {
  status: "fresh" | "stale" | "unavailable";
  latestRecordAt: string | null;
  ageDays: number | null;
  thresholdDays: number;
}
interface MonthPoint { month: string; label: string; total: number; count: number; partial: boolean }
interface RangeInfo { key: string; label: string; startDate: string; endDate: string; includesNow: boolean }
interface StageCount { name: string; count: number }
interface PipelineView { id: string; name: string; total: number; stages: StageCount[] }

interface Metrics {
  generatedAt: string;
  timezone: string;
  range: RangeInfo;
  revenue: {
    collected: number; count: number; average: number;
    excluded: { failed: number; refunded: number; testMode: number; nonAud: number };
    latestInRange: string | null; freshness: Freshness;
  } | null;
  trend: { months: MonthPoint[]; windowLabel: string; freshness: Freshness } | null;
  appointments: {
    booked: number; cancelled: number; confirmed: number;
    cancellationRate: number | null; calendarsQueried: number | null; freshness: Freshness;
  } | null;
  pipeline: { pipelines: PipelineView[]; freshness: Freshness } | null;
  unavailable: string[];
  incomplete: string[];
  incompleteDetail: string | null;
}

// ===== formatting (UK/AU) =====

const aud = (n: number) =>
  `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const audShort = (n: number) =>
  n >= 1000 ? `$${Math.round(n / 1000).toLocaleString("en-AU")}k` : `$${Math.round(n)}`;
const num = (n: number) => n.toLocaleString("en-AU");

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}
function dayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

const RANGES: { key: string; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "mtd", label: "Month to date" },
  { key: "ytd", label: "Year to date" },
  { key: "custom", label: "Custom" },
];

/** Metrics deliberately left out of v1, each with the thing that would unlock it. */
const AWAITING: { label: string; unlock: string }[] = [
  { label: "Ad spend, clicks, CTR", unlock: "awaiting Meta access" },
  { label: "Winning and losing creatives", unlock: "awaiting Meta access" },
  { label: "Landing page traffic", unlock: "not available from GHL, needs GA4" },
  { label: "Landing page conversion", unlock: "no denominator available" },
  { label: "Show rate", unlock: "awaiting the No Show stage being used" },
  { label: "MRR", unlock: "no billing interval field in the feed" },
];

// ===== shared tile chrome =====

function FreshnessMark({ f }: { f: Freshness }) {
  if (f.status === "fresh") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span className="status-dot online" />
        <span className="type-timestamp" style={{ color: "rgba(0,255,136,0.55)" }}>
          LIVE
        </span>
      </span>
    );
  }
  if (f.status === "stale") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span className="status-dot degraded" />
        <span className="type-timestamp" style={{ color: "#FFB800" }}>STALE</span>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
      <span className="status-dot offline" />
      <span className="type-timestamp" style={{ color: "#FF3344" }}>NO FEED</span>
    </span>
  );
}

function Tile({
  title, subtitle, freshness, asOf, rangeLabel, children,
}: {
  title: string;
  subtitle?: string;
  freshness?: Freshness;
  asOf: string;
  rangeLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card hud-corners p-5 flex flex-col" style={{ minHeight: "180px" }}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <p className="type-section-header">{title}</p>
          {subtitle && (
            <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.40)", marginTop: "4px" }}>{subtitle}</p>
          )}
        </div>
        {freshness && <FreshnessMark f={freshness} />}
      </div>

      <div className="flex-1 flex flex-col justify-center py-2">{children}</div>

      {/* Every tile states what it covers and when it was read. */}
      <p className="type-timestamp" style={{ marginTop: "10px", lineHeight: 1.5 }}>
        {rangeLabel}
        <br />
        READ AT {asOf}
      </p>
    </div>
  );
}

/**
 * Shown INSTEAD of a figure when a feed answered but could not prove it answered
 * in full. A short answer is not a smaller true number: one rate-limited
 * calendar out of 29 quietly removed 100 appointments from a total that still
 * looked entirely plausible.
 */
function PartialNotice({ detail }: { detail: string | null }) {
  return (
    <div>
      <p style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 700, color: "#FFB800" }}>
        PARTIAL DATA
      </p>
      <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.45)", marginTop: "6px", maxWidth: "36ch" }}>
        {detail ? `${detail}. ` : ""}The figure is withheld because it would be short without saying so.
        Try refreshing.
      </p>
    </div>
  );
}

/** Replaces the figure entirely when a feed cannot prove it is current. */
function StaleNotice({ f }: { f: Freshness }) {
  if (f.status === "unavailable") {
    return (
      <div>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 700, color: "#FF3344" }}>
          NO FEED
        </p>
        <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.45)", marginTop: "6px", maxWidth: "34ch" }}>
          The bridge did not answer, so no figure is shown rather than an old one.
        </p>
      </div>
    );
  }
  return (
    <div>
      <p style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 700, color: "#FFB800" }}>
        STALE since {f.latestRecordAt ? dayMonth(f.latestRecordAt) : "unknown"}
      </p>
      <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.45)", marginTop: "6px", maxWidth: "36ch" }}>
        Nothing new in {f.ageDays} days, past the {f.thresholdDays} day limit. The figure is withheld
        rather than shown as current.
      </p>
    </div>
  );
}

const UNAVAILABLE: Freshness = { status: "unavailable", latestRecordAt: null, ageDays: null, thresholdDays: 7 };

/**
 * One gate in front of every figure. Returns the notice to show INSTEAD of the
 * number, or null when the feed proved it is both complete and current. Order
 * matters: incompleteness is checked first, because an incomplete feed can
 * still look perfectly fresh.
 */
function guard(
  feedKey: string,
  feed: { freshness: Freshness } | null,
  data: Metrics,
): React.ReactNode | null {
  if (data.incomplete?.includes(feedKey)) return <PartialNotice detail={data.incompleteDetail} />;
  if (!feed) return <StaleNotice f={UNAVAILABLE} />;
  if (feed.freshness.status !== "fresh") return <StaleNotice f={feed.freshness} />;
  return null;
}

const bigNumber: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "clamp(28px, 3vw, 40px)",
  fontWeight: 700,
  lineHeight: 1.05,
  letterSpacing: "-0.02em",
  color: "#ffffff",
};
const subLine: React.CSSProperties = {
  fontSize: "11px",
  color: "rgba(255,255,255,0.45)",
  marginTop: "8px",
  lineHeight: 1.6,
};

// ===== page =====

export default function ExecDashboard() {
  const [rangeKey, setRangeKey] = useState("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ range: rangeKey });
      if (rangeKey === "custom") {
        if (!customStart || !customEnd) { setLoading(false); return; }
        qs.set("start", customStart);
        qs.set("end", customEnd);
      }
      const res = await fetch(`/api/exec/metrics?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`metrics request failed (${res.status})`);
      setData((await res.json()) as Metrics);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load metrics");
    } finally {
      setLoading(false);
    }
  }, [rangeKey, customStart, customEnd]);

  // ?range= makes a view linkable. Applied AFTER mount rather than in the
  // useState initialiser: the server renders without a window, so seeding state
  // from the URL during the first render is a hydration mismatch and React keeps
  // the server's markup, leaving the picker highlighting the wrong chip while
  // the figures below it are correct. Setting it here keeps both in step.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("range");
    if (q && RANGES.some((r) => r.key === q)) setRangeKey(q);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const asOf = data ? `${clockTime(data.generatedAt)} ${data.timezone}` : "";
  const rangeLabel = data ? `RANGE ${data.range.label.toUpperCase()}` : "";
  const trendMax = data?.trend ? Math.max(...data.trend!.months.map((m) => m.total), 1) : 1;

  return (
    <main className="ambient-bg min-h-screen p-6 lg:p-8" style={{ position: "relative", zIndex: 1 }}>
      {/* ===== header ===== */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="type-section-header" style={{ fontSize: "13px", color: "rgba(255,255,255,0.85)" }}>
            EXECUTIVE
          </h1>
          <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.40)", marginTop: "6px" }}>
            Live from GoHighLevel. Every tile shows the window it covers and when it was read.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p className="type-timestamp">{data ? `READ AT ${asOf}` : "LOADING"}</p>
          <button
            onClick={() => void load()}
            disabled={loading}
            style={{
              marginTop: "6px", fontFamily: "var(--font-mono)", fontSize: "10px",
              letterSpacing: "0.1em", padding: "5px 12px", borderRadius: "4px",
              border: "1px solid rgba(0,136,255,0.3)", background: "rgba(0,136,255,0.08)",
              color: "rgba(255,255,255,0.75)", cursor: loading ? "wait" : "pointer",
            }}
          >
            {loading ? "REFRESHING" : "REFRESH"}
          </button>
        </div>
      </div>

      {/* ===== range picker ===== */}
      <div className="glass-card p-4 mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="type-section-header" style={{ marginRight: "6px" }}>DATE RANGE</span>
          {RANGES.map((r) => {
            const active = r.key === rangeKey;
            return (
              <button
                key={r.key}
                onClick={() => setRangeKey(r.key)}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.06em",
                  padding: "6px 12px", borderRadius: "4px",
                  border: active ? "1px solid rgba(0,136,255,0.55)" : "1px solid rgba(255,255,255,0.10)",
                  background: active ? "rgba(0,136,255,0.16)" : "transparent",
                  color: active ? "#ffffff" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                }}
              >
                {r.label}
              </button>
            );
          })}
          {rangeKey === "custom" && (
            <span className="flex items-center gap-2" style={{ marginLeft: "6px" }}>
              <input
                type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "11px", padding: "5px 8px",
                  borderRadius: "4px", border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.8)",
                }}
              />
              <span style={{ color: "rgba(255,255,255,0.35)", fontSize: "11px" }}>to</span>
              <input
                type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "11px", padding: "5px 8px",
                  borderRadius: "4px", border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.8)",
                }}
              />
            </span>
          )}
        </div>
        {data && (
          <p className="type-timestamp" style={{ marginTop: "10px" }}>
            SHOWING {data.range.label.toUpperCase()}
            {!data.range.includesNow && "  ·  HISTORICAL RANGE"}
          </p>
        )}
      </div>

      {error && (
        <div className="glass-card p-4 mb-6" style={{ borderColor: "rgba(255,51,68,0.35)" }}>
          <p style={{ color: "#FF3344", fontSize: "12px" }}>Could not load metrics: {error}</p>
        </div>
      )}

      {data && (
        <>
          {/* ===== row 1: money ===== */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
            {/* a. revenue collected */}
            <div className="lg:col-span-2">
              <Tile
                title="Revenue collected"
                subtitle="Succeeded AUD payments, via GoHighLevel"
                freshness={data.revenue?.freshness}
                asOf={asOf}
                rangeLabel={rangeLabel}
              >
                {guard("payments", data.revenue, data) ?? (
                  <div>
                    <p style={{ ...bigNumber, fontSize: "clamp(34px, 4vw, 52px)" }}>
                      {aud(data.revenue!.collected)}
                    </p>
                    <p style={subLine}>
                      {num(data.revenue!.count)} payments in this range.
                      {" "}Excluded: {data.revenue!.excluded.failed} failed,{" "}
                      {data.revenue!.excluded.refunded} refunded,{" "}
                      {data.revenue!.excluded.testMode} test, {data.revenue!.excluded.nonAud} non-AUD.
                    </p>
                  </div>
                )}
              </Tile>
            </div>

            {/* b. payments count + average */}
            <Tile
              title="Payments and average"
              subtitle="Same rule as revenue collected"
              freshness={data.revenue?.freshness}
              asOf={asOf}
              rangeLabel={rangeLabel}
            >
              {guard("payments", data.revenue, data) ?? (
                <div>
                  <p style={bigNumber}>{num(data.revenue!.count)}</p>
                  <p style={subLine}>payments taken</p>
                  <p style={{ ...bigNumber, fontSize: "22px", marginTop: "12px", color: "rgba(0,200,255,0.85)" }}>
                    {aud(data.revenue!.average)}
                  </p>
                  <p style={{ ...subLine, marginTop: "4px" }}>average payment</p>
                </div>
              )}
            </Tile>
          </div>

          {/* ===== row 2: c. revenue trend ===== */}
          <div className="mb-4">
            <Tile
              title="Revenue by month"
              subtitle={`${data.trend?.windowLabel ?? "Last 8 months"}. This chart is fixed to the last 8 months and does not follow the range above.`}
              freshness={data.trend?.freshness}
              asOf={asOf}
              rangeLabel="RANGE LAST 8 CALENDAR MONTHS"
            >
              {guard("trend", data.trend, data) ?? (
                <div className="flex items-end gap-3" style={{ height: "170px", paddingTop: "8px" }}>
                  {data.trend!.months.map((m) => {
                    const h = Math.max((m.total / trendMax) * 130, m.total > 0 ? 3 : 1);
                    return (
                      <div key={m.month} className="flex-1 flex flex-col items-center justify-end" style={{ height: "100%" }}>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)", fontSize: "10px",
                            color: "rgba(255,255,255,0.55)", marginBottom: "6px", whiteSpace: "nowrap",
                          }}
                        >
                          {audShort(m.total)}
                        </span>
                        <div
                          title={`${m.label}: ${aud(m.total)} from ${m.count} payments`}
                          style={{
                            width: "100%", height: `${h}px`, borderRadius: "3px 3px 0 0",
                            background: m.partial
                              ? "repeating-linear-gradient(45deg, rgba(0,136,255,0.35) 0 6px, rgba(0,136,255,0.12) 6px 12px)"
                              : "linear-gradient(180deg, rgba(0,170,255,0.75) 0%, rgba(0,136,255,0.25) 100%)",
                            border: m.partial ? "1px dashed rgba(0,170,255,0.5)" : "none",
                            transition: "height 0.5s ease-out",
                          }}
                        />
                        <span
                          style={{
                            fontFamily: "var(--font-mono)", fontSize: "10px",
                            color: "rgba(255,255,255,0.45)", marginTop: "6px",
                          }}
                        >
                          {m.label}
                        </span>
                        {m.partial && (
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: "8px", color: "rgba(255,184,0,0.75)" }}>
                            SO FAR
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Tile>
          </div>

          {/* ===== row 3: appointments ===== */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {/* d. booked */}
            <Tile
              title="Appointments booked"
              subtitle="Appointments scheduled to start inside this range, across all calendars"
              freshness={data.appointments?.freshness}
              asOf={asOf}
              rangeLabel={rangeLabel}
            >
              {guard("appointments", data.appointments, data) ?? (
                <div>
                  <p style={bigNumber}>{num(data.appointments!.booked)}</p>
                  <p style={subLine}>
                    {num(data.appointments!.confirmed)} confirmed, {num(data.appointments!.cancelled)} cancelled.
                    {data.appointments!.calendarsQueried
                      ? ` Across ${data.appointments!.calendarsQueried} calendars.`
                      : ""}
                  </p>
                </div>
              )}
            </Tile>

            {/* e. cancelled + rate */}
            <Tile
              title="Appointments cancelled"
              subtitle="The one attendance signal that is actually recorded"
              freshness={data.appointments?.freshness}
              asOf={asOf}
              rangeLabel={rangeLabel}
            >
              {guard("appointments", data.appointments, data) ?? (
                <div>
                  <p style={bigNumber}>{num(data.appointments!.cancelled)}</p>
                  <p style={subLine}>
                    {data.appointments!.cancellationRate === null
                      ? "No appointments booked in this range, so there is no rate to show."
                      : `${data.appointments!.cancellationRate}% of ${num(data.appointments!.booked)} booked.`}
                  </p>
                </div>
              )}
            </Tile>
          </div>

          {/* ===== row 4: f. pipeline ===== */}
          <div className="mb-4">
            <Tile
              title="Pipeline by stage"
              subtitle="Where opportunities sit right now. This is a snapshot, not movement over the range."
              freshness={data.pipeline?.freshness}
              asOf={asOf}
              rangeLabel="AS OF NOW, NOT THE SELECTED RANGE"
            >
              {guard("pipeline", data.pipeline, data) ?? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  {data.pipeline!.pipelines.map((p) => {
                    const max = Math.max(...p.stages.map((s) => s.count), 1);
                    return (
                      <div key={p.id}>
                        <div className="flex items-baseline justify-between mb-3">
                          <span className="type-module-tag" style={{ color: "rgba(255,255,255,0.75)" }}>{p.name}</span>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "rgba(255,255,255,0.4)" }}>
                            {num(p.total)}
                          </span>
                        </div>
                        <div className="flex flex-col gap-2">
                          {p.stages.map((s) => (
                            <div key={s.name}>
                              <div className="flex items-baseline justify-between" style={{ marginBottom: "3px" }}>
                                <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.60)" }}>{s.name}</span>
                                <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "rgba(255,255,255,0.85)" }}>
                                  {num(s.count)}
                                </span>
                              </div>
                              <div className="progress-bar">
                                <div
                                  style={{
                                    width: `${(s.count / max) * 100}%`, height: "100%",
                                    background: s.count > 0 ? "rgba(0,136,255,0.55)" : "transparent",
                                    borderRadius: "2px", transition: "width 0.5s ease-out",
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Tile>
          </div>

          {/* ===== deliberately not shown ===== */}
          <div className="glass-card p-5" style={{ opacity: 0.55 }}>
            <p className="type-section-header">Not shown yet</p>
            <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.40)", marginTop: "6px", marginBottom: "14px" }}>
              These are left off on purpose. Each one would need a number that is missing or provably
              wrong, which is how the earlier dashboards lost trust.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {AWAITING.map((a) => (
                <div
                  key={a.label}
                  style={{
                    padding: "10px 12px", borderRadius: "4px",
                    border: "1px dashed rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.02)",
                  }}
                >
                  <p style={{ fontSize: "11px", color: "rgba(255,255,255,0.55)" }}>{a.label}</p>
                  <p className="type-timestamp" style={{ marginTop: "4px" }}>{a.unlock.toUpperCase()}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {!data && loading && (
        <div className="glass-card p-8 text-center">
          <p className="type-timestamp">LOADING LIVE FIGURES</p>
        </div>
      )}
    </main>
  );
}
