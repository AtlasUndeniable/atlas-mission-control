"use client";

import { useEffect, useState, useRef, useMemo } from "react";

interface ActivityEntry {
  timestamp: string;
  action: string;
  status: string;
}

interface DedupedEntry extends ActivityEntry {
  count: number;
  module: string;
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

// Module inference from action content
function inferModule(action: string): string {
  if (/call|fireflies|transcript|coaching|processed/i.test(action)) return "COACHING";
  if (/monday|task|board|item|ops/i.test(action)) return "OPS-CORE";
  if (/pipeline|ghl|opportunity|lead|sales/i.test(action)) return "GROWTH";
  if (/slack|channel|message|sent|bridge/i.test(action)) return "COMMS";
  if (/briefing|consolidation|cron|memory/i.test(action)) return "META-OPS";
  return "SYSTEM";
}

const MODULE_COLOURS: Record<string, string> = {
  "COACHING": "#00FF88",
  "OPS-CORE": "#00AAFF",
  "GROWTH": "#8855FF",
  "COMMS": "#00D4FF",
  "META-OPS": "#0088FF",
  "SYSTEM": "rgba(255,255,255,0.4)",
};

function parseTimestamp(timestamp: string): Date {
  let date = new Date(timestamp);
  if (!isNaN(date.getTime())) return date;

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
  if (diff < 0) return "just now";
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

  // Deduplicate and add module tags
  const deduped = useMemo(() => {
    const result: DedupedEntry[] = [];
    for (const entry of filtered) {
      const prev = result[result.length - 1];
      if (prev && prev.action === entry.action) {
        prev.count++;
        prev.timestamp = entry.timestamp;
      } else {
        result.push({ ...entry, count: 1, module: inferModule(entry.action) });
      }
    }
    return result;
  }, [filtered]);

  const displayed = deduped.slice(-8);

  return (
    <div className="glass-card hud-corners p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className="status-dot online" style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#B0B8C4" }}>
          Agent Activity
        </p>
        <span className="module-tag module-tag-system">SYSTEM</span>
      </div>
      {entries.length === 0 ? (
        <div className="flex items-center gap-3 py-4 justify-center">
          <div className="status-dot online" />
          <p className="breathing" style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#6B7280" }}>ATLAS is listening...</p>
        </div>
      ) : (
        <div className="activity-feed-wrap">
          <div ref={feedRef} className="activity-feed space-y-2">
            {displayed.map((entry, i) => {
              const isNew = i >= displayed.length - (entries.length - prevCount);
              const moduleColour = MODULE_COLOURS[entry.module] || MODULE_COLOURS.SYSTEM;
              return (
                <div
                  key={i}
                  className={`flex items-start gap-2 activity-entry ${ENTRY_BORDER[entry.status] || "activity-entry-info"} ${isNew ? "activity-entry-new" : ""}`}
                >
                  <span className={`status-dot mt-1.5 ${STATUS_DOT[entry.status] || "online"}`} style={{ width: "5px", height: "5px" }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "8px",
                        fontWeight: 700,
                        letterSpacing: "0.1em",
                        color: moduleColour,
                        opacity: 0.7,
                      }}>
                        {entry.module}
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", color: "#4B5563" }}>
                        {relativeTime(entry.timestamp)}
                      </span>
                    </div>
                    <p style={{ fontFamily: "var(--font-body)", fontSize: "11px", color: "rgba(255,255,255,0.80)", lineHeight: 1.4 }} className="truncate">
                      {entry.action}
                      {entry.count > 1 && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", color: "rgba(0,136,255,0.5)", marginLeft: "6px" }}>
                          ({"\u00D7"}{entry.count})
                        </span>
                      )}
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
