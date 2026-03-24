"use client";

import { useEffect, useState, useMemo } from "react";

// ===== TYPES =====
interface TaskItem {
  id: string;
  name: string;
  status: string;
  priority: string;
  group: string;
  boardName: string;
  boardId: string;
}

interface MondayData {
  boards: Array<{ id: string; name: string; totalItems: number; groups: string[] }>;
  tasks: TaskItem[];
  summary: {
    activeClients: number;
    highPriority: number;
    critical: number;
    inProgress: number;
    stuck: number;
    notStarted: number;
    done: number;
    totalTasks: number;
  };
  fetchedAt: number;
}

// Kept for backwards compat — parent still passes this
interface OperationsData {
  activeClients: number;
  highPriority: number;
  tasksDone: number;
  tasksWorking: number;
  tasksStuck: number;
}

// ===== CONSTANTS =====
const STATUS_COLOUR: Record<string, string> = {
  "Stuck": "#EF4444",
  "In Progress": "#0088FF",
  "Not Started": "rgba(255,255,255,0.35)",
  "Done": "#22C55E",
  "Waiting": "#F59E0B",
};

const PRIORITY_COLOUR: Record<string, string> = {
  "Critical": "#EF4444",
  "High": "#F59E0B",
  "Medium": "#0088FF",
  "Low": "rgba(255,255,255,0.35)",
  "None": "transparent",
};

const STATUS_ORDER: Record<string, number> = {
  "Stuck": 0,
  "In Progress": 1,
  "Not Started": 2,
  "Waiting": 3,
  "Done": 4,
};

// ===== SUBCOMPONENTS =====
function MetricRow({ label, value, valueColor }: { label: string; value: number | string; valueColor?: string }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#9CA3AF" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: 600, color: valueColor || "#FFFFFF" }}>
        {value}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colour = STATUS_COLOUR[status] || "rgba(255,255,255,0.25)";
  return (
    <span
      style={{
        width: "5px",
        height: "5px",
        borderRadius: "50%",
        background: colour,
        boxShadow: status === "Stuck" ? `0 0 4px ${colour}` : undefined,
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "None") return null;
  const colour = PRIORITY_COLOUR[priority] || "rgba(255,255,255,0.3)";
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "8px",
        fontWeight: 700,
        letterSpacing: "0.1em",
        padding: "1px 5px",
        borderRadius: "3px",
        background: `${colour}18`,
        color: colour,
        border: `1px solid ${colour}35`,
        whiteSpace: "nowrap",
      }}
    >
      {priority.toUpperCase()}
    </span>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <StatusDot status={task.status} />
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "11px",
          color: task.status === "Done" ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.80)",
          textDecoration: task.status === "Done" ? "line-through" : "none",
          flex: 1,
          minWidth: 0,
        }}
        className="truncate"
        title={`${task.name} — ${task.boardName}`}
      >
        {task.name}
      </span>
      <PriorityBadge priority={task.priority} />
    </div>
  );
}

// ===== MAIN COMPONENT =====
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function OperationsPanel({ data: _legacyData }: { data: OperationsData | null }) {
  const [mondayData, setMondayData] = useState<MondayData | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    async function fetchMonday() {
      try {
        const res = await fetch("/api/monday");
        if (res.ok) {
          const data = await res.json();
          if (data) {
            setMondayData(data);
            setConnecting(false);
          } else {
            setConnecting(true);
          }
        } else {
          setConnecting(true);
        }
      } catch {
        setConnecting(true);
      }
    }
    fetchMonday();
    const interval = setInterval(fetchMonday, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Filter out "Completed Tasks" and "Fireflies" group items, sort by priority/status
  const activeTasks = useMemo(() => {
    if (!mondayData) return [];
    return mondayData.tasks
      .filter((t) => {
        const g = t.group.toLowerCase();
        return !g.includes("completed") && !g.includes("fireflies") && !g.includes("instructions");
      })
      .sort((a, b) => {
        // Stuck first, then In Progress, then Not Started, then Done
        const sa = STATUS_ORDER[a.status] ?? 3;
        const sb = STATUS_ORDER[b.status] ?? 3;
        if (sa !== sb) return sa - sb;
        // Within same status, Critical > High > Medium > Low > None
        const pa = ["Critical", "High", "Medium", "Low", "None"].indexOf(a.priority);
        const pb = ["Critical", "High", "Medium", "Low", "None"].indexOf(b.priority);
        return pa - pb;
      });
  }, [mondayData]);

  const displayTasks = showAll ? activeTasks : activeTasks.slice(0, 8);
  const hasMore = activeTasks.length > 8;

  // ===== CONNECTING STATE =====
  if (connecting && !mondayData) {
    return (
      <div className="glass-card hud-corners p-5 pulse-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="status-dot degraded" style={{ width: "6px", height: "6px" }} />
          <p className="type-section-header">Operations</p>
          <span className="module-tag module-tag-ops-core">OPS-CORE</span>
        </div>
        <div className="flex items-center gap-3 py-4 justify-center">
          <div className="status-dot degraded" style={{ width: "5px", height: "5px" }} />
          <p className="breathing" style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#6B7280" }}>
            Connecting to Monday.com...
          </p>
        </div>
      </div>
    );
  }

  const s = mondayData!.summary;

  return (
    <div className="glass-card hud-corners p-5">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <span className="status-dot online" style={{ width: "6px", height: "6px" }} />
        <p className="type-section-header">Operations</p>
        <span className="module-tag module-tag-ops-core">OPS-CORE</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280", marginLeft: "auto" }}>
          {s.activeClients} boards
        </span>
      </div>

      {/* Summary metrics */}
      <div className="space-y-0.5 mb-3">
        <MetricRow
          label="High Priority"
          value={s.highPriority + s.critical}
          valueColor={s.highPriority + s.critical > 0 ? "#F59E0B" : "#FFFFFF"}
        />
        <MetricRow label="In Progress" value={s.inProgress} />
        <MetricRow
          label="Stuck"
          value={s.stuck}
          valueColor={s.stuck > 0 ? "#EF4444" : "#FFFFFF"}
        />
        <MetricRow label="Not Started" value={s.notStarted} />
        <MetricRow label="Completed" value={s.done} valueColor="#22C55E" />
      </div>

      {/* Task list */}
      {activeTasks.length > 0 && (
        <div className="pt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "#6B7280",
              marginBottom: "6px",
            }}
          >
            Active Tasks
          </p>
          <div className="space-y-0">
            {displayTasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => setShowAll(!showAll)}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 600,
                letterSpacing: "0.1em",
                color: "#0088FF",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "6px 0 0",
                opacity: 0.7,
              }}
            >
              {showAll ? "SHOW LESS" : `+${activeTasks.length - 8} MORE`}
            </button>
          )}
        </div>
      )}

      {/* Footer: cache age */}
      <div className="mt-3 pt-2" style={{ borderTop: "1px solid rgba(0,136,255,0.08)" }}>
        <div className="flex justify-between items-center">
          <MetricRow label="Active Clients" value={s.activeClients} valueColor="#0088FF" />
        </div>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "8px",
            color: "rgba(255,255,255,0.15)",
            letterSpacing: "0.08em",
            marginTop: "4px",
          }}
        >
          LIVE · MONDAY.COM · 5M CACHE
        </p>
      </div>
    </div>
  );
}
