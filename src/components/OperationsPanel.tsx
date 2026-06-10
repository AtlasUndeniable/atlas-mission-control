"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { extractClientName } from "@/lib/client-match";

// ===== TYPES =====
interface DraftedFollowup {
  draft: string;
  draftedAt: string;
  sentToRhysAt: string | null;
  sources?: Array<{ kind: string; summary: string }>;
}

interface RhysTask {
  id: string;
  text: string;
  sourceCall: string;
  sourceDate: number | null;
  status: "pending" | "completed";
  extractedAt: string;
  completedAt: string | null;
  draftedFollowups?: DraftedFollowup[];
}

interface RhysTasksResponse {
  pending: RhysTask[];
  completed: RhysTask[];
  summary: {
    pending: number;
    completed: number;
    total: number;
    stale?: number;
    completedThisWeek?: number;
    avgTurnaroundDays?: number | null;
  };
  thresholds?: { staleDays: number; ancientDays: number };
  updatedAt: string | null;
}

// Parent still passes this — unused by us now
interface OperationsData {
  activeClients: number;
  highPriority: number;
  tasksDone: number;
  tasksWorking: number;
  tasksStuck: number;
}

interface DraftState {
  text: string | null;
  loading: boolean;
  error: string | null;
  sentAt: string | null;
  sending: boolean;
  copied: boolean;
}

// ===== CONSTANTS =====
const STALE_DAYS = 14;
const ANCIENT_DAYS = 21;
const VIEW_MODE_KEY = "followups.viewMode";
const EXPANDED_CLIENTS_KEY = "followups.expandedClients";

// ===== HELPERS =====
function daysSince(ts: number | null): number | null {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
}

function agingColour(days: number | null): string {
  if (days === null) return "rgba(255,255,255,0.35)";
  if (days < 5) return "#22C55E"; // green — fresh
  if (days <= STALE_DAYS) return "#F59E0B"; // yellow — aging
  return "#EF4444"; // red — stale
}

function formatDateShort(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function formatCompletedAt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

function clientKey(task: RhysTask): string {
  const c = extractClientName(task.sourceCall);
  return c ?? task.sourceCall ?? "Unsorted";
}

// ===== AGING BADGE =====
function AgingBadge({ days }: { days: number | null }) {
  if (days === null) return null;
  const colour = agingColour(days);
  const label = days === 0 ? "TODAY" : `${days}D`;
  const ancient = days > ANCIENT_DAYS;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "3px",
        fontFamily: "var(--font-mono)",
        fontSize: "9px",
        fontWeight: 700,
        color: colour,
        letterSpacing: "0.05em",
      }}
      title={ancient ? `Stale — ${days} days since source call` : `${days} days since source call`}
    >
      {ancient && (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: "4px",
            height: "4px",
            borderRadius: "50%",
            background: colour,
            opacity: 0.7,
            boxShadow: `0 0 4px ${colour}`,
          }}
        />
      )}
      {label}
    </span>
  );
}

