"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

// ===== TYPES (mirror of /api/reaper — kept local so this client bundle never
// pulls the fs-backed lib) =====
interface ProvenanceSource {
  kind: string;
  summary: string;
}

interface ReaperItem {
  id: string;
  client: string | null;
  clientLabel: string;
  text: string;
  status: string;
  sourceCall: string;
  sourceDate: number | null;
  extractedAt: string;
  ageDays: number | null;
  aging: "fresh" | "aging" | "stale" | "unknown";
  draftCount: number;
  draftSent: boolean;
  provenance: ProvenanceSource[];
  signalScore: number;
  suggestedLabel: string | null;
  suggestionReason: string | null;
}

interface ReaperResponse {
  readOnly: boolean;
  note: string;
  generatedAt: string;
  items: ReaperItem[];
  summary: {
    totalPending: number;
    stale: number;
    ancient: number;
    withDraft: number;
    unattributed: number;
    withSuggestion: number;
  };
  thresholds: { staleDays: number; ancientDays: number; likelyStaleDays: number };
  sortExplanation: string;
  updatedAt: string | null;
}

// ===== CONSTANTS =====
// Mirrors the allowed triage labels in src/lib/reaper.ts. Read-only MVP: every
// button is rendered disabled and tagged as a future action.
const TRIAGE_ACTIONS: Array<{ label: string; tone: string }> = [
  { label: "still real", tone: "#22C55E" },
  { label: "draft follow-up", tone: "#0088FF" },
  { label: "delegate", tone: "#8855FF" },
  { label: "mark stale", tone: "#EF4444" },
  { label: "ignore", tone: "#6B7280" },
  { label: "needs Rhys", tone: "#F59E0B" },
];

const PAGE_SIZE = 40;
const ACTION_TOOLTIP = "Read-only MVP — triage actions are not wired yet";

// ===== HELPERS =====
function agingColour(days: number | null): string {
  if (days === null) return "rgba(255,255,255,0.35)";
  if (days < 5) return "#22C55E";
  if (days <= 14) return "#F59E0B";
  return "#EF4444";
}

function toneFor(label: string | null): string {
  const hit = TRIAGE_ACTIONS.find((a) => a.label === label);
  return hit ? hit.tone : "#6B7280";
}

function formatDate(ts: number | null): string {
  if (!ts) return "unknown";
  return new Date(ts).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatIsoDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
}

function summariseProvenance(p: ProvenanceSource[]): string {
  if (p.length === 0) return "";
  const counts = new Map<string, number>();
  for (const s of p) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(", ");
}

