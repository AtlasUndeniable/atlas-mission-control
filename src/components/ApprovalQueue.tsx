"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSoundContext } from "@/components/SoundEngine";

interface Approval {
  id: string;
  type: "slack" | "task" | "email" | "content";
  tier: "green" | "yellow" | "red";
  channel?: string;
  replyingTo?: string;
  draft: string | null;
  originalMessage?: string;
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


function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ageMs(iso: string): number {
  return Date.now() - new Date(iso).getTime();
}

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

function isSlackActivity(action: string): boolean {
  return /sent as rhys|slack bridge|monitoring.*channel/i.test(action);
}

// ===== APPROVAL CARD =====
function ApprovalCard({
  approval,
  onApprove,
  onDismiss,
}: {
  approval: Approval;
  onApprove: (id: string) => Promise<void>;
  onDismiss: (id: string) => void;
}) {
  const sound = useSoundContext();
  const [sending, setSending] = useState(false);
  const [resolved, setResolved] = useState<"sent" | "error" | "no_draft" | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [redrafting, setRedrafting] = useState(false);
  const [draft, setDraft] = useState(approval.draft);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasDraft = !!draft && draft !== "None";
  const isStale = ageMs(approval.createdAt) > TWENTY_FOUR_HOURS;
  const tier = TIER_COLOURS[approval.tier] || TIER_COLOURS.yellow;

  // Resolved state — sent, error, or no_draft warning
  if (resolved) {
    const isError = resolved === "error";
    const isNoDraft = resolved === "no_draft";
    const color = isError ? "#EF4444" : isNoDraft ? "#F59E0B" : "#22C55E";
    const bgColor = isError ? "rgba(239,68,68,0.05)" : isNoDraft ? "rgba(255,184,0,0.05)" : "rgba(34,197,94,0.05)";
    const borderColor = isError ? "rgba(239,68,68,0.25)" : isNoDraft ? "rgba(255,184,0,0.25)" : "rgba(34,197,94,0.25)";
    const msg = isError ? "Send failed — check logs" : isNoDraft ? "No draft to send — wait for next triage cycle" : "Sent as Rhys";

    return (
      <div
        style={{
          padding: "12px",
          borderRadius: "6px",
          background: bgColor,
          border: `1px solid ${borderColor}`,
          transition: "all 0.3s ease",
        }}
      >
        <div className="flex items-center gap-2">
          {resolved === "sent" && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
          )}
          {isError && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="3"><path d="M12 9v4M12 17h.01" /><circle cx="12" cy="12" r="10" strokeWidth="2" /></svg>
          )}
          {isNoDraft && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="3"><path d="M12 9v4M12 17h.01" /><circle cx="12" cy="12" r="10" strokeWidth="2" /></svg>
          )}
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            fontWeight: 600,
            color,
          }}>
            {msg}
          </span>
          {approval.channel && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "rgba(255,255,255,0.3)", marginLeft: "auto" }}>
              #{approval.channel}
            </span>
          )}
        </div>
      </div>
    );
  }

  const handleApprove = async () => {
    if (!hasDraft) {
      sound.playClick();
      setResolved("no_draft");
      setTimeout(() => setResolved(null), 3000);
      return;
    }
    sound.playClick();
    setSending(true);
    try {
      await onApprove(approval.id);
      sound.playNotification();
      setResolved("sent");
    } catch {
      setResolved("error");
    }
    setSending(false);
  };

  const handleDeny = () => {
    sound.playClick();
    setFeedbackOpen(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleRedraft = async () => {
    if (!feedback.trim()) return;
    setRedrafting(true);
    try {
      const res = await fetch(`/api/approvals/${approval.id}/redraft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: feedback.trim() }),
      });
      if (!res.ok) throw new Error("Redraft failed");
      const data = await res.json();
      setDraft(data.draft);
      setFeedbackOpen(false);
      setFeedback("");
      sound.playNotification();
    } catch {
      // Keep feedback open so user can retry
    }
    setRedrafting(false);
  };

  const handleDismiss = () => {
    sound.playClick();
    // Dismiss via deny API (silent, no redraft)
    fetch(`/api/approvals/${approval.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deny" }),
    }).catch(() => {});
    onDismiss(approval.id);
  };

  return (
    <div
      style={{
        opacity: sending ? 0.4 : isStale ? 0.35 : 1,
        transition: "opacity 0.3s ease",
        padding: "12px",
        borderRadius: "6px",
        background: tier.bg,
        border: `1px solid ${tier.border}`,
      }}
    >
      {/* Header */}
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
          {isStale && (
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: "8px",
              fontWeight: 600,
              letterSpacing: "0.1em",
              padding: "1px 5px",
              borderRadius: "3px",
              background: "rgba(107,114,128,0.15)",
              color: "#6B7280",
              border: "1px solid rgba(107,114,128,0.2)",
            }}>
              STALE
            </span>
          )}
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: isStale ? "#4B5563" : "#6B7280" }}>
          {relativeTime(approval.createdAt)}
        </span>
      </div>

      {/* Channel / sender */}
      {(approval.channel || approval.replyingTo) && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "#B0B8C4", marginBottom: "6px" }}>
          {approval.channel && `#${approval.channel}`}
          {approval.replyingTo && ` · replying to @${approval.replyingTo}`}
        </p>
      )}

      {/* Draft text or pending notice */}
      {hasDraft ? (
        <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", fontStyle: "italic", color: "rgba(255,255,255,0.80)", lineHeight: 1.5, marginBottom: "10px", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          &ldquo;{draft}&rdquo;
        </p>
      ) : (
        <div style={{ marginBottom: "10px" }}>
          {approval.originalMessage && (
            <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.50)", lineHeight: 1.5, marginBottom: "4px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {approval.originalMessage.replace(/<@[A-Z0-9]+>/g, "").trim().slice(0, 150)}
            </p>
          )}
          <p style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            letterSpacing: "0.08em",
            color: "#F59E0B",
            opacity: 0.8,
          }}>
            Draft pending — next triage cycle will generate
          </p>
        </div>
      )}

      {/* Feedback input (shown after DENY) */}
      {feedbackOpen && (
        <div style={{ marginBottom: "10px" }}>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && feedback.trim()) handleRedraft(); }}
              placeholder="What should I change?"
              disabled={redrafting}
              style={{
                flex: 1,
                fontFamily: "var(--font-body)",
                fontSize: "12px",
                padding: "6px 10px",
                borderRadius: "4px",
                border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(0,0,0,0.3)",
                color: "#FFFFFF",
                outline: "none",
              }}
            />
            <button
              onClick={handleRedraft}
              disabled={redrafting || !feedback.trim()}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 700,
                letterSpacing: "0.1em",
                padding: "6px 12px",
                borderRadius: "4px",
                border: "1px solid rgba(0,136,255,0.3)",
                background: "rgba(0,136,255,0.1)",
                color: "#0088FF",
                cursor: redrafting || !feedback.trim() ? "default" : "pointer",
                opacity: redrafting || !feedback.trim() ? 0.4 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {redrafting ? "DRAFTING..." : "REDRAFT"}
            </button>
          </div>
          <button
            onClick={() => { setFeedbackOpen(false); setFeedback(""); }}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              color: "#6B7280",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "4px 0 0",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Action buttons */}
      {!feedbackOpen && (
        <div className="flex items-center gap-3">
          <button onClick={handleApprove} className="approval-btn-send" disabled={sending} style={!hasDraft ? { opacity: 0.4, cursor: "default" } : undefined}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
            {sending ? "SENDING..." : "CONFIRM"}
          </button>
          <button onClick={handleDeny} className="approval-btn-deny">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
            DENY
          </button>
          <button
            onClick={handleDismiss}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              color: "#6B7280",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "0",
              marginLeft: "auto",
              opacity: 0.6,
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ===== MAIN COMPONENT =====
export default function ApprovalQueue() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [slackActivity, setSlackActivity] = useState<ActivityEntry[]>([]);
  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      if (res.ok) {
        const data = await res.json();
        setApprovals(data.approvals || []);
      }
    } catch {}
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

  const handleApprove = useCallback(async (id: string) => {
    const res = await fetch(`/api/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    if (!res.ok) throw new Error("Approve failed");
  }, []);

  const handleDismiss = useCallback((id: string) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const visible = approvals.slice(0, 5);

  return (
    <div className="glass-card hud-corners p-5 approval-panel">
      <div className="flex items-center gap-3 mb-4">
        <span className={`status-dot ${approvals.length > 0 ? "degraded" : "online"}`} style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#B0B8C4" }}>
          Atlas Comms
        </p>
        <span className="module-tag module-tag-comms">COMMS</span>
        {approvals.length > 0 && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 700, color: "#F59E0B", marginLeft: "auto" }}>
            {approvals.length} pending
          </span>
        )}
      </div>

      {/* Approvals section */}
      {approvals.length > 0 ? (
        <div className="space-y-3">
          {visible.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onApprove={handleApprove}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      ) : (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 0",
        }}>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            letterSpacing: "0.1em",
            color: "rgba(255,255,255,0.15)",
          }}>
            No pending approvals
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
