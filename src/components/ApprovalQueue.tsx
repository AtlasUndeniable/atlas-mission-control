"use client";

import { useEffect, useState, useCallback } from "react";
import { useSoundContext } from "@/components/SoundEngine";

interface Approval {
  id: string;
  type: "slack" | "task" | "email" | "content";
  tier: "green" | "yellow" | "red";
  channel?: string;
  replyingTo?: string;
  draft: string;
  createdAt: string;
}

interface ActivityEntry {
  timestamp: string;
  action: string;
  status: string;
}

const TYPE_LABELS: Record<string, string> = {
  slack: "SLACK RESPONSE",
  task: "TASK COMPLETION",
  email: "EMAIL DRAFT",
  content: "CONTENT PUBLISH",
};

const TIER_COLOURS: Record<string, { border: string; bg: string; label: string }> = {
  green: { border: "rgba(0,255,136,0.25)", bg: "rgba(0,255,136,0.03)", label: "#00FF88" },
  yellow: { border: "rgba(255,184,0,0.25)", bg: "rgba(255,184,0,0.03)", label: "#FFB800" },
  red: { border: "rgba(255,51,68,0.25)", bg: "rgba(255,51,68,0.03)", label: "#FF3344" },
};

const TIER_LABELS: Record<string, string> = {
  green: "AUTO",
  yellow: "REVIEW",
  red: "CRITICAL",
};

// Test data — shown when no real approvals exist
const TEST_APPROVALS: Approval[] = [
  {
    id: "test-1",
    type: "slack",
    tier: "yellow",
    channel: "um-general",
    replyingTo: "Marcus",
    draft: "Hey Marcus, I've reviewed the onboarding flow and noticed the follow-up sequence is missing step 3. I'll get that fixed today.",
    createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
  },
  {
    id: "test-2",
    type: "email",
    tier: "red",
    draft: "Subject: Q2 Pricing Adjustment — Rhys, the analysis shows a 12% price increase is sustainable given current retention rates. Recommend implementing for new cohort starting April.",
    createdAt: new Date(Date.now() - 18 * 60000).toISOString(),
  },
  {
    id: "test-3",
    type: "slack",
    tier: "green",
    channel: "um-coaching",
    replyingTo: "Jess",
    draft: "All sorted Jess — the call recording has been processed and your coaching notes are in the panel.",
    createdAt: new Date(Date.now() - 42 * 60000).toISOString(),
  },
];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function isSlackActivity(action: string): boolean {
  return /sent as rhys|slack bridge|monitoring.*channel/i.test(action);
}

