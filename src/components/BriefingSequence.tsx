"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { SoundEngine } from "@/components/SoundEngine";

// ===== TYPES =====
interface BriefingRevenue {
  closedWon: number;
  closedCount: number;
  mtd: number;
  projected: number;
  breakTarget: number;
}

interface BriefingKpis {
  callsBooked: number;
  activeClients: number;
  dailyAdSpend: number;
  roas: number;
  slackChannels: number;
  closeRate: number;
  totalContacts: number;
  totalOpportunities: number;
  tasksInProgress: number;
  taskCompletion: number;
}

interface BriefingApiData {
  timestamp: string;
  dayOfWeek: string;
  todaysMeetings: number;
  revenue: BriefingRevenue;
  kpis: BriefingKpis;
  monday: {
    summary: {
      activeClients: number;
      highPriority: number;
      critical: number;
      inProgress: number;
      stuck: number;
      notStarted: number;
      done: number;
      totalTasks: number;
    } | null;
    stuckTasks: Array<{ name: string; boardName: string; priority: string }>;
    inProgressTasks: Array<{ name: string; boardName: string; priority: string }>;
  };
  pipeline: {
    totalOpen: number;
    opportunities: Array<{ name: string; stage: string }>;
    earlyStage: number;
  };
  calls: {
    thisWeek: number;
    processed: number;
    recent: string[];
  };
  slack: {
    totalChannels: number;
  };
  approvals: Array<{
    type: string;
    channel?: string;
    replyingTo?: string;
    originalMessage?: string;
    draftReply?: string;
  }>;
  services: {
    online: number;
    total: number;
    allGreen: boolean;
  };
  activity: Array<{ action: string; status: string; source: string }>;
}

// Legacy props (kept for page.tsx compat)
interface BriefingData {
  callsBooked?: number;
  activeClients?: number;
  callsProcessed?: number;
  servicesOnline?: number;
  totalServices?: number;
  pendingApprovals?: number;
  slackChannels?: number;
  todaysMeetings?: number;
  tasksStuck?: number;
  tasksWorking?: number;
  tasksDone?: number;
  highPriority?: number;
  recentCalls?: Array<{ title: string; date: number }>;
  pipeline?: unknown;
}

interface BriefingSequenceProps {
  onComplete: () => void;
  soundEngine: SoundEngine;
  data: BriefingData;
}

// ===== FORMATTERS =====
function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  if (value > 0) return `$${value.toLocaleString()}`;
  return "$0";
}

function formatLargeCurrency(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  if (value > 0) return value.toLocaleString();
  return "0";
}

// ===== GREETING =====
function buildGreeting(d: BriefingApiData | null): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Morning, Rhys.";
  if (hour >= 12 && hour < 17) return "Afternoon, Rhys.";
  if (hour >= 17 && hour < 21) return "Evening, Rhys.";
  if (d && d.monday?.summary && d.monday.summary.stuck > 0) return "Late one. A few things to flag.";
  return "Late one, Rhys.";
}

