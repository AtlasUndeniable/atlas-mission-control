"use client";

import { useEffect, useState, useCallback } from "react";
import { useSoundContext } from "@/components/SoundEngine";

interface Approval {
  id: string;
  type: "slack" | "task" | "email" | "content";
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

const TYPE_COLOURS: Record<string, string> = {
  slack: "rgba(139, 92, 246, 0.7)",
  task: "rgba(34, 197, 94, 0.7)",
  email: "rgba(245, 158, 11, 0.7)",
  content: "rgba(0, 136, 255, 0.7)",
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

function isSlackActivity(action: string): boolean {
  return /sent as rhys|slack bridge|monitoring.*channel/i.test(action);
}

export default function ApprovalQueue() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [slackActivity, setSlackActivity] = useState<ActivityEntry[]>([]);
  const [dismissing, setDismissing] = useState<Record<string, "approve" | "deny">>({});
  const sound = useSoundContext();

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      if (res.ok) {
        const data = await res.json();
        setApprovals(data.approvals || []);
      }
    } catch {}
  }, []);

  // Fetch agent activity and extract Slack-related entries
  const fetchSlackActivity = useCallback(async () => {
    try {
      const res = await fetch("/api/activity");
      if (res.ok) {
        const data: ActivityEntry[] = await res.json();
        const slackEntries = data.filter((e) => isSlackActivity(e.action)).slice(-5);
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

      try {
        await fetch(`/api/approvals/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
      } catch {}

      if (action === "approve") sound.playNotification();

      setTimeout(() => {
        setApprovals((prev) => prev.filter((a) => a.id !== id));
        setDismissing((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 300);
    },
    [sound],
  );

  const visible = approvals.slice(0, 5);

  return (
    <div className="glass-card hud-corners p-6 approval-panel" style={{ minHeight: 200 }}>
      <div className="flex items-center gap-3 mb-4">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>
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
        <div className="space-y-3 mb-4">
          {visible.map((approval) => {
            const action = dismissing[approval.id];
            return (
              <div
                key={approval.id}
                className="approval-card"
                style={{
                  opacity: action ? 0 : 1,
                  transform: action ? (action === "approve" ? "translateX(-40px)" : "translateX(40px)") : "translateX(0)",
                  transition: "opacity 0.3s ease, transform 0.3s ease",
                  padding: "12px",
                  borderRadius: "6px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div className="flex justify-between items-center mb-2">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: 600, letterSpacing: "0.1em", color: TYPE_COLOURS[approval.type] }}>
                    {TYPE_LABELS[approval.type]}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280" }}>
                    {relativeTime(approval.createdAt)}
                  </span>
                </div>
                {(approval.channel || approval.replyingTo) && (
                  <p style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "#9CA3AF", marginBottom: "8px" }}>
                    {approval.channel && `#${approval.channel}`}
                    {approval.replyingTo && ` · replying to @${approval.replyingTo}`}
                  </p>
                )}
                <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", fontStyle: "italic", color: "rgba(255,255,255,0.80)", lineHeight: 1.5, marginBottom: "12px", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  &ldquo;{approval.draft}&rdquo;
                </p>
                <div className="flex gap-3">
                  <button onClick={() => handleAction(approval.id, "approve")} className="approval-btn-send">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
                    SEND
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
        <div className="flex items-center gap-2 mb-4 py-1">
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
        <div className="pt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#6B7280", marginBottom: "10px" }}>
            Recent Activity
          </p>
          <div className="space-y-2">
            {slackActivity.map((entry, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="status-dot online mt-1.5" style={{ width: "6px", height: "6px" }} />
                <div className="min-w-0 flex-1">
                  <p style={{ fontFamily: "var(--font-body)", fontSize: "11px", color: "rgba(255,255,255,0.70)", lineHeight: 1.4 }} className="truncate">
                    {entry.action}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280", textAlign: "center" }}>
          Monitoring 123 channels
        </p>
      </div>
    </div>
  );
}
