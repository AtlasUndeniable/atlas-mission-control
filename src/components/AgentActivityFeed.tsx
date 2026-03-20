"use client";

import { useEffect, useState, useRef } from "react";

interface ActivityEntry {
  timestamp: string;
  action: string;
  status: string;
}

const STATUS_COLOURS: Record<string, string> = {
  success: "bg-success",
  error: "bg-error",
  warning: "bg-warning",
  info: "bg-accent",
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
    <div className="glass-card p-4 fade-in">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
        Agent Activity
      </h3>
      {entries.length === 0 ? (
        <p className="text-sm text-text-muted">No activity yet</p>
      ) : (
        <div ref={feedRef} className="activity-feed space-y-2">
          {entries.slice(-15).map((entry, i) => (
            <div key={i} className="flex items-start gap-2">
              <span
                className={`status-dot mt-1.5 flex-shrink-0 ${STATUS_COLOURS[entry.status] || "bg-accent"}`}
                style={{ boxShadow: "none" }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-text-secondary truncate">{entry.action}</p>
                <p className="text-[10px] font-mono text-text-muted">{entry.timestamp}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
