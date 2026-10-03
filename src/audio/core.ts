// Audio graph shared by SFX, music and crowd. Works on any BaseAudioContext so
// tools/audio-test.ts can render the exact same code into an OfflineAudioContext.
//
//   sfx bus ─┐                         ┌─> echo (stereo SNES-style delay, lowpassed feedback)
//   music ───┼─> sends ────────────────┘            │
//   crowd ───┘                                      v
//   ui ──┴──> master (mute) ─> lowpass ─> compressor ─> makeup ─> limiter ─> soft clip ─> out
//
// Pause: setPauseDuck() pulls the sfx, music and crowd buses down ~14 dB, so
// notes the sequencer already scheduled (up to the lookahead plus their
// release) and long one-shots (the goal roar, the horn) don't ring on
// through the pause screen. The ui bus (the pause jingle) is never ducked.
//
// The soft clipper is a last-resort safety net so event spam can never
// exceed ~0.9 full scale; the limiter keeps it from engaging in normal play
// (audio-test measures the signal with and without it).

export type WaveName = 'p125' | 'p25' | 'p50' | 'organ' | 'tri' | 'sine' | 'saw' | 'square';
export type NoiseName = 'white' | 'lfsr' | 'metal';

export interface CoreOptions {
  /** false bypasses the final soft clipper (used by tests to measure true headroom) */
  safetyClip?: boolean;
  /** seed for the noise tables, so offline renders are reproducible */
  seed?: number;
}

/** Seeded PRNG (mulberry32): deterministic noise tables for reproducible tests. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sfx voice budget. Music and the crowd bed are bounded by design; only
// event-driven sounds can pile up, so only they are counted.
const VOICE_CAP = 22;

/** bus levels (the pause duck scales these) */
const BUS = { sfx: 0.8, music: 0.6, crowd: 0.65, ui: 0.8 } as const;
/** paused: ducked bus level (x BUS) and the glide's time constant (s) */
export const PAUSE_DUCK = 0.18;
const PAUSE_DUCK_TAU = 0.035;
/** sfx -> echo send (clicks and whistles slap back off the arena only faintly) */
const SFX_ECHO_SEND = 0.1;
/**
 * Echo input lowpass, ahead of the taps: the SNES echo buffer is FIR-
 * filtered on the way in, so even the FIRST repeat is darker than the dry
 * sound (with the lowpass only in the feedback loop, every click and
 * whistle came back as a bright slapback).
 */
const ECHO_LP = 2800;
/** default tap time (s) until a cue sets the tempo; the right tap is offset for width */
const ECHO_TIME = 0.172;
const ECHO_STEREO = 0.012;
/** echo feedback at ECHO_TIME; longer taps feed back less, so the tail rings equally long */
const ECHO_FB = 0.38;

export class AudioCore {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  readonly sfx: GainNode;
  readonly music: GainNode;
  readonly crowd: GainNode;
  /** pause jingle and other interface sounds: like sfx, but never pause-ducked */
  readonly ui: GainNode;
  readonly echoIn: GainNode;
  /** the two echo delay lines (left, right); setEchoTempo() moves them */
  readonly echoTaps: DelayNode[] = [];
  readonly waves: Record<Exclude<WaveName, 'tri' | 'sine' | 'saw' | 'square'>, PeriodicWave>;
  readonly noise: Record<NoiseName, AudioBuffer>;
  /** shared leslie rotor LFOs, wired into organ voices / music players */
  readonly leslieDetune: GainNode;
  readonly leslieTrem: GainNode;
  readonly lesliePan: GainNode;
  readonly random: () => number;

  /** the echo feedback gains (one per tap), rescaled with the tap time */
  private echoFb: GainNode[] = [];
  private voiceEnds: number[] = [];
  private lastPlayed = new Map<string, number>();
  private masterLevel = 1;