// ===== BRIEFING PARAGRAPH GENERATOR =====
function generateBriefing(d: BriefingApiData): string[] {
  const paragraphs: string[] = [];
  const s = d.monday?.summary;

  // Pipeline and revenue
  if (d.pipeline.totalOpen > 0) {
    const early = d.pipeline.earlyStage;
    let pipeText = `${d.pipeline.totalOpen} open opportunities in the pipeline.`;
    if (early > 0) {
      pipeText += ` ${early} sitting in early stage. Those need follow-up before they go cold.`;
    }
    const namedOpps = d.pipeline.opportunities.slice(0, 3);
    if (namedOpps.length > 0) {
      const names = namedOpps.map((o) => o.name.split(" ")[0]).join(", ");
      pipeText += ` Top of the list: ${names}.`;
    }
    paragraphs.push(pipeText);
  }

  // Monday operations
  if (s) {
    let opsText = "";
    if (s.stuck > 0 && d.monday.stuckTasks.length > 0) {
      const stuckItem = d.monday.stuckTasks[0];
      opsText = `${s.activeClients} active client boards on Monday. ${s.stuck} stuck item flagged. "${stuckItem.name}" on ${stuckItem.boardName}'s board.`;
      if (s.inProgress > 0) opsText += ` ${s.inProgress} tasks in motion across the rest.`;
    } else if (s.inProgress > 0) {
      opsText = `${s.activeClients} client boards clean. ${s.inProgress} tasks in progress, ${s.done} completed.`;
      if (s.notStarted > 20) opsText += ` ${s.notStarted} sitting in not started. Worth blocking 30 minutes to triage.`;
    } else {
      opsText = `${s.activeClients} client boards tracked. Nothing urgent on the operations side.`;
    }
    paragraphs.push(opsText);
  }

  // Calls and coaching
  if (d.calls.thisWeek > 0 || d.calls.processed > 0) {
    let callText = "";
    if (d.calls.thisWeek > 0) callText = `${d.calls.thisWeek} calls this week.`;
    if (d.calls.processed > 0) {
      callText += callText ? " " : "";
      callText += `I've processed ${d.calls.processed} transcripts.`;
    }
    if (d.calls.recent.length > 0) {
      const clientName = extractName(d.calls.recent[0]);
      if (clientName) callText += ` The ${clientName} session is the most recent. Worth reviewing if you haven't already.`;
    }
    if (callText) paragraphs.push(callText);
  }

  // Slack triage and approvals
  if (d.approvals.length > 0) {
    const count = d.approvals.length;
    let approvalText = `${count} message${count > 1 ? "s" : ""} drafted and waiting for your sign-off.`;
    const first = d.approvals[0];
    if (first.replyingTo && first.channel) {
      approvalText += ` ${first.replyingTo} in #${first.channel}. I've written the reply, just needs your approval.`;
    }
    paragraphs.push(approvalText);
  } else if (d.slack.totalChannels > 0) {
    paragraphs.push(`Monitoring ${d.slack.totalChannels} Slack channels. Nothing flagged for your attention overnight.`);
  }

  // Calendar
  if (d.todaysMeetings > 0) {
    paragraphs.push(
      `${d.todaysMeetings} ${d.todaysMeetings === 1 ? "meeting" : "meetings"} on the calendar today. I'll surface prep notes 15 minutes before each one.`
    );
  } else {
    paragraphs.push(`Clear calendar today. Open ${d.dayOfWeek} to move the needle on whatever matters most.`);
  }

  // Systems
  if (d.services.allGreen) {
    paragraphs.push(`All ${d.services.total} systems online. Running clean. Ready when you are.`);
  } else {
    const down = d.services.total - d.services.online;
    paragraphs.push(`${d.services.online}/${d.services.total} systems online. ${down} showing issues. Check the system panel.`);
  }

  return paragraphs;
}

function extractName(title: string): string | null {
  if (!title) return null;
  const xMatch = title.match(/^(.+?)\s*[xX]\s*/);
  if (xMatch) {
    const name = xMatch[1].trim();
    if (name.toLowerCase().startsWith("undeniable")) return null;
    return name;
  }
  return null;
}

// ===== KPI CARD DEFINITIONS =====
interface KpiDef {
  label: string;
  getValue: (k: BriefingKpis) => string;
  accent: string;
  dimWhenZero?: boolean;
}

const KPI_CARDS: KpiDef[] = [
  { label: "Calls Booked", getValue: (k) => String(k.callsBooked), accent: "#0088FF" },
  { label: "Active Clients", getValue: (k) => String(k.activeClients), accent: "#00FF88" },
  { label: "Daily Ad Spend", getValue: (k) => k.dailyAdSpend > 0 ? formatCurrency(k.dailyAdSpend) : "\u2014", accent: "#F59E0B", dimWhenZero: true },
  { label: "ROAS", getValue: (k) => k.roas > 0 ? `${k.roas.toFixed(1)}x` : "\u2014", accent: "#00DDFF", dimWhenZero: true },
  { label: "Slack Channels", getValue: (k) => String(k.slackChannels), accent: "#8B5CF6" },
  { label: "Close Rate", getValue: (k) => k.closeRate > 0 ? `${k.closeRate}%` : "0%", accent: "#22C55E" },
];

