/**
 * Executive dashboard metric rules — pure functions, no I/O, so every number on
 * /exec can be unit-tested and cross-checked against a direct bridge pull.
 *
 * THE BAR (Rhys, 7/13): only metrics that are FRESH and RIGHT. Fewer is better.
 * One wrong number costs more than a missing one. Prior dashboards died on stale
 * and wrong figures, so the rules below are deliberately explicit about what is
 * counted and what is thrown away, and every exclusion is reported rather than
 * silently applied.
 *
 * FIELD FACTS, all established by probing the live feed on 2026-08-12 (not from
 * docs, which are wrong about several of these):
 *
 *   - Payments amounts are in DOLLARS, not cents. The opposite of the Newie
 *     sheet. Proven by fractional values in the same feed (1147.06, 487.5).
 *   - /payments/* startAt/endAt filter on `fulfilledAt`, NOT `createdAt`. Proven:
 *     over 2026 the response holds a record created 2025-12-28 and fulfilled
 *     2026-01-01. Everything here therefore groups by fulfilledAt, so the tiles
 *     agree with the filter that produced them.
 *   - `liveMode: false` marks TEST payments. Three exist in 2026, one for
 *     $2,500. Counting them inflates revenue by real money that never arrived.
 *   - `currency` is mixed case ("aud" 831, "AUD" 2) and one record is USD.
 *     Compared case-insensitively; non-AUD is excluded from an AUD total.
 *   - status is one of succeeded / failed / refunded. The 15 refunded records in
 *     2026 are FULLY refunded (gross == amountRefunded) and no succeeded record
 *     carries a partial refund, so excluding refunded outright is correct today.
 *     `refundedExcluded` is surfaced so a future partial refund cannot hide.
 *   - Calendar events carry BOTH `appointmentStatus` and a misspelled
 *     `appoinmentStatus`. The typo field is absent on 8 of 225 July records
 *     while the correct one is always present, so only the correct one is read.
 */

// ===== DATE RANGE =====

export type RangeKey = "today" | "7d" | "30d" | "mtd" | "ytd" | "custom";