  constructor(ctx: BaseAudioContext, opts: CoreOptions = {}) {
    this.ctx = ctx;
    this.random = rng(opts.seed ?? 0x5eed);

    // ---- master chain
    this.master = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    // The SPC700's gaussian interpolation rolls off the top end; this is the
    // single biggest "sounds like a SNES" cue.
    lp.type = 'lowpass';
    lp.frequency.value = 11500;
    lp.Q.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -15;
    comp.knee.value = 10;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    // Chromium's compressor adds its own automatic makeup gain (~+9 dB small
    // signal for this pair, measured by tools/audio-chain.ts); trim it back
    const makeup = ctx.createGain();
    makeup.gain.value = 0.6;
    // brickwall-ish limiter (the compressor's built-in lookahead catches
    // transients) keeps pile-ups under the clipper's knee
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0005;
    limiter.release.value = 0.12;
    this.master.connect(lp).connect(comp).connect(makeup).connect(limiter);
    if (opts.safetyClip === false) {
      limiter.connect(ctx.destination);
    } else {
      const clip = ctx.createWaveShaper();
      clip.curve = softClipCurve();
      clip.oversample = '2x';
      limiter.connect(clip).connect(ctx.destination);
    }

    // ---- buses
    this.sfx = gain(ctx, BUS.sfx);
    this.music = gain(ctx, BUS.music);
    this.crowd = gain(ctx, BUS.crowd);
    this.ui = gain(ctx, BUS.ui);
    for (const b of [this.sfx, this.music, this.crowd, this.ui]) b.connect(this.master);

    // ---- echo: dark on the way in (input lowpass) and darker with every
    // repeat (lowpass in the feedback loop), like the SNES FIR'd echo buffer.
    this.echoIn = gain(ctx, 1);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 280; // no muddy bass repeats
    const inLp = ctx.createBiquadFilter();
    inLp.type = 'lowpass';
    inLp.frequency.value = ECHO_LP;
    inLp.Q.value = 0.6;
    this.echoIn.connect(hp).connect(inLp);
    const wet = gain(ctx, 0.3);
    wet.connect(this.master);
    // two taps 12 ms apart: stereo width without a flam between repeats
    for (const [time, pan] of [
      [ECHO_TIME, -0.6],
      [ECHO_TIME + ECHO_STEREO, 0.6],
    ] as const) {
      const d = ctx.createDelay(1);
      d.delayTime.value = time;
      const fbLp = ctx.createBiquadFilter();
      fbLp.type = 'lowpass';
      fbLp.frequency.value = 2400;
      const fb = gain(ctx, ECHO_FB);
      this.echoFb.push(fb);
      inLp.connect(d);
      d.connect(fbLp).connect(fb).connect(d);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      d.connect(p).connect(wet);
      this.echoTaps.push(d);
    }
    gain(ctx, SFX_ECHO_SEND, this.sfx).connect(this.echoIn);
    gain(ctx, SFX_ECHO_SEND, this.ui).connect(this.echoIn);
    gain(ctx, 0.3, this.music).connect(this.echoIn);

    // ---- waves
    this.waves = {
      p125: pulseWave(ctx, 0.125),
      p25: pulseWave(ctx, 0.25),
      p50: pulseWave(ctx, 0.5),
      organ: organWave(ctx),
    };
    this.noise = {
      white: whiteNoise(ctx, this.random),
      lfsr: lfsrNoise(ctx, false),
      metal: lfsrNoise(ctx, true),
    };

    // ---- leslie rotor: slightly different rates for pitch and amplitude so
    // the wobble never sounds like a plain tremolo.
    this.leslieDetune = gain(ctx, 7); // cents
    this.leslieTrem = gain(ctx, 0.12);
    this.lesliePan = gain(ctx, 0.35);
    const lfoA = ctx.createOscillator();
    lfoA.frequency.value = 6.1;
    lfoA.connect(this.leslieDetune);
    lfoA.connect(this.lesliePan);
    const lfoB = ctx.createOscillator();
    lfoB.frequency.value = 6.6;
    lfoB.connect(this.leslieTrem);
    lfoA.start();
    lfoB.start();
  }

  now(): number {
    return this.ctx.currentTime;
  }

  /** Ramp the master (mute / pause duck). */
  setMaster(level: number, ramp = 0.08): void {
    this.masterLevel = level;
    const t = this.now();
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(level, t + ramp);
  }

  /**
   * Pause duck: glide the sfx, music and crowd buses to PAUSE_DUCK of their
   * level (on) or back (off), time constant PAUSE_DUCK_TAU (-12 dB in ~0.09 s, -14.9 dB floor).
   * The ui bus is left alone so the pause jingle plays at full level.
   */
  setPauseDuck(on: boolean, t: number): void {
    if (!Number.isFinite(t)) return;
    const k = on ? PAUSE_DUCK : 1;
    for (const [bus, level] of [
      [this.sfx, BUS.sfx],
      [this.music, BUS.music],
      [this.crowd, BUS.crowd],
    ] as const) {
      const g = bus.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(level * k, t, PAUSE_DUCK_TAU);
    }
  }

