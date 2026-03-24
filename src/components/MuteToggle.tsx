"use client";

import { useSoundContext } from "./SoundEngine";

function VolumeOnIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function VolumeOffIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

interface MuteToggleProps {
  inline?: boolean;
}

export default function MuteToggle({ inline = false }: MuteToggleProps) {
  const { isMuted, toggleMute } = useSoundContext();

  if (inline) {
    return (
      <button
        onClick={toggleMute}
        aria-label={isMuted ? "Unmute audio" : "Mute audio"}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "28px",
          height: "28px",
          borderRadius: "6px",
          background: "transparent",
          border: "1px solid rgba(0, 136, 255, 0.1)",
          color: isMuted ? "rgba(255,255,255,0.2)" : "rgba(0,136,255,0.5)",
          cursor: "pointer",
          transition: "border-color 0.2s ease, color 0.2s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "rgba(0, 136, 255, 0.25)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "rgba(0, 136, 255, 0.1)";
        }}
      >
        {isMuted ? <VolumeOffIcon size={14} /> : <VolumeOnIcon size={14} />}
      </button>
    );
  }

  // Fixed position mode (legacy)
  return (
    <button
      onClick={toggleMute}
      aria-label={isMuted ? "Unmute audio" : "Mute audio"}
      className="mute-toggle"
      style={{
        position: "fixed",
        bottom: "76px",
        left: "16px",
        zIndex: 50,
        width: "40px",
        height: "40px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "8px",
        background: "linear-gradient(135deg, rgba(0, 136, 255, 0.04) 0%, rgba(5, 5, 16, 0.95) 100%)",
        border: "1px solid rgba(0, 136, 255, 0.12)",
        backdropFilter: "blur(12px)",
        color: isMuted ? "rgba(255,255,255,0.25)" : "rgba(0,136,255,0.6)",
        cursor: "pointer",
        transition: "border-color 0.3s ease, color 0.3s ease, box-shadow 0.3s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "rgba(0, 136, 255, 0.25)";
        e.currentTarget.style.boxShadow = "0 0 15px rgba(0, 136, 255, 0.06)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(0, 136, 255, 0.12)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      {isMuted ? <VolumeOffIcon /> : <VolumeOnIcon />}
    </button>
  );
}
