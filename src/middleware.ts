import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_USER = process.env.MISSION_CONTROL_AUTH_USER;
const AUTH_PASSWORD = process.env.MISSION_CONTROL_AUTH_PASSWORD;

// ===== RHYS-ONLY CREDENTIAL =====
// A SECOND Basic Auth pair. Mission Control was single-tenant: one shared
// operator credential with no notion of who is behind it. /exec is Rhys's
// board and must not be readable by whoever holds the operator password, so
// the middleware now identifies WHICH pair authenticated and tags the request.
const RHYS_USER = process.env.MISSION_CONTROL_RHYS_USER;
const RHYS_PASSWORD = process.env.MISSION_CONTROL_RHYS_PASSWORD;

/** Who is behind this request. Never inferred from a client-supplied header. */
type Principal = "operator" | "rhys" | "cf-access";

/**
 * Downstream routes read this to know who they are serving. Middleware ALWAYS
 * sets it from its own check and never forwards a client-supplied value, so it
 * cannot be spoofed by sending the header.
 */
const PRINCIPAL_HEADER = "x-mc-principal";

/** Path prefixes only the Rhys credential may reach. */
const RHYS_ONLY_PREFIXES = ["/exec", "/api/exec"];

const rhysCredentialConfigured = Boolean(RHYS_USER && RHYS_PASSWORD);

/**
 * A Rhys pair identical to the operator pair would silently hand every
 * operator the executive board. That is a misconfiguration, not a login, so
 * /exec fails closed rather than quietly granting access.
 */
const rhysCredentialIsDistinct =
  rhysCredentialConfigured && !(RHYS_USER === AUTH_USER && RHYS_PASSWORD === AUTH_PASSWORD);

/** Length-independent, constant-time-ish compare: no early exit on first mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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
/** Identify which configured pair the credentials match, or null for neither. */
function identifyBasicAuth(request: NextRequest): Principal | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    const user = decoded.slice(0, colon);
    const pass = decoded.slice(colon + 1);
    // Rhys first: on an identical pair the narrower principal must win, and
    // rhysCredentialIsDistinct gates /exec separately if they were duplicated.
    if (RHYS_USER && RHYS_PASSWORD && safeEqual(user, RHYS_USER) && safeEqual(pass, RHYS_PASSWORD)) {
      return "rhys";
    }
    if (AUTH_USER && AUTH_PASSWORD && safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASSWORD)) {
      return "operator";
    }
    return null;
  } catch {
    return null;
  }
}

function unauthorizedResponse(): NextResponse {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Atlas Mission Control"' },
  });
}

/** Pass the request through, stamped with the principal we actually verified. */
function allow(request: NextRequest, principal: Principal): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(PRINCIPAL_HEADER, principal);   // overwrites any client-sent value
  return NextResponse.next({ request: { headers } });
}

// ===== MIDDLEWARE =====
export async function middleware(request: NextRequest) {
  // Fail closed if auth env vars are not configured
  if (!AUTH_USER || !AUTH_PASSWORD) {
    return new NextResponse("Mission Control auth not configured", { status: 503 });
  }

  const isRhysOnly = RHYS_ONLY_PREFIXES.some(
    (p) => request.nextUrl.pathname === p || request.nextUrl.pathname.startsWith(`${p}/`),
  );

  // Cloudflare tunnel traffic (W1c) authenticates with a verified Access
  // JWT and never sees the Basic Auth dialog. That JWT proves "someone with
  // Access", NOT "Rhys" — it carries no identity claim we check — so it is
  // deliberately not enough for the executive board.
  if (await checkCfAccessJwt(request)) {
    if (isRhysOnly) return unauthorizedResponse();
    return allow(request, "cf-access");
  }

  // Basic Auth on every other request — no bypass. The Host header is
  // client-supplied and must never gate auth or network restrictions;
  // network-level restriction belongs at the bind address (package.json).
  const principal = identifyBasicAuth(request);
  if (!principal) {
    return unauthorizedResponse();
  }

  if (isRhysOnly) {
    if (!rhysCredentialConfigured) {
      return new NextResponse("Executive view not configured", { status: 503 });
    }
    if (!rhysCredentialIsDistinct) {
      return new NextResponse(
        "Executive view misconfigured: the Rhys credential must differ from the operator credential",
        { status: 503 },
      );
    }
    // The operator credential opens every other route and none of this one.
    if (principal !== "rhys") return unauthorizedResponse();
  }

  return allow(request, principal);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
