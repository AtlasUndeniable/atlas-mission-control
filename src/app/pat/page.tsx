"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

/**
 * Pat Approval Console — REVIEW-ONLY MVP.
 *
 * Consumes the EXISTING audited read endpoint `/api/approvals` (GET only).
 * It creates no new Slack send path, edits no approve/deny/redraft route, and
 * issues no mutating request. Approval as Rhys stays on the existing audited
 * Comms panel: the canonical rule (outbound as Rhys requires explicit human
 * approval tied to the exact final text) is preserved precisely because this
 * surface cannot send. Action buttons are disabled previews until an
 * approver-identity model exists to attribute a Pat approval.
 */

// ===== TYPES (mirror of /api/approvals — kept local; never import server lib) =====
interface Approval {
  id: string;
  type: string;
  tier: "green" | "yellow" | "red";
  channel?: string;
  replyingTo?: string;
  draft: string | null;
  originalMessage?: string;
  createdAt: string;
  status: string;
  sendable?: boolean;
  lastSendError?: string | null;
  sendFailedAt?: string | null;
}

interface ApprovalsResponse {
  approvals: Approval[];
}

// ===== CONSTANTS =====
const ACTIONABLE = new Set(["pending", "needs_draft", "drafted"]);

// Disabled previews. Wiring requires the existing audited path + an
// approver-identity model — out of scope for this review MVP.
const PREVIEW_ACTIONS: Array<{ label: string; tone: string }> = [
  { label: "approve as Rhys", tone: "#22C55E" },
  { label: "request redraft", tone: "#0088FF" },
  { label: "deny", tone: "#EF4444" },
];
const ACTION_TOOLTIP =
  "Review-only MVP. Approval as Rhys stays on the existing audited Comms panel until an approver-identity model exists.";

// Heuristic only — a read-side scan of the original message text. NOT a
// captured field. Deadline / context-confidence are not in the pipeline.
const URGENCY_TOKENS = [
  "urgent",
  "asap",
  "eod",
  "cob",
  "today",
  "tonight",
  "deadline",
  "immediately",
  "right now",
  "by tomorrow",
  "end of day",
  "first thing",
  "time sensitive",
  "time-sensitive",
];

// ===== HELPERS =====
function stripMentions(s: string): string {
  return s.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}

function urgencySignal(original: string): "high" | "medium" | "none" {
  const t = original.toLowerCase();
  const hits = URGENCY_TOKENS.filter((tok) => t.includes(tok)).length;
  if (hits >= 2) return "high";
  if (hits === 1) return "medium";
  if (/\?\s*$/.test(original.trim())) return "medium"; // a direct question still waiting
  return "none";
}

function urgencyColour(u: "high" | "medium" | "none"): string {
  if (u === "high") return "#EF4444";
  if (u === "medium") return "#F59E0B";
  return "#6B7280";
}

function confidenceProxy(a: Approval): string {
  if (a.status === "needs_draft" || !a.draft) return "awaiting draft";
  if (a.status === "drafted") return "draft ready (auto)";
  if (a.status === "pending") return "draft ready";
  return a.status;
}

function ageMinutes(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 60000);
}

