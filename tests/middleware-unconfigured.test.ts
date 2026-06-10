/**
 * Isolated unit test for the fail-closed 503 path: when the Basic Auth env
 * vars are unset, EVERY request gets 503 — including ones presenting Basic
 * credentials or a Cf-Access-Jwt-Assertion. Lives in its own file because
 * the middleware reads env at module load and node --test gives each file
 * its own process.
 * Run: node --test tests/middleware-unconfigured.test.ts   (Node 25 strips TS types)
 *
 * Lives outside src/ so it is never pulled into the Next build graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// next's package.json has no ESM exports map, so the bare "next/server"
// specifier used in src does not resolve under plain Node — map it to the
// real file here rather than de-idiomatising the src import.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    return nextResolve(specifier, context);
  },
});

// Basic Auth env UNSET; CF Access configured — the 503 must still win,
// before any JWT handling.
delete process.env.MISSION_CONTROL_AUTH_USER;
delete process.env.MISSION_CONTROL_AUTH_PASSWORD;
process.env.CF_ACCESS_TEAM_DOMAIN = "testteam.cloudflareaccess.com";
process.env.CF_ACCESS_AUD = "expected-aud-tag";

const { middleware } = await import("../src/middleware.ts");
const { NextRequest } = await import("next/server.js");

function makeRequest(headers: Record<string, string> = {}): InstanceType<typeof NextRequest> {
  return new NextRequest("http://localhost:3031/", {
    headers: { host: "localhost:3031", ...headers },
  });
}

test("no credentials: 503, not a Basic Auth challenge", async () => {
  const response = await middleware(makeRequest());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("Basic credentials presented: still 503 (nothing to match against)", async () => {
  const response = await middleware(
    makeRequest({
      authorization: `Basic ${Buffer.from("anyone:anything").toString("base64")}`,
    }),
  );
  assert.equal(response.status, 503);
});

test("Cf-Access-Jwt-Assertion presented: still 503", async () => {
  const response = await middleware(
    makeRequest({ "cf-access-jwt-assertion": "some.jwt.token" }),
  );
  assert.equal(response.status, 503);
});