// ===== STAT PILL =====
function Stat({ label, value, colour }: { label: string; value: number; colour: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "6px 14px",
        borderRight: "1px solid rgba(0,136,255,0.08)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "16px",
          fontWeight: 700,
          color: colour,
          lineHeight: 1,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "8px",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "#6B7280",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ===== ITEM CARD =====
function ItemCard({ item }: { item: ReaperItem }) {
  const ageColour = agingColour(item.ageDays);
  const provenance = summariseProvenance(item.provenance);

  return (
    <div
      className="glass-card hud-corners"
      style={{ padding: "14px 16px", marginBottom: "10px" }}
    >
      {/* Row 1: client + age + status */}
      <div
        className="flex items-center gap-2"
        style={{ flexWrap: "wrap", marginBottom: "6px" }}
      >
        <span
          className="status-dot"
          style={{
            width: "6px",
            height: "6px",
            background: ageColour,
            boxShadow: `0 0 6px ${ageColour}`,
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.06em",
            color: item.client ? "rgba(255,255,255,0.82)" : "#F59E0B",
          }}
          title={item.client ? undefined : "No client inferable from source"}
        >
          {item.clientLabel}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            fontWeight: 700,
            color: ageColour,
            letterSpacing: "0.05em",
          }}
        >
          {item.ageDays === null ? "AGE —" : `${item.ageDays}D OLD`}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "8px",
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.5)",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "3px",
            padding: "1px 6px",
          }}
        >
          {item.status}
        </span>
        {item.draftCount > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "8px",
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "#00D4FF",
              background: "rgba(0,212,255,0.1)",
              border: "1px solid rgba(0,212,255,0.2)",
              borderRadius: "3px",
              padding: "1px 6px",
            }}
          >
            {item.draftSent ? "draft sent" : `draft ×${item.draftCount}`}
          </span>
        )}
        {item.suggestedLabel && (
          <span
            title={item.suggestionReason ?? undefined}
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.06em",
              color: toneFor(item.suggestedLabel),
              background: `${toneFor(item.suggestedLabel)}18`,
              border: `1px solid ${toneFor(item.suggestedLabel)}44`,
              borderRadius: "3px",
              padding: "2px 8px",
            }}
          >
            SUGGESTS: {item.suggestedLabel.toUpperCase()}
          </span>
        )}
      </div>

      {/* Row 2: action item text */}
      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "12.5px",
          lineHeight: 1.45,
          color: "rgba(255,255,255,0.88)",
          margin: "0 0 6px 0",
          wordBreak: "break-word",
        }}
      >
        {item.text}
      </p>

      {/* Row 3: provenance */}
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "9px",
          color: "#6B7280",
          margin: "0 0 4px 0",
          letterSpacing: "0.02em",
        }}
        title={item.sourceCall}
      >
        SOURCE: {item.sourceCall} · call {formatDate(item.sourceDate)} ·
        extracted {formatIsoDate(item.extractedAt)}
        {provenance ? ` · context: ${provenance}` : ""}
      </p>

      {/* Row 4: suggestion rationale */}
      {item.suggestionReason && (
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10.5px",
            fontStyle: "italic",
            color: "rgba(255,255,255,0.45)",
            margin: "0 0 8px 0",
          }}
        >
          {item.suggestionReason}
        </p>
      )}

      {/* Row 5: disabled triage actions (future) */}
      <div
        className="flex items-center gap-2"
        style={{ flexWrap: "wrap", marginTop: "6px" }}
      >
        {TRIAGE_ACTIONS.map((a) => {
          const isSuggested = a.label === item.suggestedLabel;
          return (
            <button
              key={a.label}
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
                color: a.tone,
                background: isSuggested ? `${a.tone}14` : "transparent",
                border: `1px solid ${a.tone}${isSuggested ? "55" : "2e"}`,
                borderRadius: "4px",
                padding: "3px 9px",
                cursor: "not-allowed",
                opacity: isSuggested ? 0.75 : 0.4,
              }}
            >
              {a.label}
            </button>
          );
        })}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "8px",
            fontWeight: 700,
            letterSpacing: "0.14em",
            color: "#4B5563",
            marginLeft: "auto",
          }}
        >
          PREVIEW · NOT WIRED
        </span>
      </div>
    </div>
  );
}

