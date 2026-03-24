"use client";

import { useState } from "react";
import type { SoundEngine } from "@/components/SoundEngine";

interface AtlasChatBarProps {
  soundEngine?: SoundEngine;
}

export default function AtlasChatBar({ soundEngine }: AtlasChatBarProps) {
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
        soundEngine?.notification();
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
    <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-3">
      <div className="max-w-[1440px] mx-auto">
        <div className="glass-card" style={{ background: "rgba(5, 5, 16, 0.96)", backdropFilter: "blur(24px)", padding: "10px 16px", borderColor: "rgba(0, 136, 255, 0.12)" }}>
          {/* Top glow line */}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "1px", background: "linear-gradient(90deg, transparent, rgba(0,136,255,0.3), transparent)" }} />
          <form onSubmit={handleSubmit} className="flex items-center gap-3">
            <div className="status-dot online flex-shrink-0" style={{ width: "6px", height: "6px" }} />
            <span className="text-glow whitespace-nowrap"
                  style={{ fontFamily: "var(--font-heading)", fontSize: "13px", fontWeight: 700, letterSpacing: "0.3em", color: "#0088FF" }}>
              ATLAS
            </span>
            <span style={{ color: "rgba(0, 136, 255, 0.4)", fontSize: "14px", fontWeight: 300, lineHeight: 1 }}>&gt;</span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask ATLAS anything..."
              disabled={loading}
              className="chat-input flex-1 bg-transparent border-none"
              style={{ fontFamily: "var(--font-body)", fontSize: "13px", color: "rgba(255,255,255,0.85)" }}
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="px-3 py-1.5 rounded transition-all disabled:opacity-30"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "10px",
                fontWeight: 700,
                letterSpacing: "0.15em",
                textTransform: "uppercase" as const,
                background: loading ? "transparent" : "rgba(0, 136, 255, 0.06)",
                color: "#0088FF",
                border: "1px solid rgba(0, 136, 255, 0.25)",
              }}
            >
              {loading ? "..." : "SEND"}
            </button>
          </form>

          {response && (
            <div className="mt-2.5 pt-2.5" style={{ borderTop: "1px solid rgba(0,136,255,0.08)", marginLeft: "30px" }}>
              <div className="rounded p-3" style={{ background: "rgba(0,136,255,0.03)" }}>
                <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.78)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                  {response}
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-2.5 pt-2.5" style={{ borderTop: "1px solid rgba(255,51,68,0.1)", marginLeft: "30px" }}>
              <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#FF3344" }}>{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
