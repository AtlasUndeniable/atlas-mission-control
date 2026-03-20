"use client";

interface PlaceholderPanelProps {
  title: string;
  source: string;
  emptyMessage?: string;
  tag?: string;
}

const TAG_CLASS: Record<string, string> = {
  "meta-ops": "module-tag-meta-ops",
  "ops-core": "module-tag-ops-core",
  coaching: "module-tag-coaching",
  growth: "module-tag-growth",
  comms: "module-tag-comms",
  system: "module-tag-system",
};

export default function PlaceholderPanel({ title, source, emptyMessage, tag }: PlaceholderPanelProps) {
  const tagLabel = tag?.toUpperCase().replace("-", "-") || "SYSTEM";
  const tagClass = TAG_CLASS[tag || "system"] || "module-tag-system";

  return (
    <div className="glass-card hud-corners p-6">
      <div className="flex items-center gap-3 mb-4">
        <p className="type-section-header" style={{ fontSize: "11px", letterSpacing: "0.15em", color: "#9CA3AF" }}>
          {title}
        </p>
        <span className={`module-tag ${tagClass}`}>{tagLabel}</span>
      </div>
      <div className="flex flex-col items-center justify-center py-6">
        <p style={{
          fontFamily: "var(--font-mono)",
          fontSize: "clamp(32px, 3vw, 48px)",
          fontWeight: 700,
          color: "#374151",
          marginBottom: "12px",
        }}>
          —
        </p>
        <p style={{
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "#6B7280",
          fontStyle: "italic",
          textAlign: "center",
          lineHeight: 1.5,
        }}>
          {emptyMessage || source}
        </p>
      </div>
    </div>
  );
}
