import { NextRequest, NextResponse } from "next/server";

const AUTH_USER = process.env.MISSION_CONTROL_AUTH_USER;
const AUTH_PASSWORD = process.env.MISSION_CONTROL_AUTH_PASSWORD;

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
export function middleware(request: NextRequest) {
  // Fail closed if auth env vars are not configured
  if (!AUTH_USER || !AUTH_PASSWORD) {
    return new NextResponse("Mission Control auth not configured", { status: 503 });
  }

  // Basic Auth on every request — no bypass. The Host header is
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
