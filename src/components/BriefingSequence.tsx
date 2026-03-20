"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { SoundEngine } from "@/components/SoundEngine";

interface BriefingData {
  callsBooked?: number;
  activeClients?: number;
  callsProcessed?: number;
  servicesOnline?: number;
  totalServices?: number;
  pendingApprovals?: number;
  slackChannels?: number;
}

interface BriefingSequenceProps {
  onComplete: () => void;
  soundEngine: SoundEngine;
  data: BriefingData;
}

// ===== BRIEFING TEXT GENERATION =====
function generateBriefing(data: BriefingData): string[] {
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" :
    hour < 17 ? "Good afternoon" :
    hour < 21 ? "Good evening" :
    "Burning the midnight oil";

  const lines: string[] = [];
  lines.push(`${greeting}, Rhys.`);
  lines.push(""); // dramatic pause

  // Approvals
  if (data.pendingApprovals && data.pendingApprovals > 0) {
    lines.push(
      `You have ${data.pendingApprovals} item${data.pendingApprovals > 1 ? "s" : ""} waiting for your approval.`
    );
  } else {
    lines.push("All clear on approvals — nothing needs your attention right now.");
  }

  // Activity summary
  if (data.callsBooked && data.callsBooked > 0) {
    lines.push(
      `${data.callsBooked} calls booked this week, ${data.activeClients ?? 0} active clients on the board.`
    );
  }

  // Coaching
  if (data.callsProcessed && data.callsProcessed > 0) {
    lines.push(
      `I've processed ${data.callsProcessed} coaching calls — intel is ready in your coaching panel.`
    );
  }

  // System status
  const total = data.totalServices ?? 7;
  const online = data.servicesOnline ?? 0;
  const down = total - online;
  if (online > 0) {
    if (down === 0) {
      lines.push(`All ${total} systems are online and running clean.`);
    } else {
      lines.push(
        `Heads up: ${down} service${down > 1 ? "s are" : " is"} showing issues. Check the system panel.`
      );
    }
  }

  lines.push("");
  lines.push(
    `Let's have a great ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}.`
  );

  return lines;
}

