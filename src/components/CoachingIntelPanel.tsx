"use client";

import { useEffect, useState, useRef } from "react";

interface CoachingData {
  callsThisWeek: number;
  callsProcessed: number;
  recentCalls: Array<{ title: string; date: number }>;
}

function getInitials(title: string): string {
  const cleaned = title
    .replace(/\b(rhys|livingstone|x|vs|and|with)\b/gi, "")
    .replace(/\(.*?\)/g, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return "??";
}

const AVATAR_COLOURS = ["#0088FF", "#F59E0B", "#8B5CF6", "#00D4FF", "#EF4444"];

function TypewriterText({ text, speed = 30 }: { text: string; speed?: number }) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  const prevText = useRef("");

  useEffect(() => {
    if (text === prevText.current) {
      setDisplayed(text);
      setDone(true);
      return;
    }
    prevText.current = text;
    setDisplayed("");
    setDone(false);

    let i = 0;
    const timer = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(timer);
        setDone(true);
      }
    }, speed);

    return () => clearInterval(timer);
  }, [text, speed]);

  return (
    <span>
      {displayed}
      {!done && <span className="typing-cursor" />}
    </span>
  );
}

function MetricRow({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: 600, color: color || "#FFFFFF" }}>
        {value}
      </span>
    </div>
  );
}

export default function CoachingIntelPanel({ data }: { data: CoachingData | null }) {
  if (!data) {
    return (
      <div className="glass-card hud-corners p-5 pulse-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="status-dot degraded" style={{ width: "6px", height: "6px" }} />
          <p className="type-section-header">Coaching Intel</p>
          <span className="module-tag module-tag-coaching">COACHING</span>
        </div>
        <div className="shimmer" style={{ height: 140 }} />
      </div>
    );
  }

  return (
    <div className="glass-card hud-corners p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className="status-dot online" style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header">Coaching Intel</p>
        <span className="module-tag module-tag-coaching">COACHING</span>
      </div>

      {/* Aggregate metrics */}
      <div className="space-y-0.5 mb-4">
        <MetricRow label="Calls This Week" value={data.callsThisWeek} />
        <MetricRow label="Processed" value={data.callsProcessed} color="#22C55E" />
      </div>

      {/* Recent calls */}
      {data.recentCalls.length > 0 && (
        <div className="pt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "#6B7280",
              marginBottom: "10px",
            }}
          >
            Recent Calls
          </p>
          <div className="space-y-2.5">
            {data.recentCalls.map((call, i) => {
              const initials = getInitials(call.title);
              const colour = AVATAR_COLOURS[i % AVATAR_COLOURS.length];
              return (
                <div key={i} className="flex items-center gap-2.5">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{
                      background: `${colour}15`,
                      color: colour,
                      border: `1px solid ${colour}30`,
                      fontFamily: "var(--font-mono)",
                      fontSize: "8px",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                    }}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.85)" }}
                      className="truncate"
                    >
                      <TypewriterText text={call.title} speed={25} />
                    </p>
                  </div>
                  <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280", whiteSpace: "nowrap" }}>
                    {new Date(call.date).toLocaleDateString("en-AU", { day: "2-digit", month: "short" })}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
