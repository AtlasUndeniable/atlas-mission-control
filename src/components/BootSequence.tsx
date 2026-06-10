"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { SoundEngine } from "@/components/SoundEngine";
import { startBootAudio, stopBootAudio } from "@/utils/bootAudio";

// ===== INIT LINES — built from live API data =====
interface InitLine {
  prefix: string;
  text: string;
  dots: string;
  status: string;
}

// Pad dots to align status text at a consistent column
function padDots(text: string, targetLen: number = 48): string {
  const contentLen = text.length;
  const dotsNeeded = Math.max(4, targetLen - contentLen);
  return " " + ".".repeat(dotsNeeded) + " ";
}

// Fallback lines if API is completely unreachable
const FALLBACK_LINES: InitLine[] = [
  { prefix: "[GATEWAY]", text: " Connecting to Atlas gateway", dots: padDots("[GATEWAY] Connecting to Atlas gateway"), status: "STANDBY" },
  { prefix: "[MONDAY]", text: " Loading client boards", dots: padDots("[MONDAY] Loading client boards"), status: "STANDBY" },
  { prefix: "[GHL]", text: " Syncing pipeline", dots: padDots("[GHL] Syncing pipeline"), status: "STANDBY" },
  { prefix: "[SLACK]", text: " Monitoring channels", dots: padDots("[SLACK] Monitoring channels"), status: "STANDBY" },
  { prefix: "[COMMS]", text: " Messages queued", dots: padDots("[COMMS] Messages queued"), status: "STANDBY" },
  { prefix: "[KNOWLEDGE]", text: " Files indexed", dots: padDots("[KNOWLEDGE] Files indexed"), status: "STANDBY" },
];

interface OverviewData {
  monday?: { activeClients?: number };
  opportunities?: number;
  slack?: { totalChannels?: number };
  pendingApprovals?: number;
  knowledge?: { totalFiles?: number };
  health?: { online?: number; total?: number };
}

function buildInitLines(data: OverviewData): InitLine[] {
  const ok = (val: number | undefined) => val !== undefined && val !== null;

  const line = (prefix: string, text: string, hasData: boolean): InitLine => {
    const full = prefix + text;
    return {
      prefix,
      text,
      dots: padDots(full),
      status: hasData ? "OK" : "STANDBY",
    };
  };

  const clients = data.monday?.activeClients;
  const opps = data.opportunities;
  const channels = data.slack?.totalChannels;
  const pending = data.pendingApprovals;
  const knowledge = data.knowledge?.totalFiles;
  const healthOn = data.health?.online;

  return [
    line("[GATEWAY]", ` Connecting to Atlas gateway`, ok(healthOn)),
    line("[MONDAY]", ` Loading ${ok(clients) ? clients : "\u2014"} client boards`, ok(clients)),
    line("[GHL]", ` Syncing pipeline \u2014 ${ok(opps) ? opps : "\u2014"} opps`, ok(opps)),
    line("[SLACK]", ` Monitoring ${ok(channels) ? channels : "\u2014"} channels`, ok(channels)),
    line("[COMMS]", ` ${ok(pending) ? pending : "\u2014"} messages queued`, ok(pending)),
    line("[KNOWLEDGE]", ` ${ok(knowledge) ? knowledge : "\u2014"} files indexed`, ok(knowledge)),
  ];
}

interface BootSequenceProps {
  onComplete: () => void;           // Called on skip — goes straight to dashboard
  onInitLinesComplete: () => void;  // Called after init lines done — triggers briefing
  soundEngine: SoundEngine;
  onConstellationFadeIn?: () => void;
}

