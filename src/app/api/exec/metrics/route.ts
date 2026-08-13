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
  monthlySeries,
  evaluateFreshness,
  FRESHNESS_THRESHOLD_DAYS,
  type RangeKey,
  type Transaction,
  type AppointmentEvent,
} from "@/lib/exec-metrics";

const BRIDGE = "http://127.0.0.1:4003";
/**
 * Recurring revenue is a SEPARATE business line on a separate bridge: Newie
 * bills the subscriptions, GoHighLevel bills tickets and upsells. A cross-post
 * check over Q1 found zero payment-level overlap between them (9 of 63
 * customers appear in both systems, but not one payment matches on amount and
 * date), so the two are additive — and they are still reported as two
 * independently-gated lines, never pre-summed here.
 */
const NEWIE_BRIDGE = "http://127.0.0.1:4014";
const TREND_MONTHS = 8;
const PROBE_TTL_MS = 5 * 60 * 1000;

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
/** /revenue/summary on the newie-bridge. Totals cover DATED rows only. */
interface NewieSummary {
  totalRevenue?: number;
  mrr?: number;
  activeSubscribers?: number;
  paymentsCount?: number;
  currency?: string;
  latestPaymentAt?: string | null;
  latestSubscriptionAt?: string | null;
  undated?: { count: number; total: number };
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

/** Newie recurring-revenue summary. Cheap (the bridge caches the sheet 5m). */
function newieSummary() {
  return probe(
    "newie-summary",
    () => bridge<NewieSummary>("/revenue/summary", 20_000, NEWIE_BRIDGE),
    (v) => v !== null,
  );
}

/** Pipelines + all opportunities. Heavy (paged), so cached with the probes. */
function pipelineSnapshot() {
  return probe("pipeline-snapshot", async () => {
    const [pipesRaw, oppsRaw] = await Promise.all([
      bridge<{ pipelines?: Pipeline[] }>("/pipelines", 20_000),
      bridge<{ opportunities?: Opportunity[]; total?: number }>("/opportunities", 90_000),
    ]);
    if (!pipesRaw?.pipelines || !oppsRaw?.opportunities) return null;
    return { pipelines: pipesRaw.pipelines, opportunities: oppsRaw.opportunities };
  });
}

export async function GET(request: NextRequest) {
  const now = new Date();
  const params = request.nextUrl.searchParams;
  const key = (params.get("range") ?? "30d") as RangeKey;
  const validKeys: RangeKey[] = ["today", "7d", "30d", "mtd", "ytd", "custom"];
  const range = resolveRange(
    validKeys.includes(key) ? key : "30d",
    now,
    params.get("start"),
    params.get("end"),
  );

  const trendStart = new Date(now.getFullYear(), now.getMonth() - (TREND_MONTHS - 1), 1);
  const trendStartDate = `${trendStart.getFullYear()}-${String(trendStart.getMonth() + 1).padStart(2, "0")}-01`;

  const [
    rangePayments, trendPayments, paymentsLatest,
    rangeEvents, appointmentsLatest, pipeline, newie,
  ] = await Promise.all([
    bridge<PaymentsResponse>(
      `/payments/transactions?startAt=${range.startDate}&endAt=${range.endDate}`, 60_000),
    probe(`trend-${trendStartDate}-${range.endDate}`,
      () => bridge<PaymentsResponse>(
        `/payments/transactions?startAt=${trendStartDate}&endAt=${range.endDate}`, 60_000),
      (v) => Boolean(v?.data) && v?.complete !== false),
    paymentsHeartbeat(),
    bridge<EventsResponse>(
      `/events?start=${encodeURIComponent(range.startISO)}&end=${encodeURIComponent(range.endISO)}`, 90_000),
    appointmentsHeartbeat(now),
    pipelineSnapshot(),
    newieSummary(),
  ]);

  const unavailable: string[] = [];
  const incomplete: string[] = [];

  // A feed that answered SHORT is not a smaller true number. Anything not
  // provably complete is reported as such so the tile withholds the figure.
  const paymentsComplete = rangePayments?.complete !== false;
  const trendComplete = trendPayments?.complete !== false;
  const eventsComplete = rangeEvents?.complete !== false;
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
    ? monthlySeries(trendPayments.data, TREND_MONTHS, now)
    : null;

  // ---- appointments ----
  const appts = rangeEvents?.events && eventsComplete
    ? summariseAppointments(rangeEvents.events)
    : null;
  if (!rangeEvents?.events) unavailable.push("appointments");

  // ---- pipeline stage distribution, point-in-time ----
  let pipelineView: {
    id: string; name: string; total: number; stages: { name: string; count: number }[];
  }[] | null = null;
  let pipelineLatest: string | null = null;

  if (pipeline) {
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
  } else {
    unavailable.push("pipeline");
  }

  if (!newie) unavailable.push("recurring");

  return NextResponse.json({
    generatedAt: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
    /**
     * Recurring revenue (Newie) — the second business line, deliberately NOT
     * merged with the GHL figures above.
     *
     * Two independent gates, because the two halves of this feed fail
     * separately. `revenueFreshness` reads the newest DATED payment: the Zap
     * writes charge rows with a blank Time column, so nothing has been dated
     * since the 2026-04-04 CSV backfill and this reads STALE. `rosterFreshness`
     * reads the subscription lifecycle rows, which ARE dated and current, so
     * MRR and the subscriber count are shown.
     */
    recurring: newie && {
      mrr: newie.mrr ?? null,
      activeSubscribers: newie.activeSubscribers ?? null,
      currency: newie.currency ?? "AUD",
      latestPaymentAt: newie.latestPaymentAt ?? null,
      /**
       * All-time total over DATED charge rows, after the backfill
       * de-duplication. Deliberately not range-scoped: the range picker cannot
       * be honoured on this line until the rows carry dates, so the tile labels
       * this as an all-time figure rather than implying it follows the picker.
       */
      collectedAllTime: newie.totalRevenue ?? null,
      datedCount: newie.paymentsCount ?? null,
      /** Charge rows the Zap wrote with no date. Real money, unplaceable in time. */
      undatedCount: newie.undated?.count ?? 0,
      undatedTotal: newie.undated?.total ?? 0,
      revenueFreshness: evaluateFreshness(
        newie.latestPaymentAt ?? null, now, FRESHNESS_THRESHOLD_DAYS.newieRecurring),
      rosterFreshness: evaluateFreshness(
        newie.latestSubscriptionAt ?? null, now, FRESHNESS_THRESHOLD_DAYS.newieRoster),
    },
    unavailable,
    // Feeds that answered but could not prove they answered in full. The tile
    // shows why instead of a number that is quietly short.
    incomplete,
    incompleteDetail: rangeEvents && !eventsComplete
      ? `${rangeEvents.calendarsFailed ?? "some"} of ${rangeEvents.calendarsQueried ?? "?"} calendars did not answer`
      : null,
  });
}