// ===== REVENUE HERO =====
function RevenueHero({ revenue, visible }: { revenue: BriefingRevenue; visible: boolean }) {
  const [animatedValue, setAnimatedValue] = useState(0);
  const targetRef = useRef(revenue.mtd);

  useEffect(() => {
    if (!visible) return;
    targetRef.current = revenue.mtd;
    const duration = 1500;
    const start = performance.now();
    let raf: number;
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setAnimatedValue(Math.round(targetRef.current * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, revenue.mtd]);

  const progress = revenue.breakTarget > 0
    ? Math.min((revenue.mtd / revenue.breakTarget) * 100, 100)
    : 0;

  const hasRevenue = revenue.mtd > 0;

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transition: "opacity 0.8s ease, transform 0.8s ease",
        marginBottom: "28px",
      }}
    >
      {/* Revenue label */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px", marginBottom: "8px" }}>
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          fontWeight: 700,
          letterSpacing: "0.2em",
          color: "rgba(255,255,255,0.35)",
          textTransform: "uppercase",
        }}>
          Revenue MTD
        </span>
        {!hasRevenue && (
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            letterSpacing: "0.1em",
            color: "rgba(255,255,255,0.15)",
          }}>
            AWAITING NEWIE
          </span>
        )}
      </div>

      {/* Big number */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "16px" }}>
        <span style={{
          fontFamily: "var(--font-heading)",
          fontSize: "clamp(42px, 5vw, 64px)",
          fontWeight: 300,
          letterSpacing: "-0.02em",
          color: hasRevenue ? "#FFFFFF" : "rgba(255,255,255,0.12)",
          lineHeight: 1,
        }}>
          ${hasRevenue ? formatLargeCurrency(animatedValue) : "\u2014"}
        </span>
        {revenue.projected > 0 && (
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: "14px",
            color: "rgba(0,136,255,0.6)",
          }}>
            proj. {formatCurrency(revenue.projected)}
          </span>
        )}
      </div>

      {/* Progress bar toward break target */}
      <div style={{ marginBottom: "6px" }}>
        <div style={{
          height: "4px",
          borderRadius: "2px",
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            width: `${progress}%`,
            borderRadius: "2px",
            background: progress > 80
              ? "linear-gradient(90deg, #00FF88, #00DDAA)"
              : progress > 40
                ? "linear-gradient(90deg, #0088FF, #00DDFF)"
                : "linear-gradient(90deg, rgba(0,136,255,0.4), rgba(0,136,255,0.6))",
            transition: "width 1.5s ease-out",
          }} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          color: "rgba(255,255,255,0.2)",
          letterSpacing: "0.05em",
        }}>
          {hasRevenue ? `${progress.toFixed(0)}% to target` : "No revenue data yet"}
        </span>
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          color: "rgba(255,255,255,0.2)",
          letterSpacing: "0.05em",
        }}>
          {formatCurrency(revenue.breakTarget)} target
        </span>
      </div>
    </div>
  );
}

