"use client";

interface CoachingData {
  callsThisWeek: number;
  callsProcessed: number;
  recentCalls: Array<{ title: string; date: number }>;
}

function getInitials(title: string): string {
  // Extract non-Rhys participant name
  const cleaned = title
    .replace(/\b(rhys|livingstone|x|vs|and|with)\b/gi, "")
    .replace(/\(.*?\)/g, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return "??";
}

const AVATAR_COLOURS = ["#0DFFC6", "#FFB224", "#a855f7", "#06b6d4", "#FF4D4D"];

export default function CoachingIntelPanel({ data }: { data: CoachingData | null }) {
  if (!data) {
    return (
      <div className="glass-card p-4 pulse-border">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-3"
           style={{ fontFamily: "var(--font-inter)" }}>Coaching Intel</p>
        <div className="shimmer" style={{ height: 120 }} />
      </div>
    );
  }

  return (
    <div className="glass-card p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-4"
         style={{ fontFamily: "var(--font-inter)" }}>Coaching Intel</p>
      <div className="space-y-3">
        {/* Prominent calls this week */}
        <div className="flex justify-between items-center">
          <span className="text-xs text-text-secondary">Calls This Week</span>
          <span className="text-2xl tracking-[0.05em] text-accent"
                style={{ fontFamily: "var(--font-bebas)" }}>
            {data.callsThisWeek}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-xs text-text-secondary">Total Processed</span>
          <span className="text-sm tracking-[0.05em] text-text-primary"
                style={{ fontFamily: "var(--font-bebas)" }}>
            {data.callsProcessed}
          </span>
        </div>

        <div className="border-t border-white/[0.06] pt-3 mt-3">
          <p className="text-[0.65rem] text-muted mb-2 uppercase tracking-[0.1em]">Recent Calls</p>
          <div className="space-y-2.5">
            {data.recentCalls.map((call, i) => {
              const initials = getInitials(call.title);
              const colour = AVATAR_COLOURS[i % AVATAR_COLOURS.length];
              return (
                <div key={i} className="flex items-center gap-2.5">
                  {/* Avatar circle */}
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-[0.55rem] font-semibold"
                    style={{ background: `${colour}20`, color: colour, border: `1px solid ${colour}40` }}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-text-secondary truncate">{call.title}</p>
                  </div>
                  <p className="text-[0.6rem] text-muted whitespace-nowrap"
                     style={{ fontFamily: "var(--font-jetbrains)" }}>
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
