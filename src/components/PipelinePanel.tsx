"use client";

interface PipelineStage {
  name: string;
  count?: number;
}

interface Pipeline {
  name: string;
  stages: PipelineStage[];
}

export default function PipelinePanel({ data }: { data: unknown }) {
  let pipelines: Pipeline[] = [];

  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const raw = (d.pipelines || d) as unknown;
    if (Array.isArray(raw)) {
      for (const p of raw) {
        const pObj = p as Record<string, unknown>;
        const stages = (pObj.stages || []) as Array<Record<string, unknown>>;
        pipelines.push({
          name: String(pObj.name || "Pipeline"),
          stages: stages.map((s) => ({
            name: String(s.name || "Unknown"),
            count: typeof s.count === "number" ? s.count : undefined,
          })),
        });
      }
    }
  }

  if (pipelines.length === 0) {
    return (
      <div className="glass-card p-4 pulse-border">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-3"
           style={{ fontFamily: "var(--font-inter)" }}>Pipeline</p>
        <div className="shimmer" style={{ height: 80 }} />
      </div>
    );
  }

  // Show the main sales pipeline as a funnel
  const mainPipeline = pipelines.find((p) => p.name === "SALES") || pipelines[0];

  return (
    <div className="glass-card p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-1"
         style={{ fontFamily: "var(--font-inter)" }}>Pipeline</p>
      <p className="text-[0.6rem] text-muted mb-3">{mainPipeline.name}</p>

      {/* Horizontal funnel */}
      <div className="flex gap-1 mb-3 overflow-x-auto">
        {mainPipeline.stages.map((stage, i) => {
          const opacity = 1 - (i / (mainPipeline.stages.length)) * 0.6;
          return (
            <div
              key={i}
              className="funnel-stage flex-1 min-w-0 text-center"
              style={{
                borderBottom: `2px solid rgba(13, 255, 198, ${opacity})`,
              }}
            >
              <p className="text-[0.55rem] text-text-secondary truncate leading-tight">
                {stage.name}
              </p>
              {stage.count !== undefined && (
                <p className="text-xs text-text-primary mt-0.5"
                   style={{ fontFamily: "var(--font-bebas)" }}>
                  {stage.count}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Other pipelines as compact list */}
      {pipelines.length > 1 && (
        <div className="border-t border-white/[0.06] pt-2 mt-2">
          {pipelines
            .filter((p) => p.name !== mainPipeline.name)
            .map((p, i) => (
              <div key={i} className="flex justify-between items-center py-1">
                <span className="text-[0.65rem] text-text-secondary truncate">{p.name}</span>
                <span className="text-[0.65rem] text-muted" style={{ fontFamily: "var(--font-jetbrains)" }}>
                  {p.stages.length} stages
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
