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


// ===== BUSINESS TIME =====

/**
 * Every date bound, month bucket and printed timestamp on /exec resolves in ONE
 * explicit business timezone. It used to resolve in whatever timezone the host
 * process happened to be in, and print in whatever timezone the browser happened
 * to be in — while labelling the result with the server's zone string. Rhys
 * reading the board from a hotel in Los Angeles therefore saw a Los Angeles
 * clock value stamped "Australia/Melbourne", and "today" meant the Mac's today,
 * not his.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *   1. Calendar arithmetic is done on CIVIL dates (y/m/d), never by adding
 *      86,400,000ms. On the two days a year a zone shifts, a day is 23 or 25
 *      hours long, so "today minus 6 days" done in milliseconds lands at 23:00
 *      or 01:00 of the wrong calendar day and silently moves the window.
 *   2. A civil day is converted to an instant by solving for the zone's offset
 *      AT that moment, not by assuming a fixed one.
 */
export const DEFAULT_BUSINESS_TIMEZONE = "Australia/Melbourne";

export interface CivilDate { y: number; m: number; d: number }

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts { y: number; m: number; d: number; hh: number; mm: number; ss: number }

/** Wall-clock reading of an instant in `tz`. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = zoneFormatter(tz).formatToParts(instant);
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    y: read("year"), m: read("month"), d: read("day"),
    // h23 should never emit 24, but some ICU builds do at midnight.
    hh: read("hour") % 24, mm: read("minute"), ss: read("second"),
  };
}

/** Zone offset in ms at a given instant (positive east of UTC). */
function offsetMsAt(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The first instant of a civil day in `tz`.
 *
 * Solved rather than assumed, because the offset that applies is the offset at
 * the answer, not at the guess. Both DST pathologies are handled explicitly:
 * a midnight that happens twice resolves to its FIRST occurrence, and a
 * midnight that never happens (a zone shifting at 00:00) resolves to the first
 * instant that day actually has.
 */
export function zonedStartOfDay(c: CivilDate, tz: string): Date {
  const wall = Date.UTC(c.y, c.m - 1, c.d, 0, 0, 0, 0);
  const candidates = new Set<number>();
  for (const probeShift of [-26, -12, 0, 12, 26]) {
    candidates.add(wall - offsetMsAt(new Date(wall + probeShift * HOUR_MS), tz));
  }
  const sorted = [...candidates].sort((a, b) => a - b);

  for (const t of sorted) {
    const p = zonedParts(new Date(t), tz);
    if (p.y === c.y && p.m === c.m && p.d === c.d && p.hh === 0 && p.mm === 0 && p.ss === 0) {
      return new Date(t); // earliest exact midnight wins the ambiguous case
    }
  }
  for (const t of sorted) {
    const p = zonedParts(new Date(t), tz);
    if (p.y === c.y && p.m === c.m && p.d === c.d) return new Date(t); // midnight skipped
  }
  return new Date(sorted[0]);
}

/** Civil-date arithmetic via UTC, so a 23- or 25-hour day cannot shift a count. */
export function addCivilDays(c: CivilDate, n: number): CivilDate {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function addCivilMonths(c: CivilDate, n: number): CivilDate {
  const t = new Date(Date.UTC(c.y, c.m - 1 + n, 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: 1 };
}

export function civilToday(now: Date, tz: string): CivilDate {
  const p = zonedParts(now, tz);
  return { y: p.y, m: p.m, d: p.d };
}

export function civilStr(c: CivilDate): string {
  return `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

export function monthStr(c: CivilDate): string {
  return `${c.y}-${String(c.m).padStart(2, "0")}`;
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** Strict YYYY-MM-DD. Rejects 2026-02-31 rather than rolling it into March. */
export function parseCivil(s: string | null | undefined): CivilDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d));
  if (t.getUTCFullYear() !== c.y || t.getUTCMonth() + 1 !== c.m || t.getUTCDate() !== c.d) return null;
  return c;
}

// ===== DATE RANGE =====

export type RangeKey = "today" | "7d" | "30d" | "mtd" | "ytd" | "custom";

export interface ResolvedRange {
  key: RangeKey;
  /** The business timezone this range was resolved in. Travels with the result
   *  so the browser labels timestamps with the zone that actually produced them. */
  timezone: string;
  /** Short human label for the tile footer, e.g. "1 Aug to 12 Aug 2026". */
  label: string;
  /** Business calendar day, inclusive, YYYY-MM-DD. What /payments/* is given. */
  startDate: string;
  endDate: string;
  /** Business midnight boundaries as ISO. What /events is given (end exclusive). */
  startISO: string;
  endISO: string;
  /** True when the range runs up to today, i.e. recency is assertable. */
  includesNow: boolean;
}

function formatDayLabel(c: CivilDate, tz: string): string {
  return zonedStartOfDay(c, tz).toLocaleDateString("en-AU", {
    timeZone: tz, day: "numeric", month: "short", year: "numeric",
  });
}

/**
 * Resolve a preset (or a custom pair) into the exact bounds sent upstream.
 * Boundaries are business calendar days, because "today" means Rhys's today in
 * Melbourne — not the host's today and not the travelling browser's today. The
 * page shows the resolved range on every tile so there is no ambiguity about
 * what a number covers.
 */
export function resolveRange(
  key: RangeKey,
  now: Date,
  tz: string = DEFAULT_BUSINESS_TIMEZONE,
  customStart?: string | null,
  customEnd?: string | null,
): ResolvedRange {
  const today = civilToday(now, tz);
  let start: CivilDate;
  let end: CivilDate = today; // inclusive last day

  switch (key) {
    case "today":
      start = today;
      break;
    case "7d":
      start = addCivilDays(today, -6); // 7 days inclusive of today
      break;
    case "30d":
      start = addCivilDays(today, -29);
      break;
    case "mtd":
      start = { y: today.y, m: today.m, d: 1 };
      break;
    case "ytd":
      start = { y: today.y, m: 1, d: 1 };
      break;
    case "custom": {
      start = parseCivil(customStart) ?? today;
      end = parseCivil(customEnd) ?? today;
      if (compareCivil(start, end) > 0) [start, end] = [end, start];
      break;
    }
    default:
      start = addCivilDays(today, -29);
  }

  return {
    key,
    timezone: tz,
    label:
      compareCivil(start, end) === 0
        ? formatDayLabel(start, tz)
        : `${formatDayLabel(start, tz)} to ${formatDayLabel(end, tz)}`,
    startDate: civilStr(start),
    endDate: civilStr(end),
    startISO: zonedStartOfDay(start, tz).toISOString(),
    // End-exclusive next business midnight. On a 23- or 25-hour day this span
    // is 23 or 25 hours, which is exactly what "that calendar day" means.
    endISO: zonedStartOfDay(addCivilDays(end, 1), tz).toISOString(),
    includesNow: compareCivil(end, today) >= 0,
  };
}

/**
 * The revenue chart's window, resolved from TODAY in the business timezone and
 * deliberately independent of the range picker.
 *
 * The chart is captioned "fixed to the last 8 months". It previously fetched
 * through the SELECTED range's end date, so choosing a historical custom period
 * truncated the series to that date and rendered the later months as zero — a
 * caption and a chart that disagreed. Resolving the end here, from today, is
 * what makes the caption true.
 */
export function fixedTrendWindow(
  now: Date,
  months: number,
  tz: string,
): { startDate: string; endDate: string } {
  const today = civilToday(now, tz);
  const first = addCivilMonths({ y: today.y, m: today.m, d: 1 }, -(months - 1));
  return { startDate: civilStr(first), endDate: civilStr(today) };
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

/**
 * Collected revenue by calendar month, oldest first, grouped on fulfilledAt.
 * Months are business-timezone months: a payment fulfilled at 2026-09-01T00:30
 * Melbourne is August 31 in UTC and July 31 in Los Angeles, so grouping on the
 * host's clock moved real money between columns depending on where the process
 * ran.
 */
export function monthlySeries(
  rows: Transaction[],
  months: number,
  now: Date,
  tz: string = DEFAULT_BUSINESS_TIMEZONE,
): MonthPoint[] {
  const today = civilToday(now, tz);
  const buckets = new Map<string, { total: number; count: number }>();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const key = monthStr(addCivilMonths({ y: today.y, m: today.m, d: 1 }, -i));
    keys.push(key);
    buckets.set(key, { total: 0, count: 0 });
  }

  for (const t of rows) {
    if (!isCollectedPayment(t)) continue;
    const at = t.fulfilledAt ?? t.createdAt;
    if (!at) continue;
    const d = new Date(at);
    if (isNaN(d.getTime())) continue;
    const p = zonedParts(d, tz);
    const b = buckets.get(monthStr({ y: p.y, m: p.m, d: 1 }));
    if (!b) continue;                     // outside the window we are charting
    b.total += t.amount as number;
    b.count += 1;
  }

  const currentKey = monthStr({ y: today.y, m: today.m, d: 1 });
  return keys.map((key) => {
    const b = buckets.get(key)!;
    const [y, m] = key.split("-").map(Number);
    return {
      month: key,
      label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-AU", {
        timeZone: "UTC", month: "short",
      }),
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

/** Require an explicit instant; never interpret a provider timestamp in the
 * host or travelling viewer's timezone. Reject rollover dates as malformed. */
function appointmentStartMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !parseCivil(match[1]) || match[2] === "-00:00") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** Provider calendar queries can return events whose starts are outside the
 * requested day. Count only starts in [start, end), using the
 * existing business-midnight bounds (including 23- and 25-hour DST days).
 * Unknown start times prevent a complete metric; they are not silent drops. */
export function selectAppointmentsInRange(
  events: AppointmentEvent[],
  range: Pick<ResolvedRange, "startISO" | "endISO">,
): { events: AppointmentEvent[]; outsideRange: number; invalidStartTimes: number } {
  const start = appointmentStartMs(range.startISO);
  const end = appointmentStartMs(range.endISO);
  if (start === null || end === null || start >= end) {
    throw new RangeError("Invalid appointment range");
  }
  const selected: AppointmentEvent[] = [];
  let outsideRange = 0;
  let invalidStartTimes = 0;
  for (const event of events) {
    const at = appointmentStartMs(event?.startTime);
    if (at === null) invalidStartTimes += 1;
    else if (at < start || at >= end) outsideRange += 1;
    else selected.push(event);
  }
  return { events: selected, outsideRange, invalidStartTimes };
}

/**
 * `booked` is every appointment SCHEDULED to start inside the range, which is
 * enforced by selectAppointmentsInRange at the route. It is not "bookings created in the
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
