"use client";

import { useCallback, useRef } from "react";

export interface SoundEngine {
  boot: () => void;
  refresh: () => void;
  notification: () => void;
  playPowerUp: () => void;
  playConnectionBeep: (index: number) => void;
  playSystemOnline: () => void;
  playKeystroke: () => void;
  playGreetingComplete: () => void;
  playCommandSend: () => void;
}

export function useSoundEngine(): SoundEngine {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const beepIndexRef = useRef(0);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
      // Master gain
      const master = ctxRef.current.createGain();
      master.gain.value = 0.22;
      // Compressor for peak protection
      const comp = ctxRef.current.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      master.connect(comp);
      comp.connect(ctxRef.current.destination);
      masterGainRef.current = master;
      compressorRef.current = comp;
    }
    return ctxRef.current;
  }, []);

  const getMaster = useCallback(() => {
    getCtx();
    return masterGainRef.current!;
  }, [getCtx]);

  // Power Up — deep cinematic hum (Boot Phase 1)
  const playPowerUp = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      // Base oscillator: 30→90Hz sweep over 2.8s
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

      // 2nd harmonic: 60→180Hz
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

      // 3rd harmonic: 90→270Hz
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

      // Filtered noise burst
      const bufferSize = ctx.sampleRate * 0.4;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "lowpass";
      noiseFilter.frequency.value = 150;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0, now);
      noiseGain.gain.linearRampToValueAtTime(0.2, now + 0.1);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(master);
      noise.start(now);
      noise.stop(now + 0.5);
    } catch {}
  }, [getCtx, getMaster]);

  // Connection Beep — short tonal ping per init line (Boot Phase 2)
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

  // System Online — three-tone ascending chime C5-E5-G5 (Boot Phase 2 final)
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

  // Keystroke — barely audible click during typing (Boot Phase 3)
  const playKeystroke = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;

      const bufferSize = ctx.sampleRate * 0.01;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const d = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        d[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      }
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

  // Greeting Complete — ascending arpeggio C5-E5-G5 (Boot Phase 4)
  const playGreetingComplete = useCallback(() => {
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
        const start = now + i * 0.12;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.06, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.85);
        osc.connect(gain);
        gain.connect(master);
        osc.start(start);
        osc.stop(start + 0.85);
      });
    } catch {}
  }, [getCtx, getMaster]);

  // Command Send — quick blip (Chat)
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

  // Legacy boot (simple chime)
  const boot = useCallback(() => {
    playPowerUp();
  }, [playPowerUp]);

  const refresh = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0.02, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.06);
    } catch {}
  }, [getCtx, getMaster]);

  const notification = useCallback(() => {
    try {
      const ctx = getCtx();
      const master = getMaster();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(900, now + 0.1);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(now + 0.15);
    } catch {}
  }, [getCtx, getMaster]);

  return {
    boot,
    refresh,
    notification,
    playPowerUp,
    playConnectionBeep,
    playSystemOnline,
    playKeystroke,
    playGreetingComplete,
    playCommandSend,
  };
}
