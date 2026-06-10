"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Participant {
  email: string | null;
  name: string | null;
}

interface ActionItem {
  name: string;
  status: string;
}

interface SlackMessage {
  user: string;
  ts: string | null;
  text: string;
}

interface PendingApproval {
  id: string;
  title: string;
  createdAt: string | null;
}

interface KnowledgeChunk {
  source: string;
  title: string;
  date: string | null;
  snippet: string;
}

interface LastCall {
  id: string;
  date: number;
  title: string;
  summary: string;
  actionItems: string[];
  recordingLink: string | null;
}

interface UpcomingEvent {
  eventId: string;
  eventTitle: string;
  eventStart: string;
  eventEnd: string | null;
  calendar: "coaching" | "business";
  location: string | null;
  hangoutLink: string | null;
  participants: Participant[];
  clientName: string | null;
  minutesUntil: number;
  prepped: boolean;
  preppedAt: string | null;
  dmSent: boolean;
  dmSentAt: string | null;
  monday: { id: string; name: string } | null;
  channel: { id: string; name: string } | null;
  lastCall: LastCall | null;
  openTasks: ActionItem[];
  recentSlackActivity: SlackMessage[];
  pendingApprovals: PendingApproval[];
  relevantKnowledge: KnowledgeChunk[];
}

interface MeetingPrepResponse {
  updatedAt: string | null;
  authFailed: boolean;
  note?: string;
  upcoming: UpcomingEvent[];
  nextEvent: UpcomingEvent | null;
}

