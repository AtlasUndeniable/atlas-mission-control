import { NextRequest, NextResponse } from "next/server";

// ===== IP FILTERING =====
// Tailscale CGNAT range: 100.64.0.0/10 (100.64.0.0 – 100.127.255.255)
function isTailscaleOrLocal(ip: string): boolean {
  const clean = ip.replace("::ffff:", "");

  // Localhost variants
  if (clean === "127.0.0.1" || clean === "::1" || ip === "::ffff:127.0.0.1") {
    return true;
  }

  // Tailscale CGNAT: 100.64.0.0/10
  const parts = clean.split(".");
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);
  if (first !== 100) return false;
  // /10 mask means second octet 64-127 (bits: 01xxxxxx)
  return second >= 64 && second <= 127;
}

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

// ===== MIDDLEWARE =====
export function middleware(request: NextRequest) {
  const ip = getClientIp(request);

  // IP filter — reject anything outside Tailscale/localhost
  if (!isTailscaleOrLocal(ip)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