  /**
   * Sync the echo to the music: both taps glide to an 8th note
   * (60 / bpm / 2, kept within 0.15-0.33 s), the right one ECHO_STEREO
   * later. The feedback is rescaled so the tail decays in the same time
   * (same arena, different rhythm): 0.38 at 0.172 s, ~0.2 at 0.283 s.
   * Called when a cue starts; the taps stay put through live play.
   */
  setEchoTempo(bpm: number, t: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(t)) return;
    const base = Math.max(0.15, Math.min(0.33, 60 / bpm / 2));
    this.echoTaps.forEach((d, i) => {
      const time = base + i * ECHO_STEREO;
      const p = d.delayTime;
      p.cancelScheduledValues(t);
      // a gentle glide: a step would click, a fast ramp would warble the tail
      p.setTargetAtTime(time, t, 0.08);
      const fb = this.echoFb[i].gain;
      fb.cancelScheduledValues(t);
      fb.setTargetAtTime(Math.pow(ECHO_FB, time / (ECHO_TIME + i * ECHO_STEREO)), t, 0.08);
    });
  }

  get masterTarget(): number {
    return this.masterLevel;
  }

  /**
   * Gatekeeper for event sounds. `key` throttles repeats of the same sound
   * (boards rattles, stick clicks); the voice cap drops low-priority sounds
   * when many are already ringing. priority >= 2 always plays.
   */
  claim(key: string, t: number, minGap: number, endTime: number, priority = 1): boolean {
    const last = this.lastPlayed.get(key);
    if (last !== undefined && t - last < minGap && t >= last) return false;
    this.voiceEnds = this.voiceEnds.filter((e) => e > t);
    const busy = this.voiceEnds.length;
    if (priority < 2 && busy >= VOICE_CAP) return false;
    if (priority < 1 && busy >= VOICE_CAP / 2) return false;
    this.lastPlayed.set(key, t);
    this.voiceEnds.push(endTime);
    return true;
  }

  get activeVoices(): number {
    const t = this.now();
    return this.voiceEnds.filter((e) => e > t).length;
  }
}

export function gain(ctx: BaseAudioContext, value: number, input?: AudioNode): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  if (input) input.connect(g);
  return g;
}

/** linear below the knee, tanh-rounded above, never exceeding ~0.9 */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  const knee = 0.62;
  const room = 0.3;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax < knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/**
 * Band-limited pulse wave with duty `d` (the SNES didn't have these natively,
 * but every SNES composer sampled them; 12.5/25/50% are the classic three).
 * Fourier series of a 0/1 pulse: a_n = sin(2πnd)/(πn), b_n = (1-cos(2πnd))/(πn).
 */
function pulseWave(ctx: BaseAudioContext, d: number): PeriodicWave {
  const n = 96;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    re[k] = Math.sin(2 * Math.PI * k * d) / (Math.PI * k);
    im[k] = (1 - Math.cos(2 * Math.PI * k * d)) / (Math.PI * k);
  }
  return ctx.createPeriodicWave(re, im);
}

/** Drawbar-style organ: 8' 4' 2⅔' 2' 1⅗' 1⅓' 1' - a bright arena/theatre registration. */
function organWave(ctx: BaseAudioContext): PeriodicWave {
  const bars: Record<number, number> = { 1: 1, 2: 0.75, 3: 0.55, 4: 0.42, 5: 0.12, 6: 0.22, 8: 0.2 };
  const n = 12;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (const [h, a] of Object.entries(bars)) im[Number(h)] = a;
  return ctx.createPeriodicWave(re, im);
}

function whiteNoise(ctx: BaseAudioContext, rnd: () => number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 2);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  return b;
}

/**
 * Game-console LFSR noise. Long mode (15-bit) is the crunchy hiss; short mode
 * (tap at bit 6, 93-step loop) is the "metallic" tonal noise used for hats,
 * the post ping's attack and skate scrapes. Each LFSR step lasts `hold`
 * samples, so playbackRate shifts its pitch.
 */
function lfsrNoise(ctx: BaseAudioContext, short: boolean): AudioBuffer {
  const hold = 4;
  const steps = short ? 93 * 8 : 32767;
  const len = steps * hold;
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let reg = 1;
  for (let s = 0; s < steps; s++) {
    const bit = (reg ^ (reg >> (short ? 6 : 1))) & 1;
    reg = (reg >> 1) | (bit << 14);
    const v = reg & 1 ? 0.8 : -0.8;
    for (let h = 0; h < hold; h++) d[s * hold + h] = v;
  }
  return b;
}
