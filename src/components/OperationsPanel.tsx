"use client";

interface OperationsData {
  activeClients: number;
  highPriority: number;
  tasksDone: number;
  tasksWorking: number;
  tasksStuck: number;
}

function Metric({ label, value, color, max }: { label: string; value: number; color: string; max: number }) {
  const display = value === 0 ? "—" : value;
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;

  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-text-secondary">{label}</span>
        <span className="text-sm tracking-[0.05em]"
              style={{ fontFamily: "var(--font-bebas)", color }}>
          {display}
        </span>
      </div>
      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export default function OperationsPanel({ data }: { data: OperationsData | null }) {
  if (!data) {
    return (
      <div className="glass-card p-4 pulse-border">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-3"
           style={{ fontFamily: "var(--font-inter)" }}>Operations</p>
        <div className="shimmer" style={{ height: 120 }} />
      </div>
    );
  }

  const total = data.tasksDone + data.tasksWorking + data.tasksStuck + data.highPriority || 1;

  return (
    <div className="glass-card p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-4"
         style={{ fontFamily: "var(--font-inter)" }}>Operations</p>
      <div className="space-y-3">
        <Metric label="High Priority" value={data.highPriority} color="#FFB224" max={total} />
        <Metric label="In Progress" value={data.tasksWorking} color="#0DFFC6" max={total} />
        <Metric label="Stuck" value={data.tasksStuck} color="#FF4D4D" max={total} />
        <Metric label="Completed" value={data.tasksDone} color="#0DFFC6" max={total} />
        <div className="border-t border-white/[0.06] pt-3 mt-3">
          <div className="flex justify-between items-center">
            <span className="text-xs text-text-secondary">Active Clients</span>
            <span className="text-lg tracking-[0.05em] text-text-primary"
                  style={{ fontFamily: "var(--font-bebas)" }}>
              {data.activeClients}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
