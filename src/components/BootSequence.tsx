"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { SoundEngine } from "@/components/SoundEngine";

// ===== INIT LINES — military/sci-fi style =====
interface InitLine {
  prefix: string;
  text: string;
  dots: string;
  status: string;
}

const INIT_LINES: InitLine[] = [
  { prefix: "[CORE]", text: " Initializing neural bridge", dots: "..............", status: "OK" },
  { prefix: "[SYNC]", text: " Connecting data streams", dots: ".................", status: "OK" },
  { prefix: "[AUTH]", text: " Validating credentials", dots: "..................", status: "OK" },
  { prefix: "[GRID]", text: " Loading dashboard modules", dots: "...............", status: "OK" },
  { prefix: "[NET]",  text: " Establishing service mesh", dots: "...............", status: "OK" },
];

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

  const beepRef = useRef(0);
  const cancelledRef = useRef(false);
  const soundRef = useRef(soundEngine);
  soundRef.current = soundEngine;

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
    if (initLineIndex < 0 || initLineIndex >= INIT_LINES.length || skipped) return;
    cancelledRef.current = false;

    const line = INIT_LINES[initLineIndex];
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
          if (initLineIndex < INIT_LINES.length - 1) {
            setInitLineIndex((prev) => prev + 1);
            setInitCharIndex(0);
          } else {
            // All lines done — play system online chime
            soundRef.current.playSystemOnline();
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
  }, [initLineIndex, skipped]);

  // ===== SKIP =====
  const handleSkip = useCallback(() => {
    cancelledRef.current = true;
    setSkipped(true);
    setShowDashboard(true);
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
            className="text-glow-strong"
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "64px",
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
            {INIT_LINES.map((line, i) => {
              if (i > initLineIndex) return null;

              const fullText = line.prefix + line.text + " " + line.dots + " " + line.status;
              const isCurrentLine = i === initLineIndex;
              const displayText = isCurrentLine
                ? fullText.slice(0, initCharIndex)
                : fullText;

              // Parse the displayed text to colour segments
              const prefixLen = line.prefix.length;
              const statusStart = fullText.length - line.status.length;

              return (
                <div key={i} style={{ whiteSpace: "pre", position: "relative" }}>
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
                  {/* Status — bright blue */}
                  {displayText.length > statusStart && (
                    <span style={{ color: "#0088FF", fontWeight: 600 }}>
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
