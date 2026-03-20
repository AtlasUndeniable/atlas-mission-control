"use client";

interface PlaceholderPanelProps {
  title: string;
  source: string;
  emptyMessage?: string;
}

export default function PlaceholderPanel({ title, source, emptyMessage }: PlaceholderPanelProps) {
  return (
    <div className="glass-card p-4 pulse-border">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted mb-3"
         style={{ fontFamily: "var(--font-inter)" }}>
        {title}
      </p>
      <div className="flex flex-col items-center justify-center py-5">
        {emptyMessage ? (
          <p className="text-xs text-muted">{emptyMessage}</p>
        ) : (
          <>
            <div className="shimmer mb-3" style={{ width: 80, height: 28 }} />
            <p className="text-xs text-muted connecting-pulse">{source}</p>
          </>
        )}
      </div>
    </div>
  );
}
