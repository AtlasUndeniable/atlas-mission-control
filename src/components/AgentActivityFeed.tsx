"use client";

import { useEffect, useState, useRef } from "react";

interface ActivityEntry {
  timestamp: string;
  action: string;
  status: string;
}

const STATUS_DOT: Record<string, string> = {
  success: "online",
  error: "offline",
  warning: "degraded",
  info: "online",
};

export default function AgentActivityFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchActivity() {
      try {
        const res = await fetch("/api/activity");
        if (res.ok) {
          const data = await res.json();
          setEntries(data);
        }
      } catch {}
    }
    fetchActivity();
    const interval = setInterval(fetchActivity, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="glass-card p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-3"
         style={{ fontFamily: "var(--font-inter)" }}>
        Agent Activity
      </p>
      {entries.length === 0 ? (
        <div className="flex items-center gap-3 py-6 justify-center">
          <div className="status-dot online" />
          <p className="text-sm text-muted breathing">ATLAS is listening...</p>
        </div>
      ) : (
        <div ref={feedRef} className="activity-feed space-y-2">
          {entries.slice(-15).map((entry, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className={`status-dot mt-1.5 ${STATUS_DOT[entry.status] || "online"}`} />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-text-secondary truncate">{entry.action}</p>
                <p className="text-[0.6rem] text-muted"
                   style={{ fontFamily: "var(--font-jetbrains)" }}>
                  {entry.timestamp}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