export default function ApprovalQueue() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [slackActivity, setSlackActivity] = useState<ActivityEntry[]>([]);
  const [dismissing, setDismissing] = useState<Record<string, "approve" | "deny">>({});
  const [useTestData, setUseTestData] = useState(false);
  const sound = useSoundContext();

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      if (res.ok) {
        const data = await res.json();
        const real = data.approvals || [];
        setApprovals(real);
        setUseTestData(real.length === 0);
      }
    } catch {
      setUseTestData(true);
    }
  }, []);

  const fetchSlackActivity = useCallback(async () => {
    try {
      const res = await fetch("/api/activity");
      if (res.ok) {
        const data: ActivityEntry[] = await res.json();
        const slackEntries = data.filter((e) => isSlackActivity(e.action)).slice(-3);
        setSlackActivity(slackEntries);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchApprovals();
    fetchSlackActivity();
    const interval1 = setInterval(fetchApprovals, 10000);
    const interval2 = setInterval(fetchSlackActivity, 10000);
    return () => {
      clearInterval(interval1);
      clearInterval(interval2);
    };
  }, [fetchApprovals, fetchSlackActivity]);

  const handleAction = useCallback(
    async (id: string, action: "approve" | "deny") => {
      sound.playClick();
      setDismissing((prev) => ({ ...prev, [id]: action }));

      // Only send to API for real approvals
      if (!id.startsWith("test-")) {
        try {
          await fetch(`/api/approvals/${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
        } catch {}
      }

      if (action === "approve") sound.playNotification();

      setTimeout(() => {
        if (useTestData) {
          setApprovals([]);
        } else {
          setApprovals((prev) => prev.filter((a) => a.id !== id));
        }
        setDismissing((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 300);
    },
    [sound, useTestData],
  );

  const displayApprovals = useTestData ? TEST_APPROVALS : approvals;
  const visible = displayApprovals.slice(0, 5);

  return (
    <div className="glass-card hud-corners p-5 approval-panel">
      <div className="flex items-center gap-3 mb-4">
        <span className={`status-dot ${displayApprovals.length > 0 ? "degraded" : "online"}`} style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#B0B8C4" }}>
          Atlas Comms
        </p>
        <span className="module-tag module-tag-comms">COMMS</span>
        {displayApprovals.length > 0 && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 700, color: "#F59E0B", marginLeft: "auto" }}>
            {displayApprovals.length} pending
          </span>
        )}
      </div>

      {/* Approvals section */}
      {displayApprovals.length > 0 ? (
        <div className="space-y-3">
          {visible.map((approval) => {
            const action = dismissing[approval.id];
            const tier = TIER_COLOURS[approval.tier] || TIER_COLOURS.yellow;
            return (
              <div
                key={approval.id}
                style={{
                  opacity: action ? 0 : 1,
                  transform: action ? (action === "approve" ? "translateX(-40px)" : "translateX(40px)") : "translateX(0)",
                  transition: "opacity 0.3s ease, transform 0.3s ease",
                  padding: "12px",
                  borderRadius: "6px",
                  background: tier.bg,
                  border: `1px solid ${tier.border}`,
                }}
              >
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-2">
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "8px",
                      fontWeight: 700,
                      letterSpacing: "0.15em",
                      padding: "2px 6px",
                      borderRadius: "3px",
                      background: `${tier.label}15`,
                      color: tier.label,
                      border: `1px solid ${tier.label}30`,
                    }}>
                      {TIER_LABELS[approval.tier]}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: 600, letterSpacing: "0.1em", color: "rgba(255,255,255,0.5)" }}>
                      {TYPE_LABELS[approval.type]}
                    </span>
                  </div>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280" }}>
                    {relativeTime(approval.createdAt)}
                  </span>
                </div>
                {(approval.channel || approval.replyingTo) && (
                  <p style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "#B0B8C4", marginBottom: "6px" }}>
                    {approval.channel && `#${approval.channel}`}
                    {approval.replyingTo && ` · replying to @${approval.replyingTo}`}
                  </p>
                )}
                <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", fontStyle: "italic", color: "rgba(255,255,255,0.80)", lineHeight: 1.5, marginBottom: "10px", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  &ldquo;{approval.draft}&rdquo;
                </p>
                <div className="flex gap-3">
                  <button onClick={() => handleAction(approval.id, "approve")} className="approval-btn-send">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
                    CONFIRM
                  </button>
                  <button onClick={() => handleAction(approval.id, "deny")} className="approval-btn-deny">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    DENY
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 py-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2" opacity="0.6">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#6B7280" }}>
            No approvals pending
          </span>
        </div>
      )}

      {/* Recent Slack Activity */}
      {slackActivity.length > 0 && (
        <div className="pt-3 mt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#6B7280", marginBottom: "8px" }}>
            Recent Activity
          </p>
          <div className="space-y-1.5">
            {slackActivity.map((entry, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="status-dot online mt-1.5" style={{ width: "4px", height: "4px" }} />
                <p style={{ fontFamily: "var(--font-body)", fontSize: "11px", color: "rgba(255,255,255,0.60)", lineHeight: 1.4 }} className="truncate">
                  {entry.action}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "9px", color: "#4B5563", textAlign: "center", letterSpacing: "0.1em" }}>
          Monitoring 123 channels
        </p>
      </div>
    </div>
  );
}
