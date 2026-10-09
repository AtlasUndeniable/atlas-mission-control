/**
 * E1 regression suite — the five /exec defects named in atlas-exec-build-gate.md.
 *
 * Each test below fails against the code as it stood at 6810f90 and passes
 * after the E1 repair. They are written as the specific wrong number or wrong
 * label Rhys would have been shown, not as coverage for its own sake.
 *
 * Run: node --test tests/exec-e1-regression.test.ts
 * These must pass from ANY host timezone; CI should run at least Melbourne and
 * a far-away zone, since a Melbourne-only run cannot see defect 2 at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRange,
  monthlySeries,
  fixedTrendWindow,
  zonedStartOfDay,
  civilToday,
  addCivilDays,
  parseCivil,
  DEFAULT_BUSINESS_TIMEZONE,
  type Transaction,
} from "../src/lib/exec-metrics.ts";

const MEL = "Australia/Melbourne";
const LA = "America/Los_Angeles";
const HOUR = 3600 * 1000;
const good: Transaction = {
  amount: 1000, status: "succeeded", currency: "aud", liveMode: true,
  fulfilledAt: "2026-08-01T00:00:00Z",
};

// ===== defect 1: the "fixed" chart followed the picker =====

test("defect 1: the fixed 8-month window is identical for every selected range", () => {
  const now = new Date("2026-09-09T11:00:00+10:00");
  const expected = { startDate: "2026-02-01", endDate: "2026-09-09" };

  // The window takes no range argument at all — the old code derived its end
  // from range.endDate, so a historical selection truncated the series.
  assert.deepEqual(fixedTrendWindow(now, 8, MEL), expected);

  // Whatever the picker resolves to, the chart window is unmoved.
  for (const r of [
    resolveRange("today", now, MEL),
    resolveRange("ytd", now, MEL),
    resolveRange("custom", now, MEL, "2026-01-01", "2026-02-28"),
    resolveRange("custom", now, MEL, "2025-06-01", "2025-06-30"),
  ]) {
    assert.deepEqual(
      fixedTrendWindow(now, 8, MEL), expected,
      `selecting ${r.label} must not move the fixed chart window`,
    );
  }
});

test("defect 1: a historical selection still charts through the CURRENT month", () => {
  const now = new Date("2026-09-09T11:00:00+10:00");
  // Money in months AFTER a historical range's end date. The old code fetched
  // trendStart -> range.endDate, so these rows were never requested and the
  // chart drew Mar-Sep as zero under a "last 8 months" caption.
  const rows: Transaction[] = [
    { ...good, amount: 5000, fulfilledAt: "2026-03-15T02:00:00Z" },
    { ...good, amount: 7000, fulfilledAt: "2026-09-02T02:00:00Z" },
  ];
  const series = monthlySeries(rows, 8, now, MEL);
  assert.equal(series.length, 8);
  assert.equal(series[0].month, "2026-02");
  assert.equal(series[7].month, "2026-09", "the series ends at the current month, not the picker's");
  assert.equal(series.find((m) => m.month === "2026-03")!.total, 5000);
  assert.equal(series.find((m) => m.month === "2026-09")!.total, 7000);
  assert.equal(series[7].partial, true, "the running month is marked incomplete");
});

// ===== defect 2: business time was the host's time =====

test("defect 2: the business day is Melbourne's, whatever the host or viewer zone", () => {
  // 09:30 on 14 Sep in Melbourne is still 13 Sep in Los Angeles. The business
  // day must not depend on who is looking or where the process runs.
  const instant = new Date("2026-09-14T09:30:00+10:00");
  assert.equal(resolveRange("today", instant, MEL).startDate, "2026-09-14");
  assert.equal(resolveRange("today", instant, LA).startDate, "2026-09-13");
  assert.deepEqual(civilToday(instant, MEL), { y: 2026, m: 9, d: 14 });
  // The default is explicit rather than inherited from the host.
  assert.equal(DEFAULT_BUSINESS_TIMEZONE, MEL);
});

test("defect 2: a 23-hour day (DST start) is still exactly one calendar day", () => {
  // Melbourne springs forward 2am->3am on 4 October 2026.
  const during = new Date("2026-10-04T06:00:00Z");
  const r = resolveRange("today", during, MEL);
  assert.equal(r.startDate, "2026-10-04");
  assert.equal(r.endDate, "2026-10-04");
  const span = new Date(r.endISO).getTime() - new Date(r.startISO).getTime();
  assert.equal(span, 23 * HOUR, "the events window must be 23h, not a fixed 24h");
});

test("defect 2: a 25-hour day (DST end) is still exactly one calendar day", () => {
  // Melbourne falls back 3am->2am on 5 April 2026.
  const during = new Date("2026-04-05T06:00:00Z");
  const r = resolveRange("today", during, MEL);
  assert.equal(r.startDate, "2026-04-05");
  const span = new Date(r.endISO).getTime() - new Date(r.startISO).getTime();
  assert.equal(span, 25 * HOUR, "an hour of appointments must not fall outside the day");
});

test("defect 2: multi-day ranges spanning a DST change keep their exact day count", () => {
  const after = new Date("2026-10-06T11:00:00+11:00"); // two days past the shift
  assert.equal(resolveRange("7d", after, MEL).startDate, "2026-09-30",
    "7d inclusive of today, unmoved by the 23-hour day inside it");
  assert.equal(resolveRange("30d", after, MEL).startDate, "2026-09-07");
  // ms arithmetic would have landed a day early or late here.
  assert.equal(civilStrOf(addCivilDays({ y: 2026, m: 10, d: 6 }, -6)), "2026-09-30");
});

function civilStrOf(c: { y: number; m: number; d: number }) {
  return `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

test("defect 2: month and year boundaries resolve in business time", () => {
  // 00:30 on 1 September in Melbourne is 31 August in UTC and in LA.
  const justAfterMidnight = new Date("2026-09-01T00:30:00+10:00");
  const mtd = resolveRange("mtd", justAfterMidnight, MEL);
  assert.equal(mtd.startDate, "2026-09-01");
  assert.equal(mtd.endDate, "2026-09-01");
  const ytd = resolveRange("ytd", new Date("2026-01-01T00:30:00+11:00"), MEL);
  assert.equal(ytd.startDate, "2026-01-01");
  assert.equal(ytd.endDate, "2026-01-01");
});

test("defect 2: payments are bucketed into business months, not host months", () => {
  const now = new Date("2026-09-09T11:00:00+10:00");
  // 2026-08-31T15:00Z is 1 September 01:00 in Melbourne: September money.
  // Grouped on a UTC or US host it lands in August and moves real revenue
  // between columns depending only on where the process runs.
  const rows: Transaction[] = [{ ...good, amount: 2400, fulfilledAt: "2026-08-31T15:00:00Z" }];
  const series = monthlySeries(rows, 8, now, MEL);
  assert.equal(series.find((m) => m.month === "2026-09")!.total, 2400);
  assert.equal(series.find((m) => m.month === "2026-08")!.total, 0);
});

test("defect 2: the resolved range carries the timezone that produced it", () => {
  const r = resolveRange("30d", new Date("2026-09-09T11:00:00+10:00"), MEL);
  assert.equal(r.timezone, MEL, "the page must label timestamps with this, not the server's zone");
});

test("defect 2: business midnight is solved, not assumed, across the DST edge", () => {
  // The instant before/after a shift has a different offset; a fixed offset
  // would put these an hour out and silently move a day boundary.
  assert.equal(zonedStartOfDay({ y: 2026, m: 10, d: 3 }, MEL).toISOString(), "2026-10-02T14:00:00.000Z");
  assert.equal(zonedStartOfDay({ y: 2026, m: 10, d: 5 }, MEL).toISOString(), "2026-10-04T13:00:00.000Z");
});

test("defect 2: an impossible custom date is rejected, not rolled forward", () => {
  const now = new Date("2026-09-09T11:00:00+10:00");
  assert.equal(parseCivil("2026-02-31"), null, "31 February must not become 3 March");
  assert.equal(parseCivil("not-a-date"), null);
  assert.equal(parseCivil("2026-02-28")!.d, 28);
  // A rejected bound falls back to today rather than to a silently wrong day.
  assert.equal(resolveRange("custom", now, MEL, "2026-02-31", "2026-03-05").endDate, "2026-09-09");
});
