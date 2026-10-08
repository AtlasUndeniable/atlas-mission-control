/**
 * /api/exec/metrics — the only data source for the executive board.
 *
 * Everything comes from the local ghl-bridge on :4003. The browser never talks
 * to GoHighLevel: the PIT credential stays server-side, and the bridge already
 * owns the epoch-ms conversion and the 29-calendar fan-out cache that a naive
 * date-picker would otherwise burn the rate limit on.
 *
 * Middleware gates /api/exec to the Rhys credential, so this route is not
 * reachable with the shared operator password.
 *
 * FRESHNESS. Each feed is probed for liveness INDEPENDENTLY of the selected
 * range, because "no records in January" and "this feed stopped in April" look
 * identical if you only read the range. The probes are cached for 5 minutes so
 * asking a liveness question never costs more than one fan-out per feed.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  resolveRange,
  summarisePayments,
  summariseAppointments,
  selectAppointmentsInRange,
  monthlySeries,
  evaluateFreshness,
  fixedTrendWindow,
  DEFAULT_BUSINESS_TIMEZONE,
  FRESHNESS_THRESHOLD_DAYS,
  type RangeKey,
  type Transaction,
  type AppointmentEvent,
} from "@/lib/exec-metrics";

/**
 * Overridable ONLY so the board can be driven from sanitized fixtures during
 * verification. Unset in production, which is every deployment: the default is
 * the same loopback address this route has always used, so behaviour is
 * unchanged unless someone deliberately points it elsewhere.
 */
const BRIDGE = process.env.EXEC_GHL_BRIDGE_URL || "http://127.0.0.1:4003";
const TREND_MONTHS = 8;
const PROBE_TTL_MS = 5 * 60 * 1000;

/**
 * The one timezone every bound, bucket and label on this board resolves in.
 *
 * Previously implicit: date bounds took the host's zone and the page printed
 * the browser's zone while labelling it with the server's. Rhys reads this
 * board while travelling, so "today" has to mean his Melbourne today from any
 * device. Overridable for a meeting run from a different business timezone;
 * it is never taken from the request, because the viewer's location must not
 * silently redefine a business day.
 */
const BUSINESS_TZ = process.env.EXEC_BUSINESS_TIMEZONE || DEFAULT_BUSINESS_TIMEZONE;

