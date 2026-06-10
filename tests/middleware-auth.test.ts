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
process.env.MISSION_CONTROL_AUTH_USER = "test-user";
process.env.MISSION_CONTROL_AUTH_PASSWORD = "test-pass";

const { middleware } = await import("../src/middleware.ts");
const { NextRequest } = await import("next/server.js");

test('"Host: localhost" with no credentials gets 401 (no bypass)', () => {
  const request = new NextRequest("http://localhost:3000/", {
    headers: { host: "localhost:3000" },
  });
  const response = middleware(request);
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Basic realm="Atlas Mission Control"',
  );
});

test("MagicDNS Host with valid credentials is allowed (no 403)", () => {
  const request = new NextRequest("http://atlas-studio.tail1234.ts.net/", {
    headers: {
      host: "atlas-studio.tail1234.ts.net",
      authorization: `Basic ${Buffer.from("test-user:test-pass").toString("base64")}`,
    },
  });
  const response = middleware(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("wrong credentials get 401 regardless of Host", () => {
  const request = new NextRequest("http://localhost:3000/", {
    headers: {
      host: "localhost:3000",
      authorization: `Basic ${Buffer.from("test-user:wrong").toString("base64")}`,
    },
  });
  const response = middleware(request);
  assert.equal(response.status, 401);
});
