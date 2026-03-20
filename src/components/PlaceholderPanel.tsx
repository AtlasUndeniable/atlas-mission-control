"use client";

interface PlaceholderPanelProps {
  title: string;
  source: string;
}

export default function PlaceholderPanel({ title, source }: PlaceholderPanelProps) {
  return (
    <div className="glass-card p-4 fade-in pulse-border">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="flex flex-col items-center justify-center py-6">
        <div className="w-10 h-10 rounded-full border border-card-border flex items-center justify-center mb-3">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="8" stroke="#64748b" strokeWidth="1.5" strokeDasharray="3 3" />
            <circle cx="10" cy="10" r="2" fill="#64748b" />
          </svg>
        </div>
        <p className="text-sm text-text-muted">Connecting...</p>
        <p className="text-xs text-text-muted mt-1">{source}</p>
      </div>
    </div>
  );
}
