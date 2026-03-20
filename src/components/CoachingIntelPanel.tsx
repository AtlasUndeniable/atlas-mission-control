"use client";

interface CoachingData {
  callsThisWeek: number;
  callsProcessed: number;
  recentCalls: Array<{ title: string; date: number }>;
}

export default function CoachingIntelPanel({ data }: { data: CoachingData | null }) {
  if (!data) {
    return (
      <div className="glass-card p-4 fade-in pulse-border">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Coaching Intel
        </h3>
        <p className="text-sm text-text-muted">Connecting...</p>
        <p className="text-xs text-text-muted mt-1">Fireflies bridge</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-4 fade-in">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
        Coaching Intel
      </h3>
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-text-secondary">Calls This Week</span>
          <span className="text-sm font-mono font-bold text-accent">{data.callsThisWeek}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-text-secondary">Total Processed</span>
          <span className="text-sm font-mono font-bold text-text-primary">{data.callsProcessed}</span>
        </div>
        <div className="border-t border-card-border pt-2 mt-2">
          <p className="text-xs text-text-muted mb-2">Recent Calls</p>
          <div className="space-y-2">
            {data.recentCalls.map((call, i) => (
              <div key={i} className="flex justify-between items-start gap-2">
                <p className="text-xs text-text-secondary truncate flex-1">{call.title}</p>
                <p className="text-xs font-mono text-text-muted whitespace-nowrap">
                  {new Date(call.date).toLocaleDateString("en-AU", { day: "2-digit", month: "short" })}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
