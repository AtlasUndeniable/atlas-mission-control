"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// ===== PUBLIC INTERFACE =====
export interface SoundEngine {
  // Master controls
  isMuted: boolean;
  toggleMute: () => void;
  setMasterVolume: (v: number) => void;
  // Ambient
  startAmbient: () => void;
  stopAmbient: () => void;
  isAmbientPlaying: boolean;
  // One-shots
  playBoot: () => void;
  playInitLine: () => void;
  playBootComplete: () => void;
  playPanelReveal: () => void;
  playHover: () => void;
  playClick: () => void;
  playNotification: () => void;
  playDataRefresh: () => void;
  // Legacy compat (used by BootSequence)
  playPowerUp: () => void;
  playConnectionBeep: (index: number) => void;
  playSystemOnline: () => void;
  playKeystroke: () => void;
  playCommandSend: () => void;
  refresh: () => void;
  notification: () => void;
  boot: () => void;
}

const SoundContext = createContext<SoundEngine | null>(null);

export function useSoundContext(): SoundEngine {
  const ctx = useContext(SoundContext);
  if (!ctx) throw new Error("useSoundContext must be used within <SoundProvider>");
  return ctx;
}

// ===== PROVIDER =====
export function SoundProvider({ children }: { children: ReactNode }) {
  const [isMuted, setIsMuted] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("atlas-sound-muted") === "1";
    }
    return false;
  });
  const [isAmbientPlaying, setIsAmbientPlaying] = useState(false);

  // Refs for Web Audio objects
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const ambientNodesRef = useRef<{
    baseOsc: OscillatorNode;
    lfoOsc: OscillatorNode;
    noiseSource: AudioBufferSourceNode;
    pingInterval: ReturnType<typeof setInterval>;
    allNodes: AudioNode[];
  } | null>(null);
  const masterVolumeRef = useRef(0.22);
  const mutedRef = useRef(isMuted);
  const lastRefreshRef = useRef(0);
  const reducedMotionRef = useRef(false);

  // Keep mutedRef in sync
  useEffect(() => {
    mutedRef.current = isMuted;
    if (masterRef.current) {
      masterRef.current.gain.value = isMuted ? 0 : masterVolumeRef.current;
    }
  }, [isMuted]);

  // Check reduced motion on mount
  useEffect(() => {
    reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // ===== LAZY INIT AudioContext =====
  const getCtx = useCallback(() => {
    if (!ctxRef.current) {
      const ac = new AudioContext();
      ctxRef.current = ac;

      const master = ac.createGain();
      master.gain.value = mutedRef.current ? 0 : masterVolumeRef.current;
      masterRef.current = master;

      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      compressorRef.current = comp;

      master.connect(comp);
      comp.connect(ac.destination);
    }
    // Resume if suspended (autoplay policy)
    if (ctxRef.current.state === "suspended") {
      ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  const getMaster = useCallback(() => {
    getCtx();
    return masterRef.current!;
  }, [getCtx]);

  // ===== MASTER CONTROLS =====
  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      localStorage.setItem("atlas-sound-muted", next ? "1" : "0");
      return next;
    });
  }, []);

  const setMasterVolume = useCallback((v: number) => {
    masterVolumeRef.current = Math.max(0, Math.min(1, v));
    if (masterRef.current && !mutedRef.current) {
      masterRef.current.gain.value = masterVolumeRef.current;
    }
  }, []);

  // ===== AMBIENT SYNTH =====
  const startAmbient = useCallback(() => {
    if (ambientNodesRef.current) return; // already playing
    if (reducedMotionRef.current) return; // respect reduced motion

    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;
      const allNodes: AudioNode[] = [];

      // --- Layer 1: Sub-bass hum (55Hz sine, very quiet) ---
      const baseOsc = ctx.createOscillator();
      const baseGain = ctx.createGain();
      baseOsc.type = "sine";
      baseOsc.frequency.value = 55;
      baseGain.gain.setValueAtTime(0, now);
      baseGain.gain.linearRampToValueAtTime(0.03, now + 2);
      baseOsc.connect(baseGain);
      baseGain.connect(master);
      baseOsc.start(now);
      allNodes.push(baseOsc, baseGain);

      // --- Layer 2: Filtered noise with LFO breathing ---
      // Create noise buffer (2 seconds, loopable)
      const noiseDuration = 2;
      const bufferSize = ctx.sampleRate * noiseDuration;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const noiseData = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        noiseData[i] = Math.random() * 2 - 1;
      }
      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;

      // Low-pass filter on noise
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "lowpass";
      noiseFilter.frequency.value = 400;
      noiseFilter.Q.value = 0.7;

      // LFO to modulate noise gain (breathing)
      const lfoOsc = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const noiseGain = ctx.createGain();
      lfoOsc.type = "sine";
      lfoOsc.frequency.value = 0.05; // very slow
      lfoGain.gain.value = 0.008; // modulation depth
      noiseGain.gain.value = 0.012; // base noise level

      lfoOsc.connect(lfoGain);
      lfoGain.connect(noiseGain.gain); // modulate the gain parameter
      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(master);
      lfoOsc.start(now);
      noiseSource.start(now);
      allNodes.push(noiseSource, noiseFilter, noiseGain, lfoOsc, lfoGain);

      // --- Layer 3: Random pings ---
      const schedulePing = () => {
        if (!ctxRef.current || !ambientNodesRef.current) return;
        try {
          const ac = ctxRef.current;
          const m = masterRef.current!;
          const t = ac.currentTime;
          const freq = 800 + Math.random() * 1200; // 800-2000Hz

          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.02, t + 0.1);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
          osc.connect(gain);
          gain.connect(m);
          osc.start(t);
          osc.stop(t + 0.5);
        } catch { /* ignore */ }
      };

      const pingInterval = setInterval(() => {
        schedulePing();
      }, (8 + Math.random() * 7) * 1000); // 8-15s

      ambientNodesRef.current = { baseOsc, lfoOsc, noiseSource, pingInterval, allNodes };
      setIsAmbientPlaying(true);
    } catch { /* ignore audio errors */ }
  }, [getCtx, getMaster]);

  const stopAmbient = useCallback(() => {
    const ambient = ambientNodesRef.current;
    if (!ambient) return;

    clearInterval(ambient.pingInterval);
    try {
      ambient.baseOsc.stop();
      ambient.lfoOsc.stop();
      ambient.noiseSource.stop();
    } catch { /* already stopped */ }
    ambient.allNodes.forEach((n) => { try { n.disconnect(); } catch {} });
    ambientNodesRef.current = null;
    setIsAmbientPlaying(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAmbient();
      if (ctxRef.current) {
        ctxRef.current.close();
        ctxRef.current = null;
      }
    };
  }, [stopAmbient]);

  // ===== BOOT SOUNDS =====

  // playBoot — rising sine sweep 200→800Hz, 1.5s, with delay-based reverb
  const playBoot = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      // Main sweep
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(800, now + 1.5);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 0.1);
      gain.gain.setValueAtTime(0.08, now + 1.2);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 2.0);
      osc.connect(gain);

      // Delay-based fake reverb
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.25;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.3;
      const reverbGain = ctx.createGain();
      reverbGain.gain.value = 0.04;

      gain.connect(master);
      gain.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(reverbGain);
      reverbGain.connect(master);

      osc.start(now);
      osc.stop(now + 2.0);

      // 2nd harmonic layer
      const h2 = ctx.createOscillator();
      const h2Gain = ctx.createGain();
      h2.type = "sine";
      h2.frequency.setValueAtTime(100, now);
      h2.frequency.exponentialRampToValueAtTime(400, now + 1.5);
      h2Gain.gain.setValueAtTime(0, now);
      h2Gain.gain.linearRampToValueAtTime(0.04, now + 0.2);
      h2Gain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
      h2.connect(h2Gain);
      h2Gain.connect(master);
      h2.start(now);
      h2.stop(now + 1.8);

      // Noise burst for texture
      const bufLen = ctx.sampleRate * 0.4;
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufLen);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const nf = ctx.createBiquadFilter();
      nf.type = "lowpass";
      nf.frequency.value = 200;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0, now);
      ng.gain.linearRampToValueAtTime(0.12, now + 0.05);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      noise.connect(nf);
      nf.connect(ng);
      ng.connect(master);
      noise.start(now);
      noise.stop(now + 0.5);
    } catch {}
  }, [getCtx, getMaster]);

  // playInitLine — short blip with pitch variation
  const playInitLine = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;
      const freq = 1200 + (Math.random() - 0.5) * 200; // 1100-1300Hz

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.06);
    } catch {}
  }, [getCtx, getMaster]);

  // playBootComplete — two-tone chime with delay echo
  const playBootComplete = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      // First tone — 600Hz
      const osc1 = ctx.createOscillator();
      const g1 = ctx.createGain();
      osc1.type = "sine";
      osc1.frequency.value = 600;
      g1.gain.setValueAtTime(0, now);
      g1.gain.linearRampToValueAtTime(0.1, now + 0.01);
      g1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc1.connect(g1);
      g1.connect(master);
      osc1.start(now);
      osc1.stop(now + 0.15);

      // Second tone — 900Hz
      const osc2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.value = 900;
      g2.gain.setValueAtTime(0, now + 0.1);
      g2.gain.linearRampToValueAtTime(0.1, now + 0.11);
      g2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      // Delay echo
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.3;
      const echoGain = ctx.createGain();
      echoGain.gain.value = 0.04;

      osc2.connect(g2);
      g2.connect(master);
      g2.connect(delay);
      delay.connect(echoGain);
      echoGain.connect(master);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.4);
    } catch {}
  }, [getCtx, getMaster]);

  // playPanelReveal — filtered white noise whoosh
  const playPanelReveal = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      const bufLen = ctx.sampleRate * 0.15;
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufLen);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;

      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 400;
      bp.Q.value = 0.5;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.04, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      noise.connect(bp);
      bp.connect(gain);
      gain.connect(master);
      noise.start(now);
      noise.stop(now + 0.16);
    } catch {}
  }, [getCtx, getMaster]);

  // ===== INTERACTION SOUNDS =====

  // playHover — tiny tick
  const playHover = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 2000;
      gain.gain.setValueAtTime(0.03, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.025);
    } catch {}
  }, [getCtx, getMaster]);

  // playClick — sharper tick with pitch drop
  const playClick = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(3000, now);
      osc.frequency.exponentialRampToValueAtTime(2000, now + 0.03);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.035);
    } catch {}
  }, [getCtx, getMaster]);

  // playNotification — double beep
  const playNotification = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      // First beep
      const osc1 = ctx.createOscillator();
      const g1 = ctx.createGain();
      osc1.type = "sine";
      osc1.frequency.value = 880;
      g1.gain.setValueAtTime(0, now);
      g1.gain.linearRampToValueAtTime(0.08, now + 0.01);
      g1.gain.setValueAtTime(0.08, now + 0.09);
      g1.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc1.connect(g1);
      g1.connect(master);
      osc1.start(now);
      osc1.stop(now + 0.12);

      // Second beep (after 0.15s gap)
      const osc2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.value = 880;
      g2.gain.setValueAtTime(0, now + 0.15);
      g2.gain.linearRampToValueAtTime(0.08, now + 0.16);
      g2.gain.setValueAtTime(0.08, now + 0.24);
      g2.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc2.connect(g2);
      g2.connect(master);
      osc2.start(now + 0.15);
      osc2.stop(now + 0.27);
    } catch {}
  }, [getCtx, getMaster]);

  // playDataRefresh — subtle sweep, throttled to 1 per 5s
  const playDataRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastRefreshRef.current < 5000) return;
    lastRefreshRef.current = now;

    try {
      const ctx = getCtx();
      const master = getMaster();
      const t = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(400, t);
      osc.frequency.exponentialRampToValueAtTime(600, t + 0.2);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.02, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc.stop(t + 0.22);
    } catch {}
  }, [getCtx, getMaster]);

  // ===== LEGACY COMPAT (keep BootSequence working during transition) =====

  // playPowerUp — original deep cinematic hum (30→90Hz sweep + harmonics)
  const playPowerUp = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      const base = ctx.createOscillator();
      const baseGain = ctx.createGain();
      base.type = "sine";
      base.frequency.setValueAtTime(30, now);
      base.frequency.exponentialRampToValueAtTime(90, now + 2.8);
      baseGain.gain.setValueAtTime(0, now);
      baseGain.gain.linearRampToValueAtTime(0.14, now + 0.3);
      baseGain.gain.linearRampToValueAtTime(0.08, now + 1.0);
      baseGain.gain.exponentialRampToValueAtTime(0.001, now + 3.3);
      base.connect(baseGain);
      baseGain.connect(master);
      base.start(now);
      base.stop(now + 3.3);

      const h2 = ctx.createOscillator();
      const h2Gain = ctx.createGain();
      h2.type = "sine";
      h2.frequency.setValueAtTime(60, now);
      h2.frequency.exponentialRampToValueAtTime(180, now + 2.8);
      h2Gain.gain.setValueAtTime(0, now);
      h2Gain.gain.linearRampToValueAtTime(0.04, now + 0.5);
      h2Gain.gain.exponentialRampToValueAtTime(0.001, now + 3.0);
      h2.connect(h2Gain);
      h2Gain.connect(master);
      h2.start(now);
      h2.stop(now + 3.0);

      const h3 = ctx.createOscillator();
      const h3Gain = ctx.createGain();
      h3.type = "sine";
      h3.frequency.setValueAtTime(90, now);
      h3.frequency.exponentialRampToValueAtTime(270, now + 2.8);
      h3Gain.gain.setValueAtTime(0, now);
      h3Gain.gain.linearRampToValueAtTime(0.015, now + 0.5);
      h3Gain.gain.exponentialRampToValueAtTime(0.001, now + 3.0);
      h3.connect(h3Gain);
      h3Gain.connect(master);
      h3.start(now);
      h3.stop(now + 3.0);

      const bufferSize = ctx.sampleRate * 0.4;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const nf = ctx.createBiquadFilter();
      nf.type = "lowpass";
      nf.frequency.value = 150;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0, now);
      ng.gain.linearRampToValueAtTime(0.2, now + 0.1);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      noise.connect(nf);
      nf.connect(ng);
      ng.connect(master);
      noise.start(now);
      noise.stop(now + 0.5);
    } catch {}
  }, [getCtx, getMaster]);

  const BEEP_FREQS = [880, 932, 988, 1047, 1109, 1175, 1245, 1319];
  const playConnectionBeep = useCallback((index: number) => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;
      const freq = BEEP_FREQS[index % BEEP_FREQS.length];

      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      filter.type = "lowpass";
      filter.frequency.value = freq * 1.5;
      filter.Q.value = 1;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.07, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.13);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getCtx, getMaster]);

  const playSystemOnline = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99];

      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = now + i * 0.1;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.09, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.55);
        osc.connect(gain);
        gain.connect(master);
        osc.start(start);
        osc.stop(start + 0.55);
      });
    } catch {}
  }, [getCtx, getMaster]);

  const playKeystroke = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      const bufferSize = ctx.sampleRate * 0.01;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const d = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 3000 + Math.random() * 800;
      filter.Q.value = 2;
      const gain = ctx.createGain();
      gain.gain.value = 0.015 + Math.random() * 0.008;
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      noise.start(now);
      noise.stop(now + 0.018);
    } catch {}
  }, [getCtx, getMaster]);

  const playCommandSend = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(500, now);
      osc.frequency.exponentialRampToValueAtTime(1000, now + 0.14);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.05, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.14);
    } catch {}
  }, [getCtx, getMaster]);

  // Legacy aliases
  const refresh = playDataRefresh;
  const notification = playNotification;
  const boot = playBoot;

  // ===== CONTEXT VALUE =====
  const engine: SoundEngine = {
    isMuted,
    toggleMute,
    setMasterVolume,
    startAmbient,
    stopAmbient,
    isAmbientPlaying,
    playBoot,
    playInitLine,
    playBootComplete,
    playPanelReveal,
    playHover,
    playClick,
    playNotification,
    playDataRefresh,
    // Legacy
    playPowerUp,
    playConnectionBeep,
    playSystemOnline,
    playKeystroke,
    playCommandSend,
    refresh,
    notification,
    boot,
  };

  return (
    <SoundContext.Provider value={engine}>
      {children}
    </SoundContext.Provider>
  );
}
