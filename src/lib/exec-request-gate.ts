/**
 * Latest-request gate for the executive board's metric fetches.
 *
 * THE FAILURE THIS PREVENTS. /exec fires one request per picker click, and
 * those reads are slow and very uneven — a year-to-date calendar fan-out can
 * take tens of seconds while "today" returns almost immediately. With no gate,
 * clicking "Year to date" and then "Today" lets the slower YTD response land
 * second and overwrite the Today figures. The picker then highlights Today
 * above a full year of revenue. Nothing looks broken: every tile agrees with
 * every other tile, the freshness marks are green, and the number is simply
 * wrong by an order of magnitude. That is precisely the class of error this
 * board exists to make impossible.
 *
 * Two independent mechanisms, because neither alone is sufficient:
 *
 *   - The sequence number decides which response may COMMIT. This is the
 *     correctness guarantee. It holds even when a request cannot be cancelled,
 *     when a response is already in flight, or when the abort arrives too late.
 *   - The AbortSignal stops the superseded read from holding a connection and
 *     lets the server drop the work. This is an efficiency measure, and it is
 *     explicitly NOT relied on for correctness: an abort that loses the race is
 *     still caught by the sequence check.
 *
 * Kept out of the component so the out-of-order case can be tested directly —
 * the bug is a race, and a race that is only exercised through a rendered tree
 * is not really being tested.
 */

export interface RequestTicket {
  /** Monotonic id for this attempt. Pass back to `isCurrent`. */
  seq: number;
  /** Aborted as soon as a later request begins, or on `close()`. */
  signal: AbortSignal;
}

export interface RequestGate {
  begin(): RequestTicket;
  /** True only while `seq` is still the newest attempt. */
  isCurrent(seq: number): boolean;
  /** Invalidate everything in flight, e.g. on unmount. */
  close(): void;
}

export function createRequestGate(): RequestGate {
  let seq = 0;
  let inflight: AbortController | null = null;

  return {
    begin() {
      // Abort the previous attempt BEFORE bumping the sequence, so the
      // resulting AbortError is attributed to the request that was superseded.
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      seq += 1;
      return { seq, signal: controller.signal };
    },
    isCurrent(candidate: number) {
      return candidate === seq;
    },
    close() {
      inflight?.abort();
      inflight = null;
      // Nothing outstanding may commit after this point.
      seq += 1;
    },
  };
}

/**
 * Was this rejection just a superseded request being cancelled on purpose?
 * Those must never surface as an error to Rhys — the newer request is already
 * running and will paint the board.
 */
export function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}