/** Pipelines Rhys reads. Matched by id, with a name fallback if an id changes. */
const TARGET_PIPELINES: { id: string; name: string }[] = [
  { id: "QWPWOGrp5uCpgZytIM9j", name: "SALES" },
  { id: "Zo3tl9XzZ3XqHgVYM0BG", name: "Undeniable L1" },
  { id: "hjv5PTAmkIGMxJWf3ZQs", name: "Undeniable L2" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

async function bridge<T>(path: string, timeoutMs: number, base = BRIDGE): Promise<T | null> {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ===== 5-minute probe cache =====
/**
 * @param shouldCache Gate on the RESULT. A failed or incomplete answer must
 *   never be held for the full TTL: that converts a momentary upstream blip
 *   into five minutes of a confidently wrong figure. Observed live before this
 *   guard existed: an 8-month revenue chart frozen with January to May at zero.
 */
const probeCache = new Map<string, { at: number; value: unknown }>();
async function probe<T>(key: string, fn: () => Promise<T>, shouldCache?: (v: T) => boolean): Promise<T> {
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value as T;
  const value = await fn();
  if (!shouldCache || shouldCache(value)) probeCache.set(key, { at: Date.now(), value });
  return value;
}

/** The bridge reports `complete: false` when a fan-out lost a calendar or a
 *  paged read was capped. A short answer is not a smaller true number. */
interface PaymentsResponse {
  data?: Transaction[]; total?: number; totalCount?: number | null;
  complete?: boolean; truncated?: boolean;
}
interface EventsResponse {
  events?: AppointmentEvent[]; total?: number; calendarsQueried?: number;
  calendarsFailed?: number; complete?: boolean; failures?: string[];
}
interface Stage { id: string; name: string; position: number }
interface Pipeline { id: string; name: string; stages: Stage[] }
interface Opportunity { pipelineId: string; pipelineStageId: string; status?: string; lastStageChangeAt?: string }

/** Newest payment the feed holds at all. Transactions come back newest-first. */
function paymentsHeartbeat() {
  return probe("payments-heartbeat", async () => {
    const r = await bridge<PaymentsResponse>("/payments/transactions?limit=1&offset=0", 15_000);
    const row = r?.data?.[0];
    return row?.fulfilledAt ?? row?.createdAt ?? null;
  });
}

/**
 * Newest BOOKING (dateAdded) in a window around now. Appointments are scheduled
 * ahead, so startTime says nothing about whether the feed is alive; dateAdded
 * is when a human actually booked.
 */
function appointmentsHeartbeat(now: Date) {
  return probe("appointments-heartbeat", async () => {
    const from = new Date(now.getTime() - 14 * DAY_MS).toISOString();
    const to = new Date(now.getTime() + 14 * DAY_MS).toISOString();
    const r = await bridge<EventsResponse>(
      `/events?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`, 90_000);
    if (!r?.events) return null;
    return summariseAppointments(r.events).latestBookedAt;
  });
}

/**
 * Pipelines + all opportunities. Heavy (paged), so cached with the probes.
 *
 * COMPLETENESS. /opportunities sends no `complete` flag the way /payments does.
 * It sends two counts, and only one of them is a real check:
 *
 *   total     — the bridge sets this to `all.length`, i.e. the rows it managed
 *               to collect. Comparing it against the row count is vacuous; it
 *               agrees with itself no matter how short the read was.
 *   metaTotal — the count GoHighLevel itself reported for the query. This is
 *               the only independent signal, so it is the one checked here.
 *
 * The bridge's paging loop breaks out on an empty batch, which is also what an
 * upstream error looks like, so a short read is consistent rather than obviously
 * broken. Observed live: reads of 1,019 and 950 SALES opportunities against a
 * true 2,024, each rendered as a complete, green, LIVE snapshot (CLOSED DEAL 10
 * and 6 against a true 76) until the TTL expired.
 *
 * A metaTotal we cannot read counts as NOT complete. We would rather say
 * "short" than publish a number we cannot prove is whole.
 */
function pipelineSnapshot() {
  return probe(
    "pipeline-snapshot",
    async () => {
      const [pipesRaw, oppsRaw] = await Promise.all([
        bridge<{ pipelines?: Pipeline[] }>("/pipelines", 20_000),
        bridge<{ opportunities?: Opportunity[]; total?: number; metaTotal?: number | null }>(
          "/opportunities", 90_000),
      ]);
      if (!pipesRaw?.pipelines || !oppsRaw?.opportunities) return null;
      const received = oppsRaw.opportunities.length;
      const expected = typeof oppsRaw.metaTotal === "number" ? oppsRaw.metaTotal : null;
      return {
        pipelines: pipesRaw.pipelines,
        opportunities: oppsRaw.opportunities,
        complete: expected !== null && received === expected,
        received,
        expected,
      };
    },
    // Gate on the RESULT, exactly as the trend probe does. Without this a
    // momentary short read is pinned for the full TTL and served as truth.
    (v) => v !== null && v.complete,
  );
}

export async function GET(request: NextRequest) {
  const now = new Date();
  const params = request.nextUrl.searchParams;
  const key = (params.get("range") ?? "30d") as RangeKey;
  const validKeys: RangeKey[] = ["today", "7d", "30d", "mtd", "ytd", "custom"];
  const range = resolveRange(
    validKeys.includes(key) ? key : "30d",
    now,
    BUSINESS_TZ,
    params.get("start"),
    params.get("end"),
  );

  /**
   * The chart's window is resolved from TODAY, not from the picker.
   *
   * It used to be fetched as `trendStart -> range.endDate`, so selecting a
   * historical custom period truncated the series at that date and drew the
   * months after it as zero — under a caption that said the chart was fixed to
   * the last 8 months. Both ends now come from the business clock, and the
   * cache key holds only those, so a picker change can no longer evict or
   * reshape the fixed series.
   */
  const trendWindow = fixedTrendWindow(now, TREND_MONTHS, BUSINESS_TZ);

  const [
    rangePayments, trendPayments, paymentsLatest,
    rangeEvents, appointmentsLatest, pipeline,
  ] = await Promise.all([
    bridge<PaymentsResponse>(
      `/payments/transactions?startAt=${range.startDate}&endAt=${range.endDate}`, 60_000),
    probe(`trend-${trendWindow.startDate}-${trendWindow.endDate}`,
      () => bridge<PaymentsResponse>(
        `/payments/transactions?startAt=${trendWindow.startDate}&endAt=${trendWindow.endDate}`,
        60_000),
      (v) => Boolean(v?.data) && v?.complete === true),
    paymentsHeartbeat(),
    bridge<EventsResponse>(
      `/events?start=${encodeURIComponent(range.startISO)}&end=${encodeURIComponent(range.endISO)}`, 90_000),
    appointmentsHeartbeat(now),
    pipelineSnapshot(),
  ]);

  const unavailable: string[] = [];
  const incomplete: string[] = [];

  /**
   * A feed that answered SHORT is not a smaller true number. Anything not
   * provably complete is reported as such so the tile withholds the figure.
   *
   * AFFIRMATIVE, not merely not-negative. This was `complete !== false`, which
   * passes when the flag is absent entirely — so any response that did not
   * carry the flag was read as whole. Verified against the bridge source at
   * `~/.openclaw/workspace/services/ghl-bridge/ghl-bridge.mjs`: both
   * /payments/* (single-page and paged) and /events set `complete` on every
   * successful answer, and a malformed page throws rather than returning short.
   * Requiring `true` therefore changes nothing against the current bridge and
   * fails closed against an older one, a restarted one mid-deploy, or anything
   * else answering on :4003 with a shape we do not recognise.
   *
   * /opportunities is deliberately not in this list: that bridge route sends no
   * `complete` flag at all, only GoHighLevel's own metaTotal, so its
   * completeness is established by the independent count check in
   * pipelineSnapshot() instead.
   */
  const paymentsComplete = rangePayments?.complete === true;
  const trendComplete = trendPayments?.complete === true;
  const selectedEvents = rangeEvents && Array.isArray(rangeEvents.events)
    ? selectAppointmentsInRange(rangeEvents.events, range)
    : null;
  const eventsComplete = rangeEvents?.complete === true && selectedEvents !== null
    && selectedEvents.invalidStartTimes === 0;
  if (rangePayments && !paymentsComplete) incomplete.push("payments");
  if (trendPayments && !trendComplete) incomplete.push("trend");
  if (rangeEvents && !eventsComplete) incomplete.push("appointments");

  // ---- revenue, count, average ----
  const pay = rangePayments?.data && paymentsComplete
    ? summarisePayments(rangePayments.data)
    : null;
  if (!rangePayments?.data) unavailable.push("payments");

  // ---- monthly trend (fixed 8-month window, NOT the picker range) ----
  const trend = trendPayments?.data && trendComplete
    ? monthlySeries(trendPayments.data, TREND_MONTHS, now, BUSINESS_TZ)
    : null;

  // ---- appointments ----
  const appts = selectedEvents && eventsComplete
    ? summariseAppointments(selectedEvents.events)
    : null;
  if (!Array.isArray(rangeEvents?.events)) unavailable.push("appointments");

  // ---- pipeline stage distribution, point-in-time ----
  let pipelineView: {
    id: string; name: string; total: number; stages: { name: string; count: number }[];
  }[] | null = null;
  let pipelineLatest: string | null = null;

  // A short opportunity read is not a smaller true pipeline. Same rule as
  // payments and appointments: report it, and let the tile withhold the counts.
  const pipelineComplete = pipeline?.complete === true;
  if (pipeline && !pipelineComplete) incomplete.push("pipeline");

  if (pipeline && pipelineComplete) {
    const counts = new Map<string, number>();
    for (const o of pipeline.opportunities) {
      counts.set(o.pipelineStageId, (counts.get(o.pipelineStageId) ?? 0) + 1);
      const at = o.lastStageChangeAt;
      if (at && (!pipelineLatest || at > pipelineLatest)) pipelineLatest = at;
    }
    pipelineView = TARGET_PIPELINES.map((target) => {
      const p =
        pipeline.pipelines.find((x) => x.id === target.id) ??
        pipeline.pipelines.find((x) => x.name === target.name);
      if (!p) return { id: target.id, name: target.name, total: 0, stages: [] };
      const stages = [...p.stages]
        .sort((a, b) => a.position - b.position)
        .map((s) => ({ name: s.name, count: counts.get(s.id) ?? 0 }));
      return {
        id: p.id,
        name: p.name,
        total: stages.reduce((sum, s) => sum + s.count, 0),
        stages,
      };
    });
  } else if (!pipeline) {
    // Only "no answer at all" is unavailable. A short answer is already
    // reported as incomplete above and must not be double-counted here.
    unavailable.push("pipeline");
  }

  unavailable.push("recurring");

  return NextResponse.json({
    generatedAt: now.toISOString(),
    /**
     * The BUSINESS timezone, which is the one every figure above was actually
     * computed in — not the host's. The page formats timestamps with this, so a
     * clock value and its zone label can no longer disagree.
     */
    timezone: BUSINESS_TZ,
    /** Diagnostic only. A mismatch means the host clock moved, not the board. */
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    range,
    revenue: pay && {
      collected: pay.collected,
      count: pay.count,
      average: pay.average,
      excluded: pay.excluded,
      latestInRange: pay.latestAt,
      freshness: evaluateFreshness(paymentsLatest, now, FRESHNESS_THRESHOLD_DAYS.payments),
    },
    trend: trend && {
      months: trend,
      windowLabel: `Last ${TREND_MONTHS} months`,
      freshness: evaluateFreshness(paymentsLatest, now, FRESHNESS_THRESHOLD_DAYS.payments),
    },
    appointments: appts && {
      booked: appts.booked,
      cancelled: appts.cancelled,
      confirmed: appts.confirmed,
      cancellationRate: appts.cancellationRate,
      calendarsQueried: rangeEvents?.calendarsQueried ?? null,
      freshness: evaluateFreshness(appointmentsLatest, now, FRESHNESS_THRESHOLD_DAYS.appointments),
    },
    pipeline: pipelineView && {
      pipelines: pipelineView,
      freshness: evaluateFreshness(pipelineLatest, now, FRESHNESS_THRESHOLD_DAYS.pipeline),
    },
    // Native account reconciliation has not established an authoritative automatic
    // source. Never release inferred payment/MRR/roster values, even if fresh.
    recurring: null,
    recurringAvailability: "Pending verification: collections, MRR and subscriber count",
    unavailable,
    // Feeds that answered but could not prove they answered in full. The tile
    // shows why instead of a number that is quietly short.
    incomplete,
    // More than one feed can be short at once, so this names each of them
    // rather than describing only the calendars.
    incompleteDetail: [
      rangePayments && !paymentsComplete
        ? `the payments read for this range could not prove it was complete${
            rangePayments.truncated ? " (page cap reached)" : ""}`
        : null,
      trendPayments && !trendComplete
        ? "the 8-month payments read could not prove it was complete"
        : null,
      rangeEvents && !eventsComplete
        ? rangeEvents.complete !== true
          ? `${rangeEvents.calendarsFailed ?? "some"} of ${rangeEvents.calendarsQueried ?? "?"} calendars did not answer`
          : selectedEvents
            ? `${selectedEvents.invalidStartTimes} appointment start time${selectedEvents.invalidStartTimes === 1 ? " is" : "s are"} missing or invalid`
            : "the appointment read returned an invalid event list"
        : null,
      pipeline && !pipelineComplete
        ? `the opportunity read returned ${pipeline.received} of ${pipeline.expected ?? "an unknown number of"} records`
        : null,
    ].filter(Boolean).join("; ") || null,
  });
}
