"use client";

interface OperationsData {
  activeClients: number;
  highPriority: number;
  tasksDone: number;
  tasksWorking: number;
  tasksStuck: number;
}

export default function OperationsPanel({ data }: { data: OperationsData | null }) {
  if (!data) {
    return (
      <div className="glass-card p-4 fade-in pulse-border">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Operations
        </h3>
        <p className="text-sm text-text-muted">Connecting...</p>
        <p className="text-xs text-text-muted mt-1">Monday.com bridge</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-4 fade-in">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
        Operations
      </h3>
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-text-secondary">High Priority</span>
          <span className="text-sm font-mono font-bold text-warning">{data.highPriority}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-text-secondary">In Progress</span>
          <span className="text-sm font-mono font-bold text-accent">{data.tasksWorking}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-text-secondary">Stuck</span>
          <span className="text-sm font-mono font-bold text-error">{data.tasksStuck}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-text-secondary">Completed</span>
          <span className="text-sm font-mono font-bold text-success">{data.tasksDone}</span>
        </div>
        <div className="border-t border-card-border pt-2 mt-2">
          <div className="flex justify-between items-center">
            <span className="text-sm text-text-secondary">Active Clients</span>
            <span className="text-sm font-mono font-bold text-text-primary">{data.activeClients}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
