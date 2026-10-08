"use client";

/**
 * Action Board (/board) — Rhys only, READ-ONLY.
 *
 * v1 is glass over the hosted `tasks` table (migration 008). Eve writes the
 * rows from Slack; this page renders them and does nothing else. There are
 * deliberately NO approve / decline / edit controls: `task_act` records no
 * actor at B1, so a button here would be an unattributable decision. Approvals
 * stay in Slack until B4 wires the decision path with a real identity.
 *
 * All rows arrive from /api/board, which holds the retrieval token server-side.
 * The browser never sees a credential.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

// ===== types mirroring /api/board =====

type Lane = "business" | "engineering";
type Origin = "slack_request" | "atlas_signal" | "operator";
type State =
  | "queued" | "needs_approval" | "approved"
  | "in_build" | "delivered" | "declined" | "sent_back";

interface TaskRow {
  id: string;
  title: string;
  client: string | null;
  lane: Lane;
  owner: string;
  origin: Origin;
  state: State;
  due: string | null;
  source_quote: string | null;
  created_by: string;
  declined_reason: string | null;
  stale_flagged_at: string | null;
  receipts: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface BoardPayload {
  fetchedAt: string;
  audience: string;
  tasks: TaskRow[];
  policy: string | null;
}

// ===== columns =====

/**
 * The four columns of the approved mock, in order. A column holds a SET of
 * states, because 008 defines seven and the mock has four.
 *
 * `approved` shares the In build column with `in_build` (B3.1). A card Rhys
 * approved in Slack is progress he asked for and must read as progress, not as
 * a footnote below the board — but it is not being built either, so it carries
 * its own amber state line rather than borrowing "Atlas is working".
 *
 * `sent_back` and `declined` still have no column. They are not dropped: a card
 * Rhys sent back would otherwise vanish from the board entirely, which is worse
 * than an unglamorous strip. They render below the columns instead.
 */
const COLUMNS: { key: string; states: State[]; label: string; hint: string }[] = [
  { key: "queued",         states: ["queued"],                 label: "Queued",         hint: "Logged, not started" },
  { key: "needs_approval", states: ["needs_approval"],          label: "Needs approval", hint: "Waiting on you in Slack" },
  { key: "in_build",       states: ["approved", "in_build"],    label: "In build",       hint: "Approved or under way" },
  { key: "delivered",      states: ["delivered"],               label: "Delivered",      hint: "Receipt on file" },
];

const OFF_BOARD: { state: State; label: string }[] = [
  { state: "sent_back", label: "Sent back" },
  { state: "declined",  label: "Declined" },
];

const FILTERS: { key: "all" | Lane; label: string }[] = [
  { key: "all",         label: "Everything" },
  { key: "business",    label: "Business" },
  { key: "engineering", label: "Engineering" },
];

// ===== formatting =====

const ACCENT = "#0088FF";
const AMBER = "#FFB800";
const RED = "#FF3344";

