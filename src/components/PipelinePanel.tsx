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
      <div className="glass-card hud-corners p-6">
        <div className="flex items-center gap-3 mb-4">
          <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>Pipeline</p>
          <span className="module-tag module-tag-growth">GROWTH</span>
        </div>
        <div className="flex flex-col items-center justify-center py-6">
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "clamp(32px, 3vw, 48px)", fontWeight: 700, color: "#374151", marginBottom: "12px" }}>—</p>
          <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "#6B7280", fontStyle: "italic" }}>
            Awaiting GHL pipeline data
          </p>
        </div>
      </div>
    );
  }

  const mainPipeline = pipelines.find((p) => p.name === "SALES") || pipelines[0];

  // Shorten stage names for compact display
  const SHORT_NAMES: Record<string, string> = {
    "Lead Magnet": "Lead",
    "Enquired": "Enquired",
    "Booked Triage": "Triage",
    "Booked IA": "BOOKED",
    "Pending": "Pending",
    "Closed Deal": "Closed",
    "No Sale": "No Sale",
  };
  const shortName = (name: string) => {
    for (const [key, val] of Object.entries(SHORT_NAMES)) {
      if (name.toLowerCase().startsWith(key.toLowerCase())) return val;
    }
    return name.length > 8 ? name.slice(0, 7) + "." : name;
  };

  const maxCount = Math.max(...mainPipeline.stages.map((s) => s.count ?? 0), 1);

  return (
    <div className="glass-card hud-corners p-6">
      <div className="flex items-center gap-3 mb-2">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>Pipeline</p>
        <span className="module-tag module-tag-growth">GROWTH</span>
      </div>
      <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280", marginBottom: "16px" }}>{mainPipeline.name}</p>

      {/* Horizontal funnel with visible bars */}
      <div className="flex gap-1.5 mb-4 overflow-x-auto">
        {mainPipeline.stages.map((stage, i) => {
          const count = stage.count ?? 0;
          const barHeight = count > 0 ? Math.max(20, (count / maxCount) * 48) : 4;
          const opacity = 1 - (i / mainPipeline.stages.length) * 0.5;
          return (
            <div
              key={i}
              className="flex-1 min-w-0 text-center"
              title={stage.name}
            >
              {/* Count above bar */}
              <p style={{
                fontFamily: "var(--font-mono)",
                fontSize: "14px",
                fontWeight: 700,
                color: "#FFFFFF",
                marginBottom: "4px",
              }}>
                {count}
              </p>
              {/* Bar */}
              <div
                style={{
                  height: `${barHeight}px`,
                  background: `rgba(0, 136, 255, ${opacity * 0.3})`,
                  borderRadius: "3px",
                  marginBottom: "6px",
                  transition: "height 0.5s ease",
                }}
              />
              {/* Label */}
              <p style={{
                fontFamily: "var(--font-body)",
                fontSize: "9px",
                color: "#9CA3AF",
                lineHeight: 1.2,
              }}>
                {shortName(stage.name)}
              </p>
            </div>
          );
        })}
      </div>

      {/* Other pipelines as compact list */}
      {pipelines.length > 1 && (
        <div className="pt-3 mt-3" style={{ borderTop: "1px solid rgba(0,136,255,0.1)" }}>
          {pipelines
            .filter((p) => p.name !== mainPipeline.name)
            .map((p, i) => (
              <div key={i} className="flex justify-between items-center py-1.5">
                <span style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.75)" }} className="truncate">{p.name}</span>
                <span className="type-data" style={{ fontSize: "11px", color: "#6B7280" }}>
                  {p.stages.length} stages
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
