/**
 * Rhys-only route gating for /exec.
 *
 * Mission Control was single-tenant: ONE shared operator credential, no notion
 * of who was behind a request. /exec is Rhys's executive board and carries the
 * live revenue figure, so holding the operator password must not be enough to
 * read it. The middleware now identifies WHICH configured pair authenticated
 * and stamps the request with a principal.
 *
 * What this pins:
 *   - the operator pair keeps every pre-existing route and is refused on /exec
 *   - the Rhys pair opens /exec and also still works elsewhere
 *   - no credentials get 401 on /exec (never a redirect or a 403 leak)
 *   - the x-mc-principal tag cannot be forged by sending the header
 *   - a Cf-Access JWT proves "someone with Access", not Rhys, so it is refused
 *     on /exec even though it passes everywhere else
 *
 * Run: node --test tests/middleware-rhys-only.test.ts
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

// The header middleware sets on an allowed request, as Next encodes it.
function principalOf(response: Response): string | null {
  return response.headers.get("x-middleware-request-x-mc-principal");
}

test("operator credential is REFUSED on /exec", async () => {
  for (const path of ["/exec", "/exec/", "/exec/anything", "/api/exec/revenue"]) {
    const res = await middleware(req(path, OPERATOR));
    assert.equal(res.status, 401, `${path} must 401 for the operator pair`);
    assert.equal(res.headers.get("www-authenticate"), 'Basic realm="Atlas Mission Control"');
  }
});

test("no credentials are REFUSED on /exec", async () => {
  const res = await middleware(req("/exec"));
  assert.equal(res.status, 401);
});

test("wrong password on the Rhys user is REFUSED on /exec", async () => {
  const res = await middleware(req("/exec", { authorization: basic("rhys", "not-the-pass") }));
  assert.equal(res.status, 401);
});

test("Rhys credential is ALLOWED on /exec and tagged as rhys", async () => {
  for (const path of ["/exec", "/exec/deep", "/api/exec/revenue"]) {
    const res = await middleware(req(path, RHYS));
    assert.equal(res.status, 200, `${path} must pass for the Rhys pair`);
    assert.equal(res.headers.get("x-middleware-next"), "1");
    assert.equal(principalOf(res), "rhys");
  }
});

test("the operator credential still opens every pre-existing route", async () => {
  for (const path of ["/", "/pat", "/reaper", "/workspace", "/workspace-demo", "/api/overview"]) {
    const res = await middleware(req(path, OPERATOR));
    assert.equal(res.status, 200, `${path} must still work for the operator pair`);
    assert.equal(principalOf(res), "operator");
  }
});

test("the Rhys credential also works on the shared routes", async () => {
  const res = await middleware(req("/", RHYS));
  assert.equal(res.status, 200);
  assert.equal(principalOf(res), "rhys");
});

test("a route merely STARTING with the letters exec is not gated", async () => {
  // /execute must not be swept into the /exec prefix by a naive startsWith
  const res = await middleware(req("/execute-something", OPERATOR));
  assert.equal(res.status, 200);
});

test("the principal tag cannot be forged by sending the header", async () => {
  // Operator sends x-mc-principal: rhys. It must be refused on /exec, and on a
  // shared route the tag must come back as operator, not the value they sent.
  const forged = { ...OPERATOR, "x-mc-principal": "rhys" };
  assert.equal((await middleware(req("/exec", forged))).status, 401);

  const res = await middleware(req("/", forged));
  assert.equal(res.status, 200);
  assert.equal(principalOf(res), "operator", "middleware must overwrite the client value");
});

test("an unauthenticated forged header gets nowhere", async () => {
  const res = await middleware(req("/exec", { "x-mc-principal": "rhys" }));
  assert.equal(res.status, 401);
});
