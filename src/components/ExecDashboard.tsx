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

import { useCallback, useEffect, useRef, useState } from "react";
import { captureExecReport, REPORT_PRINT_CSS } from "@/lib/exec-report";
import { createRequestGate, isAbort } from "@/lib/exec-request-gate";
import { deriveViewState } from "@/lib/exec-view-state";

// ===== types mirroring /api/exec/metrics =====

interface Freshness {
  status: "fresh" | "stale" | "unavailable";
  latestRecordAt: string | null;
  ageDays: number | null;
  thresholdDays: number;
}
interface MonthPoint { month: string; label: string; total: number; count: number; partial: boolean }
interface RangeInfo {
  key: string; label: string; startDate: string; endDate: string;
  includesNow: boolean;
  /** The business timezone this range was resolved in. */
  timezone: string;
}
interface StageCount { name: string; count: number }
interface PipelineView { id: string; name: string; total: number; stages: StageCount[] }

export interface Metrics {
  generatedAt: string;
  /** BUSINESS timezone — the one the figures were computed in, and the one
   *  every timestamp below is formatted in. Not the browser's. */
  timezone: string;
  serverTimezone?: string;
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
  recurring: {
    mrr: number | null;
    activeSubscribers: number | null;
    currency: string;
    latestPaymentAt: string | null;
    collectedAllTime: number | null;
    datedCount: number | null;
    undatedCount: number;
    undatedTotal: number;
    /** False while dated rows omit known undated charges. */
    coverageComplete: boolean;
    revenueFreshness: Freshness;
    rosterFreshness: Freshness;
  } | null;
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

/**
 * Timestamps are printed in the BUSINESS timezone that the API reports, never
 * in the browser's.
 *
 * These two formatters previously took no timeZone, so they rendered in
 * whatever zone the device was in, and the header then appended the SERVER's
 * zone string to the result. Opening the board from Los Angeles produced a
 * Los Angeles clock reading labelled "Australia/Melbourne" — the one failure
 * mode most likely to appear during a trip, on the day it matters.
 */
function clockTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", {
    timeZone: tz, hour: "2-digit", minute: "2-digit",
  });
}
function dayMonth(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    timeZone: tz, day: "numeric", month: "short", year: "numeric",
  });
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
  // Newie remains unavailable until source verification.
  { label: "Recurring revenue by period", unlock: "pending source verification" },
  { label: "Combined total revenue", unlock: "held until both lines prove current" },
];

// ===== shared tile chrome =====

/**
 * @param partial Coverage is known to be short even though the feed is current.
 *   A LIVE badge over a figure that silently omits rows is the exact failure
 *   this board exists to prevent, so coverage outranks freshness in the badge.
 */
function FreshnessMark({ f, partial }: { f: Freshness; partial?: boolean }) {
  if (f.status === "fresh" && partial) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
        <span className="status-dot degraded" />
        <span className="type-timestamp" style={{ color: "#FFB800" }}>PARTIAL</span>
      </span>
    );
  }
  if (f.status === "fresh") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
        <span className="status-dot online" />
        <span className="type-timestamp" style={{ color: "rgba(0,255,136,0.62)" }}>
          LIVE
        </span>
      </span>
    );
  }
  if (f.status === "stale") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
        <span className="status-dot degraded" />
        <span className="type-timestamp" style={{ color: "#FFB800" }}>STALE</span>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
      <span className="status-dot offline" />
      <span className="type-timestamp" style={{ color: "#FF3344" }}>NO FEED</span>
    </span>
  );
}