function relTime(iso: string): string {
  const m = ageMinutes(iso);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function absTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const URGENCY_RANK: Record<string, number> = { high: 2, medium: 1, none: 0 };

// ===== CARD =====
function ReviewCard({ a }: { a: Approval }) {
  const original = stripMentions(a.originalMessage ?? "");
  const u = urgencySignal(a.originalMessage ?? "");
  const uColour = urgencyColour(u);
  const hasDraft = !!a.draft && a.draft !== "None";
  const failed = a.status === "send_failed";

  return (
    <div
      className="glass-card hud-corners"
      style={{ padding: "14px 16px", marginBottom: "10px", opacity: failed ? 0.7 : 1 }}
    >
      {/* Row 1: channel / person / status / age */}
      <div className="flex items-center gap-2" style={{ flexWrap: "wrap", marginBottom: "6px" }}>
        <span
          className="status-dot"
          style={{ width: "6px", height: "6px", background: uColour, boxShadow: `0 0 6px ${uColour}` }}
        />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.05em",
            color: "rgba(255,255,255,0.85)",
          }}
        >
          #{a.channel || "unknown"}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#B0B8C4" }}>
          {a.replyingTo ? `replying to ${a.replyingTo}` : "sender unknown"}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "8px",
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: failed ? "#EF4444" : "rgba(255,255,255,0.5)",
            background: failed ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.05)",
            border: `1px solid ${failed ? "rgba(239,68,68,0.25)" : "rgba(255,255,255,0.1)"}`,
            borderRadius: "3px",
            padding: "1px 6px",
          }}
        >
          {a.status}
        </span>
        <span
          title={absTime(a.createdAt)}
          style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: "10px", color: "#6B7280" }}
        >
          {relTime(a.createdAt)}
        </span>
      </div>

      {/* Row 2: signals — clearly labelled as heuristic / not-captured */}
      <div className="flex items-center gap-2" style={{ flexWrap: "wrap", marginBottom: "8px" }}>
        <span
          title="Heuristic scan of the original message — not a captured field"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "8px",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: uColour,
            background: `${uColour}18`,
            border: `1px solid ${uColour}40`,
            borderRadius: "3px",
            padding: "2px 7px",
          }}
        >
          urgency: {u} (heuristic)
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", color: "#6B7280" }}>
          deadline: not captured · confidence: {confidenceProxy(a)} (pipeline state)
        </span>
      </div>

      {/* Row 3: original ask */}
      <p style={{ fontFamily: "var(--font-mono)", fontSize: "9px", letterSpacing: "0.08em", color: "#4B5563", margin: "0 0 3px 0" }}>
        ORIGINAL ASK
      </p>
      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          lineHeight: 1.45,
          color: "rgba(255,255,255,0.7)",
          margin: "0 0 8px 0",
          wordBreak: "break-word",
        }}
      >
        {original ? original : "(no original message captured)"}
      </p>

      {/* Row 4: Atlas draft */}
      <p style={{ fontFamily: "var(--font-mono)", fontSize: "9px", letterSpacing: "0.08em", color: "#4B5563", margin: "0 0 3px 0" }}>
        ATLAS DRAFT (exact text that would send as Rhys)
      </p>
      {hasDraft ? (
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "12.5px",
            fontStyle: "italic",
            lineHeight: 1.5,
            color: "rgba(255,255,255,0.9)",
            background: "rgba(0,212,255,0.04)",
            border: "1px solid rgba(0,212,255,0.12)",
            borderRadius: "4px",
            padding: "8px 10px",
            margin: "0 0 8px 0",
            wordBreak: "break-word",
          }}
        >
          “{a.draft}”
        </p>
      ) : (
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            color: "#F59E0B",
            margin: "0 0 8px 0",
          }}
        >
          Draft pending — the next triage cycle will generate it.
        </p>
      )}

      {failed && a.sendFailedAt && (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "9px", color: "#EF4444", margin: "0 0 8px 0" }}>
          send failed {absTime(a.sendFailedAt)}
          {a.lastSendError ? ` · ${a.lastSendError}` : ""} · resolve on the audited Comms panel
        </p>
      )}

      {/* Row 5: disabled preview actions + canonical rule */}
      <div className="flex items-center gap-2" style={{ flexWrap: "wrap", marginTop: "4px" }}>
        {PREVIEW_ACTIONS.map((act) => (
          <button
            key={act.label}
            type="button"
            disabled
            aria-disabled
            title={ACTION_TOOLTIP}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: act.tone,
              background: "transparent",
              border: `1px solid ${act.tone}2e`,
              borderRadius: "4px",
              padding: "3px 9px",
              cursor: "not-allowed",
              opacity: 0.4,
            }}
          >
            {act.label}
          </button>
        ))}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "8px", fontWeight: 700, letterSpacing: "0.1em", color: "#4B5563", marginLeft: "auto" }}>
          REVIEW ONLY · APPROVAL STAYS ON AUDITED COMMS PANEL
        </span>
      </div>
    </div>
  );
}

// ===== STAT =====
function Stat({ label, value, colour }: { label: string; value: number; colour: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "6px 14px", borderRight: "1px solid rgba(0,136,255,0.08)" }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "16px", fontWeight: 700, color: colour, lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "8px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#6B7280" }}>
        {label}
      </span>
    </div>
  );
}

