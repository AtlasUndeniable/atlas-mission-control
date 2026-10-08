import {pilotCredential,isPilotLogin} from "./lib/artifact-pilot-auth";
import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { meetingRpc } from "./lib/meetings/transport";

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
type Principal = {name: string; kind: "named" | "shared" | "unmapped"; legacy: "operator" | "rhys" | "cf-access" | null};

// Accepted named-identity mechanism, contained to the meeting queue only.
// Email is a configured login identifier, never trusted from a request header.
// Existing Rhys/operator pairs retain their installed authentication and reach.
type NamedCredential = {name:string; user:string; password:string};
function namedConfiguration(): {credentials:NamedCredential[]; error:boolean} {
  try {
    const raw=process.env.MISSION_CONTROL_NAMED_CREDENTIALS;
    const entries:unknown=raw?.trim()?JSON.parse(raw):[];
    if(!Array.isArray(entries))throw Error();
    const names=new Set<string>(),users=new Set<string>(),pairs=new Set<string>();
    for(const [user,password]of [[AUTH_USER,AUTH_PASSWORD],[RHYS_USER,RHYS_PASSWORD]]) {
      if(user&&password){users.add(user);pairs.add(JSON.stringify([user,password]));}
    }
    const credentials:NamedCredential[]=[];
    for(const c of entries){
      if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.name!=='string'||
        !/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(c.name)||['operator','rhys','cf-access'].includes(c.name)||
        typeof c.user!=='string'||!c.user||c.user.includes(':')||typeof c.password!=='string'||!c.password||
        names.has(c.name)||users.has(c.user)||pairs.has(JSON.stringify([c.user,c.password])))throw Error();
      names.add(c.name);users.add(c.user);pairs.add(JSON.stringify([c.user,c.password]));credentials.push(c);
    }
    return {credentials,error:false};
  } catch {return {credentials:[],error:true};}
}
const NAMED=namedConfiguration();

/**
 * Downstream routes read this to know who they are serving. Middleware ALWAYS
 * sets it from its own check and never forwards a client-supplied value, so it
 * cannot be spoofed by sending the header.
 */
const PRINCIPAL_HEADER = "x-mc-principal";

/**
 * Path prefixes only the Rhys credential may reach.
 *
 * /board (the action board) joins /exec on the SAME pair deliberately: it is
 * the same person's surface, and Basic Auth is scoped to the origin and realm,
 * so one login opens both rather than two. Everything /exec's rules say about
 * the operator credential and about Cf-Access holds here unchanged.
 */
const RHYS_ONLY_PREFIXES = ["/exec", "/api/exec", "/board", "/api/board"];

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
      return {name:"rhys",kind:"named",legacy:"rhys"};
    }
    if (AUTH_USER && AUTH_PASSWORD && safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASSWORD)) {
      return {name:"operator",kind:"shared",legacy:"operator"};
    }
    for(const c of NAMED.credentials) {
      if(safeEqual(user,c.user)&&safeEqual(pass,c.password))return {name:c.name,kind:"named",legacy:null};
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
  headers.set(PRINCIPAL_HEADER, principal.name);
  headers.set("x-mc-principal-kind", principal.kind);   // overwrites any client-sent value
  return NextResponse.next({ request: { headers } });
}

// ===== MIDDLEWARE =====
export async function middleware(request: NextRequest) {
  // Fail closed if auth env vars are not configured
  if (!AUTH_USER || !AUTH_PASSWORD) {
    return new NextResponse("Mission Control auth not configured", { status: 503 });
  }

  const path=request.nextUrl.pathname;
  // Dedicated synthetic-review identity: no Rhys, operator or meeting principal inheritance.
  if(path==='/pilot/artifacts'){
    if(process.env.ATLAS_DANTE_PILOT_REVIEW_ENABLED!=='1'||!pilotCredential(process.env))return new NextResponse('Pilot review unavailable',{status:503});
    if(!isPilotLogin(request.headers.get('authorization'),process.env))return new NextResponse('Unauthorized',{status:401,headers:{'WWW-Authenticate':'Basic realm="Atlas Dante synthetic review"'}});
    return allow(request,{name:'dante-pilot',kind:'named',legacy:null});
  }
  if(isPilotLogin(request.headers.get('authorization'),process.env))return new NextResponse('This login is scoped to the synthetic artifact review.',{status:403});

  const isMeeting=path==='/board'||path==='/api/board/meetings'||path.startsWith('/api/board/meetings/');
  if(process.env.ATLAS_MEETING_QUEUE==='1'&&isMeeting&&NAMED.error)
    return new NextResponse('Meeting identity configuration invalid',{status:503,headers:{'Cache-Control':'no-store'}});
  const isRhysOnly = RHYS_ONLY_PREFIXES.some(
    (p) => request.nextUrl.pathname === p || request.nextUrl.pathname.startsWith(`${p}/`),
  );

  // Cloudflare tunnel traffic (W1c) authenticates with a verified Access
  // JWT and never sees the Basic Auth dialog. That JWT proves "someone with
  // Access", NOT "Rhys" — it carries no identity claim we check — so it is
  // deliberately not enough for the executive board.
  if (await checkCfAccessJwt(request)) {
    if (isRhysOnly) return unauthorizedResponse();
    return allow(request, {name:"cf-access",kind:"unmapped",legacy:"cf-access"});
  }

  // Basic Auth on every other request — no bypass. The Host header is
  // client-supplied and must never gate auth or network restrictions;
  // network-level restriction belongs at the bind address (package.json).
  const principal = identifyBasicAuth(request);
  if (!principal) {
    return unauthorizedResponse();
  }

  if(process.env.ATLAS_MEETING_QUEUE==='1'&&isMeeting) {
    if(principal.kind!=='named')return unauthorizedResponse();
    if(principal.legacy==='rhys'&&!rhysCredentialIsDistinct)
      return new NextResponse('Rhys credential is not distinct',{status:503});
    try {
      await meetingRpc(principal.name,'capability');
      const response=allow(request,principal);
      response.headers.set('Cache-Control','private, no-store');
      return response;
    } catch {return new NextResponse('Meeting queue access denied',{status:403,headers:{'Cache-Control':'no-store'}});}
  }
  // New named credentials never fall through to financial, Ask, operational,
  // legacy board or staff/document endpoints, including when queue is disabled.
  if(principal.legacy===null)return new NextResponse('This login is scoped to meeting actions.',{status:403,headers:{'Cache-Control':'no-store'}});

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
    if (principal.legacy !== "rhys") return unauthorizedResponse();
  }

  return allow(request, principal);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|pilot/artifacts/api/(?:list|review|content|approve)$).*)"],
};
