"use client";

import { useSoundContext } from "./SoundEngine";

// Inline SVG icons (no external deps)
function VolumeOnIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function VolumeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

export default function MuteToggle() {
  const { isMuted, toggleMute, isAmbientPlaying } = useSoundContext();

  return (
    <button
      onClick={toggleMute}
      aria-label={isMuted ? "Unmute audio" : "Mute audio"}
      className="mute-toggle"
      style={{
        position: "fixed",
        bottom: "76px", // above chat bar
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
        animation: !isMuted && isAmbientPlaying ? "muteTogglePulse 3s ease-in-out infinite" : "none",
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