// ===== COMPONENT =====
export default function BootSequence({ onComplete, onInitLinesComplete, soundEngine, onConstellationFadeIn }: BootSequenceProps) {
  // Phase tracking
  const [showDotGrid, setShowDotGrid] = useState(false);
  const [showLogo, setShowLogo] = useState(false);
  const [showScanLine, setShowScanLine] = useState(false);
  const [initLineIndex, setInitLineIndex] = useState(-1); // -1 = not started
  const [initCharIndex, setInitCharIndex] = useState(0);
  const [fadeOutBoot, setFadeOutBoot] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [initLines, setInitLines] = useState<InitLine[]>(FALLBACK_LINES);

  const beepRef = useRef(0);
  const cancelledRef = useRef(false);
  const soundRef = useRef(soundEngine);
  soundRef.current = soundEngine;

  // ===== BOOT HUM — starts on mount, stops on completion =====
  useEffect(() => {
    startBootAudio();
    return () => stopBootAudio();
  }, []);

  // ===== FETCH REAL DATA ON MOUNT =====
  useEffect(() => {
    fetch("/api/overview")
      .then((res) => {
        if (!res.ok) throw new Error("API error");
        return res.json();
      })
      .then((data: OverviewData) => {
        setInitLines(buildInitLines(data));
      })
      .catch(() => {
        // Graceful degradation — use fallback lines
        setInitLines(FALLBACK_LINES);
      });
  }, []);

  // ===== PHASE TIMELINE =====
  useEffect(() => {
    if (skipped) return;
    cancelledRef.current = false;

    // 0-700ms: Constellation fade in (replaces dot grid)
    const t1 = setTimeout(() => {
      if (!cancelledRef.current) {
        setShowDotGrid(true);
        onConstellationFadeIn?.();
      }
    }, 50);

    // 700ms: Logo + tagline fade in + start ambient
    const t2 = setTimeout(() => {
      if (!cancelledRef.current) {
        setShowLogo(true);
        soundRef.current.playPowerUp();
        soundRef.current.startAmbient();
      }
    }, 700);

    // 1300ms: Scan line sweep
    const t3 = setTimeout(() => {
      if (!cancelledRef.current) setShowScanLine(true);
    }, 1300);

    // 2100ms: Start init text
    const t4 = setTimeout(() => {
      if (!cancelledRef.current) {
        setInitLineIndex(0);
        setInitCharIndex(0);
      }
    }, 2100);

    return () => {
      cancelledRef.current = true;
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipped]);

  // ===== INIT LINE TYPEWRITER =====
  useEffect(() => {
    if (initLineIndex < 0 || initLineIndex >= initLines.length || skipped) return;
    cancelledRef.current = false;

    const line = initLines[initLineIndex];
    const fullText = line.prefix + line.text + " " + line.dots + " " + line.status;
    let charIdx = 0;

    function typeNext() {
      if (cancelledRef.current) return;

      if (charIdx >= fullText.length) {
        // Line complete — play beep + init line blip
        soundRef.current.playConnectionBeep(beepRef.current++);
        soundRef.current.playInitLine();

        // 200ms pause then next line
        setTimeout(() => {
          if (cancelledRef.current) return;
          if (initLineIndex < initLines.length - 1) {
            setInitLineIndex((prev) => prev + 1);
            setInitCharIndex(0);
          } else {
            // All lines done — play system online chime, stop boot hum
            soundRef.current.playSystemOnline();
            stopBootAudio();
            // 500ms pause then fade out boot, hand off to briefing
            setTimeout(() => {
              if (cancelledRef.current) return;
              setFadeOutBoot(true);
              setTimeout(() => {
                if (cancelledRef.current) return;
                setShowDashboard(true);
                onInitLinesComplete();
              }, 300);
            }, 500);
          }
        }, 200);
        return;
      }

      charIdx++;
      setInitCharIndex(charIdx);

      // Keystroke sound every 5th char
      if (charIdx % 5 === 0) {
        soundRef.current.playKeystroke();
      }

      setTimeout(typeNext, 15);
    }

    typeNext();

    return () => { cancelledRef.current = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initLineIndex, skipped, initLines]);

  // ===== SKIP =====
  const handleSkip = useCallback(() => {
    cancelledRef.current = true;
    setSkipped(true);
    setShowDashboard(true);
    stopBootAudio();
    onConstellationFadeIn?.();
    soundEngine.startAmbient();
    soundEngine.playClick();
    onComplete();
  }, [onComplete, onConstellationFadeIn, soundEngine]);

  // ===== RENDER =====
  if (showDashboard && !fadeOutBoot) {
    // Skipped — immediately gone
    return null;
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "#050510",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: fadeOutBoot ? 0 : 1,
        transition: "opacity 300ms ease-out",
        pointerEvents: fadeOutBoot ? "none" : "auto",
      }}
    >
      {/* Constellation canvas provides the background — no dot grid needed */}

      {/* Scan line sweep */}
      {showScanLine && (
        <div className="boot-scan-sweep" />
      )}

      {/* Center content */}
      <div style={{
        position: "relative",
        zIndex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: "100%",
        maxWidth: "600px",
        padding: "0 24px",
      }}>
        {/* Logo + tagline */}
        <div
          style={{
            textAlign: "center",
            opacity: showLogo ? 1 : 0,
            transform: showLogo ? "scale(1)" : "scale(0.95)",
            transition: "opacity 600ms cubic-bezier(0.16,1,0.3,1), transform 600ms cubic-bezier(0.16,1,0.3,1)",
            marginBottom: initLineIndex >= 0 ? "40px" : "0",
          }}
        >
          <h1
            className={`text-glow-strong${!fadeOutBoot ? " boot-glow-pulse" : ""}`}
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "clamp(36px, 10vw, 64px)",
              fontWeight: 700,
              letterSpacing: "0.35em",
              color: "#0088FF",
              lineHeight: 1,
              margin: 0,
              paddingRight: "0.35em", // compensate for letter-spacing on last char
            }}
          >
            ATLAS
          </h1>
          <p style={{
            fontFamily: "var(--font-mono)",
            fontSize: "14px",
            fontWeight: 400,
            letterSpacing: "0.5em",
            color: "rgba(0,136,255,0.5)",
            marginTop: "8px",
            paddingRight: "0.5em",
          }}>
            MISSION CONTROL
          </p>
        </div>

        {/* Init lines */}
        {initLineIndex >= 0 && (
          <div style={{
            width: "100%",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            lineHeight: 2.0,
          }}>
            {initLines.map((line, i) => {
              if (i > initLineIndex) return null;

              const fullText = line.prefix + line.text + " " + line.dots + " " + line.status;
              const isCurrentLine = i === initLineIndex;
              const displayText = isCurrentLine
                ? fullText.slice(0, initCharIndex)
                : fullText;

              // Parse the displayed text to colour segments
              const prefixLen = line.prefix.length;
              const statusStart = fullText.length - line.status.length;
              const isStandby = line.status === "STANDBY";

              return (
                <div key={i} className="boot-line-flash" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", position: "relative" }}>
                  {/* Prefix — blue */}
                  <span style={{ color: "rgba(0,136,255,0.5)" }}>
                    {displayText.slice(0, Math.min(displayText.length, prefixLen))}
                  </span>
                  {/* Main text + dots — dim white */}
                  {displayText.length > prefixLen && (
                    <span style={{ color: "rgba(255,255,255,0.35)" }}>
                      {displayText.slice(prefixLen, Math.min(displayText.length, statusStart))}
                    </span>
                  )}
                  {/* Status — bright blue for OK, amber for STANDBY */}
                  {displayText.length > statusStart && (
                    <span style={{
                      color: isStandby ? "#FFAA00" : "#0088FF",
                      fontWeight: 600,
                    }}>
                      {displayText.slice(statusStart)}
                    </span>
                  )}
                  {/* Cursor on current line */}
                  {isCurrentLine && initCharIndex < fullText.length && (
                    <span className="boot-cursor" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Skip button */}
      {!fadeOutBoot && !showDashboard && (
        <button
          onClick={handleSkip}
          className="boot-skip-fade"
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            fontWeight: 400,
            letterSpacing: "0.15em",
            color: "rgba(255,255,255,0.3)",
            background: "none",
            border: "none",
            padding: "6px 12px",
            cursor: "pointer",
            transition: "color 0.2s ease",
            zIndex: 101,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "rgba(255,255,255,0.6)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "rgba(255,255,255,0.3)";
          }}
        >
          Skip &rarr;
        </button>
      )}
    </div>
  );
}