// ===== PAGE =====
export default function ReaperPage() {
  const [data, setData] = useState<ReaperResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [onlyStale, setOnlyStale] = useState(false);
  const [onlySuggested, setOnlySuggested] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/reaper");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ReaperResponse = await res.json();
      setData(json);
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

  const staleDays = data?.thresholds.staleDays ?? 14;

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    return items.filter((i) => {
      if (onlyStale && !(i.ageDays !== null && i.ageDays > staleDays)) return false;
      if (onlySuggested && !i.suggestedLabel) return false;
      return true;
    });
  }, [data, onlyStale, onlySuggested, staleDays]);

  const shown = filtered.slice(0, visible);

  return (
    <div className="ambient-bg" style={{ minHeight: "100vh", paddingBottom: "60px" }}>
      <div className="crt-scanlines" />

      {/* Header */}
      <header
        className="sticky top-0 z-40"
        style={{
          background: "rgba(5,5,16,0.92)",
          backdropFilter: "blur(16px)",
          padding: "12px 24px",
          borderBottom: "1px solid rgba(0,136,255,0.12)",
        }}
      >
        <div
          className="flex items-center gap-3"
          style={{ maxWidth: "1100px", margin: "0 auto", flexWrap: "wrap" }}
        >
          <h1
            className="type-section-header text-glow"
            style={{ color: "#0088FF", fontSize: "13px", margin: 0 }}
          >
            STALE OBLIGATION REAPER
          </h1>
          <span className="module-tag module-tag-ops-core">TRIAGE · MVP</span>
          <Link
            href="/"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: "#6B7280",
              textDecoration: "none",
              marginLeft: "auto",
            }}
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
              color: "#0088FF",
              background: "transparent",
              border: "1px solid rgba(0,136,255,0.3)",
              borderRadius: "4px",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            REFRESH
          </button>
        </div>
      </header>

      <main
        style={{
          maxWidth: "1100px",
          margin: "0 auto",
          padding: "20px 24px 0",
          position: "relative",
          zIndex: 2,
        }}
      >
        {/* Provenance banner */}
        <div
          style={{
            background: "rgba(245,158,11,0.06)",
            border: "1px solid rgba(245,158,11,0.25)",
            borderRadius: "6px",
            padding: "10px 14px",
            marginBottom: "16px",
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "12px",
              color: "rgba(255,255,255,0.78)",
              margin: 0,
              lineHeight: 1.45,
            }}
          >
            These are <strong>extracted Fireflies / Rhys action items</strong>,
            not confirmed live obligations. Counts like “{data?.summary.stale ?? "—"}{" "}
            aging past {staleDays} days” must be triaged before being treated as
            current. This MVP is read-only — every action below is a disabled
            preview.
          </p>
        </div>

        {/* Summary strip */}
        {data && (
          <div
            className="glass-card"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              padding: "4px 4px",
              marginBottom: "14px",
            }}
          >
            <Stat label="Pending" value={data.summary.totalPending} colour="rgba(255,255,255,0.85)" />
            <Stat label={`Stale >${staleDays}d`} value={data.summary.stale} colour="#F59E0B" />
            <Stat label={`Ancient >${data.thresholds.ancientDays}d`} value={data.summary.ancient} colour="#EF4444" />
            <Stat label="With draft" value={data.summary.withDraft} colour="#00D4FF" />
            <Stat label="Unattributed" value={data.summary.unattributed} colour="#8855FF" />
            <Stat label="Suggested" value={data.summary.withSuggestion} colour="#22C55E" />
          </div>
        )}

        {/* Filters */}
        <div
          className="flex items-center gap-3"
          style={{ marginBottom: "14px", flexWrap: "wrap" }}
        >
          {[
            { on: onlyStale, set: setOnlyStale, label: `Only stale >${staleDays}d` },
            { on: onlySuggested, set: setOnlySuggested, label: "Only with suggestion" },
          ].map((f) => (
            <button
              key={f.label}
              type="button"
              onClick={() => f.set(!f.on)}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: f.on ? "#0088FF" : "#6B7280",
                background: f.on ? "rgba(0,136,255,0.1)" : "transparent",
                border: `1px solid ${f.on ? "rgba(0,136,255,0.35)" : "rgba(255,255,255,0.1)"}`,
                borderRadius: "4px",
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              {f.on ? "✓ " : ""}
              {f.label}
            </button>
          ))}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              color: "#4B5563",
              marginLeft: "auto",
            }}
          >
            {filtered.length} shown · sorted by signal then age
          </span>
        </div>

        {/* States */}
        {loading && !data && (
          <p
            className="breathing"
            style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "#6B7280" }}
          >
            Loading extracted action items…
          </p>
        )}
        {error && (
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "#EF4444" }}>
            Error: {error}
          </p>
        )}
        {data && filtered.length === 0 && !loading && (
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "12px",
              color: "rgba(255,255,255,0.4)",
            }}
          >
            Nothing matches the current filters.
          </p>
        )}

        {/* List */}
        {shown.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}

        {visible < filtered.length && (
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            style={{
              width: "100%",
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.12em",
              color: "#0088FF",
              background: "rgba(0,136,255,0.06)",
              border: "1px solid rgba(0,136,255,0.2)",
              borderRadius: "6px",
              padding: "10px",
              cursor: "pointer",
              marginTop: "4px",
            }}
          >
            SHOW MORE ({filtered.length - visible} remaining)
          </button>
        )}

        {data && (
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "8px",
              color: "rgba(255,255,255,0.18)",
              letterSpacing: "0.08em",
              textAlign: "center",
              marginTop: "20px",
            }}
          >
            READ-ONLY · {data.sortExplanation} · generated{" "}
            {formatIsoDate(data.generatedAt)}
          </p>
        )}
      </main>
    </div>
  );
}
