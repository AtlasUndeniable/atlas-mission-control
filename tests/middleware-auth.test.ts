/**
 * Isolated unit test for the Basic Auth middleware.
 * Regression guard for the Host-header auth bypass: a client-supplied
 * "Host: localhost" must NOT skip Basic Auth, and a MagicDNS Host must
 * NOT 403 a request carrying valid credentials.
 * Run: node --test tests/middleware-auth.test.ts   (Node 25 strips TS types)
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

// The middleware reads auth config at module load — set env before importing.
// CF Access vars are explicitly deleted: this file pins the JWT path OFF
// (fail-closed) when Cloudflare Access is not configured.
process.env.MISSION_CONTROL_AUTH_USER = "test-user";
process.env.MISSION_CONTROL_AUTH_PASSWORD = "test-pass";
delete process.env.CF_ACCESS_TEAM_DOMAIN;
delete process.env.CF_ACCESS_AUD;

// Any JWKS fetch with CF Access unconfigured is itself a bug — count them.
let jwksFetchAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/cdn-cgi/access/certs")) {
    jwksFetchAttempts += 1;
    return new Response("{}", { status: 500 });
  }
  return realFetch(input as RequestInfo, init as RequestInit);
}) as typeof fetch;

const { middleware } = await import("../src/middleware.ts");
const { NextRequest } = await import("next/server.js");

test('"Host: localhost" with no credentials gets 401 (no bypass)', async () => {
  const request = new NextRequest("http://localhost:3000/", {
    headers: { host: "localhost:3000" },
  });
  const response = await middleware(request);
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Basic realm="Atlas Mission Control"',
  );
});

test("MagicDNS Host with valid credentials is allowed (no 403)", async () => {
  const request = new NextRequest("http://atlas-studio.tail1234.ts.net/", {
    headers: {
      host: "atlas-studio.tail1234.ts.net",
      authorization: `Basic ${Buffer.from("test-user:test-pass").toString("base64")}`,
    },
  });
  const response = await middleware(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("wrong credentials get 401 regardless of Host", async () => {
  const request = new NextRequest("http://localhost:3000/", {
    headers: {
      host: "localhost:3000",
      authorization: `Basic ${Buffer.from("test-user:wrong").toString("base64")}`,
    },
  });
  const response = await middleware(request);
  assert.equal(response.status, 401);
});

test("Cf-Access JWT header with CF env unset: path stays OFF, 401, no JWKS fetch", async () => {
  // Well-formed (but meaningless) JWT — must not even trigger a JWKS lookup
  // while CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD are unset.
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const wellFormedJwt = `${b64({ alg: "RS256", kid: "k" })}.${b64({
    iss: "https://testteam.cloudflareaccess.com",
    aud: "expected-aud-tag",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  })}.${Buffer.from("fake-signature").toString("base64url")}`;

  const request = new NextRequest("http://localhost:3000/", {
    headers: { host: "localhost:3000", "cf-access-jwt-assertion": wellFormedJwt },
  });
  const response = await middleware(request);
  assert.equal(response.status, 401);
  assert.equal(jwksFetchAttempts, 0);
});
