/**
 * E1 defect 5 — rapid picker changes could show an old request's figures under
 * the new selection.
 *
 * Every test resolves requests DELIBERATELY OUT OF ORDER, which is the only
 * way this bug appears: the slow "Year to date" fan-out returning after the
 * fast "Today" read is not an edge case, it is the normal relative timing of
 * those two endpoints.
 *
 * Run: node --test tests/exec-request-gate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestGate, isAbort } from "../src/lib/exec-request-gate.ts";

/** A board that commits whatever the gate lets through. */
function board() {
  const gate = createRequestGate();
  const state = { shown: null as string | null, errors: [] as string[], commits: 0 };

  async function load(label: string, resolver: Promise<string>) {
    const { seq, signal } = gate.begin();
    try {
      const value = await resolver;
      if (!gate.isCurrent(seq)) return;      // superseded: must not paint
      state.shown = value;
      state.commits += 1;
    } catch (e) {
      if (!gate.isCurrent(seq) || isAbort(e)) return;
      state.errors.push(`${label}: ${(e as Error).message}`);
    }
    void signal;
  }

  return { gate, state, load };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a slower EARLIER request cannot overwrite a faster later one", async () => {
  const b = board();
  const ytd = deferred<string>();
  const today = deferred<string>();

  const a = b.load("ytd", ytd.promise);      // clicked first, slow
  const c = b.load("today", today.promise);  // clicked second, fast

  today.resolve("TODAY $1,200");
  await c;
  assert.equal(b.state.shown, "TODAY $1,200");

  // The year-to-date read now lands, long after it was superseded.
  ytd.resolve("YTD $980,000");
  await a;

  assert.equal(b.state.shown, "TODAY $1,200",
    "the superseded YTD response must never replace the current selection");
  assert.equal(b.state.commits, 1, "exactly one response was allowed to paint");
});

test("the newest request still wins when responses arrive in order", async () => {
  const b = board();
  const first = deferred<string>();
  const second = deferred<string>();
  const a = b.load("7d", first.promise);
  const c = b.load("30d", second.promise);

  first.resolve("7D");    // superseded, arrives first
  await a;
  second.resolve("30D");
  await c;

  assert.equal(b.state.shown, "30D");
  assert.equal(b.state.commits, 1);
});

test("three rapid clicks paint only the last, whatever order they return in", async () => {
  const b = board();
  const d = [deferred<string>(), deferred<string>(), deferred<string>()];
  const runs = [
    b.load("today", d[0].promise),
    b.load("7d", d[1].promise),
    b.load("ytd", d[2].promise),
  ];

  // Reverse order: the last click returns first, the first click returns last.
  d[2].resolve("YTD");
  d[1].resolve("7D");
  d[0].resolve("TODAY");
  await Promise.all(runs);

  assert.equal(b.state.shown, "YTD", "only the final selection may be on screen");
  assert.equal(b.state.commits, 1);
});

test("a superseded request that FAILS does not raise an error on the new view", async () => {
  const b = board();
  const slow = deferred<string>();
  const fast = deferred<string>();
  const a = b.load("ytd", slow.promise);
  const c = b.load("today", fast.promise);

  fast.resolve("TODAY $1,200");
  await c;
  slow.reject(new Error("metrics request failed (504)"));
  await a;

  assert.deepEqual(b.state.errors, [],
    "the abandoned request's failure is not the current view's failure");
  assert.equal(b.state.shown, "TODAY $1,200");
});

test("a CURRENT request that fails does surface, so a failure is never swallowed", async () => {
  const b = board();
  const only = deferred<string>();
  const run = b.load("30d", only.promise);
  only.reject(new Error("metrics request failed (503)"));
  await run;
  assert.deepEqual(b.state.errors, ["30d: metrics request failed (503)"]);
  assert.equal(b.state.shown, null, "nothing is invented to fill the gap");
});

test("beginning a request aborts the one it supersedes", () => {
  const gate = createRequestGate();
  const first = gate.begin();
  assert.equal(first.signal.aborted, false);
  const second = gate.begin();
  assert.equal(first.signal.aborted, true, "the superseded read is cancelled");
  assert.equal(second.signal.aborted, false);
  assert.equal(gate.isCurrent(first.seq), false);
  assert.equal(gate.isCurrent(second.seq), true);
});

test("closing the gate invalidates everything in flight", async () => {
  const b = board();
  const pending = deferred<string>();
  const run = b.load("30d", pending.promise);
  b.gate.close();
  pending.resolve("LATE");
  await run;
  assert.equal(b.state.shown, null, "nothing may commit after unmount");
  assert.equal(b.state.commits, 0);
});

test("cancellation is never reported to the user as a metrics failure", () => {
  const abort = new Error("The operation was aborted."); abort.name = "AbortError";
  const timeout = new Error("timed out"); timeout.name = "TimeoutError";
  assert.equal(isAbort(abort), true);
  assert.equal(isAbort(timeout), true);
  assert.equal(isAbort(new Error("metrics request failed (500)")), false,
    "a real failure must still be shown");
});