export interface ResolvedRange {
  key: RangeKey;
  /** Short human label for the tile footer, e.g. "1 Aug to 12 Aug 2026". */
  label: string;
  /** Local calendar day, inclusive, YYYY-MM-DD. What /payments/* is given. */
  startDate: string;
  endDate: string;
  /** Local midnight boundaries as ISO. What /events is given (end exclusive). */
  startISO: string;
  endISO: string;
  /** True when the range runs up to today, i.e. recency is assertable. */
  includesNow: boolean;
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDayLabel(d: Date): string {
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Resolve a preset (or a custom pair) into the exact bounds sent upstream.
 * Boundaries are LOCAL days, because "today" means Rhys's today. The page shows
 * the resolved range on every tile so there is no ambiguity about what a number
 * covers.
 */
export function resolveRange(
  key: RangeKey,
  now: Date,
  customStart?: string | null,
  customEnd?: string | null,
): ResolvedRange {
  const today = startOfLocalDay(now);
  let start: Date;
  let end: Date = today; // inclusive last day

  switch (key) {
    case "today":
      start = today;
      break;
    case "7d":
      start = new Date(today.getTime() - 6 * DAY_MS); // 7 days inclusive of today
      break;
    case "30d":
      start = new Date(today.getTime() - 29 * DAY_MS);
      break;
    case "mtd":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "ytd":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case "custom": {
      const s = customStart ? new Date(`${customStart}T00:00:00`) : today;
      const e = customEnd ? new Date(`${customEnd}T00:00:00`) : today;
      start = startOfLocalDay(isNaN(s.getTime()) ? today : s);
      end = startOfLocalDay(isNaN(e.getTime()) ? today : e);
      if (start.getTime() > end.getTime()) [start, end] = [end, start];
      break;
    }
  }

  const endExclusive = new Date(end.getTime() + DAY_MS);
  return {
    key,
    label:
      localDateStr(start) === localDateStr(end)
        ? formatDayLabel(start)
        : `${formatDayLabel(start)} to ${formatDayLabel(end)}`,
    startDate: localDateStr(start),
    endDate: localDateStr(end),
    startISO: start.toISOString(),
    endISO: endExclusive.toISOString(),
    includesNow: end.getTime() >= today.getTime(),
  };
}

// ===== PAYMENTS =====

export interface Transaction {
  amount?: number;
  status?: string;
  currency?: string;
  liveMode?: boolean;
  fulfilledAt?: string;
  createdAt?: string;
}

/**
 * Money that actually arrived: a live (non-test) AUD payment that succeeded.
 * Every clause here removes a figure that would otherwise be wrong, not merely
 * untidy.
 */
export function isCollectedPayment(t: Transaction): boolean {
  return (
    t.status === "succeeded" &&
    t.liveMode !== false &&
    String(t.currency ?? "").toLowerCase() === "aud" &&
    typeof t.amount === "number" &&
    Number.isFinite(t.amount)
  );
}

export interface PaymentsSummary {
  collected: number;
  count: number;
  average: number;
  /** What was removed from the raw feed, so the number is explainable. */
  excluded: { failed: number; refunded: number; testMode: number; nonAud: number };
  /** Newest fulfilledAt among COUNTED payments, for the as-of line. */
  latestAt: string | null;
}

export function summarisePayments(rows: Transaction[]): PaymentsSummary {
  let collected = 0;
  let count = 0;
  let latestAt: string | null = null;
  const excluded = { failed: 0, refunded: 0, testMode: 0, nonAud: 0 };

  for (const t of rows) {
    if (isCollectedPayment(t)) {
      collected += t.amount as number;
      count += 1;
      const at = t.fulfilledAt ?? t.createdAt ?? null;
      if (at && (!latestAt || at > latestAt)) latestAt = at;
      continue;
    }
    if (t.status === "failed") excluded.failed += 1;
    else if (t.status === "refunded") excluded.refunded += 1;
    else if (t.liveMode === false) excluded.testMode += 1;
    else if (String(t.currency ?? "").toLowerCase() !== "aud") excluded.nonAud += 1;
  }

  return {
    // Round to cents once, at the end, so repeated float addition cannot drift.
    collected: Math.round(collected * 100) / 100,
    count,
    average: count > 0 ? Math.round((collected / count) * 100) / 100 : 0,
    excluded,
    latestAt,
  };
}

export interface MonthPoint {
  month: string;   // YYYY-MM
  label: string;   // "Aug"
  total: number;
  count: number;
  /** True for the month still in progress, which is not comparable to the rest. */
  partial: boolean;
}

/** Collected revenue by calendar month, oldest first, grouped on fulfilledAt. */
export function monthlySeries(rows: Transaction[], months: number, now: Date): MonthPoint[] {
  const buckets = new Map<string, { total: number; count: number }>();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    keys.push(key);
    buckets.set(key, { total: 0, count: 0 });
  }

  for (const t of rows) {
    if (!isCollectedPayment(t)) continue;
    const at = t.fulfilledAt ?? t.createdAt;
    if (!at) continue;
    const d = new Date(at);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const b = buckets.get(key);
    if (!b) continue;                     // outside the window we are charting
    b.total += t.amount as number;
    b.count += 1;
  }

  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return keys.map((key) => {
    const b = buckets.get(key)!;
    const [y, m] = key.split("-").map(Number);
    return {
      month: key,
      label: new Date(y, m - 1, 1).toLocaleDateString("en-AU", { month: "short" }),
      total: Math.round(b.total * 100) / 100,
      count: b.count,
      partial: key === currentKey,
    };
  });
}

// ===== APPOINTMENTS =====

export interface AppointmentEvent {
  appointmentStatus?: string;
  startTime?: string;
  dateAdded?: string;
}

export interface AppointmentsSummary {
  booked: number;
  cancelled: number;
  confirmed: number;
  /** cancelled / booked, as a percentage. Null when nothing was booked. */
  cancellationRate: number | null;
  /** Newest booking timestamp (dateAdded), which is the feed's real heartbeat. */
  latestBookedAt: string | null;
}

/**
 * `booked` is every appointment SCHEDULED to start inside the range, which is
 * what the upstream filter selects on. It is not "bookings created in the
 * range" — the tile says so explicitly rather than leaving it to be assumed.
 */
export function summariseAppointments(events: AppointmentEvent[]): AppointmentsSummary {
  let cancelled = 0;
  let confirmed = 0;
  let latestBookedAt: string | null = null;

  for (const e of events) {
    const status = String(e.appointmentStatus ?? "").toLowerCase();
    if (status === "cancelled") cancelled += 1;
    else if (status === "confirmed") confirmed += 1;
    const at = e.dateAdded ?? null;
    if (at && (!latestBookedAt || at > latestBookedAt)) latestBookedAt = at;
  }

  const booked = events.length;
  return {
    booked,
    cancelled,
    confirmed,
    cancellationRate: booked > 0 ? Math.round((cancelled / booked) * 1000) / 10 : null,
    latestBookedAt,
  };
}

// ===== FRESHNESS =====

export type FreshnessStatus = "fresh" | "stale" | "unavailable";

export interface Freshness {
  status: FreshnessStatus;
  /** Newest record the FEED holds, independent of the selected range. */
  latestRecordAt: string | null;
  ageDays: number | null;
  thresholdDays: number;
}

/**
 * Freshness is a property of the FEED, not of the range. A range with no
 * records is a legitimate zero; a feed whose newest record anywhere is months
 * old is the failure that killed the last dashboard, and it renders as an
 * explicit "STALE since <date>" rather than a plausible number.
 *
 * A null latest date means the probe could not establish liveness at all, which
 * is reported as unavailable rather than being allowed to read as fresh.
 */
export function evaluateFreshness(
  latestRecordAt: string | null,
  now: Date,
  thresholdDays: number,
): Freshness {
  if (!latestRecordAt) {
    return { status: "unavailable", latestRecordAt: null, ageDays: null, thresholdDays };
  }
  const t = new Date(latestRecordAt).getTime();
  if (isNaN(t)) {
    return { status: "unavailable", latestRecordAt: null, ageDays: null, thresholdDays };
  }
  // Future-dated records (a booking next week) are not stale; clamp at 0.
  const ageDays = Math.max(0, (now.getTime() - t) / DAY_MS);
  return {
    status: ageDays > thresholdDays ? "stale" : "fresh",
    latestRecordAt,
    ageDays: Math.round(ageDays * 10) / 10,
    thresholdDays,
  };
}

/**
 * How many days of silence before each feed is called stale.
 *
 * These are per-feed on purpose: a threshold is only meaningful against a
 * feed's own natural cadence, and one global number would either miss a dead
 * feed or cry wolf on a quiet one.
 *
 * newieRecurring (3): the Newie payment feed writes 2-3 charge rows a day, so
 *   three days of silence is a genuine fault rather than a quiet patch.
 * newieRoster (90): subscription LIFECYCLE rows only appear when someone joins,
 *   changes plan, or cancels. Measured over the feed's history the largest
 *   natural gap is 90 days (Feb 2026 and Jun 2026 each recorded none at all),
 *   so anything tighter would flag a legitimately quiet quarter as a failure.
 *   This gates the MRR/active-subscriber roster, not the payment figures.
 */
export const FRESHNESS_THRESHOLD_DAYS = {
  payments: 7,
  appointments: 7,
  pipeline: 7,
  newieRecurring: 3,
  newieRoster: 90,
} as const;