// ===== COMPONENT =====
export default function BriefingSequence({ onComplete, soundEngine, data }: BriefingSequenceProps) {
  const [displayedLines, setDisplayedLines] = useState<string[]>([]);
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);
  const [typingDone, setTypingDone] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);

  const cancelledRef = useRef(false);
  const soundRef = useRef(soundEngine);
  soundRef.current = soundEngine;
  const linesRef = useRef<string[]>([]);
  const lineBlipPlayedRef = useRef<Set<number>>(new Set());
  const [linesReady, setLinesReady] = useState(false);

  // Generate briefing lines once
  useEffect(() => {
    const generated = generateBriefing(data);
    linesRef.current = generated;
    setDisplayedLines(new Array(generated.length).fill(""));
    setLinesReady(true);
  }, [data]);

  // ===== TYPING ENGINE (requestAnimationFrame-based) =====
  useEffect(() => {
    if (!linesReady || cancelledRef.current) return;

    let active = true;
    let lineIdx = 0;
    let charIdx = 0;
    let waitUntil = 0;
    let raf: number;

    function getDelay(char: string): number {
      // After period
      if (char === ".") return 50 + Math.random() * 20;
      // After comma
      if (char === ",") return 30 + Math.random() * 20;
      // Spaces
      if (char === " ") return 8;
      // Regular characters — organic variation
      return 12 + Math.random() * 6;
    }

    function tick(timestamp: number) {
      if (!active || cancelledRef.current) return;

      if (timestamp < waitUntil) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const lines = linesRef.current;

      // All lines done
      if (lineIdx >= lines.length) {
        setTypingDone(true);
        return;
      }

      const currentLine = lines[lineIdx];

      // Play line blip on first char of each non-empty line
      if (charIdx === 0 && currentLine.length > 0 && !lineBlipPlayedRef.current.has(lineIdx)) {
        lineBlipPlayedRef.current.add(lineIdx);
        soundRef.current.playInitLine();
      }

      // Blank line — pause
      if (currentLine === "") {
        setDisplayedLines(prev => {
          const next = [...prev];
          next[lineIdx] = "";
          return next;
        });
        lineIdx++;
        charIdx = 0;
        waitUntil = timestamp + 600; // dramatic beat
        raf = requestAnimationFrame(tick);
        return;
      }

      // Type next character
      if (charIdx < currentLine.length) {
        const char = currentLine[charIdx];
        charIdx++;
        setCurrentLineIndex(lineIdx);
        setCurrentCharIndex(charIdx);

        setDisplayedLines(prev => {
          const next = [...prev];
          next[lineIdx] = currentLine.slice(0, charIdx);
          return next;
        });

        const delay = getDelay(char);
        waitUntil = timestamp + delay;
        raf = requestAnimationFrame(tick);
      } else {
        // Line complete — move to next
        lineIdx++;
        charIdx = 0;
        waitUntil = timestamp + 400; // scene beat between lines
        raf = requestAnimationFrame(tick);
      }
    }

    // Small initial delay before typing starts
    const startTimeout = setTimeout(() => {
      if (active && !cancelledRef.current) {
        raf = requestAnimationFrame(tick);
      }
    }, 800);

    return () => {
      active = false;
      clearTimeout(startTimeout);
      if (raf) cancelAnimationFrame(raf);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesReady]); // start when lines are generated

  // ===== CURSOR BLINK =====
  useEffect(() => {
    const interval = setInterval(() => {
      setCursorVisible(v => !v);
    }, 530);
    return () => clearInterval(interval);
  }, []);

  // ===== POST-TYPING: hold, then fade =====
  useEffect(() => {
    if (!typingDone || cancelledRef.current) return;

    // Hold cursor for 1.5s, then start fade
    const holdTimer = setTimeout(() => {
      if (!cancelledRef.current) {
        setFadeOut(true);
        soundRef.current.playBootComplete();
        soundRef.current.startAmbient();
      }
    }, 2000);

    return () => clearTimeout(holdTimer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingDone]);

  // ===== FADE OUT → COMPLETE =====
  useEffect(() => {
    if (!fadeOut) return;

    const completeTimer = setTimeout(() => {
      if (!cancelledRef.current) {
        onComplete();
      }
    }, 1200); // match fade duration

    return () => clearTimeout(completeTimer);
  }, [fadeOut, onComplete]);

  // ===== SKIP =====
  const handleSkip = useCallback(() => {
    cancelledRef.current = true;
    soundRef.current.playClick();
    soundRef.current.startAmbient();
    onComplete();
  }, [onComplete]);

  // ===== RENDER =====
  const lines = linesRef.current;

  return (
    <div
      onClick={handleSkip}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        opacity: fadeOut ? 0 : 1,
        transition: "opacity 1.2s ease-out",
        pointerEvents: fadeOut ? "none" : "auto",
      }}
    >
      {/* Semi-transparent backdrop — edges fade for constellation bleed-through */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse 80% 70% at 50% 50%, rgba(5,5,16,0.85) 0%, rgba(5,5,16,0.5) 60%, transparent 100%)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
        }}
      />

      {/* Text container */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: "800px",
          width: "100%",
          padding: "0 40px",
        }}
      >
        {displayedLines.map((text, i) => {
          if (i >= lines.length) return null;
          const isGreeting = i === 0;
          const isBlankLine = lines[i] === "";
          const isCurrentLine = i === currentLineIndex && !typingDone;
          const showCursor = isCurrentLine && cursorVisible && !fadeOut;

          if (isBlankLine) {
            return <div key={i} style={{ height: "24px" }} />;
          }

          return (
            <p
              key={i}
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: isGreeting ? "clamp(28px, 3vw, 36px)" : "clamp(16px, 1.5vw, 20px)",
                fontWeight: isGreeting ? 400 : 300,
                lineHeight: 1.7,
                color: isGreeting ? "#FFFFFF" : "rgba(0,136,255,0.7)",
                letterSpacing: isGreeting ? "0.02em" : "0.01em",
                minHeight: isGreeting ? "auto" : "1.7em",
                marginBottom: isGreeting ? "8px" : "2px",
              }}
            >
              {text}
              {showCursor && (
                <span
                  style={{
                    display: "inline-block",
                    width: "2px",
                    height: isGreeting ? "32px" : "18px",
                    background: "#0088FF",
                    marginLeft: "2px",
                    verticalAlign: "text-bottom",
                    opacity: cursorVisible ? 1 : 0,
                  }}
                />
              )}
            </p>
          );
        })}

        {/* Cursor after typing done — blinks then fades */}
        {typingDone && !fadeOut && (
          <span
            style={{
              display: "inline-block",
              width: "2px",
              height: "18px",
              background: "#0088FF",
              opacity: cursorVisible ? 0.7 : 0,
              transition: "opacity 0.1s",
            }}
          />
        )}
      </div>

      {/* Skip hint */}
      {!fadeOut && !typingDone && (
        <p
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            letterSpacing: "0.15em",
            color: "rgba(255,255,255,0.2)",
            zIndex: 2,
          }}
        >
          Click to skip
        </p>
      )}
    </div>
  );
}
