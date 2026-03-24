"use client";

import { useEffect, useState, useRef, useCallback } from "react";

interface Approval {
  id: string;
  channel: string;
  replyingTo: string;
}

interface Toast {
  id: string;
  name: string;
  channel: string;
  expiresAt: number;
}

const POLL_INTERVAL = 30_000;
const TOAST_DURATION = 8_000;

export default function CommsToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const initialised = useRef(false);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Expire toasts
  useEffect(() => {
    if (toasts.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => t.expiresAt > now));
    }, 1000);
    return () => clearInterval(interval);
  }, [toasts.length]);

  // Poll approvals
  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch("/api/approvals");
        if (!res.ok) return;
        const data = await res.json();
        const approvals: Approval[] = data.approvals ?? [];
        const currentIds = new Set(approvals.map((a) => a.id));

        if (!initialised.current) {
          // First poll: seed known IDs, don't toast
          knownIdsRef.current = currentIds;
          initialised.current = true;
          return;
        }

        // Find new approvals
        const newApprovals = approvals.filter((a) => !knownIdsRef.current.has(a.id));
        if (newApprovals.length > 0) {
          const now = Date.now();
          const newToasts: Toast[] = newApprovals.map((a) => ({
            id: a.id,
            name: a.replyingTo || "Someone",
            channel: a.channel || "slack",
            expiresAt: now + TOAST_DURATION,
          }));
          setToasts((prev) => [...prev, ...newToasts].slice(-5)); // max 5 visible
        }

        knownIdsRef.current = currentIds;
      } catch {}
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "80px",
        right: "24px",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast, i) => (
        <div
          key={toast.id}
          className="comms-toast"
          style={{
            pointerEvents: "auto",
            animationDelay: `${i * 80}ms`,
          }}
          onClick={() => dismissToast(toast.id)}
        >
          {/* Accent bar */}
          <div className="comms-toast-accent" />

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: 0 }}>
            {/* Icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0088FF" strokeWidth="2" style={{ flexShrink: 0 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>

            {/* Text */}
            <span className="comms-toast-text">
              <strong>{toast.name}</strong>
              {" in "}
              <span style={{ color: "rgba(0,136,255,0.8)" }}>#{toast.channel}</span>
              {" \u2014 needs your sign-off"}
            </span>
          </div>

          {/* Dismiss */}
          <button
            onClick={(e) => { e.stopPropagation(); dismissToast(toast.id); }}
            className="comms-toast-dismiss"
          >
            &times;
          </button>

          {/* Auto-dismiss progress bar */}
          <div className="comms-toast-progress" />
        </div>
      ))}
    </div>
  );
}
