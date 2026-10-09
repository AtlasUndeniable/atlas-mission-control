/**
 * Executive dashboard metric rules.
 *
 * Every case below is a number that WOULD have been wrong on the board. They
 * are drawn from the live feed as probed on 2026-08-12, not invented:
 *   - a $2,500 test-mode payment (liveMode:false) inflating revenue
 *   - a USD record summed into an AUD total
 *   - fully refunded and failed payments counted as collected
 *   - a payment created 2025-12-28 but fulfilled 2026-01-01, which lands in the
 *     wrong month if grouped on createdAt (the API filters on fulfilledAt)
 *   - calendar events carrying a misspelled duplicate `appoinmentStatus` that is
 *     absent on some records
 *   - a feed whose newest record is months old still rendering a confident total
 *
 * Run: node --test tests/exec-metrics.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BUSINESS_TIMEZONE,
  resolveRange,
  isCollectedPayment,
  summarisePayments,
  monthlySeries,
  summariseAppointments,
  evaluateFreshness,
  type Transaction,
} from "../src/lib/exec-metrics.ts";

const NOW = new Date(2026, 7, 12, 14, 30, 0); // 12 Aug 2026, local

// ===== ranges =====

test("range presets resolve to the bounds actually sent upstream", () => {
  assert.deepEqual(
    { s: resolveRange("today", NOW).startDate, e: resolveRange("today", NOW).endDate },
    { s: "2026-08-12", e: "2026-08-12" },
  );
  // 7d is inclusive of today, so it spans 7 calendar days not 8
  assert.equal(resolveRange("7d", NOW).startDate, "2026-08-06");
  assert.equal(resolveRange("30d", NOW).startDate, "2026-07-14");
  assert.equal(resolveRange("mtd", NOW).startDate, "2026-08-01");
  assert.equal(resolveRange("ytd", NOW).startDate, "2026-01-01");
  for (const k of ["today", "7d", "30d", "mtd", "ytd"] as const) {
    assert.equal(resolveRange(k, NOW).endDate, "2026-08-12", `${k} ends today`);
    assert.equal(resolveRange(k, NOW).includesNow, true);
  }
});

test("the events window ends at the NEXT local midnight so the last day is included", () => {
  const r = resolveRange("today", NOW);
  assert.equal(new Date(r.endISO).getTime() - new Date(r.startISO).getTime(), 24 * 3600 * 1000);
});

test("custom ranges are honoured, reversed pairs are repaired, and history is flagged", () => {
  // resolveRange is (key, now, tz, customStart, customEnd) — this case used to
  // pass the dates into tz and customStart, which threw on the Intl lookup.
  const r = resolveRange("custom", NOW, DEFAULT_BUSINESS_TIMEZONE, "2026-03-01", "2026-03-31");
  assert.equal(r.startDate, "2026-03-01");
  assert.equal(r.endDate, "2026-03-31");
  assert.equal(r.includesNow, false, "a historical range must not claim to include now");

  const flipped = resolveRange("custom", NOW, DEFAULT_BUSINESS_TIMEZONE, "2026-03-31", "2026-03-01");
  assert.equal(flipped.startDate, "2026-03-01", "start/end swapped back into order");
  assert.equal(flipped.endDate, "2026-03-31");
});

// ===== what counts as collected revenue =====

const good: Transaction = { amount: 1000, status: "succeeded", currency: "aud", liveMode: true, fulfilledAt: "2026-08-01T00:00:00Z" };

test("only live, succeeded, AUD payments count as collected", () => {
  assert.equal(isCollectedPayment(good), true);
  assert.equal(isCollectedPayment({ ...good, currency: "AUD" }), true, "currency is case-insensitive");
  assert.equal(isCollectedPayment({ ...good, liveMode: undefined }), true, "missing liveMode is treated as live");

  assert.equal(isCollectedPayment({ ...good, status: "failed" }), false);
  assert.equal(isCollectedPayment({ ...good, status: "refunded" }), false);
  assert.equal(isCollectedPayment({ ...good, liveMode: false }), false, "test payments are not revenue");
  assert.equal(isCollectedPayment({ ...good, currency: "USD" }), false, "non-AUD out of an AUD total");
  assert.equal(isCollectedPayment({ ...good, amount: undefined }), false);
});

test("summarisePayments reproduces the live 2026 rule and reports what it dropped", () => {
  // mirrors the real feed's shape: succeeded + failed + refunded + test + USD
  const rows: Transaction[] = [
    { ...good, amount: 3000, fulfilledAt: "2026-08-12T06:04:13Z" },
    { ...good, amount: 18750, fulfilledAt: "2026-08-02T00:00:00Z" },
    { ...good, amount: 2500, liveMode: false, fulfilledAt: "2026-02-27T06:07:47Z" }, // the real test payment
    { ...good, amount: 0, currency: "USD", liveMode: false, fulfilledAt: "2026-02-05T05:15:55Z" },
    { ...good, amount: 5000, status: "failed" },
    { ...good, amount: 4000, status: "refunded" },
    { ...good, amount: 1200, currency: "usd" },
  ];
  const s = summarisePayments(rows);
  assert.equal(s.collected, 21750, "3000 + 18750, with test/failed/refunded/USD excluded");
  assert.equal(s.count, 2);
  assert.equal(s.average, 10875);
  assert.deepEqual(s.excluded, { failed: 1, refunded: 1, testMode: 2, nonAud: 1 });
  assert.equal(s.latestAt, "2026-08-12T06:04:13Z", "as-of uses the newest COUNTED payment");
});

test("an empty range is a clean zero, not a crash or a NaN average", () => {
  const s = summarisePayments([]);
  assert.equal(s.collected, 0);
  assert.equal(s.count, 0);
  assert.equal(s.average, 0);
  assert.equal(s.latestAt, null);
});

// ===== monthly trend =====

test("the trend groups on fulfilledAt, which is what the API filters on", () => {
  // The real record: created in December, fulfilled in January. Grouping on
  // createdAt would put January's money in a month the range never selected.
  const rows: Transaction[] = [
    { ...good, amount: 1950, createdAt: "2025-12-28T04:39:57Z", fulfilledAt: "2026-01-01T10:39:29Z" },
  ];
  const series = monthlySeries(rows, 8, NOW);
  const jan = series.find((m) => m.month === "2026-01");
  assert.ok(jan, "January is inside an 8-month window ending August");
  assert.equal(jan!.total, 1950, "counted in January (fulfilled), not December (created)");
  assert.equal(series.find((m) => m.month === "2025-12"), undefined);
});

test("the trend returns a contiguous 8 months, zero-filled, current month flagged partial", () => {
  const series = monthlySeries([], 8, NOW);
  assert.equal(series.length, 8);
  assert.equal(series[0].month, "2026-01");
  assert.equal(series[7].month, "2026-08");
  assert.deepEqual(series.map((m) => m.total), new Array(8).fill(0), "no data means zeroes, not gaps");
  assert.equal(series[7].partial, true, "August is still running and is not comparable");
  assert.equal(series[6].partial, false);
});

test("the trend applies the same exclusions as the revenue tile", () => {
  const rows: Transaction[] = [
    { ...good, amount: 100, fulfilledAt: "2026-08-05T00:00:00Z" },
    { ...good, amount: 2500, liveMode: false, fulfilledAt: "2026-08-06T00:00:00Z" },
  ];
  const aug = monthlySeries(rows, 8, NOW).find((m) => m.month === "2026-08");
  assert.equal(aug!.total, 100, "test payment excluded from the chart too");
  assert.equal(aug!.count, 1);
});

// ===== appointments =====

test("appointments read the correct status field, not the misspelled duplicate", () => {
  const events = [
    { appointmentStatus: "confirmed", appoinmentStatus: "confirmed", dateAdded: "2026-08-01T00:00:00Z" },
    { appointmentStatus: "cancelled", appoinmentStatus: "cancelled", dateAdded: "2026-08-02T00:00:00Z" },
    // the real shape of 8 of 225 July records: typo field absent entirely
    { appointmentStatus: "confirmed", dateAdded: "2026-08-03T00:00:00Z" },
  ];
  const s = summariseAppointments(events);
  assert.equal(s.booked, 3, "booked counts every appointment scheduled in the range");
  assert.equal(s.confirmed, 2);
  assert.equal(s.cancelled, 1);
  assert.equal(s.cancellationRate, 33.3);
  assert.equal(s.latestBookedAt, "2026-08-03T00:00:00Z");
});

test("cancellation rate is null when nothing was booked, never a divide-by-zero", () => {
  const s = summariseAppointments([]);
  assert.equal(s.booked, 0);
  assert.equal(s.cancellationRate, null);
  assert.equal(s.latestBookedAt, null);
});

test("July's real split reproduces the recon figures", () => {
  const events = [
    ...Array.from({ length: 220 }, () => ({ appointmentStatus: "confirmed" })),
    ...Array.from({ length: 5 }, () => ({ appointmentStatus: "cancelled" })),
  ];
  const s = summariseAppointments(events);
  assert.equal(s.booked, 225);
  assert.equal(s.cancelled, 5);
  assert.equal(s.cancellationRate, 2.2);
});

// ===== freshness =====

test("a feed silent past its threshold is STALE, not a confident number", () => {
  // the Newie failure mode: well-formed data whose newest record is months old
  const f = evaluateFreshness("2026-04-04T00:00:00Z", NOW, 7);
  assert.equal(f.status, "stale");
  assert.ok(f.ageDays! > 100, `expected a large age, got ${f.ageDays}`);
  assert.equal(f.latestRecordAt, "2026-04-04T00:00:00Z", "the STALE state names the date");
});

test("a live feed is fresh, and a future-dated record is not treated as aged", () => {
  assert.equal(evaluateFreshness("2026-08-12T06:00:00Z", NOW, 7).status, "fresh");
  assert.equal(evaluateFreshness("2026-08-10T00:00:00Z", NOW, 7).status, "fresh");
  // appointments are booked ahead; a future startTime must not read as stale
  const ahead = evaluateFreshness("2026-09-01T00:00:00Z", NOW, 7);
  assert.equal(ahead.status, "fresh");
  assert.equal(ahead.ageDays, 0, "future records clamp to zero age");
});

test("a feed that cannot prove liveness is UNAVAILABLE, never silently fresh", () => {
  for (const bad of [null, "", "not-a-date"]) {
    const f = evaluateFreshness(bad as string | null, NOW, 7);
    assert.equal(f.status, "unavailable", `${JSON.stringify(bad)} must not read as fresh`);
    assert.equal(f.latestRecordAt, null);
  }
});

test("the stale boundary sits exactly on the threshold", () => {
  const sixDays = new Date(NOW.getTime() - 6 * 24 * 3600 * 1000).toISOString();
  const eightDays = new Date(NOW.getTime() - 8 * 24 * 3600 * 1000).toISOString();
  assert.equal(evaluateFreshness(sixDays, NOW, 7).status, "fresh");
  assert.equal(evaluateFreshness(eightDays, NOW, 7).status, "stale");
});
