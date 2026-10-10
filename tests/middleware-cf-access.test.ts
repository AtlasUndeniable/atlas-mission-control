/**
 * Isolated unit test for the Cloudflare Access JWT path in the middleware.
 * Only a signature-verified Cf-Access-Jwt-Assertion may skip Basic Auth:
 * forged/unsigned tokens and wrong-audience tokens must still 401, and
 * Basic Auth must keep working as the fallback.
 * Run: node --test tests/middleware-cf-access.test.ts   (Node 25 strips TS types)
 *
 * Lives outside src/ so it is never pulled into the Next build graph.
 * The JWKS endpoint is served by a patched globalThis.fetch — no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSrcModuleResolve } from "./helpers/src-module-resolve.ts";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

// src/ uses the bare "next/server" specifier and extensionless relative
// imports; neither resolves under plain Node. One shared hook maps both.
registerSrcModuleResolve();

// The middleware reads all auth config at module load — set env first.
process.env.MISSION_CONTROL_AUTH_USER = "test-user";
process.env.MISSION_CONTROL_AUTH_PASSWORD = "test-pass";
process.env.CF_ACCESS_TEAM_DOMAIN = "testteam.cloudflareaccess.com";
process.env.CF_ACCESS_AUD = "expected-aud-tag";

const TEAM_ISSUER = "https://testteam.cloudflareaccess.com";
const CERTS_URL = `${TEAM_ISSUER}/cdn-cgi/access/certs`;

// Real team key served via the mocked JWKS endpoint, plus a rogue key
// that signs "forged" tokens the JWKS knows nothing about.
const teamKeys = await generateKeyPair("RS256");
const rogueKeys = await generateKeyPair("RS256");
const teamJwk = { ...(await exportJWK(teamKeys.publicKey)), kid: "team-key", alg: "RS256", use: "sig" };

const realFetch = globalThis.fetch;
let jwksFetchCount = 0;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === CERTS_URL) {
    jwksFetchCount += 1;
    return new Response(JSON.stringify({ keys: [teamJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input as RequestInfo, init as RequestInit);
}) as typeof fetch;

const { middleware } = await import("../src/middleware.ts");
const { NextRequest } = await import("next/server.js");

type SignKey = typeof teamKeys.privateKey;
function signAccessJwt(
  key: SignKey,
  { aud = "expected-aud-tag", iss = TEAM_ISSUER, kid = "team-key" } = {},
): Promise<string> {
  return new SignJWT({ email: "rhys@undeniablementoring.com" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject("test-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

function tunnelRequest(headers: Record<string, string>): InstanceType<typeof NextRequest> {
  return new NextRequest("https://atlas.undeniable.com/", {
    headers: { host: "atlas.undeniable.com", ...headers },
  });
}

test("valid Cloudflare Access JWT skips Basic Auth (200)", async () => {
  const jwt = await signAccessJwt(teamKeys.privateKey);
  const response = await middleware(
    tunnelRequest({ "cf-access-jwt-assertion": jwt }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.ok(jwksFetchCount >= 1, "verification must consult the JWKS endpoint");
});

test("forged JWT signed by an unknown key is rejected (401)", async () => {
  const jwt = await signAccessJwt(rogueKeys.privateKey);
  const response = await middleware(
    tunnelRequest({ "cf-access-jwt-assertion": jwt }),
  );
  assert.equal(response.status, 401);
});

test("unsigned/garbage assertion is rejected (401)", async () => {
  // alg:none-style unsigned token: valid-looking header+payload, no signature.
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: TEAM_ISSUER,
      aud: "expected-aud-tag",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  ).toString("base64url");

  for (const token of [`${header}.${payload}.`, "not-a-jwt"]) {
    const response = await middleware(
      tunnelRequest({ "cf-access-jwt-assertion": token }),
    );
    assert.equal(response.status, 401);
  }
});

test("correctly signed JWT with wrong aud is rejected (401)", async () => {
  const jwt = await signAccessJwt(teamKeys.privateKey, { aud: "some-other-app" });
  const response = await middleware(
    tunnelRequest({ "cf-access-jwt-assertion": jwt }),
  );
  assert.equal(response.status, 401);
});

test("expired JWT signed by the team key is rejected (401)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "team-key" })
    .setIssuer(TEAM_ISSUER)
    .setAudience("expected-aud-tag")
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 3600)
    .sign(teamKeys.privateKey);
  const response = await middleware(
    tunnelRequest({ "cf-access-jwt-assertion": jwt }),
  );
  assert.equal(response.status, 401);
});

test("valid Basic Auth still works with CF Access configured (200)", async () => {
  const response = await middleware(
    tunnelRequest({
      authorization: `Basic ${Buffer.from("test-user:test-pass").toString("base64")}`,
    }),
  );
  assert.equal(response.status, 200);
});

test("no credentials at all still gets 401", async () => {
  const response = await middleware(tunnelRequest({}));
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Basic realm="Atlas Mission Control"',
  );
});

test("forgeable Cf-Access-* identity headers alone never authenticate (401)", async () => {
  const response = await middleware(
    tunnelRequest({
      "cf-access-authenticated-user-email": "rhys@undeniablementoring.com",
      "cf-access-username": "rhys",
    }),
  );
  assert.equal(response.status, 401);
});

test("team-key-signed token missing exp is rejected (401)", async () => {
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "team-key" })
    .setIssuer(TEAM_ISSUER)
    .setAudience("expected-aud-tag")
    .setIssuedAt()
    .sign(teamKeys.privateKey);
  const response = await middleware(
    tunnelRequest({ "cf-access-jwt-assertion": jwt }),
  );
  assert.equal(response.status, 401);
});

test("team-key-signed token missing iat is rejected (401)", async () => {
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "team-key" })
    .setIssuer(TEAM_ISSUER)
    .setAudience("expected-aud-tag")
    .setExpirationTime("5m")
    .sign(teamKeys.privateKey);
  const response = await middleware(
    tunnelRequest({ "cf-access-jwt-assertion": jwt }),
  );
  assert.equal(response.status, 401);
});

// Keep this test LAST: it pins the JWKS cache across everything above.
test("JWKS is fetched once and cached across all verifications", async () => {
  const jwt = await signAccessJwt(teamKeys.privateKey);
  const response = await middleware(
    tunnelRequest({ "cf-access-jwt-assertion": jwt }),
  );
  assert.equal(response.status, 200);
  assert.equal(jwksFetchCount, 1);
});