// ===== KPI ROW =====
function KpiRow({ kpis, visible }: { kpis: BriefingKpis; visible: boolean }) {
  return (
    <div
      className="briefing-kpi-grid"
      style={{
        display: "grid",
        gap: "12px",
        marginBottom: "32px",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transition: "opacity 0.8s ease 0.2s, transform 0.8s ease 0.2s",
      }}
    >
      {KPI_CARDS.map((card) => {
        const val = card.getValue(kpis);
        const isDim = card.dimWhenZero && val === "\u2014";
        return (
          <div
            key={card.label}
            style={{
              padding: "12px 10px",
              borderRadius: "6px",
              border: "1px solid rgba(255,255,255,0.04)",
              background: "rgba(255,255,255,0.015)",
              textAlign: "center",
            }}
          >
            <p style={{
              fontFamily: "var(--font-mono)",
              fontSize: "clamp(18px, 2vw, 24px)",
              fontWeight: 600,
              color: isDim ? "rgba(255,255,255,0.12)" : card.accent,
              lineHeight: 1.2,
              marginBottom: "4px",
            }}>
              {val}
            </p>
            <p style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              fontWeight: 600,
              letterSpacing: "0.1em",
              color: "rgba(255,255,255,0.25)",
              textTransform: "uppercase",
              lineHeight: 1.3,
            }}>
              {card.label}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ===== COMPONENT =====
export default function BriefingSequence({
  onComplete,
  soundEngine,
}: BriefingSequenceProps) {
  const [briefing, setBriefing] = useState<BriefingApiData | null>(null);
  const [greeting, setGreeting] = useState("");
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [displayedParagraphs, setDisplayedParagraphs] = useState<string[]>([]);
  const [currentParaIndex, setCurrentParaIndex] = useState(0);
  const [typingDone, setTypingDone] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const [heroVisible, setHeroVisible] = useState(false);

  const cancelledRef = useRef(false);
  const soundRef = useRef(soundEngine);
  soundRef.current = soundEngine;
  const paraBlipPlayedRef = useRef<Set<number>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // ===== FETCH BRIEFING DATA =====
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/briefing");
        if (!res.ok) throw new Error("fetch failed");
        const data: BriefingApiData = await res.json();
        if (cancelled) return;
        setBriefing(data);
        setGreeting(buildGreeting(data));
        const p = generateBriefing(data);
        setParagraphs(p);
        setDisplayedParagraphs(new Array(p.length).fill(""));
        setReady(true);
        // Stagger hero reveal
        setTimeout(() => { if (!cancelled) setHeroVisible(true); }, 300);
      } catch {
        if (cancelled) return;
        setGreeting("Systems online.");
        setParagraphs(["Dashboard loading. All services operational."]);
        setDisplayedParagraphs([""]);
        setReady(true);
        setHeroVisible(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ===== SCROLL TO TOP on mount =====
  useEffect(() => {
    if (!ready) return;
    window.scrollTo(0, 0);
    scrollContainerRef.current?.scrollTo(0, 0);
  }, [ready]);

  // ===== AMBIENT SOUND =====
  useEffect(() => {
    if (!ready) return;
    soundRef.current.startAmbient();
  }, [ready]);

  // ===== TYPING ENGINE =====
  useEffect(() => {
    if (!ready || cancelledRef.current) return;

    let active = true;
    let paraIdx = 0;
    let charIdx = 0;
    let waitUntil = 0;
    let raf: number;

    function getDelay(char: string): number {
      if (char === ".") return 80 + Math.random() * 40;
      if (char === ",") return 45 + Math.random() * 20;
      if (char === "?") return 90 + Math.random() * 30;
      if (char === '"') return 30;
      if (char === " ") return 14;
      return 26 + Math.random() * 8;
    }

    function tick(timestamp: number) {
      if (!active || cancelledRef.current) return;
      if (timestamp < waitUntil) { raf = requestAnimationFrame(tick); return; }

      if (paraIdx >= paragraphs.length) {
        setTypingDone(true);
        soundRef.current.playBootComplete();
        return;
      }

      const currentPara = paragraphs[paraIdx];
      if (charIdx === 0 && !paraBlipPlayedRef.current.has(paraIdx)) {
        paraBlipPlayedRef.current.add(paraIdx);
        soundRef.current.playInitLine();
      }

      if (charIdx < currentPara.length) {
        charIdx++;
        setCurrentParaIndex(paraIdx);
        setDisplayedParagraphs((prev) => {
          const next = [...prev];
          next[paraIdx] = currentPara.slice(0, charIdx);
          return next;
        });
        waitUntil = timestamp + getDelay(currentPara[charIdx - 1]);
        raf = requestAnimationFrame(tick);
      } else {
        paraIdx++;
        charIdx = 0;
        waitUntil = timestamp + 600;
        raf = requestAnimationFrame(tick);
      }
    }

    const startTimer = setTimeout(() => {
      if (active && !cancelledRef.current) raf = requestAnimationFrame(tick);
    }, 800); // Slightly longer delay to let hero animate in

    return () => {
      active = false;
      clearTimeout(startTimer);
      if (raf) cancelAnimationFrame(raf);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, paragraphs]);

  // Cursor blink
  useEffect(() => {
    const interval = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(interval);
  }, []);

  // ===== ENTER DASHBOARD =====
  const handleEnter = useCallback(() => {
    cancelledRef.current = true;
    setFadeOut(true);
    soundRef.current.playClick();
    setTimeout(() => onComplete(), 1000);
  }, [onComplete]);

  const handleSkip = useCallback(() => {
    if (typingDone) return;
    cancelledRef.current = true;
    setDisplayedParagraphs([...paragraphs]);
    setTypingDone(true);
    soundRef.current.playBootComplete();
  }, [paragraphs, typingDone]);

  if (!ready) return null;

  const timestamp = briefing?.timestamp ?? "";
  const revenue = briefing?.revenue ?? { closedWon: 0, closedCount: 0, mtd: 0, projected: 0, breakTarget: 850000 };
  const kpis = briefing?.kpis ?? { callsBooked: 0, activeClients: 0, dailyAdSpend: 0, roas: 0, slackChannels: 0, closeRate: 0, totalContacts: 0, totalOpportunities: 0, tasksInProgress: 0, taskCompletion: 0 };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        opacity: fadeOut ? 0 : 1,
        transform: fadeOut ? "translateY(-20px)" : "translateY(0)",
        transition: "opacity 1s ease-out, transform 1s ease-out",
        pointerEvents: fadeOut ? "none" : "auto",
        overflow: "hidden",
      }}
    >
      {/* Backdrop */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse 90% 80% at 50% 40%, rgba(5,5,16,0.92) 0%, rgba(5,5,16,0.6) 60%, transparent 100%)",
          backdropFilter: "blur(3px)",
          WebkitBackdropFilter: "blur(3px)",
        }}
      />

      {/* Scrollable content */}
      <div
        ref={scrollContainerRef}
        onClick={handleSkip}
        style={{
          position: "relative",
          zIndex: 1,
          flex: 1,
          overflowY: "auto",
          display: "flex",
          justifyContent: "center",
          cursor: typingDone ? "default" : "pointer",
          paddingTop: "clamp(32px, 4vh, 60px)",
          paddingBottom: "120px",
        }}
      >
        <div style={{ maxWidth: "820px", width: "100%", padding: "0 32px" }}>

          {/* ===== HEADER: ATLAS + timestamp ===== */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ opacity: 0.7 }}>
              <circle cx="16" cy="8" r="2" fill="#0088FF" />
              <circle cx="8" cy="20" r="1.5" fill="#00DDAA" />
              <circle cx="24" cy="18" r="1.5" fill="#0088FF" />
              <circle cx="12" cy="28" r="1" fill="#00DDAA" opacity="0.6" />
              <circle cx="22" cy="26" r="1" fill="#0088FF" opacity="0.6" />
              <circle cx="16" cy="16" r="2.5" fill="#0088FF" />
              <line x1="16" y1="8" x2="16" y2="16" stroke="#0088FF" strokeWidth="0.5" opacity="0.4" />
              <line x1="8" y1="20" x2="16" y2="16" stroke="#00DDAA" strokeWidth="0.5" opacity="0.4" />
              <line x1="24" y1="18" x2="16" y2="16" stroke="#0088FF" strokeWidth="0.5" opacity="0.4" />
              <line x1="12" y1="28" x2="8" y2="20" stroke="#00DDAA" strokeWidth="0.5" opacity="0.3" />
              <line x1="22" y1="26" x2="24" y2="18" stroke="#0088FF" strokeWidth="0.5" opacity="0.3" />
            </svg>
            <span style={{ fontFamily: "var(--font-heading)", fontSize: "14px", fontWeight: 700, letterSpacing: "0.3em", color: "#0088FF" }}>
              ATLAS
            </span>
            <div style={{ flex: 1, height: "1px", background: "linear-gradient(90deg, rgba(0,136,255,0.4), transparent)" }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "rgba(255,255,255,0.3)", letterSpacing: "0.05em" }}>
              {timestamp}
            </span>
          </div>

          {/* ===== GREETING ===== */}
          <h1 style={{
            fontFamily: "var(--font-heading)",
            fontSize: "clamp(28px, 3.5vw, 40px)",
            fontWeight: 300,
            letterSpacing: "0.01em",
            lineHeight: 1.3,
            color: "#FFFFFF",
            marginBottom: "28px",
          }}>
            {greeting}
          </h1>

          {/* ===== REVENUE HERO ===== */}
          <RevenueHero revenue={revenue} visible={heroVisible} />

          {/* ===== KPI CARDS ROW ===== */}
          <KpiRow kpis={kpis} visible={heroVisible} />

          {/* ===== BRIEFING SECTION HEADER ===== */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            marginBottom: "20px",
            opacity: heroVisible ? 1 : 0,
            transition: "opacity 0.6s ease 0.4s",
          }}>
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.2em",
              color: "rgba(255,255,255,0.25)",
              textTransform: "uppercase",
            }}>
              Executive Briefing
            </span>
            <div style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.06)" }} />
          </div>

          {/* ===== TYPED PARAGRAPHS ===== */}
          <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
            {displayedParagraphs.map((text, i) => {
              if (i >= paragraphs.length) return null;
              const hasContent = text.length > 0;
              const isCurrentPara = i === currentParaIndex && !typingDone;
              const showCursor = isCurrentPara && cursorVisible;
              if (!hasContent && i > currentParaIndex) return null;

              return (
                <p
                  key={i}
                  style={{
                    fontFamily: "var(--font-body, var(--font-heading))",
                    fontSize: "clamp(15px, 1.4vw, 18px)",
                    fontWeight: 300,
                    lineHeight: 1.75,
                    color: "rgba(255,255,255,0.72)",
                    letterSpacing: "0.005em",
                    minHeight: hasContent ? "1em" : 0,
                    margin: 0,
                  }}
                >
                  {text}
                  {showCursor && (
                    <span style={{
                      display: "inline-block",
                      width: "2px",
                      height: "16px",
                      background: "#0088FF",
                      marginLeft: "2px",
                      verticalAlign: "text-bottom",
                      opacity: cursorVisible ? 0.8 : 0,
                    }} />
                  )}
                </p>
              );
            })}

            {typingDone && !fadeOut && (
              <span style={{
                display: "inline-block",
                width: "2px",
                height: "16px",
                background: "#0088FF",
                opacity: cursorVisible ? 0.5 : 0,
                transition: "opacity 0.15s",
              }} />
            )}
          </div>
        </div>
      </div>

      {/* ===== ENTER DASHBOARD BUTTON ===== */}
      {typingDone && !fadeOut && (
        <div style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          padding: "32px 0 40px",
          background: "linear-gradient(transparent, rgba(5,5,16,0.95) 40%)",
          zIndex: 2,
          animation: "briefingButtonFadeIn 0.8s ease-out",
        }}>
          <button
            onClick={handleEnter}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              fontWeight: 600,
              letterSpacing: "0.2em",
              color: "#0088FF",
              background: "transparent",
              border: "1px solid rgba(0,136,255,0.3)",
              padding: "14px 40px",
              cursor: "pointer",
              transition: "border-color 0.3s, background 0.3s, color 0.3s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "rgba(0,136,255,0.6)";
              e.currentTarget.style.background = "rgba(0,136,255,0.08)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "rgba(0,136,255,0.3)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            {"ENTER DASHBOARD \u2192"}
          </button>
        </div>
      )}

      {/* ===== SKIP HINT ===== */}
      {!fadeOut && !typingDone && (
        <p style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          letterSpacing: "0.15em",
          color: "rgba(255,255,255,0.15)",
          zIndex: 2,
        }}>
          CLICK TO SKIP
        </p>
      )}
    </div>
  );
}
