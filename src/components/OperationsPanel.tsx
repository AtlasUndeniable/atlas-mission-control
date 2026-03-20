"use client";

interface OperationsData {
  activeClients: number;
  highPriority: number;
  tasksDone: number;
  tasksWorking: number;
  tasksStuck: number;
}

function Metric({ label, value, color, max }: { label: string; value: number; color: string; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;

  return (
    <div>
      <div className="flex justify-between items-center mb-1.5">
        <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>{label}</span>
        <span className="type-data" style={{ fontSize: "16px", fontWeight: 600, color: "#FFFFFF" }}>
          {value}
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
      <div className="glass-card hud-corners p-6 pulse-border">
        <div className="flex items-center gap-3 mb-4">
          <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>Operations</p>
          <span className="module-tag module-tag-ops-core">OPS-CORE</span>
        </div>
        <div className="shimmer" style={{ height: 120 }} />
      </div>
    );
  }

  const total = data.tasksDone + data.tasksWorking + data.tasksStuck + data.highPriority || 1;

  return (
    <div className="glass-card hud-corners p-6">
      <div className="flex items-center gap-3 mb-4">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>Operations</p>
        <span className="module-tag module-tag-ops-core">OPS-CORE</span>
      </div>
      <div className="space-y-3">
        <Metric label="High Priority" value={data.highPriority} color="#F59E0B" max={total} />
        <Metric label="In Progress" value={data.tasksWorking} color="#0088FF" max={total} />
        <Metric label="Stuck" value={data.tasksStuck} color="#EF4444" max={total} />
        <Metric label="Completed" value={data.tasksDone} color="#22C55E" max={total} />
        <div className="pt-4 mt-4" style={{ borderTop: "1px solid rgba(0,136,255,0.1)" }}>
          <div className="flex justify-between items-center">
            <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>Active Clients</span>
            <span className="type-data" style={{ fontSize: "24px", fontWeight: 700, color: "#FFFFFF" }}>
              {data.activeClients}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
