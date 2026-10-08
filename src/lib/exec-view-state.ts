/**
 * What the executive board is ACTUALLY showing, versus what was last asked for.
 *
 * THE FAILURE THIS PREVENTS. The board keeps the previous payload on screen
 * while a new range loads, which is right — blanking six tiles on every click
 * would be worse. But the range picker used to highlight the newly clicked chip
 * immediately, so for the whole duration of a slow read the highlighted period
 * and the figures underneath it disagreed. A 30-second year-to-date fan-out is
 * ample time to read a number off the screen and attribute it to the wrong
 * period. The same disagreement appeared on failure.
 *
 * So alignment is derived here, in one place, from the payload that is really
 * rendered — not tracked as a separate flag that can drift from it.
 *
 * CUSTOM-TO-CUSTOM is why this cannot be a key comparison. Moving from
 * 1 Jan - 28 Feb to 1 Mar - 30 Apr leaves `range.key === "custom"` on both
 * sides, so a chip-level check reports agreement while every figure on screen
 * belongs to the other period. The resolved dates are compared for that reason.
 *
 * This module is consumed by ExecDashboard directly; it is not a parallel model
 * of the component's behaviour.
 */

export interface DisplayedRange {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
}

export interface Selection {
  rangeKey: string;
  customStart: string;
  customEnd: string;
}

/**
 * How the on-screen payload relates to the current selection.
 *
 * - `aligned`      figures, period label and provenance all describe the selection.
 * - `pending`      a different period is loading; the old payload is still shown.
 * - `failed`       the selection could not be loaded; the old payload is still shown.
 * - `needs-input`  a custom range is half-entered, so nothing has been requested.
 */
export type ViewSync = "aligned" | "pending" | "failed" | "needs-input";

/** A custom range is only fully specified once BOTH bounds are present. */
export function customRangeComplete(sel: Selection): boolean {
  return sel.rangeKey !== "custom" || Boolean(sel.customStart && sel.customEnd);
}

/** The bounds as the server will resolve them: reversed pairs are ordered. */
export function orderedCustomBounds(sel: Selection): { start: string; end: string } {
  const { customStart: a, customEnd: b } = sel;
  return a && b && a > b ? { start: b, end: a } : { start: a, end: b };
}

/**
 * Does the rendered payload describe the current selection?
 *
 * Presets are identified by key alone: a preset resolves deterministically from
 * today, so a matching key is a matching period. Custom ranges must match on
 * the resolved dates, because the key carries no period information.
 */
export function selectionMatchesRange(range: DisplayedRange | null, sel: Selection): boolean {
  if (!range) return false;
  if (range.key !== sel.rangeKey) return false;
  if (sel.rangeKey !== "custom") return true;
  if (!customRangeComplete(sel)) return false;
  const { start, end } = orderedCustomBounds(sel);
  return range.startDate === start && range.endDate === end;
}

/** "2026-03-01" -> "1 Mar 2026". Timezone-free: these are civil dates already. */
export function civilLabel(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(
    "en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" },
  );
}

/**
 * Human name for what the user has currently selected — which, for a custom
 * range, must state the dates. "Custom" alone cannot distinguish the range
 * being requested from the different custom range still on screen.
 */
export function describeSelection(sel: Selection, presetLabel: string | undefined): string {
  if (sel.rangeKey !== "custom") return presetLabel ?? sel.rangeKey;
  if (!customRangeComplete(sel)) return "a custom range";
  const { start, end } = orderedCustomBounds(sel);
  return start === end ? civilLabel(start) : `${civilLabel(start)} to ${civilLabel(end)}`;
}

export interface ViewStateInput {
  range: DisplayedRange | null;   // the rendered payload's range, null before first load
  loading: boolean;
  error: string | null;
  selection: Selection;
  presetLabel: string | undefined; // label for selection.rangeKey, when a preset
}

export interface ViewState {
  sync: ViewSync;
  /** True when a previous payload is on screen that is NOT the selection. */
  showingPrevious: boolean;
  /** Which chip to highlight: always the period actually rendered, when one is. */
  activeChipKey: string;
  /** Chip to mark as requested-but-not-yet-shown. Null when aligned. */
  requestedChipKey: string | null;
  /** What is on screen right now. */
  displayedLabel: string | null;
  /** What was asked for. */
  requestedLabel: string;
}

/**
 * Single source of truth for the picker highlight and the banner.
 *
 * The highlight follows the RENDERED payload whenever one is on screen, so the
 * emphasised chip and the figures can never describe different periods. The
 * requested chip is surfaced separately, as a pending marker, which is what
 * "clearly indicate the requested range while loading" needs — without ever
 * letting a request masquerade as a result.
 */
export function deriveViewState(input: ViewStateInput): ViewState {
  const { range, loading, error, selection, presetLabel } = input;
  const aligned = selectionMatchesRange(range, selection);
  const requestedLabel = describeSelection(selection, presetLabel);
  const displayedLabel = range?.label ?? null;

  let sync: ViewSync;
  if (aligned) sync = "aligned";
  else if (!customRangeComplete(selection)) sync = "needs-input";
  else if (error) sync = "failed";
  else if (loading) sync = "pending";
  // Not loading, no error, still not aligned: a settled payload for another
  // period. Treated as failed rather than aligned — it is not what was asked
  // for, and silence is the one thing this must never do.
  else sync = range ? "failed" : "pending";

  return {
    sync,
    showingPrevious: !aligned && range !== null,
    // With no payload at all there is nothing to disagree with, so the
    // selection may hold the highlight.
    activeChipKey: aligned || !range ? selection.rangeKey : range.key,
    requestedChipKey: aligned ? null : selection.rangeKey,
    displayedLabel,
    requestedLabel,
  };
}

/**
 * Money on the recurring line, with the ISO currency code VISIBLE.
 *
 * `currencyDisplay: "narrowSymbol"` was actively misleading here: in en-AU it
 * renders AUD, USD, NZD, CAD and SGD all as a bare "$", so the single case
 * this formatter exists to expose — a feed reporting something other than
 * Australian dollars — looked identical to the case it was meant to be
 * distinguished from. `code` prints "AUD 1,234.50" / "USD 1,234.50".
 *
 * LIMITATION this does not address: the Newie bridge hardcodes
 * `currency: "AUD"` as a constant rather than reading it per row. This renders
 * what the bridge ASSERTS, not a verified per-transaction currency. Confirming
 * that assertion is source reconciliation and remains outstanding.
 */
export function formatMoney(n: number, currency: string): string {
  try {
    return n.toLocaleString("en-AU", {
      style: "currency", currency, currencyDisplay: "code",
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  } catch {
    // An unknown or malformed code must still be shown, not swallowed.
    return `${currency} ${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
