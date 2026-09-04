/**
 * /api/board — the only data source for the action board (/board).
 *
 * Calls the hosted `public.task_board(audience)` RPC (migration 008, gate B1b)
 * over PostgREST. Three things about that call are deliberate:
 *
 *  1. IT RUNS SERVER-SIDE ONLY. `task_board` is granted to exactly one role,
 *     `atlas_retrieval`, and the token that assumes it is a bearer credential
 *     with no per-user identity behind it. The browser never sees it: this
 *     handler holds the token and ships rows.
 *
 *  2. THE AUDIENCE IS HARDCODED TO 'rhys'. 008 warns in its own comment that
 *     the audience argument is caller-asserted and NOT authenticated — it is a
 *     claim, not an identity. The only thing that makes 'rhys' true here is the
 *     middleware gate on /api/board, which is the same Rhys credential pair
 *     that opens /exec. Taking the audience from the query string would let the
 *     URL, rather than the credential, decide the scope.
 *
 *  3. IT IS READ-ONLY AT B3. `task_act` is granted to the same role and is
 *     deliberately not called from anywhere in this app. Approvals happen in
 *     Slack until B4 wires the decision path with a real actor identity.
 */
import { NextRequest, NextResponse } from "next/server";
import { readAtlasSecret, ATLAS_SECRETS_PATH } from "@/lib/atlas-secrets";

export const runtime = "nodejs";
// Live rows only: never serve this from a build-time or router cache.
export const dynamic = "force-dynamic";

/** Middleware stamps this from its own check; a client-sent value is overwritten. */
const PRINCIPAL_HEADER = "x-mc-principal";

const AUDIENCE = "rhys";
const RPC_TIMEOUT_MS = 15_000;

/** One row of public.tasks, as `to_jsonb(t)` returns it. */
export interface TaskRow {
  id: string;
  title: string;
  client: string | null;
  lane: "business" | "engineering";
  owner: string;
  origin: "slack_request" | "atlas_signal" | "operator";
  state: "queued" | "needs_approval" | "approved" | "in_build" | "delivered" | "declined" | "sent_back";
  due: string | null;
  source_quote: string | null;
  created_by: string;
  declined_reason: string | null;
  stale_flagged_at: string | null;
  receipts: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function GET(request: NextRequest) {
  // Defence in depth. src/middleware.ts already refuses /api/board to anyone
  // but the Rhys pair; this makes a widened matcher fail closed rather than
  // quietly serving the board to the shared operator credential.
  if (request.headers.get(PRINCIPAL_HEADER) !== "rhys") {
    return new NextResponse("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Atlas Mission Control"' },
    });
  }

  const url = readAtlasSecret("SUPABASE_URL");
  const anonKey = readAtlasSecret("SUPABASE_ANON_KEY");
  const token = readAtlasSecret("ATLAS_RETRIEVAL_TOKEN");

  if (!url || !anonKey || !token) {
    // Name WHICH key is missing, never any value.
    const missing = [
      !url && "SUPABASE_URL",
      !anonKey && "SUPABASE_ANON_KEY",
      !token && "ATLAS_RETRIEVAL_TOKEN",
    ].filter(Boolean).join(", ");
    return NextResponse.json(
      { error: "unconfigured", detail: `missing ${missing} in ${ATLAS_SECRETS_PATH}` },
      { status: 503 },
    );
  }

  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/task_board`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ audience: AUDIENCE }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    console.warn(`[api/board] task_board unreachable — ${reason}`);
    return NextResponse.json({ error: "unreachable", detail: reason }, { status: 502 });
  }

  const body = await res.text();
  if (!res.ok) {
    // PostgREST returns its own JSON error body. It carries no credential, but
    // it is trimmed anyway so a long upstream message cannot become the page.
    console.warn(`[api/board] task_board ${res.status}: ${body.slice(0, 400)}`);
    return NextResponse.json(
      { error: "rpc_failed", status: res.status, detail: body.slice(0, 400) },
      { status: 502 },
    );
  }

  let payload: { tasks?: TaskRow[]; policy?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "bad_payload" }, { status: 502 });
  }

  return NextResponse.json(
    {
      // Server clock at the moment the rows were read. The board's
      // "synced n min ago" stamp measures from here, not from render.
      fetchedAt: new Date().toISOString(),
      audience: AUDIENCE,
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      // 008 returns a plain-English policy string describing the scope it
      // actually applied. Shown in the footer rather than trusted silently.
      policy: typeof payload.policy === "string" ? payload.policy : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
