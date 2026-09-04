/**
 * /board rides on the SAME Rhys credential as /exec.
 *
 * The action board is Rhys's surface, not the operator's, so it joins the
 * Rhys-only prefix list rather than getting a credential of its own. Two
 * credentials for one person is two things to rotate and two things to leak;
 * Basic Auth is scoped per origin+realm, so one login already opens both.
 *
 * What this pins:
 *   - the operator pair is refused on /board and /api/board (401, not 403)
 *   - the Rhys pair opens BOTH /exec and /board with the same header
 *   - no credentials get 401
 *   - a Cf-Access JWT proves "someone with Access", not Rhys — refused here
 *     exactly as it is on /exec
 *   - the x-mc-principal tag /api/board trusts cannot be forged by sending it
 *
 * Run: node --test tests/middleware-board-gate.test.ts
 * Lives outside src/ so it is never pulled into the Next build graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    return nextResolve(specifier, context);
  },
});

// Middleware reads auth config at module load — set env BEFORE importing.
process.env.MISSION_CONTROL_AUTH_USER = "operator";
process.env.MISSION_CONTROL_AUTH_PASSWORD = "operator-pass";
process.env.MISSION_CONTROL_RHYS_USER = "rhys";
process.env.MISSION_CONTROL_RHYS_PASSWORD = "rhys-pass";
delete process.env.CF_ACCESS_TEAM_DOMAIN;
delete process.env.CF_ACCESS_AUD;

const { middleware } = await import("../src/middleware.ts");
const { NextRequest } = await import("next/server.js");

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: { host: "localhost:3000", ...headers } });

const OPERATOR = { authorization: basic("operator", "operator-pass") };
const RHYS = { authorization: basic("rhys", "rhys-pass") };

const BOARD_PATHS = ["/board", "/board/", "/board/anything", "/api/board"];

function principalOf(response: Response): string | null {
  return response.headers.get("x-middleware-request-x-mc-principal");
}

test("operator credential is REFUSED on the action board", async () => {
  for (const path of BOARD_PATHS) {
    const res = await middleware(req(path, OPERATOR));
    assert.equal(res.status, 401, `${path} must 401 for the operator pair`);
    assert.equal(res.headers.get("www-authenticate"), 'Basic realm="Atlas Mission Control"');
  }
});

test("no credentials are REFUSED on the action board", async () => {
  for (const path of BOARD_PATHS) {
    const res = await middleware(req(path));
    assert.equal(res.status, 401, `${path} must 401 unauthenticated`);
  }
});

test("wrong password on the Rhys user is REFUSED on the action board", async () => {
  const res = await middleware(req("/board", { authorization: basic("rhys", "not-the-pass") }));
  assert.equal(res.status, 401);
});

test("the Rhys pair opens the action board and is tagged as rhys", async () => {
  for (const path of BOARD_PATHS) {
    const res = await middleware(req(path, RHYS));
    assert.equal(res.status, 200, `${path} must pass for the Rhys pair`);
    assert.equal(res.headers.get("x-middleware-next"), "1");
    assert.equal(principalOf(res), "rhys");
  }
});

test("ONE login covers both surfaces — the same header opens /exec and /board", async () => {
  const exec = await middleware(req("/exec", RHYS));
  const board = await middleware(req("/board", RHYS));
  assert.equal(exec.status, 200);
  assert.equal(board.status, 200);
  assert.equal(principalOf(exec), principalOf(board));
});

test("a forged x-mc-principal header cannot reach the action board", async () => {
  // No credentials, but claiming to be Rhys. Middleware never reads the
  // inbound value — it only ever writes its own.
  const res = await middleware(req("/board", { "x-mc-principal": "rhys" }));
  assert.equal(res.status, 401);

  // With the operator pair the header is still overwritten, not honoured.
  const asOperator = await middleware(req("/", { ...OPERATOR, "x-mc-principal": "rhys" }));
  assert.equal(asOperator.status, 200);
  assert.equal(principalOf(asOperator), "operator", "middleware must overwrite a client-sent principal");
});

test("routes outside the board are unaffected by the new prefixes", async () => {
  for (const path of ["/", "/api/health", "/workspace", "/boardroom-not-a-thing"]) {
    const res = await middleware(req(path, OPERATOR));
    assert.equal(res.status, 200, `${path} must still open for the operator pair`);
    assert.equal(principalOf(res), "operator");
  }
});