// ===== DRAFT DRAWER =====
function DraftDrawer({
  state,
  onCopy,
  onSend,
  onClose,
}: {
  state: DraftState;
  onCopy: () => void;
  onSend: () => void;
  onClose: () => void;
}) {
  if (!state.text && !state.loading && !state.error) return null;
  return (
    <div
      style={{
        marginTop: "4px",
        marginLeft: "21px",
        padding: "8px 10px",
        borderLeft: "2px solid rgba(0,136,255,0.3)",
        background: "rgba(0,136,255,0.04)",
        borderRadius: "0 3px 3px 0",
      }}
    >
      {state.loading && (
        <p className="breathing" style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280", margin: 0 }}>
          Drafting follow-up…
        </p>
      )}
      {state.error && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#EF4444", margin: 0 }}>
          {state.error}
        </p>
      )}
      {state.text && (
        <>
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "11.5px",
              lineHeight: 1.45,
              color: "rgba(255,255,255,0.88)",
              margin: "0 0 8px 0",
              whiteSpace: "pre-wrap",
            }}
          >
            {state.text}
          </p>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              onClick={onCopy}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 600,
                letterSpacing: "0.08em",
                color: state.copied ? "#22C55E" : "#0088FF",
                background: "transparent",
                border: `1px solid ${state.copied ? "#22C55E" : "rgba(0,136,255,0.4)"}`,
                borderRadius: "3px",
                padding: "3px 8px",
                cursor: "pointer",
              }}
            >
              {state.copied ? "✓ COPIED" : "COPY"}
            </button>
            <button
              onClick={onSend}
              disabled={state.sending || !!state.sentAt}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 600,
                letterSpacing: "0.08em",
                color: state.sentAt ? "#22C55E" : "#0088FF",
                background: "transparent",
                border: `1px solid ${state.sentAt ? "#22C55E" : "rgba(0,136,255,0.4)"}`,
                borderRadius: "3px",
                padding: "3px 8px",
                cursor: state.sending ? "wait" : state.sentAt ? "default" : "pointer",
                opacity: state.sending ? 0.5 : 1,
              }}
            >
              {state.sentAt ? "✓ SENT TO DM" : state.sending ? "SENDING…" : "SEND TO RHYS DM"}
            </button>
            <button
              onClick={onClose}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                color: "#6B7280",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                marginLeft: "auto",
                padding: "3px 4px",
              }}
              title="Close drawer"
            >
              ✕
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ===== TASK ITEM =====
function TaskItem({
  task,
  onToggle,
  onDraft,
  onCopy,
  onSend,
  onCloseDraft,
  busy,
  draft,
}: {
  task: RhysTask;
  onToggle: (id: string, next: "pending" | "completed") => void;
  onDraft: (id: string) => void;
  onCopy: (id: string) => void;
  onSend: (id: string) => void;
  onCloseDraft: (id: string) => void;
  busy: boolean;
  draft: DraftState | undefined;
}) {
  const days = daysSince(task.sourceDate);
  const isDone = task.status === "completed";
  const displayText = truncate(task.text, 160);

  return (
    <div style={{ paddingTop: "4px", paddingBottom: "4px" }}>
      <div
        className="flex items-start gap-2"
        style={{
          opacity: busy ? 0.4 : 1,
          transition: "opacity 0.15s ease",
        }}
      >
        {/* Checkbox */}
        <button
          onClick={() => onToggle(task.id, isDone ? "pending" : "completed")}
          disabled={busy}
          aria-label={isDone ? "Mark as pending" : "Mark as completed"}
          style={{
            width: "13px",
            height: "13px",
            marginTop: "2px",
            borderRadius: "3px",
            border: `1.5px solid ${isDone ? "#22C55E" : "rgba(255,255,255,0.3)"}`,
            background: isDone ? "rgba(34,197,94,0.15)" : "transparent",
            cursor: busy ? "wait" : "pointer",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            transition: "all 0.15s ease",
          }}
        >
          {isDone && (
            <span style={{ color: "#22C55E", fontSize: "9px", fontWeight: 900, lineHeight: 1 }}>
              ✓
            </span>
          )}
        </button>

        {/* Text + source */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            title={task.text}
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "11.5px",
              lineHeight: 1.4,
              color: isDone ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.85)",
              textDecoration: isDone ? "line-through" : "none",
              margin: 0,
              wordBreak: "break-word",
            }}
          >
            {displayText}
          </p>
          <div className="flex items-center gap-2 mt-0.5" style={{ flexWrap: "wrap" }}>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                color: "#6B7280",
                letterSpacing: "0.02em",
              }}
              title={task.sourceCall}
            >
              {truncate(task.sourceCall, 32)} · {formatDateShort(task.sourceDate)}
            </span>
            {!isDone && <AgingBadge days={days} />}
            {isDone && task.completedAt && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9px",
                  color: "#22C55E",
                  letterSpacing: "0.02em",
                }}
              >
                ✓ {formatCompletedAt(task.completedAt)}
              </span>
            )}
            {!isDone && (
              <button
                onClick={() => onDraft(task.id)}
                disabled={draft?.loading}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9px",
                  fontWeight: 600,
                  color: draft?.text ? "#6B7280" : "#0088FF",
                  background: "transparent",
                  border: "none",
                  cursor: draft?.loading ? "wait" : "pointer",
                  padding: "0",
                  letterSpacing: "0.05em",
                  marginLeft: "auto",
                  opacity: draft?.loading ? 0.5 : 1,
                }}
                title="Generate a follow-up draft using retrieval + voice profile"
              >
                {draft?.loading ? "…" : draft?.text ? "RE-DRAFT" : "DRAFT FOLLOW-UP"}
              </button>
            )}
          </div>
        </div>
      </div>
      {draft && (
        <DraftDrawer
          state={draft}
          onCopy={() => onCopy(task.id)}
          onSend={() => onSend(task.id)}
          onClose={() => onCloseDraft(task.id)}
        />
      )}
    </div>
  );
}

