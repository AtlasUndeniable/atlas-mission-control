"use client";

import { useState } from "react";

export default function AtlasChatBar() {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: query.trim() }),
      });

      const data = await res.json();

      if (res.ok) {
        setResponse(data.answer);
        setQuery("");
      } else {
        setError(data.error || "Request failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4">
      <div className="max-w-[1600px] mx-auto">
        <div className="glass-card p-3" style={{ background: "rgba(10, 14, 20, 0.95)", backdropFilter: "blur(24px)" }}>
          <form onSubmit={handleSubmit} className="flex items-center gap-3">
            <div className="status-dot online flex-shrink-0" />
            <span className="text-sm font-bold tracking-[0.05em] text-accent whitespace-nowrap"
                  style={{ fontFamily: "var(--font-bebas)", fontSize: "1rem" }}>
              ATLAS
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask ATLAS anything..."
              disabled={loading}
              className="chat-input flex-1 bg-transparent border-none text-sm text-text-primary placeholder:text-muted"
              style={{ fontFamily: "var(--font-inter)" }}
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="px-3 py-1.5 rounded text-xs font-semibold transition-all disabled:opacity-30"
              style={{
                fontFamily: "var(--font-inter)",
                background: loading ? "transparent" : "rgba(13, 255, 198, 0.1)",
                color: "#0DFFC6",
                border: "1px solid rgba(13, 255, 198, 0.2)",
              }}
            >
              {loading ? "..." : "Send"}
            </button>
          </form>

          {response && (
            <div className="mt-3 pt-3 border-t border-white/[0.06] ml-10">
              <div className="bg-white/[0.03] rounded-lg p-3">
                <p className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed"
                   style={{ fontFamily: "var(--font-inter)" }}>
                  {response}
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-3 pt-3 border-t border-white/[0.06] ml-10">
              <p className="text-xs text-error">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
