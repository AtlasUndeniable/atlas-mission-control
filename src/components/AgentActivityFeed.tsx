"use client";

import { useEffect, useState, useRef, useMemo } from "react";

interface ActivityEntry {
  timestamp: string;
  action: string;
  status: string;
}

interface DedupedEntry extends ActivityEntry {
  count: number;
}

const STATUS_DOT: Record<string, string> = {
  success: "online",
  error: "offline",
  warning: "degraded",
  info: "online",
};

const ENTRY_BORDER: Record<string, string> = {
  success: "activity-entry-success",
  error: "activity-entry-error",
  warning: "activity-entry-warning",
  info: "activity-entry-info",
};

function parseTimestamp(timestamp: string): Date {
  // Try standard parsing first
  let date = new Date(timestamp);
  if (!isNaN(date.getTime())) return date;

  // Handle DD/MM/YYYY, HH:MM:SS format (AU locale)
  const match = timestamp.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):?(\d{2})?\s*(am|pm)?/i);
  if (match) {
    const [, day, month, year, hours, mins, secs, ampm] = match;
    let h = parseInt(hours);
    if (ampm) {
      if (ampm.toLowerCase() === "pm" && h < 12) h += 12;
      if (ampm.toLowerCase() === "am" && h === 12) h = 0;
    }
    date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), h, parseInt(mins), parseInt(secs || "0"));
  }
  return date;
}

function relativeTime(timestamp: string): string {
  const date = parseTimestamp(timestamp);
  if (isNaN(date.getTime())) return timestamp;
  const diff = Date.now() - date.getTime();
  if (diff < 0) return "just now"; // future timestamps
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export default function AgentActivityFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [prevCount, setPrevCount] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchActivity() {
      try {
        const res = await fetch("/api/activity");
        if (res.ok) {
          const data = await res.json();
          setPrevCount(entries.length);
          setEntries(data);
        }
      } catch {}
    }
    fetchActivity();
    const interval = setInterval(fetchActivity, 5000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [entries]);

  // Filter out Slack entries (shown in Atlas Comms panel)
  const filtered = useMemo(() =>
    entries.filter((e) => !/sent as rhys|slack bridge|monitoring.*channel/i.test(e.action)),
  [entries]);

  // Deduplicate consecutive same-action entries
  const deduped = useMemo(() => {
    const result: DedupedEntry[] = [];
    for (const entry of filtered) {
      const prev = result[result.length - 1];
      if (prev && prev.action === entry.action) {
        prev.count++;
        prev.timestamp = entry.timestamp; // use most recent
      } else {
        result.push({ ...entry, count: 1 });
      }
    }
    return result;
  }, [filtered]);

  const displayed = deduped.slice(-6);

  return (
    <div className="glass-card hud-corners p-6">
      <div className="flex items-center gap-3 mb-4">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>
          Agent Activity
        </p>
        <span className="module-tag module-tag-system">SYSTEM</span>
      </div>
      {entries.length === 0 ? (
        <div className="flex items-center gap-3 py-6 justify-center">
          <div className="status-dot online" />
          <p className="breathing" style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#6B7280" }}>ATLAS is listening...</p>
        </div>
      ) : (
        <div className="activity-feed-wrap">
          <div ref={feedRef} className="activity-feed space-y-2.5">
            {displayed.map((entry, i) => {
              const isNew = i >= displayed.length - (entries.length - prevCount);
              return (
                <div
                  key={i}
                  className={`flex items-start gap-2.5 activity-entry ${ENTRY_BORDER[entry.status] || "activity-entry-info"} ${isNew ? "activity-entry-new" : ""}`}
                >
                  <span className={`status-dot mt-1.5 ${STATUS_DOT[entry.status] || "online"}`} />
                  <div className="min-w-0 flex-1">
                    <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.80)" }} className="truncate">
                      {entry.action}
                      {entry.count > 1 && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "rgba(0,136,255,0.5)", marginLeft: "6px" }}>
                          (×{entry.count})
                        </span>
                      )}
                    </p>
                    <p
                      style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280" }}
                      title={entry.timestamp}
                    >
                      {relativeTime(entry.timestamp)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