function titleCase(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** `due` is a DATE, not a timestamp. Parse the parts so no timezone shifts it. */
function parseDueDate(due: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function startOfToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function dueLabel(due: string): { text: string; tone: "normal" | "soon" | "late" } {
  const d = parseDueDate(due);
  if (!d) return { text: `Due ${due}`, tone: "normal" };
  const days = Math.round((d.getTime() - startOfToday().getTime()) / 86_400_000);
  const stamp = d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  if (days < 0) return { text: `Due ${stamp} · ${Math.abs(days)}d overdue`, tone: "late" };
  if (days === 0) return { text: `Due today`, tone: "soon" };
  if (days === 1) return { text: `Due tomorrow`, tone: "soon" };
  return { text: `Due ${stamp}`, tone: days <= 3 ? "soon" : "normal" };
}

function relativeMinutes(iso: string, now: number): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hr ago" : `${hours} hrs ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The one-line "where this stands" under each card. */
function stateLine(t: TaskRow, now: number): string {
  const touched = relativeMinutes(t.updated_at, now);
  switch (t.state) {
    case "queued":         return `Queued ${touched}`;
    case "needs_approval": return `Waiting for your call · raised ${relativeMinutes(t.created_at, now)}`;
    // B3.1 product decision: approved is visible progress with a distinct
    // reading. The age is kept because a card that has sat approved for days
    // is exactly the thing this column exists to surface.
    case "approved":       return `APPROVED · WAITING TO START · ${touched.toUpperCase()}`;
    case "in_build":       return `In build · last moved ${touched}`;
    case "delivered":      return `Delivered ${touched}`;
    case "sent_back":      return `Sent back ${touched}`;
    case "declined":       return `Declined ${touched}`;
  }
}

const ORIGIN_LABEL: Record<Origin, string> = {
  slack_request: "FROM SLACK",
  atlas_signal:  "RAISED BY ATLAS",
  operator:      "OPERATOR",
};

/** Receipts are a free-shaped jsonb object. Render them, bounded, never dumped. */
function receiptPairs(receipts: Record<string, unknown>): { k: string; v: string }[] {
  return Object.entries(receipts).slice(0, 4).map(([k, raw]) => {
    const v = typeof raw === "string" ? raw : JSON.stringify(raw);
    return { k, v: v.length > 48 ? `${v.slice(0, 48)}…` : v };
  });
}

// ===== small pieces =====

function Chip({
  children, color = "rgba(255,255,255,0.55)", border = "rgba(255,255,255,0.14)", bg = "transparent",
}: { children: React.ReactNode; color?: string; border?: string; bg?: string }) {
  return (
    <span
      className="type-module-tag"
      style={{
        color, background: bg, border: `1px solid ${border}`,
        borderRadius: "3px", padding: "3px 6px", fontSize: "9px",
        letterSpacing: "0.1em", whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function TaskCard({ task, now, dim }: { task: TaskRow; now: number; dim: boolean }) {
  const due = task.due ? dueLabel(task.due) : null;
  const dueColor =
    due?.tone === "late" ? RED : due?.tone === "soon" ? AMBER : "rgba(255,255,255,0.45)";

  return (
    <article
      className="glass-card"
      style={{
        padding: "14px 14px 12px",
        opacity: dim ? 0.55 : 1,
        borderColor: task.stale_flagged_at ? "rgba(255,184,0,0.32)" : undefined,
        transition: "opacity 0.2s ease",
      }}
    >
      <p
        style={{
          fontFamily: "var(--font-heading)", fontSize: "13px", fontWeight: 600,
          lineHeight: 1.35, color: "rgba(255,255,255,0.90)", marginBottom: "9px",
        }}
      >
        {task.title}
      </p>

      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: "9px" }}>
        {task.client && (
          <Chip color="rgba(0,212,255,0.85)" border="rgba(0,212,255,0.30)" bg="rgba(0,136,255,0.07)">
            {task.client}
          </Chip>
        )}
        {task.lane === "engineering" && <Chip>ENGINEERING</Chip>}
        {task.origin === "atlas_signal" ? (
          <Chip color="rgba(136,85,255,0.90)" border="rgba(136,85,255,0.32)" bg="rgba(136,85,255,0.08)">
            RAISED BY ATLAS
          </Chip>
        ) : (
          <Chip color="rgba(255,255,255,0.38)" border="rgba(255,255,255,0.10)">
            {ORIGIN_LABEL[task.origin]}
          </Chip>
        )}
        {task.stale_flagged_at && (
          <Chip color={AMBER} border="rgba(255,184,0,0.38)" bg="rgba(255,184,0,0.08)">
            STALE
          </Chip>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ marginBottom: "7px" }}>
        <span className="type-timestamp" style={{ color: "rgba(255,255,255,0.52)" }}>
          {titleCase(task.owner)}
        </span>
        {due && (
          <>
            <span className="type-timestamp" style={{ color: "rgba(255,255,255,0.18)" }}>·</span>
            <span className="type-timestamp" style={{ color: dueColor }}>{due.text}</span>
          </>
        )}
        {!due && (
          <>
            <span className="type-timestamp" style={{ color: "rgba(255,255,255,0.18)" }}>·</span>
            <span className="type-timestamp" style={{ color: "rgba(255,255,255,0.28)" }}>No due date</span>
          </>
        )}
      </div>

      <p
        className="type-timestamp"
        style={{
          lineHeight: 1.6,
          // Approved sits in the In build column but is NOT being built.
          // Amber is the visual seam between the two.
          color: task.state === "approved" ? AMBER : undefined,
        }}
      >
        {stateLine(task, now)}
      </p>

      {task.state === "declined" && task.declined_reason && (
        <p
          className="type-panel-content"
          style={{
            marginTop: "8px", fontSize: "11px", color: "rgba(255,255,255,0.55)",
            borderLeft: `2px solid rgba(255,51,68,0.35)`, paddingLeft: "8px",
          }}
        >
          {task.declined_reason}
        </p>
      )}

      {task.state === "delivered" && task.receipts && (
        <div
          style={{
            marginTop: "10px", paddingTop: "9px",
            borderTop: "1px solid rgba(0,255,136,0.14)",
          }}
        >
          <p className="type-module-tag" style={{ color: "rgba(0,255,136,0.72)", marginBottom: "6px" }}>
            RECEIPTS
          </p>
          {receiptPairs(task.receipts).map(({ k, v }) => (
            <p key={k} className="type-timestamp" style={{ lineHeight: 1.8, wordBreak: "break-all" }}>
              <span style={{ color: "rgba(255,255,255,0.34)" }}>{k}</span>{" "}
              <span style={{ color: "rgba(255,255,255,0.62)" }}>{v}</span>
            </p>
          ))}
        </div>
      )}
    </article>
  );
}

// ===== board =====

export default function ActionBoard({ initialFilter = "business" }: { initialFilter?: "all" | Lane } = {}) {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | Lane>(initialFilter);
  // Ticks so "synced n min ago" ages between fetches instead of freezing.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/board", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.detail ? `${body.error ?? res.status}: ${body.detail}` : `HTTP ${res.status}`);
      } else {
        setData(await res.json());
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Auto-refresh every 60s, and re-render the age stamp every 30s in between.
  useEffect(() => {
    const refresh = setInterval(() => { void load(); }, 60_000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, [load]);

  const tasks = useMemo(() => data?.tasks ?? [], [data]);

  const visible = useMemo(
    () => (filter === "all" ? tasks : tasks.filter((t) => t.lane === filter)),
    [tasks, filter],
  );

  const laneCounts = useMemo(() => ({
    all: tasks.length,
    business: tasks.filter((t) => t.lane === "business").length,
    engineering: tasks.filter((t) => t.lane === "engineering").length,
  }), [tasks]);

  const offBoard = useMemo(
    () => OFF_BOARD
      .map((o) => ({ ...o, rows: visible.filter((t) => t.state === o.state) }))
      .filter((o) => o.rows.length > 0),
    [visible],
  );

  const synced = data ? relativeMinutes(data.fetchedAt, now) : null;

  return (
    <main
      className="action-board ambient-bg min-h-screen p-8 lg:p-10"
      style={{ position: "relative", zIndex: 1 }}
    >
      {/* ===== header ===== */}
      <div className="flex flex-wrap items-end justify-between gap-5 mb-7">
        <div>
          <p className="type-section-header" style={{ color: ACCENT, marginBottom: "10px" }}>
            ACTION BOARD
          </p>
          <h1
            style={{
              fontFamily: "var(--font-heading)", fontSize: "30px", fontWeight: 300,
              letterSpacing: "-0.02em", color: "rgba(255,255,255,0.92)",
            }}
          >
            What Atlas is holding for you
          </h1>
        </div>

        <div className="flex items-center gap-4">
          <div style={{ textAlign: "right" }}>
            <p className="type-timestamp">
              {error ? "SYNC FAILED" : synced ? `SYNCED ${synced.toUpperCase()}` : "LOADING"}
            </p>
            <p className="type-timestamp" style={{ marginTop: "5px", color: "rgba(255,255,255,0.22)" }}>
              AUTO-REFRESH 60S
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="type-module-tag"
            style={{
              padding: "9px 14px", borderRadius: "4px",
              border: `1px solid rgba(0,136,255,${loading ? 0.14 : 0.32})`,
              background: "rgba(0,136,255,0.06)",
              color: loading ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.78)",
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "SYNCING" : "REFRESH"}
          </button>
        </div>
      </div>

      {/* ===== lane filter ===== */}
      <div className="glass-card p-4 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="type-section-header" style={{ marginRight: "8px" }}>SHOW</span>
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className="type-module-tag"
                style={{
                  padding: "7px 12px", borderRadius: "4px",
                  border: `1px solid ${active ? "rgba(0,136,255,0.45)" : "rgba(255,255,255,0.10)"}`,
                  background: active ? "rgba(0,136,255,0.12)" : "transparent",
                  color: active ? "rgba(255,255,255,0.90)" : "rgba(255,255,255,0.45)",
                  cursor: "pointer",
                }}
              >
                {f.label}
                <span style={{ marginLeft: "8px", color: "rgba(255,255,255,0.32)" }}>
                  {laneCounts[f.key]}
                </span>
              </button>
            );
          })}
          <span className="type-timestamp" style={{ marginLeft: "6px" }}>
            ENGINEERING WORK IS DIMMED IN THE MIXED VIEW
          </span>
        </div>
      </div>

      {/* ===== error ===== */}
      {error && (
        <div className="glass-card p-5 mb-6" style={{ borderColor: "rgba(255,51,68,0.35)" }}>
          <p className="type-section-header" style={{ color: RED, marginBottom: "8px" }}>
            THE BOARD COULD NOT BE READ
          </p>
          <p className="type-panel-content" style={{ fontSize: "11px" }}>{error}</p>
          <p className="type-timestamp" style={{ marginTop: "8px" }}>
            NO ROWS ARE SHOWN RATHER THAN STALE ONES.
          </p>
        </div>
      )}

      {/* ===== columns ===== */}
      {!error && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
          {COLUMNS.map((col) => {
            const rows = visible.filter((t) => col.states.includes(t.state));
            return (
              <section key={col.key}>
                <div
                  className="flex items-baseline justify-between"
                  style={{
                    marginBottom: "12px", paddingBottom: "9px",
                    borderBottom: "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  <div>
                    <p className="type-section-header" style={{ color: "rgba(255,255,255,0.78)" }}>
                      {col.label.toUpperCase()}
                    </p>
                    <p className="type-timestamp" style={{ marginTop: "6px" }}>
                      {col.hint.toUpperCase()}
                    </p>
                  </div>
                  <span
                    className="type-data"
                    style={{ fontSize: "18px", color: rows.length ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.20)" }}
                  >
                    {rows.length}
                  </span>
                </div>

                <div className="flex flex-col gap-3">
                  {rows.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      now={now}
                      // Dim engineering only where it competes with business
                      // work. Under the Engineering filter it is the subject,
                      // so dimming it would just look like a broken page.
                      dim={filter === "all" && t.lane === "engineering"}
                    />
                  ))}
                  {rows.length === 0 && (
                    <p
                      className="type-timestamp"
                      style={{
                        padding: "16px 0", textAlign: "center",
                        color: "rgba(255,255,255,0.18)",
                      }}
                    >
                      {loading && !data ? "LOADING" : "NOTHING HERE"}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ===== states the four columns have no home for ===== */}
      {!error && offBoard.length > 0 && (
        <div className="glass-card p-6" style={{ marginTop: "26px", opacity: 0.72 }}>
          <p className="type-section-header" style={{ marginBottom: "6px" }}>NOT ON THE BOARD</p>
          <p className="type-timestamp" style={{ marginBottom: "16px", lineHeight: 1.7 }}>
            STATES THE FOUR COLUMNS DO NOT COVER. SHOWN SO NOTHING DISAPPEARS.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {offBoard.map((o) => (
              <div key={o.state}>
                <p className="type-module-tag" style={{ color: "rgba(255,255,255,0.55)", marginBottom: "10px" }}>
                  {o.label.toUpperCase()} · {o.rows.length}
                </p>
                <div className="flex flex-col gap-3">
                  {o.rows.map((t) => (
                    <TaskCard key={t.id} task={t} now={now} dim={filter === "all" && t.lane === "engineering"} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== footer ===== */}
      <footer
        style={{
          marginTop: "34px", paddingTop: "18px",
          borderTop: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <p
          className="type-panel-content"
          style={{ fontSize: "12px", color: "rgba(255,255,255,0.62)", marginBottom: "10px" }}
        >
          Approvals happen in Slack for now.
        </p>
        <p className="type-timestamp" style={{ lineHeight: 1.8 }}>
          READ-ONLY VIEW · NO CARD CAN BE CHANGED FROM THIS PAGE
        </p>
        {data?.policy && (
          <p
            className="type-timestamp"
            style={{ marginTop: "8px", lineHeight: 1.8, color: "rgba(255,255,255,0.26)" }}
          >
            {data.policy.toUpperCase()}
          </p>
        )}
      </footer>
    </main>
  );
}
