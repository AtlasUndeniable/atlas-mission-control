"use client";

import { useSoundContext, AMBIENT_SOUND_LABELS, type AmbientSound } from "./SoundEngine";

interface AmbientModeSelectProps {
  inline?: boolean;
}

const SOUND_ORDER: AmbientSound[] = ["off", "hum", "hum+sputnik", "radar", "hum+radar"];

export default function AmbientModeSelect({ inline = false }: AmbientModeSelectProps) {
  const { ambientSound, setAmbientSound, isMuted } = useSoundContext();

  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: inline ? "4px" : "6px",
        opacity: isMuted ? 0.4 : 1,
        transition: "opacity 150ms ease",
      }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: inline ? "9px" : "10px",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.28)",
        }}
      >
        Ambient
      </span>
      <select
        aria-label="Ambient sound"
        value={ambientSound}
        onChange={(e) => setAmbientSound(e.target.value as AmbientSound)}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          fontFamily: "var(--font-mono)",
          fontSize: inline ? "10px" : "11px",
          letterSpacing: "0.06em",
          color: "rgba(0,136,255,0.85)",
          background: "rgba(0, 16, 32, 0.5)",
          border: "1px solid rgba(0,136,255,0.22)",
          borderRadius: "3px",
          padding: inline ? "2px 18px 2px 6px" : "3px 20px 3px 8px",
          cursor: "pointer",
          outline: "none",
          backgroundImage:
            "linear-gradient(45deg, transparent 50%, rgba(0,136,255,0.6) 50%), linear-gradient(135deg, rgba(0,136,255,0.6) 50%, transparent 50%)",
          backgroundPosition:
            inline
              ? "calc(100% - 10px) center, calc(100% - 6px) center"
              : "calc(100% - 12px) center, calc(100% - 8px) center",
          backgroundSize: "4px 4px, 4px 4px",
          backgroundRepeat: "no-repeat",
        }}
      >
        {SOUND_ORDER.map((s) => (
          <option key={s} value={s} style={{ background: "#060a14", color: "#e6e9ee" }}>
            {AMBIENT_SOUND_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  );
}