function Tile({
  title, subtitle, freshness, partial, asOf, rangeLabel, children,
}: {
  title: string;
  subtitle?: string;
  freshness?: Freshness;
  partial?: boolean;
  asOf: string;
  rangeLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card hud-corners p-7 lg:p-9 flex flex-col" style={{ minHeight: "260px" }}>
      <div className="flex items-start justify-between gap-5 mb-2">
        <div>
          <p className="type-section-header" style={{ whiteSpace: "normal" }}>{title}</p>
          {subtitle && (
            <p style={{ fontSize: "14px", lineHeight: 1.55, color: "rgba(255,255,255,0.42)", marginTop: "8px", maxWidth: "72ch" }}>
              {subtitle}
            </p>
          )}
        </div>
        {freshness && <FreshnessMark f={freshness} partial={partial} />}
      </div>

      <div className="flex-1 flex flex-col justify-center py-4">{children}</div>

      {/* Every tile states what it covers and when it was read. */}
      <p className="type-timestamp" style={{ marginTop: "18px", lineHeight: 1.7 }}>
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
      <p style={{ fontFamily: "var(--font-mono)", fontSize: "32px", fontWeight: 700, letterSpacing: "-0.01em", color: "#FFB800" }}>
        PARTIAL DATA
      </p>
      <p style={{ fontSize: "15px", lineHeight: 1.6, color: "rgba(255,255,255,0.48)", marginTop: "12px", maxWidth: "48ch" }}>
        {detail ? `${detail}. ` : ""}The figure is withheld because it would be short without saying so.
        Try refreshing.
      </p>
    </div>
  );
}

/** Replaces the figure entirely when a feed cannot prove it is current. */
function StaleNotice({ f, tz }: { f: Freshness; tz: string }) {
  if (f.status === "unavailable") {
    return (
      <div>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "32px", fontWeight: 700, letterSpacing: "-0.01em", color: "#FF3344" }}>
          NO FEED
        </p>
        <p style={{ fontSize: "15px", lineHeight: 1.6, color: "rgba(255,255,255,0.48)", marginTop: "12px", maxWidth: "46ch" }}>
          The bridge did not answer, so no figure is shown rather than an old one.
        </p>
      </div>
    );
  }
  return (
    <div>
      <p style={{ fontFamily: "var(--font-mono)", fontSize: "32px", fontWeight: 700, letterSpacing: "-0.01em", color: "#FFB800" }}>
        STALE since {f.latestRecordAt ? dayMonth(f.latestRecordAt, tz) : "unknown"}
      </p>
      <p style={{ fontSize: "15px", lineHeight: 1.6, color: "rgba(255,255,255,0.48)", marginTop: "12px", maxWidth: "48ch" }}>
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
  if (!feed) return <StaleNotice f={UNAVAILABLE} tz={data.timezone} />;
  if (feed.freshness.status !== "fresh") return <StaleNotice f={feed.freshness} tz={data.timezone} />;
  return null;
}

const bigNumber: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "clamp(44px, 4.2vw, 64px)",
  fontWeight: 700,
  lineHeight: 1.02,
  letterSpacing: "-0.03em",
  color: "#ffffff",
};
const subLine: React.CSSProperties = {
  fontSize: "15px",
  color: "rgba(255,255,255,0.50)",
  marginTop: "14px",
  lineHeight: 1.65,
  maxWidth: "62ch",
};

// ===== page =====