// ===== PAGE =====
export default function PatConsolePage() {
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals"); // EXISTING audited read-only GET
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ApprovalsResponse = await res.json();
      setItems(json.approvals ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const comms = useMemo(
    () => items.filter((a) => a.type === "slack"),
    [items],
  );

  const actionable = useMemo(() => {
    return comms
      .filter((a) => ACTIONABLE.has(a.status))
      .slice()
      .sort((x, y) => {
        const ur =
          URGENCY_RANK[urgencySignal(y.originalMessage ?? "")] -
          URGENCY_RANK[urgencySignal(x.originalMessage ?? "")];
        if (ur !== 0) return ur;
        return Date.parse(x.createdAt) - Date.parse(y.createdAt); // oldest first
      });
  }, [comms]);

  const blocked = useMemo(
    () => comms.filter((a) => a.status === "send_failed"),
    [comms],
  );

  const counts = {
    total: actionable.length,
    drafted: actionable.filter((a) => a.status === "drafted").length,
    awaiting: actionable.filter((a) => a.status === "needs_draft" || !a.draft).length,
    blocked: blocked.length,
  };

  return (
    <div className="ambient-bg" style={{ minHeight: "100vh", paddingBottom: "60px" }}>
      <div className="crt-scanlines" />

      <header
        className="sticky top-0 z-40"
        style={{
          background: "rgba(5,5,16,0.92)",
          backdropFilter: "blur(16px)",
          padding: "12px 24px",
          borderBottom: "1px solid rgba(0,212,255,0.12)",
        }}
      >
        <div className="flex items-center gap-3" style={{ maxWidth: "1100px", margin: "0 auto", flexWrap: "wrap" }}>
          <h1 className="type-section-header text-glow" style={{ color: "#00D4FF", fontSize: "13px", margin: 0 }}>
            PAT APPROVAL CONSOLE
          </h1>
          <span className="module-tag module-tag-comms">REVIEW · MVP</span>
          <Link
            href="/"
            style={{ fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: 700, letterSpacing: "0.1em", color: "#6B7280", textDecoration: "none", marginLeft: "auto" }}
          >
            ← DASHBOARD
          </Link>
          <button
            type="button"
            onClick={load}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: "#00D4FF",
              background: "transparent",
              border: "1px solid rgba(0,212,255,0.3)",
              borderRadius: "4px",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            REFRESH
          </button>
        </div>
      </header>

      <main style={{ maxWidth: "1100px", margin: "0 auto", padding: "20px 24px 0", position: "relative", zIndex: 2 }}>
        <div
          style={{
            background: "rgba(0,212,255,0.05)",
            border: "1px solid rgba(0,212,255,0.22)",
            borderRadius: "6px",
            padding: "10px 14px",
            marginBottom: "16px",
          }}
        >
          <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.8)", margin: 0, lineHeight: 1.5 }}>
            <strong>Canonical rule preserved:</strong> outbound messages as Rhys
            require explicit human approval tied to the exact final text. This
            console is <strong>review-only</strong> — it reads the existing
            audited approvals data and sends nothing. Approval still happens on
            the existing audited Comms panel. Gate-held items are intentionally
            excluded (they go to Dante’s out-of-band triage, not Pat).
          </p>
        </div>

        <div className="glass-card" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", padding: "4px", marginBottom: "14px" }}>
          <Stat label="Pending comms" value={counts.total} colour="rgba(255,255,255,0.85)" />
          <Stat label="Draft ready" value={counts.drafted} colour="#00D4FF" />
          <Stat label="Awaiting draft" value={counts.awaiting} colour="#F59E0B" />
          <Stat label="Blocked" value={counts.blocked} colour="#EF4444" />
        </div>

        {loading && (
          <p className="breathing" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "#6B7280" }}>
            Loading pending Rhys comms…
          </p>
        )}
        {error && (
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "#EF4444" }}>
            Error: {error}
          </p>
        )}
        {!loading && !error && actionable.length === 0 && (
          <p style={{ fontFamily: "var(--font-body)", fontSize: "12px", color: "rgba(255,255,255,0.4)" }}>
            No pending Rhys comms to review. Nothing waiting on a sign-off.
          </p>
        )}

        {actionable.map((a) => (
          <ReviewCard key={a.id} a={a} />
        ))}

        {blocked.length > 0 && (
          <>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#6B7280", margin: "18px 0 8px" }}>
              Blocked · {blocked.length} (read-only — resolve on the audited Comms panel)
            </p>
            {blocked.map((a) => (
              <ReviewCard key={a.id} a={a} />
            ))}
          </>
        )}

        <p style={{ fontFamily: "var(--font-mono)", fontSize: "8px", color: "rgba(255,255,255,0.18)", letterSpacing: "0.08em", textAlign: "center", marginTop: "20px" }}>
          READ-ONLY · source: existing /api/approvals (audited) · sorted by urgency heuristic then oldest-first
        </p>
      </main>
    </div>
  );
}
