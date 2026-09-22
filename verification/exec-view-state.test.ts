/**
 * E1.1 — the picker highlight, the banner and the rendered figures must always
 * describe the SAME period.
 *
 * These exercise the seam ExecDashboard actually consumes: the component calls
 * deriveViewState() for both the chip states and the banner, so a case that
 * passes here is the case the board renders. The earlier request-gate tests
 * cover which response may commit; they say nothing about what is displayed
 * while one is in flight, which is where the review found the defect.
 *
 * Run: node --test tests/exec-view-state.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveViewState,
  selectionMatchesRange,
  describeSelection,
  customRangeComplete,
  civilLabel,
  formatMoney,
  type DisplayedRange,
} from "../src/lib/exec-view-state.ts";


const RANGE_30D: DisplayedRange = {
  key: "30d", label: "11 Aug 2026 to 9 Sept 2026",
  startDate: "2026-08-11", endDate: "2026-09-09",
};
const RANGE_CUSTOM_JANFEB: DisplayedRange = {
  key: "custom", label: "1 Jan 2026 to 28 Feb 2026",
  startDate: "2026-01-01", endDate: "2026-02-28",
};
const sel = (rangeKey: string, customStart = "", customEnd = "") => ({ rangeKey, customStart, customEnd });
const derive = (o: Partial<Parameters<typeof deriveViewState>[0]> = {}) =>
  deriveViewState({
    range: RANGE_30D, loading: false, error: null,
    selection: sel("30d"), presetLabel: "30 days", ...o,
  });

// ===== the settled, correct case =====

test("when the payload matches the selection nothing is flagged", () => {
  const v = derive();
  assert.equal(v.sync, "aligned");
  assert.equal(v.showingPrevious, false);
  assert.equal(v.activeChipKey, "30d");
  assert.equal(v.requestedChipKey, null, "no pending marker when the board is current");
});

// ===== defect: a pending request highlighted the new chip over old figures =====

test("while a new preset loads, the highlight stays on the period ON SCREEN", () => {
  const v = derive({ loading: true, selection: sel("ytd"), presetLabel: "Year to date" });
  assert.equal(v.sync, "pending");
  assert.equal(v.showingPrevious, true);
  assert.equal(v.activeChipKey, "30d",
    "the highlighted chip must describe the figures that are actually rendered");
  assert.equal(v.requestedChipKey, "ytd", "the requested period is marked separately");
  assert.equal(v.displayedLabel, "11 Aug 2026 to 9 Sept 2026");
  assert.equal(v.requestedLabel, "Year to date");
});

test("the highlight and the figures never describe different periods, in any state", () => {
  for (const [loading, error] of [[true, null], [false, "boom"], [false, null]] as const) {
    const v = deriveViewState({
      range: RANGE_30D, loading, error,
      selection: sel("ytd"), presetLabel: "Year to date",
    });
    assert.equal(v.activeChipKey, RANGE_30D.key,
      `highlight must follow the payload (loading=${loading}, error=${error})`);
    assert.equal(v.showingPrevious, true);
  }
});

test("a failed request keeps the old period highlighted and names what failed", () => {
  const v = derive({ error: "metrics request failed (503)", selection: sel("today"), presetLabel: "Today" });
  assert.equal(v.sync, "failed");
  assert.equal(v.activeChipKey, "30d");
  assert.equal(v.requestedChipKey, "today");
  assert.equal(v.requestedLabel, "Today");
});

test("with no payload yet the selection may hold the highlight", () => {
  const v = derive({ range: null, loading: true, selection: sel("ytd"), presetLabel: "Year to date" });
  assert.equal(v.activeChipKey, "ytd", "nothing on screen to disagree with");
  assert.equal(v.showingPrevious, false);
  assert.equal(v.displayedLabel, null);
});

// ===== defect: custom-to-custom is invisible to a key comparison =====

test("two DIFFERENT custom ranges are not treated as the same view", () => {
  const v = deriveViewState({
    range: RANGE_CUSTOM_JANFEB, loading: true, error: null,
    selection: sel("custom", "2026-03-01", "2026-04-30"), presetLabel: undefined,
  });
  assert.equal(v.sync, "pending", "same key, different period — this is NOT aligned");
  assert.equal(v.showingPrevious, true);
  assert.equal(v.displayedLabel, "1 Jan 2026 to 28 Feb 2026");
  assert.equal(v.requestedLabel, "1 Mar 2026 to 30 Apr 2026",
    "the requested custom range must name its dates; 'Custom' cannot distinguish the two");
});

test("the SAME custom range is aligned", () => {
  const v = deriveViewState({
    range: RANGE_CUSTOM_JANFEB, loading: false, error: null,
    selection: sel("custom", "2026-01-01", "2026-02-28"), presetLabel: undefined,
  });
  assert.equal(v.sync, "aligned");
  assert.equal(v.requestedChipKey, null);
});

test("a reversed custom pair matches the range the server ordered", () => {
  // The server swaps start/end back into order, so the payload comes back
  // ordered. Comparing raw input would report a false mismatch forever.
  assert.equal(
    selectionMatchesRange(RANGE_CUSTOM_JANFEB, sel("custom", "2026-02-28", "2026-01-01")),
    true,
  );
});

test("a custom selection never matches a preset payload", () => {
  assert.equal(selectionMatchesRange(RANGE_30D, sel("custom", "2026-01-01", "2026-02-28")), false);
  assert.equal(selectionMatchesRange(RANGE_CUSTOM_JANFEB, sel("30d")), false);
});

// ===== defect: half-entered custom claimed a failure =====

test("a half-entered custom range asks for the missing date, it does not report a failure", () => {
  for (const s of [sel("custom", "2026-03-01", ""), sel("custom", "", "2026-04-30"), sel("custom")]) {
    const v = deriveViewState({
      range: RANGE_30D, loading: false, error: null, selection: s, presetLabel: undefined,
    });
    assert.equal(v.sync, "needs-input", "nothing was requested, so nothing failed");
    assert.equal(v.activeChipKey, "30d", "the figures on screen are still the previous period");
    assert.equal(v.requestedLabel, "a custom range");
  }
});

test("needs-input outranks a stale error from an earlier request", () => {
  // Clearing a date after a failure must not keep claiming the failure.
  const v = deriveViewState({
    range: RANGE_30D, loading: false, error: "metrics request failed (503)",
    selection: sel("custom", "2026-03-01", ""), presetLabel: undefined,
  });
  assert.equal(v.sync, "needs-input");
});

test("customRangeComplete only passes when both bounds are present", () => {
  assert.equal(customRangeComplete(sel("custom", "2026-03-01", "2026-04-30")), true);
  assert.equal(customRangeComplete(sel("custom", "2026-03-01", "")), false);
  assert.equal(customRangeComplete(sel("30d")), true, "presets need no bounds");
});

// ===== labels =====

test("a settled payload for another period is reported, never silently accepted", () => {
  const v = derive({ loading: false, error: null, selection: sel("ytd"), presetLabel: "Year to date" });
  assert.equal(v.sync, "failed", "not loading, no error, wrong period — must not read as aligned");
  assert.equal(v.showingPrevious, true);
});

test("civil dates are labelled without a timezone shift", () => {
  assert.equal(civilLabel("2026-01-01"), "1 Jan 2026");
  assert.equal(civilLabel("2026-12-31"), "31 Dec 2026");
  assert.equal(civilLabel("garbage"), "garbage", "an unparseable bound is shown as-is");
});

test("a single-day custom range is described as one day", () => {
  assert.equal(describeSelection(sel("custom", "2026-03-01", "2026-03-01"), undefined), "1 Mar 2026");
});

// ===== defect: narrowSymbol rendered several currencies as a bare "$" =====

test("the ISO currency code is visible, so AUD and USD cannot be confused", () => {
  const audText = formatMoney(268400, "AUD");
  const usdText = formatMoney(268400, "USD");
  assert.match(audText, /AUD/, "the recurring figure must state its currency");
  assert.match(usdText, /USD/);
  assert.notEqual(audText, usdText,
    "narrowSymbol rendered both of these as '$268,400.00' — indistinguishable");
  assert.match(audText, /268,400\.00/, "the amount is still readable");
});

test("every dollar-symbol currency is distinguishable from every other", () => {
  const dollarish = ["AUD", "USD", "NZD", "CAD", "SGD"];
  const rendered = dollarish.map((c) => formatMoney(1234.5, c));
  assert.equal(new Set(rendered).size, dollarish.length,
    `all five must render differently, got: ${rendered.join(" | ")}`);
  for (const c of dollarish) assert.match(formatMoney(1234.5, c), new RegExp(c));
});

test("an unknown currency code is shown rather than swallowed", () => {
  assert.match(formatMoney(10, "NOT-A-CODE"), /NOT-A-CODE/);
  assert.match(formatMoney(10, "NOT-A-CODE"), /10\.00/);
});
