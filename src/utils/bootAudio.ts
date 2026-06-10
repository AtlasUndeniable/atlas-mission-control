/**
 * Boot Hum — low-frequency ambient audio for the ATLAS boot sequence.
 *
 * Layers:
 *   1. 30Hz sub-bass sine (the "room hum")
 *   2. 120Hz sine for warmth
 *   3. Filtered white noise through a bandpass for "digital air" texture
 *   All through a lowpass at 200Hz to keep it deep and clean.
 *
 * Envelope: fade in 1.5s → sustain → fade out 0.5s on stop.
 * Default gain 0.15 — ambient, not an alert.
 */

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let nodes: AudioNode[] = [];
let sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
let active = false;

const BASE_GAIN = 0.15;

export function startBootAudio(): void {
  if (active) return;

  try {
    ctx = new AudioContext();

    // If autoplay is blocked, bail gracefully
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Master gain — fade in over 1.5s
    masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(BASE_GAIN, now + 1.5);

    // Lowpass filter — keep everything below 200Hz deep and clean
    const lpFilter = ctx.createBiquadFilter();
    lpFilter.type = "lowpass";
    lpFilter.frequency.value = 200;
    lpFilter.Q.value = 0.7;

    masterGain.connect(lpFilter);
    lpFilter.connect(ctx.destination);
    nodes.push(masterGain, lpFilter);

    // --- Layer 1: 30Hz sub-bass hum ---
    const basOsc = ctx.createOscillator();
    const basGain = ctx.createGain();
    basOsc.type = "sine";
    basOsc.frequency.value = 30;
    basGain.gain.setValueAtTime(0, now);
    basGain.gain.linearRampToValueAtTime(0.6, now + 1.5);
    basOsc.connect(basGain);
    basGain.connect(masterGain);
    basOsc.start(now);
    sources.push(basOsc);
    nodes.push(basOsc, basGain);

    // --- Layer 2: 120Hz warmth ---
    const warmOsc = ctx.createOscillator();
    const warmGain = ctx.createGain();
    warmOsc.type = "sine";
    warmOsc.frequency.value = 120;
    warmGain.gain.setValueAtTime(0, now);
    warmGain.gain.linearRampToValueAtTime(0.15, now + 1.5);
    warmOsc.connect(warmGain);
    warmGain.connect(masterGain);
    warmOsc.start(now);
    sources.push(warmOsc);
    nodes.push(warmOsc, warmGain);

    // --- Layer 3: Filtered white noise ("digital air") ---
    const noiseDuration = 2;
    const bufferSize = ctx.sampleRate * noiseDuration;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      noiseData[i] = Math.random() * 2 - 1;
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;
    noiseSrc.loop = true;

    const noiseBp = ctx.createBiquadFilter();
    noiseBp.type = "bandpass";
    noiseBp.frequency.value = 80;
    noiseBp.Q.value = 0.5;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, now);
    noiseGain.gain.linearRampToValueAtTime(0.25, now + 1.5);

    noiseSrc.connect(noiseBp);
    noiseBp.connect(noiseGain);
    noiseGain.connect(masterGain);
    noiseSrc.start(now);
    sources.push(noiseSrc);
    nodes.push(noiseSrc, noiseBp, noiseGain);

    active = true;
  } catch {
    // Audio blocked or unavailable — boot sequence continues silently
    cleanup();
  }
}

export function stopBootAudio(): void {
  if (!active || !ctx || !masterGain) {
    cleanup();
    return;
  }

  try {
    const now = ctx.currentTime;
    // Fade out over 0.5s
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(0, now + 0.5);

    // Stop sources after fade completes
    setTimeout(() => {
      for (const src of sources) {
        try { src.stop(); } catch { /* already stopped */ }
      }
      cleanup();
    }, 600);
  } catch {
    cleanup();
  }
}

function cleanup(): void {
  for (const n of nodes) {
    try { n.disconnect(); } catch { /* ignore */ }
  }
  nodes = [];
  sources = [];
  if (ctx) {
    try { ctx.close(); } catch { /* ignore */ }
    ctx = null;
  }
  masterGain = null;
  active = false;
}