// ===== CLIENT GROUP =====
function ClientGroup({
  clientName,
  tasks,
  expanded,
  onToggleExpand,
  renderTask,
}: {
  clientName: string;
  tasks: RhysTask[];
  expanded: boolean;
  onToggleExpand: () => void;
  renderTask: (t: RhysTask) => React.ReactNode;
}) {
  const oldestDays = tasks.reduce((max, t) => {
    const d = daysSince(t.sourceDate);
    return d !== null && d > (max ?? -1) ? d : max;
  }, null as number | null);

  return (
    <div style={{ marginBottom: "6px" }}>
      <button
        onClick={onToggleExpand}
        style={{
          width: "100%",
          textAlign: "left",
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.72)",
          background: "transparent",
          border: "none",
          borderBottom: "1px solid rgba(0,136,255,0.08)",
          padding: "4px 0",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <span style={{ color: "#6B7280" }}>{expanded ? "▾" : "▸"}</span>
        <span>{clientName}</span>
        <span style={{ color: "#6B7280", fontWeight: 400 }}>
          · {tasks.length} {tasks.length === 1 ? "item" : "items"}
        </span>
        {oldestDays !== null && (
          <span style={{ marginLeft: "auto", color: agingColour(oldestDays), fontWeight: 700 }}>
            oldest {oldestDays}d
          </span>
        )}
      </button>
      {expanded && <div style={{ paddingLeft: "4px" }}>{tasks.map(renderTask)}</div>}
    </div>
  );
}

// ===== MAIN COMPONENT =====
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function OperationsPanel({ data: _legacyData }: { data: OperationsData | null }) {
  const [tasks, setTasks] = useState<RhysTasksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Map<string, DraftState>>(new Map());
  const [showCompleted, setShowCompleted] = useState(false);
  const [viewMode, setViewMode] = useState<"grouped" | "flat">("grouped");
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set());

  // Hydrate view mode + expanded clients from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY);
      if (saved === "grouped" || saved === "flat") setViewMode(saved);
      const expanded = localStorage.getItem(EXPANDED_CLIENTS_KEY);
      if (expanded) {
        const parsed = JSON.parse(expanded);
        if (Array.isArray(parsed)) setExpandedClients(new Set(parsed));
      }
    } catch {}
  }, []);

  const updateViewMode = useCallback((mode: "grouped" | "flat") => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {}
  }, []);

  const toggleClientExpanded = useCallback((name: string) => {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(EXPANDED_CLIENTS_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/rhys-tasks");
      if (!res.ok) throw new Error(`${res.status}`);
      const data: RhysTasksResponse = await res.json();
      setTasks(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 30_000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  const handleToggle = useCallback(
    async (id: string, next: "pending" | "completed") => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        const path = next === "completed" ? "complete" : "reopen";
        const res = await fetch(`/api/rhys-tasks/${id}/${path}`, { method: "POST" });
        if (!res.ok) throw new Error(`${res.status}`);
        await fetchTasks();
      } catch (e) {
        setError(e instanceof Error ? e.message : "toggle failed");
      } finally {
        setBusyIds((prev) => {
          const s = new Set(prev);
          s.delete(id);
          return s;
        });
      }
    },
    [fetchTasks]
  );

  const setDraft = useCallback((id: string, patch: Partial<DraftState>) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) ?? {
        text: null,
        loading: false,
        error: null,
        sentAt: null,
        sending: false,
        copied: false,
      };
      next.set(id, { ...existing, ...patch });
      return next;
    });
  }, []);

  const handleDraft = useCallback(
    async (id: string) => {
      setDraft(id, { loading: true, error: null, copied: false });
      try {
        const res = await fetch(`/api/rhys-tasks/${id}/draft-followup`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail ?? data.error ?? `${res.status}`);
        setDraft(id, {
          loading: false,
          text: data.draft,
          error: null,
          sentAt: null,
        });
      } catch (e) {
        setDraft(id, {
          loading: false,
          error: e instanceof Error ? e.message : "draft failed",
        });
      }
    },
    [setDraft]
  );

  const handleCopy = useCallback(
    async (id: string) => {
      const draft = drafts.get(id);
      if (!draft?.text) return;
      try {
        await navigator.clipboard.writeText(draft.text);
        setDraft(id, { copied: true });
        setTimeout(() => setDraft(id, { copied: false }), 2000);
      } catch {
        setDraft(id, { error: "clipboard write failed" });
      }
    },
    [drafts, setDraft]
  );

  const handleSend = useCallback(
    async (id: string) => {
      setDraft(id, { sending: true });
      try {
        const res = await fetch(`/api/rhys-tasks/${id}/send-draft`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `${res.status}`);
        setDraft(id, { sending: false, sentAt: data.sentAt ?? new Date().toISOString() });
      } catch (e) {
        setDraft(id, { sending: false, error: e instanceof Error ? e.message : "send failed" });
      }
    },
    [setDraft]
  );

  const handleCloseDraft = useCallback((id: string) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Group pending by client; sort clients by oldest-age desc
  const groups = useMemo(() => {
    const pending = tasks?.pending ?? [];
    const byClient = new Map<string, RhysTask[]>();
    for (const t of pending) {
      const k = clientKey(t);
      if (!byClient.has(k)) byClient.set(k, []);
      byClient.get(k)!.push(t);
    }
    return [...byClient.entries()]
      .map(([name, items]) => {
        const oldest = items.reduce((max, t) => {
          const d = daysSince(t.sourceDate);
          return d !== null && d > (max ?? -1) ? d : max;
        }, null as number | null);
        // sort items within a group by age desc
        items.sort((a, b) => (daysSince(b.sourceDate) ?? 0) - (daysSince(a.sourceDate) ?? 0));
        return { name, items, oldest: oldest ?? 0 };
      })
      .sort((a, b) => b.oldest - a.oldest);
  }, [tasks]);

  const flatSorted = useMemo(() => {
    const p = [...(tasks?.pending ?? [])];
    p.sort((a, b) => (daysSince(b.sourceDate) ?? 0) - (daysSince(a.sourceDate) ?? 0));
    return p;
  }, [tasks]);

  // ===== LOADING STATE =====
  if (loading && !tasks) {
    return (
      <div className="glass-card hud-corners p-5 pulse-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="status-dot degraded" style={{ width: "6px", height: "6px" }} />
          <p className="type-section-header">Operations</p>
          <span className="module-tag module-tag-ops-core">FOLLOW-UPS</span>
        </div>
        <div className="flex items-center gap-3 py-4 justify-center">
          <div className="status-dot degraded" style={{ width: "5px", height: "5px" }} />
          <p className="breathing" style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#6B7280" }}>
            Loading follow-ups...
          </p>
        </div>
      </div>
    );
  }

  const pending = tasks?.pending ?? [];
  const completed = tasks?.completed ?? [];
  const summary = tasks?.summary;
  const stale = summary?.stale ?? 0;
  const thisWeek = summary?.completedThisWeek ?? 0;
  const avgTurn = summary?.avgTurnaroundDays;

  const renderTask = (t: RhysTask) => (
    <TaskItem
      key={t.id}
      task={t}
      onToggle={handleToggle}
      onDraft={handleDraft}
      onCopy={handleCopy}
      onSend={handleSend}
      onCloseDraft={handleCloseDraft}
      busy={busyIds.has(t.id)}
      draft={drafts.get(t.id)}
    />
  );

  return (
    <div className="glass-card hud-corners p-5">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2" style={{ flexWrap: "wrap" }}>
        <span
          className={`status-dot ${pending.length > 0 ? "online" : "degraded"}`}
          style={{ width: "6px", height: "6px" }}
        />
        <p className="type-section-header">Operations</p>
        <span className="module-tag module-tag-ops-core">FOLLOW-UPS</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            color: "#6B7280",
            marginLeft: "auto",
            letterSpacing: "0.02em",
          }}
        >
          {pending.length} open
          {stale > 0 && (
            <>
              {" · "}
              <span style={{ color: "#EF4444", fontWeight: 700 }}>{stale} stale</span>
            </>
          )}
          {" · "}
          <span style={{ color: "#22C55E" }}>{thisWeek} closed this week</span>
        </span>
      </div>

      {/* View toggle */}
      <div
        style={{
          display: "flex",
          gap: "2px",
          marginBottom: "10px",
          alignItems: "center",
        }}
      >
        <button
          onClick={() => updateViewMode("grouped")}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: viewMode === "grouped" ? "#0088FF" : "#6B7280",
            background: "transparent",
            border: "none",
            padding: "2px 6px",
            cursor: "pointer",
            borderBottom: `1.5px solid ${viewMode === "grouped" ? "#0088FF" : "transparent"}`,
          }}
        >
          BY CLIENT
        </button>
        <button
          onClick={() => updateViewMode("flat")}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: viewMode === "flat" ? "#0088FF" : "#6B7280",
            background: "transparent",
            border: "none",
            padding: "2px 6px",
            cursor: "pointer",
            borderBottom: `1.5px solid ${viewMode === "flat" ? "#0088FF" : "transparent"}`,
          }}
        >
          BY AGE
        </button>
      </div>

      {error && (
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            color: "#EF4444",
            marginBottom: "8px",
          }}
        >
          Error: {error}
        </p>
      )}

      {/* Pending section */}
      <div>
        {pending.length === 0 ? (
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "11px",
              color: "rgba(255,255,255,0.35)",
              padding: "8px 0",
            }}
          >
            No pending follow-ups. Nothing aging on your plate.
          </p>
        ) : (
          <div
            style={{
              maxHeight: "520px",
              overflowY: "auto",
              paddingRight: "4px",
            }}
          >
            {viewMode === "grouped"
              ? groups.map((g) => (
                  <ClientGroup
                    key={g.name}
                    clientName={g.name}
                    tasks={g.items}
                    expanded={expandedClients.has(g.name)}
                    onToggleExpand={() => toggleClientExpanded(g.name)}
                    renderTask={renderTask}
                  />
                ))
              : flatSorted.map(renderTask)}
          </div>
        )}
      </div>

      {/* Completed section (collapsed by default) */}
      {completed.length > 0 && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "#6B7280",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <span>{showCompleted ? "▾" : "▸"}</span>
            Completed · {completed.length}
          </button>
          {showCompleted && (
            <>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9px",
                  color: "#22C55E",
                  margin: "6px 0 4px 0",
                  letterSpacing: "0.04em",
                }}
              >
                {thisWeek} this week · {completed.length} total
                {avgTurn !== null && avgTurn !== undefined && ` · avg turnaround ${avgTurn}d`}
              </p>
              <div
                className="mt-1"
                style={{
                  maxHeight: "240px",
                  overflowY: "auto",
                  paddingRight: "4px",
                }}
              >
                {completed.map(renderTask)}
              </div>
            </>
          )}
        </div>
      )}

      {/* Footer */}
      <p
        className="mt-3 pt-2"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "8px",
          color: "rgba(255,255,255,0.15)",
          letterSpacing: "0.08em",
          borderTop: "1px solid rgba(0,136,255,0.08)",
          paddingTop: "8px",
          margin: 0,
        }}
      >
        LIVE · FIREFLIES ACTION ITEMS · STALE &gt;{STALE_DAYS}D
      </p>
    </div>
  );
}
