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
    <div className="glass-card p-4 fade-in">
      <form onSubmit={handleSubmit} className="flex items-center gap-3">
        <span className="text-accent font-mono font-bold text-sm whitespace-nowrap">ATLAS &gt;</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask ATLAS anything..."
          disabled={loading}
          className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-muted font-sans focus:ring-0"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="text-accent hover:text-text-primary transition-colors disabled:text-text-muted text-sm font-mono"
        >
          {loading ? "..." : "⏎"}
        </button>
      </form>

      {response && (
        <div className="mt-3 pt-3 border-t border-card-border">
          <p className="text-sm text-text-secondary whitespace-pre-wrap">{response}</p>
        </div>
      )}

      {error && (
        <div className="mt-3 pt-3 border-t border-card-border">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}
    </div>
  );
}