function formatCountdown(mins: number): string {
  if (mins <= 0) return "Starting now";
  if (mins < 60) return `In ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `In ${h}h ${m}m` : `In ${h}h`;
  const d = Math.floor(h / 24);
  return `In ${d}d ${h % 24}h`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return "Today";
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function daysAgo(ts: number | null): string {
  if (!ts) return "";
  const days = Math.round((Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function urgencyBadgeColour(mins: number): string {
  if (mins <= 30) return "#F59E0B";
  if (mins <= 120) return "#0088FF";
  return "rgba(255,255,255,0.5)";
}

export default function MeetingPrepPanel() {
  const [data, setData] = useState<MeetingPrepResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tick, setTick] = useState(0); // drives 1s countdown re-render

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/meeting-prep", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as MeetingPrepResponse;
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const refetch = setInterval(fetchData, 60_000);
    const countdownTick = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => {
      clearInterval(refetch);
      clearInterval(countdownTick);
    };
  }, [fetchData]);

  // recompute minutesUntil on the client too, so the countdown stays live
  // between 60s refetches
  const displayNext: UpcomingEvent | null = useMemo(() => {
    if (!data?.nextEvent) return null;
    const mins = Math.max(
      0,
      Math.round((new Date(data.nextEvent.eventStart).getTime() - Date.now()) / 60000)
    );
    return { ...data.nextEvent, minutesUntil: mins };
    // tick forces recompute every 15s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tick]);

  if (loading && !data) {
    return (
      <div className="glass-card hud-corners p-4">
        <div className="flex items-center gap-3">
          <span className="status-dot degraded" style={{ width: "6px", height: "6px" }} />
          <p className="type-section-header">Up Next</p>
          <span className="module-tag module-tag-meta-ops">CALENDAR</span>
          <p
            className="breathing"
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "12px",
              color: "#6B7280",
              marginLeft: "auto",
            }}
          >
            Loading…
          </p>
        </div>
      </div>
    );
  }

  const authFailed = data?.authFailed;
  const hasEvent = !!displayNext;

  return (
    <div
      className="glass-card hud-corners p-4"
      style={{
        cursor: hasEvent ? "pointer" : "default",
        transition: "border-color 0.2s ease",
      }}
      onClick={() => hasEvent && setExpanded((v) => !v)}
      role={hasEvent ? "button" : undefined}
      aria-expanded={expanded}
    >
      {/* ===== HEADER ===== */}
      <div className="flex items-center gap-3">
        <span
          className={`status-dot ${authFailed ? "degraded" : hasEvent ? "online" : "degraded"}`}
          style={{ width: "6px", height: "6px" }}
        />
        <p className="type-section-header">Up Next</p>
        <span className="module-tag module-tag-meta-ops">CALENDAR</span>
        {hasEvent && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: urgencyBadgeColour(displayNext.minutesUntil),
              textTransform: "uppercase",
            }}
          >
            {formatCountdown(displayNext.minutesUntil)}
          </span>
        )}
        {!hasEvent && !authFailed && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              color: "rgba(255,255,255,0.3)",
              letterSpacing: "0.1em",
            }}
          >
            IDLE
          </span>
        )}
      </div>

      {/* ===== AUTH FAILED ===== */}
      {authFailed && (
        <div className="mt-3">
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "12px",
              color: "#F59E0B",
              margin: 0,
            }}
          >
            Calendar unavailable — Google ADC token expired.
          </p>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              color: "rgba(255,255,255,0.4)",
              margin: "6px 0 0",
            }}
          >
            Re-auth with{" "}
            <span style={{ color: "#0088FF" }}>
              gcloud auth application-default login
            </span>{" "}
            (see logs)
          </p>
        </div>
      )}

      {/* ===== EMPTY STATE ===== */}
      {!authFailed && !hasEvent && (
        <div className="mt-3">
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "12px",
              color: "rgba(255,255,255,0.4)",
              margin: 0,
            }}
          >
            No meetings in the next 24 hours.
          </p>
        </div>
      )}

      {/* ===== NEXT EVENT SUMMARY ===== */}
      {hasEvent && (
        <div className="mt-3">
          <p
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "15px",
              fontWeight: 600,
              color: "#FFFFFF",
              margin: 0,
              lineHeight: 1.3,
            }}
          >
            {displayNext.clientName || displayNext.eventTitle}
          </p>
          <div
            className="flex items-center gap-3 mt-1"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10.5px",
              color: "rgba(255,255,255,0.5)",
              letterSpacing: "0.02em",
            }}
          >
            <span>
              {formatDayLabel(displayNext.eventStart)} ·{" "}
              {formatClock(displayNext.eventStart)}
              {displayNext.eventEnd ? ` – ${formatClock(displayNext.eventEnd)}` : ""}
            </span>
            {displayNext.calendar && (
              <span style={{ color: "rgba(255,255,255,0.25)" }}>
                {displayNext.calendar.toUpperCase()}
              </span>
            )}
            {displayNext.channel?.name && (
              <span style={{ color: "#8B5CF6" }}>#{displayNext.channel.name}</span>
            )}
          </div>
          {displayNext.clientName && displayNext.eventTitle !== displayNext.clientName && (
            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "11.5px",
                color: "rgba(255,255,255,0.45)",
                marginTop: "4px",
                marginBottom: 0,
              }}
            >
              {displayNext.eventTitle}
            </p>
          )}

          {/* Quick-look badges */}
          <div
            className="flex items-center gap-3 mt-2 flex-wrap"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9.5px",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {displayNext.prepped ? (
              <span style={{ color: "#22C55E" }}>● Prepped</span>
            ) : (
              <span style={{ color: "rgba(255,255,255,0.3)" }}>
                ○ Brief at T-30
              </span>
            )}
            {displayNext.dmSent && (
              <span style={{ color: "#0088FF" }}>DM sent</span>
            )}
            {displayNext.openTasks.length > 0 && (
              <span style={{ color: "#F59E0B" }}>
                {displayNext.openTasks.length} open task
                {displayNext.openTasks.length === 1 ? "" : "s"}
              </span>
            )}
            {displayNext.pendingApprovals.length > 0 && (
              <span style={{ color: "#EF4444" }}>
                ⚠ {displayNext.pendingApprovals.length} pending
              </span>
            )}
          </div>
        </div>
      )}

      {/* ===== EXPANDED BRIEF ===== */}
      {hasEvent && expanded && displayNext.prepped && (
        <div
          className="mt-4 pt-4"
          style={{
            borderTop: "1px solid rgba(0,136,255,0.08)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Last call */}
          {displayNext.lastCall && (
            <Section label={`Last call · ${daysAgo(displayNext.lastCall.date)}`}>
              <p
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "11.5px",
                  color: "rgba(255,255,255,0.75)",
                  margin: 0,
                  lineHeight: 1.45,
                }}
              >
                {(displayNext.lastCall.summary || displayNext.lastCall.title).slice(0, 280)}
                {(displayNext.lastCall.summary || "").length > 280 ? "…" : ""}
              </p>
              {displayNext.lastCall.actionItems.length > 0 && (
                <ul
                  style={{
                    margin: "6px 0 0",
                    padding: "0 0 0 16px",
                    listStyleType: "disc",
                  }}
                >
                  {displayNext.lastCall.actionItems.slice(0, 5).map((a, i) => (
                    <li
                      key={i}
                      style={{
                        fontFamily: "var(--font-body)",
                        fontSize: "11px",
                        color: "rgba(255,255,255,0.65)",
                        lineHeight: 1.4,
                      }}
                    >
                      {a}
                    </li>
                  ))}
                </ul>
              )}
              {displayNext.lastCall.recordingLink && (
                <a
                  href={displayNext.lastCall.recordingLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "9.5px",
                    color: "#0088FF",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    display: "inline-block",
                    marginTop: "6px",
                  }}
                >
                  Recording ↗
                </a>
              )}
            </Section>
          )}

          {/* Open tasks */}
          {displayNext.openTasks.length > 0 && (
            <Section label={`Your open tasks · ${displayNext.openTasks.length}`}>
              {displayNext.openTasks.map((t, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 py-0.5"
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "11px",
                    color: "rgba(255,255,255,0.7)",
                  }}
                >
                  <span style={{ color: "#F59E0B" }}>▸</span>
                  <span>{t.name}</span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "9px",
                      color: "rgba(255,255,255,0.35)",
                      letterSpacing: "0.05em",
                      marginLeft: "auto",
                    }}
                  >
                    {t.status}
                  </span>
                </div>
              ))}
            </Section>
          )}

          {/* Recent Slack */}
          {displayNext.recentSlackActivity.length > 0 && (
            <Section
              label={`Recent in #${displayNext.channel?.name || "channel"} · ${displayNext.recentSlackActivity.length}`}
            >
              {displayNext.recentSlackActivity.slice(0, 5).map((m, i) => (
                <div
                  key={i}
                  className="py-1"
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "11px",
                    color: "rgba(255,255,255,0.65)",
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ color: "#8B5CF6", fontWeight: 600 }}>{m.user}</span>{" "}
                  <span style={{ color: "rgba(255,255,255,0.75)" }}>{m.text}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Pending approvals */}
          {displayNext.pendingApprovals.length > 0 && (
            <Section label={`Pending approvals · ${displayNext.pendingApprovals.length}`}>
              {displayNext.pendingApprovals.map((a) => (
                <div
                  key={a.id}
                  className="py-0.5"
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "11px",
                    color: "#EF4444",
                  }}
                >
                  ⚠ {a.title}
                </div>
              ))}
            </Section>
          )}

          {/* Knowledge chunks */}
          {displayNext.relevantKnowledge.length > 0 && (
            <Section
              label={`Relevant context · ${displayNext.relevantKnowledge.length}`}
            >
              {displayNext.relevantKnowledge.slice(0, 3).map((k, i) => (
                <div
                  key={i}
                  className="py-1"
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "10.5px",
                    color: "rgba(255,255,255,0.55)",
                    lineHeight: 1.45,
                    borderLeft: "2px solid rgba(0,136,255,0.25)",
                    paddingLeft: "8px",
                  }}
                >
                  <span style={{ color: "rgba(255,255,255,0.8)" }}>{k.title || k.source}</span>
                  {" — "}
                  {k.snippet}
                </div>
              ))}
            </Section>
          )}
        </div>
      )}

      {/* ===== EXPAND HINT (when collapsed + prepped) ===== */}
      {hasEvent && !expanded && displayNext.prepped && (
        <p
          className="mt-3 pt-3"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9.5px",
            letterSpacing: "0.1em",
            color: "rgba(255,255,255,0.3)",
            textTransform: "uppercase",
            borderTop: "1px solid rgba(0,136,255,0.06)",
            margin: 0,
            paddingTop: "8px",
          }}
        >
          Click to expand brief ↓
        </p>
      )}

      {error && (
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            color: "#EF4444",
            margin: "6px 0 0",
          }}
        >
          Error: {error}
        </p>
      )}
    </div>
  );
}

// ===== Subsection wrapper ==========================================

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "9px",
          fontWeight: 700,
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          color: "#6B7280",
          marginBottom: "4px",
        }}
      >
        {label}
      </p>
      {children}
    </div>
  );
}
