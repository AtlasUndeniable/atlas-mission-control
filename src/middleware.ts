import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_USER = process.env.MISSION_CONTROL_AUTH_USER;
const AUTH_PASSWORD = process.env.MISSION_CONTROL_AUTH_PASSWORD;

// ===== CLOUDFLARE ACCESS JWT =====
// Both env vars must be set or the JWT path stays OFF (Basic Auth only).
// Values come from the Cloudflare Zero Trust dashboard (.env.local).
const CF_ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN;
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD;

const cfAccessIssuer = CF_ACCESS_TEAM_DOMAIN
  ? `https://${CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
  : null;

// Module-scoped so jose's built-in JWKS cache survives across requests.
let cfAccessJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function checkCfAccessJwt(request: NextRequest): Promise<boolean> {
  if (!cfAccessIssuer || !CF_ACCESS_AUD) return false;

  // Only the signed assertion counts. Cf-Access-* identity headers
  // (e.g. Cf-Access-Authenticated-User-Email) are client-forgeable and
  // must never be trusted without this signature check.
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return false;

  try {
    cfAccessJwks ??= createRemoteJWKSet(
      new URL(`${cfAccessIssuer}/cdn-cgi/access/certs`),
    );
    await jwtVerify(token, cfAccessJwks, {
      issuer: cfAccessIssuer,
      audience: CF_ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"],
    });
    return true;
  } catch (error) {
    // Bad signature, wrong aud/iss, expired, malformed, or JWKS fetch
    // failure — all fail closed to the Basic Auth fallback. Log the error
    // class only (never the token) so a JWKS outage is distinguishable
    // from a forged token in the logs.
    const reason =
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    console.warn(`[middleware] Cf-Access JWT rejected — ${reason}`);
    return false;
  }
}

// ===== BASIC AUTH =====
function checkBasicAuth(request: NextRequest): boolean {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    if (colon === -1) return false;
    const user = decoded.slice(0, colon);
    const pass = decoded.slice(colon + 1);
    return user === AUTH_USER && pass === AUTH_PASSWORD;
  } catch {
    return false;
  }
}

function unauthorizedResponse(): NextResponse {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Atlas Mission Control"' },
  });
}

// ===== MIDDLEWARE =====
export async function middleware(request: NextRequest) {
  // Fail closed if auth env vars are not configured
  if (!AUTH_USER || !AUTH_PASSWORD) {
    return new NextResponse("Mission Control auth not configured", { status: 503 });
  }

  // Cloudflare tunnel traffic (W1c) authenticates with a verified Access
  // JWT and never sees the Basic Auth dialog.
  if (await checkCfAccessJwt(request)) {
    return NextResponse.next();
  }

  // Basic Auth on every other request — no bypass. The Host header is
  // client-supplied and must never gate auth or network restrictions;
  // network-level restriction belongs at the bind address (package.json).
  if (!checkBasicAuth(request)) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
