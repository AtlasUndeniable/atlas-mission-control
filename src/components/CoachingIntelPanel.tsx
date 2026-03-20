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

export default function CoachingIntelPanel({ data }: { data: CoachingData | null }) {
  if (!data) {
    return (
      <div className="glass-card hud-corners p-6 pulse-border">
        <div className="flex items-center gap-3 mb-4">
          <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>Coaching Intel</p>
          <span className="module-tag module-tag-coaching">COACHING</span>
        </div>
        <div className="shimmer" style={{ height: 120 }} />
      </div>
    );
  }

  return (
    <div className="glass-card hud-corners p-6">
      <div className="flex items-center gap-3 mb-4">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>Coaching Intel</p>
        <span className="module-tag module-tag-coaching">COACHING</span>
      </div>
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>Calls This Week</span>
          <span className="type-data" style={{ fontSize: "24px", fontWeight: 700, color: "#FFFFFF" }}>
            {data.callsThisWeek}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>Total Processed</span>
          <span className="type-data" style={{ fontSize: "16px", fontWeight: 600, color: "#FFFFFF" }}>
            {data.callsProcessed}
          </span>
        </div>

        <div className="pt-4 mt-4" style={{ borderTop: "1px solid rgba(0,136,255,0.1)" }}>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#6B7280", marginBottom: "12px" }}>Recent Calls</p>
          <div className="space-y-3">
            {data.recentCalls.map((call, i) => {
              const initials = getInitials(call.title);
              const colour = AVATAR_COLOURS[i % AVATAR_COLOURS.length];
              return (
                <div key={i} className="flex items-center gap-2.5">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ background: `${colour}15`, color: colour, border: `1px solid ${colour}30`, fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: 700, letterSpacing: "0.05em" }}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.80)" }} className="truncate">
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
      </div>
    </div>
  );
}
