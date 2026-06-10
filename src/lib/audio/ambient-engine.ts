/**
 * ATLAS Mission Control — Ambient Audio Engine
 *
 * Five selectable modes, deliberately minimal:
 *   - "off"          — silent (default)
 *   - "hum"          — station hum only
 *   - "hum+sputnik"  — station hum + sputnik double-beep every 4s
 *   - "radar"        — radar ping + 3 echoes every 4s
 *   - "hum+radar"    — station hum + radar
 *
 * Sound spec (do not modify):
 *
 *   STATION HUM — 1 oscillator, 55Hz triangle, gain 0.03, no modulation.
 *
 *   SPUTNIK BEEP (every 4s) — double-beep:
 *     200ms 1000Hz sine | 200ms silence | 200ms 1000Hz sine
 *     Each beep: gain 0→0.06 ramp 5ms, hold, 0.06→0 ramp 5ms (soft edges).
 *
 *   RADAR PING (every 4s) — 50ms 1200Hz sine, peak 0.05, exponential decay
 *     to 0.001 over 50ms. Followed by 3 echoes at 180ms intervals, gain halved
 *     each step (0.025, 0.0125, 0.006). Each echo is a fresh oscillator
 *     start/stop — no DelayNode.
 */

export type AmbientSound = "off" | "hum" | "hum+sputnik" | "radar" | "hum+radar";

export const AMBIENT_SOUND_LABELS: Record<AmbientSound, string> = {
  off: "Off",
  hum: "Station Hum",
  "hum+sputnik": "Station Hum + Sputnik",
  radar: "Radar Ping",
  "hum+radar": "Station Hum + Radar",
};

export class AmbientAudio {
  private ctx: AudioContext;
  private dest: AudioNode;
  private current: AmbientSound = "off";

  private humOsc: OscillatorNode | null = null;
  private humGain: GainNode | null = null;
  private sputnikTimer: ReturnType<typeof setTimeout> | null = null;
  private radarTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.dest = destination;
  }

  /** Public API per spec. */
  start(mode: AmbientSound): void {
    this.setSound(mode);
  }

  /** Public API per spec. */
  stop(): void {
    this.setSound("off");
  }

  /** Integration API used by SoundEngine.tsx. */
  setSound(sound: AmbientSound): void {
    if (sound === this.current) return;
    this.teardown();
    this.current = sound;
    if (sound === "off") return;

    const wantsHum = sound === "hum" || sound === "hum+sputnik" || sound === "hum+radar";
    const wantsSputnik = sound === "hum+sputnik";
    const wantsRadar = sound === "radar" || sound === "hum+radar";

    if (wantsHum) this.startHum();
    if (wantsSputnik) this.startSputnikLoop();
    if (wantsRadar) this.startRadarLoop();
  }

  getSound(): AmbientSound {
    return this.current;
  }

  isRunning(): boolean {
    return this.current !== "off";
  }

  private teardown(): void {
    if (this.sputnikTimer) {
      clearTimeout(this.sputnikTimer);
      this.sputnikTimer = null;
    }
    if (this.radarTimer) {
      clearTimeout(this.radarTimer);
      this.radarTimer = null;
    }
    if (this.humOsc) {
      try { this.humOsc.stop(); } catch {}
      try { this.humOsc.disconnect(); } catch {}
      this.humOsc = null;
    }
    if (this.humGain) {
      try { this.humGain.disconnect(); } catch {}
      this.humGain = null;
    }
  }

  // ─── STATION HUM ────────────────────────────────────────
  private startHum(): void {
    const ac = this.ctx;
    const osc = ac.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 55;

    const g = ac.createGain();
    g.gain.value = 0.03;

    osc.connect(g);
    g.connect(this.dest);
    osc.start();

    this.humOsc = osc;
    this.humGain = g;
  }

  // ─── SPUTNIK ────────────────────────────────────────────
  private startSputnikLoop(): void {
    const tick = () => {
      if (this.current !== "hum+sputnik") return;
      this.emitSputnikDoubleBeep();
      this.sputnikTimer = setTimeout(tick, 4000);
    };
    tick();
  }

  private emitSputnikDoubleBeep(): void {
    const ac = this.ctx;
    const t0 = ac.currentTime;
    // Beep 1: t0 → t0+200ms
    this.emitSputnikBeep(t0);
    // Beep 2: t0+400ms (200ms beep + 200ms silence) → t0+600ms
    this.emitSputnikBeep(t0 + 0.4);
  }

  private emitSputnikBeep(startAt: number): void {
    const ac = this.ctx;
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 1000;

    const g = ac.createGain();
    // 0 → 0.06 over 5ms
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(0.06, startAt + 0.005);
    // hold through beep body until 5ms before end
    g.gain.setValueAtTime(0.06, startAt + 0.195);
    // 0.06 → 0 over 5ms (ends at startAt + 0.200)
    g.gain.linearRampToValueAtTime(0, startAt + 0.2);

    osc.connect(g);
    g.connect(this.dest);
    osc.start(startAt);
    osc.stop(startAt + 0.21);
  }

  // ─── RADAR PING ─────────────────────────────────────────
  private startRadarLoop(): void {
    const tick = () => {
      if (this.current !== "radar" && this.current !== "hum+radar") return;
      this.emitRadarPing();
      this.radarTimer = setTimeout(tick, 4000);
    };
    tick();
  }

  private emitRadarPing(): void {
    const ac = this.ctx;
    const t0 = ac.currentTime;
    // Primary + 3 echoes; each echo is a fresh oscillator (no DelayNode).
    const gains = [0.05, 0.025, 0.0125, 0.006];
    for (let i = 0; i < gains.length; i++) {
      this.emitRadarTone(t0 + i * 0.18, gains[i]);
    }
  }

  private emitRadarTone(startAt: number, peakGain: number): void {
    const ac = this.ctx;
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 1200;

    const g = ac.createGain();
    // Peak at start, exponential decay to 0.001 over 50ms.
    g.gain.setValueAtTime(peakGain, startAt);
    g.gain.exponentialRampToValueAtTime(0.001, startAt + 0.05);

    osc.connect(g);
    g.connect(this.dest);
    osc.start(startAt);
    osc.stop(startAt + 0.06);
  }
}

// Backwards-compat alias — existing code imports `AmbientEngine`.
export { AmbientAudio as AmbientEngine };

// ──────────────────────────────────────────────────────────
// Lazy singleton — one engine per AudioContext.
// ──────────────────────────────────────────────────────────
let _instance: AmbientAudio | null = null;

export function getAmbientEngine(ctx: AudioContext, destination: AudioNode): AmbientAudio {
  if (!_instance) {
    _instance = new AmbientAudio(ctx, destination);
  }
  return _instance;
}

export function disposeAmbientEngine(): void {
  if (_instance) {
    _instance.setSound("off");
    _instance = null;
  }
}
