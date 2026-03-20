"use client";

interface PipelineStage {
  name: string;
  count?: number;
}

export default function PipelinePanel({ data }: { data: unknown }) {
  // Try to extract pipeline stages from GHL response
  let stages: PipelineStage[] = [];

  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const pipelines = (d.pipelines || d.pipeline || d) as unknown;

    if (Array.isArray(pipelines)) {
      for (const p of pipelines) {
        const pObj = p as Record<string, unknown>;
        const pStages = (pObj.stages || []) as Array<Record<string, unknown>>;
        for (const s of pStages) {
          stages.push({ name: String(s.name || "Unknown"), count: Number(s.count || 0) });
        }
      }
    }
  }

  if (stages.length === 0) {
    return (
      <div className="glass-card p-4 fade-in pulse-border">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Pipeline
        </h3>
        <p className="text-sm text-text-muted">Connecting...</p>
        <p className="text-xs text-text-muted mt-1">GHL bridge</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-4 fade-in">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
        Pipeline
      </h3>
      <div className="space-y-2">
        {stages.map((stage, i) => (
          <div key={i} className="flex justify-between items-center">
            <span className="text-xs text-text-secondary truncate">{stage.name}</span>
            <span className="text-xs font-mono font-bold text-text-primary">{stage.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