export default function ExecDashboard() {
  const [rangeKey, setRangeKey] = useState("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Only the newest request may paint the board. See exec-request-gate.ts for
   * the failure this prevents; the rule is tested directly against out-of-order
   * resolution in tests/exec-request-gate.test.ts.
   */
  const gate = useRef(createRequestGate());

  const load = useCallback(async () => {
    const { seq, signal } = gate.current.begin();

    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ range: rangeKey });
      if (rangeKey === "custom") {
        if (!customStart || !customEnd) {
          // Nothing to ask for yet. deriveViewState reports this as
          // "needs-input" from the selection itself, so no flag is set here —
          // the banner asks for the missing date rather than implying a
          // failure that never happened.
          if (gate.current.isCurrent(seq)) setLoading(false);
          return;
        }
        qs.set("start", customStart);
        qs.set("end", customEnd);
      }
      const res = await fetch(`/api/exec/metrics?${qs.toString()}`, {
        cache: "no-store", signal,
      });
      // Checked again after every await: the board may have moved on while
      // this response was in flight, and a stale commit is the whole bug.
      if (!gate.current.isCurrent(seq)) return;
      if (!res.ok) throw new Error(`metrics request failed (${res.status})`);
      const next = (await res.json()) as Metrics;
      if (!gate.current.isCurrent(seq)) return;
      setData({ ...next, recurring: null });
    } catch (e) {
      // A superseded read was cancelled on purpose; it is not an error to show.
      if (!gate.current.isCurrent(seq) || isAbort(e)) return;
      setError(e instanceof Error ? e.message : "could not load metrics");
    } finally {
      if (gate.current.isCurrent(seq)) setLoading(false);
    }
  }, [rangeKey, customStart, customEnd]);

  // Do not let an in-flight read commit into an unmounted tree.
  const gateRef = gate;
  useEffect(() => () => gateRef.current.close(), [gateRef]);

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

  // Clock value and zone label now come from the same place: the business
  // timezone the API computed the figures in.
  const asOf = data ? `${clockTime(data.generatedAt, data.timezone)} ${data.timezone}` : "";
  const rangeLabel = data ? `RANGE ${data.range.label.toUpperCase()}` : "";
  /**
   * One derivation drives the picker highlight AND the banner, so the
   * emphasised chip can never describe a different period from the figures.
   * Computed from the payload actually rendered rather than from a flag that
   * could drift from it. See exec-view-state.ts.
   */
  const view = deriveViewState({
    range: data?.range ?? null,
    loading,
    error,
    selection: { rangeKey, customStart, customEnd },
    presetLabel: RANGES.find((r) => r.key === rangeKey)?.label,
  });
  const [report, setReport] = useState<string | null>(null);
  const printable = captureExecReport(data, { loading, error, selection: { rangeKey, customStart, customEnd } });
  const printSource = useRef<string | null>(null);
  printSource.current = report ?? printable;
  useEffect(() => {
    const prepare = () => {
      // Synchronous capture also handles browser menu print/Ctrl+P. The print
      // tree is independent of later React renders or network responses.
      document.getElementById("exec-print-capture")?.remove();
      const node = document.createElement("section");
      node.id = "exec-print-capture";
      node.innerHTML = printSource.current ?? "<h1>Report unavailable</h1><p>Wait for a successful, settled selection before printing.</p>";
      document.body.appendChild(node);
    };
    const cleanup = () => document.getElementById("exec-print-capture")?.remove();
    window.addEventListener("beforeprint", prepare);
    window.addEventListener("afterprint", cleanup);
    return () => { window.removeEventListener("beforeprint", prepare); window.removeEventListener("afterprint", cleanup); cleanup(); };
  }, []);
  const reportDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (report) reportDialog.current?.showModal(); }, [report]);
  const trendMax = data?.trend ? Math.max(...data.trend!.months.map((m) => m.total), 1) : 1;

  return (
    <main className="exec-board ambient-bg min-h-screen p-8 lg:p-12" style={{ position: "relative", zIndex: 1 }}>
      <style>{REPORT_PRINT_CSS}</style>
      <dialog ref={reportDialog} onCancel={() => setReport(null)} onClose={() => setReport(null)} aria-label="Executive report preview" style={{ maxWidth: "900px", width: "95%", maxHeight: "90vh", padding: "24px", color: "#17202a", background: "white" }}>
        <button onClick={() => window.print()}>Print / Save PDF</button>{" "}
        <button onClick={() => { reportDialog.current?.close(); setReport(null); }}>Close report</button>
        <div className="exec-report" dangerouslySetInnerHTML={{ __html: report ?? "" }} />
      </dialog>
      {/* ===== header ===== */}
      <div className="flex flex-wrap items-end justify-between gap-6 mb-9">
        <div>
          <h1
            className="type-section-header"
            style={{ fontSize: "30px", letterSpacing: "0.16em", color: "rgba(255,255,255,0.92)" }}
          >
            EXECUTIVE
          </h1>
          <p style={{ fontSize: "16px", lineHeight: 1.55, color: "rgba(255,255,255,0.45)", marginTop: "12px" }}>
            GoHighLevel figures, with Newie pending verification. Each tile states its period and freshness.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p className="type-timestamp">{data ? `READ AT ${asOf}` : "LOADING"}</p>
          <button disabled={!printable} onClick={() => setReport(printable)} style={{ marginRight: "12px" }} title={printable ? "Open a fixed report of these figures" : "Wait for settled, matching figures"}>Print / Save PDF</button>
          <button
            onClick={() => void load()}
            disabled={loading}
            style={{
              marginTop: "10px", fontFamily: "var(--font-mono)", fontSize: "13px",
              letterSpacing: "0.1em", padding: "10px 20px", borderRadius: "5px",
              border: "1px solid rgba(0,136,255,0.3)", background: "rgba(0,136,255,0.08)",
              color: "rgba(255,255,255,0.75)", cursor: loading ? "wait" : "pointer",
            }}
          >
            {loading ? "REFRESHING" : "REFRESH"}
          </button>
        </div>
      </div>

      {/* ===== range picker ===== */}
      <div className="glass-card p-6 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="type-section-header" style={{ marginRight: "10px" }}>DATE RANGE</span>
          {RANGES.map((r) => {
            // `active` is the period ON SCREEN. `requested` is what was just
            // asked for and is not showing yet — marked as pending, never as
            // active, so the emphasised chip always matches the figures.
            //
            // Both can be true at once, and that case matters: moving from one
            // Custom range to another leaves the same chip holding the rendered
            // period AND the requested one. The chip alone cannot express which
            // dates are which, so it carries the pending marker while the
            // SHOWING line and the banner name both periods explicitly.
            const active = r.key === view.activeChipKey;
            const requested = r.key === view.requestedChipKey;
            return (
              <button
                key={r.key}
                onClick={() => setRangeKey(r.key)}
                aria-current={active ? "true" : undefined}
                data-state={
                  active && requested ? "showing-and-requested"
                    : active ? "showing" : requested ? "requested" : "idle"
                }
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "14px", letterSpacing: "0.06em",
                  padding: "11px 20px", borderRadius: "5px",
                  border: requested
                    ? "1px dashed rgba(255,184,0,0.65)"
                    : active
                      ? "1px solid rgba(0,136,255,0.55)"
                      : "1px solid rgba(255,255,255,0.10)",
                  background: active ? "rgba(0,136,255,0.16)" : "transparent",
                  color: active ? "#ffffff" : requested ? "#FFB800" : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                }}
              >
                {r.label}
                {requested && (
                  <span style={{ marginLeft: "8px", fontSize: "11px", letterSpacing: "0.1em" }}>
                    {view.sync === "pending" ? "LOADING" : view.sync === "needs-input" ? "SET DATES" : "NOT SHOWN"}
                  </span>
                )}
              </button>
            );
          })}
          {rangeKey === "custom" && (
            <span className="flex items-center gap-3" style={{ marginLeft: "10px" }}>
              <input
                type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "14px", padding: "10px 14px",
                  borderRadius: "5px", border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.8)",
                }}
              />
              <span style={{ color: "rgba(255,255,255,0.35)", fontSize: "14px" }}>to</span>
              <input
                type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: "14px", padding: "10px 14px",
                  borderRadius: "5px", border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.8)",
                }}
              />
            </span>
          )}
        </div>
        {data && (
          <p className="type-timestamp" style={{ marginTop: "16px" }}>
            SHOWING {data.range.label.toUpperCase()}
            {!data.range.includesNow && "  ·  HISTORICAL RANGE"}
            {view.showingPrevious && `  ·  REQUESTED ${view.requestedLabel.toUpperCase()}`}
          </p>
        )}
      </div>

      {error && (
        <div className="glass-card p-6 mb-6" style={{ borderColor: "rgba(255,51,68,0.35)" }}>
          <p style={{ color: "#FF3344", fontSize: "15px" }}>Could not load metrics: {error}</p>
        </div>
      )}

      {(loading || view.showingPrevious) && (
        <p role="status" className="mb-4" style={{ fontSize: "14px", color: "#FFB800" }}>
          {loading ? "Loading…" : view.sync === "needs-input" ? "Choose both dates." : "Requested range unavailable."}
          {data ? ` Showing ${data.range.startDate} to ${data.range.endDate} (${data.timezone}).` : " No figures displayed yet."}
        </p>
      )}
      <details className="glass-card p-4 mb-6">
        <summary style={{ cursor: "pointer" }}>Sources and periods</summary>
        <p style={subLine}>Range tiles use the displayed dates in the business timezone. The successful-payments chart is a fixed eight-month window; pipeline is a read-time snapshot. September MTD and completed August are unequal periods. GoHighLevel totals succeeded AUD payments and excludes failed, refunded-status, test and non-AUD payments. Partial refunds and fees are not deducted; these figures are not net collections or bank payouts. Newie collections, MRR and subscriber counts await source verification; private native exports are not dashboard inputs. Combined revenue, leads and won-sales metrics remain unavailable.</p>
      </details>

      {data && (
        <>
          {/* ===== row 1: money ===== */}
          {/*
            Keep the sources separate. A combined total requires fresh
            payment-level overlap reconciliation and verified currency, period,
            payment status and completeness for both sources. Historical overlap
            checks do not establish that current figures can be added.
            No combined total is released here.
          */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            {/* a. successful payments — GHL */}
            <Tile
              title="Successful payments (GoHighLevel)"
              subtitle="Succeeded AUD payments; partial refunds and fees not deducted"
              freshness={data.revenue?.freshness}
              asOf={asOf}
              rangeLabel={rangeLabel}
            >
              {guard("payments", data.revenue, data) ?? (
                <div>
                  <p style={{ ...bigNumber, fontSize: "clamp(36px, 3.2vw, 52px)" }}>
                    {aud(data.revenue!.collected)}
                  </p>
                  <p style={subLine}>
                    {num(data.revenue!.count)} payments in this range.
                    {" "}Excluded: {data.revenue!.excluded.failed} failed,{" "}
                    {data.revenue!.excluded.refunded} refunded-status,{" "}
                    {data.revenue!.excluded.testMode} test, {data.revenue!.excluded.nonAud} non-AUD.
                  </p>
                </div>
              )}
            </Tile>

            <Tile title="Recurring revenue (Newie)" subtitle="Separate business line" asOf={asOf} rangeLabel="PENDING VERIFICATION">
              <p style={{ fontSize: "22px", color: "#FFB800" }}>Unavailable</p>
              <p style={subLine}>Collections, MRR and subscriber count pending verification.</p>
            </Tile>

            {/* b. payments count + average */}
            <Tile
              title="Payments and average"
              subtitle="Same successful-payment criteria"
              freshness={data.revenue?.freshness}
              asOf={asOf}
              rangeLabel={rangeLabel}
            >
              {guard("payments", data.revenue, data) ?? (
                <div>
                  <p style={bigNumber}>{num(data.revenue!.count)}</p>
                  <p style={{ ...subLine, marginTop: "10px" }}>payments taken</p>
                  <p style={{ ...bigNumber, fontSize: "clamp(30px, 2.6vw, 40px)", marginTop: "26px", color: "rgba(0,200,255,0.85)" }}>
                    {aud(data.revenue!.average)}
                  </p>
                  <p style={{ ...subLine, marginTop: "8px" }}>average payment</p>
                </div>
              )}
            </Tile>
          </div>

          {/* ===== row 2: c. successful payments trend ===== */}
          <div className="mb-6">
            <Tile
              title="Successful payments by month"
              subtitle={`${data.trend?.windowLabel ?? "Last 8 months"}. This chart is fixed to the last 8 months and does not follow the range above.`}
              freshness={data.trend?.freshness}
              asOf={asOf}
              rangeLabel="RANGE LAST 8 CALENDAR MONTHS"
            >
              {guard("trend", data.trend, data) ?? (
                <div className="flex items-end gap-5" style={{ height: "300px", paddingTop: "12px" }}>
                  {data.trend!.months.map((m) => {
                    const h = Math.max((m.total / trendMax) * 230, m.total > 0 ? 4 : 1);
                    return (
                      <div key={m.month} className="flex-1 flex flex-col items-center justify-end" style={{ height: "100%" }}>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)", fontSize: "16px", fontWeight: 600,
                            color: "rgba(255,255,255,0.72)", marginBottom: "10px", whiteSpace: "nowrap",
                          }}
                        >
                          {audShort(m.total)}
                        </span>
                        <div
                          title={`${m.label}: ${aud(m.total)} from ${m.count} payments`}
                          style={{
                            width: "100%", height: `${h}px`, borderRadius: "4px 4px 0 0",
                            background: m.partial
                              ? "repeating-linear-gradient(45deg, rgba(0,136,255,0.35) 0 6px, rgba(0,136,255,0.12) 6px 12px)"
                              : "linear-gradient(180deg, rgba(0,170,255,0.75) 0%, rgba(0,136,255,0.25) 100%)",
                            border: m.partial ? "1px dashed rgba(0,170,255,0.5)" : "none",
                            transition: "height 0.5s ease-out",
                          }}
                        />
                        <span
                          style={{
                            fontFamily: "var(--font-mono)", fontSize: "14px",
                            color: "rgba(255,255,255,0.52)", marginTop: "12px",
                          }}
                        >
                          {m.label}
                        </span>
                        {m.partial && (
                          <span
                            style={{
                              fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.1em",
                              color: "rgba(255,184,0,0.8)", marginTop: "4px",
                            }}
                          >
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
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
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
              subtitle="Cancellation status for appointments scheduled in this range. Attendance is not verified."
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
          <div className="mb-6">
            <Tile
              title="Pipeline by stage"
              subtitle="Where opportunities sit right now. This is a snapshot, not movement over the range."
              freshness={data.pipeline?.freshness}
              asOf={asOf}
              rangeLabel="AS OF NOW, NOT THE SELECTED RANGE"
            >
              {guard("pipeline", data.pipeline, data) ?? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
                  {data.pipeline!.pipelines.map((p) => {
                    const max = Math.max(...p.stages.map((s) => s.count), 1);
                    return (
                      <div key={p.id}>
                        <div
                          className="flex items-baseline justify-between mb-5"
                          style={{ paddingBottom: "10px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}
                        >
                          <span className="type-module-tag" style={{ color: "rgba(255,255,255,0.80)" }}>{p.name}</span>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: "15px", color: "rgba(255,255,255,0.45)" }}>
                            {num(p.total)}
                          </span>
                        </div>
                        <div className="flex flex-col gap-4">
                          {p.stages.map((s) => (
                            <div key={s.name}>
                              <div className="flex items-baseline justify-between gap-4" style={{ marginBottom: "7px" }}>
                                <span style={{ fontSize: "15px", color: "rgba(255,255,255,0.66)" }}>{s.name}</span>
                                <span style={{ fontFamily: "var(--font-mono)", fontSize: "17px", fontWeight: 600, color: "rgba(255,255,255,0.92)" }}>
                                  {num(s.count)}
                                </span>
                              </div>
                              <div className="progress-bar" style={{ height: "7px", borderRadius: "3px" }}>
                                <div
                                  style={{
                                    width: `${(s.count / max) * 100}%`, height: "100%",
                                    background: s.count > 0 ? "rgba(0,136,255,0.55)" : "transparent",
                                    borderRadius: "3px", transition: "width 0.5s ease-out",
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
          <div className="glass-card p-7 lg:p-9" style={{ opacity: 0.6 }}>
            <p className="type-section-header">Not shown yet</p>
            <p style={{ fontSize: "14px", lineHeight: 1.6, color: "rgba(255,255,255,0.42)", marginTop: "10px", marginBottom: "24px", maxWidth: "80ch" }}>
              These are left off on purpose. Each one would need a number that is missing or provably
              wrong, which is how the earlier dashboards lost trust.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
              {AWAITING.map((a) => (
                <div
                  key={a.label}
                  style={{
                    padding: "18px 20px", borderRadius: "5px",
                    border: "1px dashed rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.02)",
                  }}
                >
                  <p style={{ fontSize: "15px", color: "rgba(255,255,255,0.58)" }}>{a.label}</p>
                  <p className="type-timestamp" style={{ marginTop: "8px" }}>{a.unlock.toUpperCase()}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

    </main>
  );
}
