// Voice primitives (tone, noise) with ADSR, pitch sweeps, vibrato and
// filters, plus the music instruments and drum kit built from them.
// Every function schedules at an absolute context time and returns when the
// voice is silent, so callers can budget voices.

import type { AudioCore, NoiseName, WaveName } from './core';

export interface Env {
  a: number; // attack s
  d: number; // decay time constant-ish s (time to settle near sustain)
  s: number; // sustain 0..1 of peak
  r: number; // release s
}

// WebAudio throws on a non-finite AudioParam value (TypeError) and on an
// exponential ramp to 0 (RangeError). Recipes pass sim-derived numbers
// through, and an exception here would escape into the game loop, so every
// voice validates its inputs: a bad voice is skipped, a bad sweep is dropped.
const fin = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
/** floor for exponential ramp targets (which must be > 0) */
const expTo = (x: number, floor: number) => Math.max(floor, x);

const ENV = {
  pluck: { a: 0.002, d: 0.12, s: 0, r: 0.03 },
  organ: { a: 0.004, d: 0.06, s: 0.88, r: 0.05 },
  pad: { a: 0.03, d: 0.3, s: 0.7, r: 0.15 },
  hit: { a: 0.001, d: 0.06, s: 0, r: 0.02 },
  hold: { a: 0.005, d: 0.05, s: 1, r: 0.04 },
} satisfies Record<string, Env>;

/**
 * Schedules an ADSR on `p` (a gain param). The voice holds for `dur` then
 * releases. Values are computed analytically so the release always starts
 * from the true level (no cancelAndHold, which Firefox lacks).
 */
export function envelope(p: AudioParam, t: number, dur: number, e: Env, peak: number): number {
  if (!fin(t)) return 0;
  if (!fin(dur)) dur = 0;
  if (!fin(peak)) peak = 0;
  const a = fin(e.a) ? Math.max(0.001, e.a) : 0.001;
  const tau = fin(e.d) ? Math.max(0.002, e.d / 3) : 0.002;
  const r = fin(e.r) ? Math.max(0.006, e.r) : 0.006;
  const sus = (fin(e.s) ? e.s : 0) * peak;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  const rel = t + Math.max(dur, a);
  let v = peak;
  if (rel > t + a) {
    p.setTargetAtTime(sus, t + a, tau);
    v = sus + (peak - sus) * Math.exp(-(rel - t - a) / tau);
  }
  p.setValueAtTime(v, rel);
  p.linearRampToValueAtTime(0, rel + r);
  return rel + r;
}

interface FilterOpts {
  type: BiquadFilterType;
  f: number;
  q?: number;
  /** sweep the cutoff to `to` over `time` (exponential) */
  to?: number;
  time?: number;
  /** optional third point: after the sweep, settle to `settle` over `settleTime` */
  settle?: number;
  settleTime?: number;
}

function makeFilter(core: AudioCore, t: number, o: FilterOpts): BiquadFilterNode {
  const f = core.ctx.createBiquadFilter();
  f.type = o.type;
  f.Q.value = fin(o.q) ? o.q : 0.7;
  f.frequency.setValueAtTime(o.f, t);
  if (fin(o.to)) {
    const t1 = t + (fin(o.time) ? o.time : 0.1);
    f.frequency.exponentialRampToValueAtTime(expTo(o.to, 20), t1);
    if (fin(o.settle)) f.frequency.exponentialRampToValueAtTime(expTo(o.settle, 20), t1 + (fin(o.settleTime) ? o.settleTime : 0.2));
  }
  return f;
}

/** Wire `node` through optional filters/panner into `dest`. */
function chain(core: AudioCore, t: number, node: AudioNode, dest: AudioNode, filters: FilterOpts[], pan?: number): void {
  let n = node;
  for (const fo of filters) if (fin(fo.f)) n = n.connect(makeFilter(core, t, fo));
  if (pan && fin(pan)) {
    const p = core.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    n = n.connect(p);
  }
  n.connect(dest);
}

interface ToneOpts {
  t: number;
  f: number;
  dur: number; // gate length before release
  wave: WaveName;
  vol: number;
  dest: AudioNode;
  env?: Env;
  /** glide from f to `to` over `time` s (exponential unless lin) */
  sweep?: { to: number; time: number; lin?: boolean; delay?: number };
  /** explicit pitch points [offset s, Hz], exponential between them */
  pitch?: [number, number][];
  vib?: { rate: number; depth: number; delay?: number }; // depth in cents
  detune?: number; // cents
  filters?: FilterOpts[];
  pan?: number;
  /** extra send into the echo bus */
  echo?: number;
  leslie?: boolean;
}

export function tone(core: AudioCore, o: ToneOpts): number {
  if (!fin(o.t) || !fin(o.f) || !fin(o.dur) || !fin(o.vol)) return fin(o.t) ? o.t : 0;
  const ctx = core.ctx;
  const osc = ctx.createOscillator();
  const w = o.wave;
  if (w === 'tri') osc.type = 'triangle';
  else if (w === 'sine' || w === 'saw' || w === 'square') osc.type = w === 'saw' ? 'sawtooth' : w;
  else osc.setPeriodicWave(core.waves[w]);
  osc.frequency.setValueAtTime(o.f, o.t);
  if (o.sweep && fin(o.sweep.to) && fin(o.sweep.time)) {
    const delay = fin(o.sweep.delay) ? o.sweep.delay : 0;
    const t0 = o.t + delay;
    if (delay) osc.frequency.setValueAtTime(o.f, t0);
    if (o.sweep.lin) osc.frequency.linearRampToValueAtTime(o.sweep.to, t0 + o.sweep.time);
    else osc.frequency.exponentialRampToValueAtTime(expTo(o.sweep.to, 1), t0 + o.sweep.time);
  }
  if (o.pitch) for (const [dt, hz] of o.pitch) if (fin(dt) && fin(hz)) osc.frequency.exponentialRampToValueAtTime(expTo(hz, 1), o.t + dt);
  if (o.detune && fin(o.detune)) osc.detune.value = o.detune;
  if (o.leslie) {
    // the shared rotor LFO would otherwise keep every finished organ voice alive
    core.leslieDetune.connect(osc.detune);
    osc.onended = () => core.leslieDetune.disconnect(osc.detune);
  }

  const g = ctx.createGain();
  const end = envelope(g.gain, o.t, o.dur, o.env ?? ENV.hold, o.vol);
  osc.connect(g);

  let lfo: OscillatorNode | null = null;
  if (o.vib && fin(o.vib.rate) && fin(o.vib.depth)) {
    lfo = ctx.createOscillator();
    lfo.frequency.value = o.vib.rate;
    const depth = ctx.createGain();
    const d0 = o.t + (fin(o.vib.delay) ? o.vib.delay : 0);
    depth.gain.setValueAtTime(0, o.t);
    depth.gain.setValueAtTime(0, d0);
    // delayed vibrato fades in, the classic SNES lead mannerism
    depth.gain.linearRampToValueAtTime(o.vib.depth, d0 + 0.12);
    lfo.connect(depth).connect(osc.detune);
    lfo.start(o.t);
    lfo.stop(end);
  }
  chain(core, o.t, g, o.dest, o.filters ?? [], o.pan);
  if (o.echo && fin(o.echo)) {
    const s = ctx.createGain();
    s.gain.value = o.echo;
    g.connect(s).connect(core.echoIn);
  }
  osc.start(o.t);
  osc.stop(end + 0.01);
  return end;
}

interface NoiseOpts {
  t: number;
  dur: number;
  vol: number;
  dest: AudioNode;
  buf?: NoiseName;
  rate?: number; // playbackRate (pitch of LFSR noise)
  rateTo?: number;
  env?: Env;
  filters?: FilterOpts[];
  pan?: number;
  echo?: number;
  /** amplitude modulation (rattle): square-ish LFO at `rate` Hz, depth 0..1 */
  am?: { rate: number; depth: number };
}

export function noise(core: AudioCore, o: NoiseOpts): number {
  if (!fin(o.t) || !fin(o.dur) || !fin(o.vol)) return fin(o.t) ? o.t : 0;
  const ctx = core.ctx;
  const src = ctx.createBufferSource();
  const buf = core.noise[o.buf ?? 'white'];
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.setValueAtTime(fin(o.rate) ? o.rate : 1, o.t);
  if (fin(o.rateTo)) src.playbackRate.exponentialRampToValueAtTime(expTo(o.rateTo, 1e-4), o.t + o.dur);
  const g = ctx.createGain();
  const end = envelope(g.gain, o.t, o.dur, o.env ?? ENV.hit, o.vol);
  src.connect(g);
  let out: AudioNode = g;
  if (o.am && fin(o.am.rate) && fin(o.am.depth)) {
    const amg = ctx.createGain();
    amg.gain.value = 1 - o.am.depth / 2;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = o.am.rate;
    const d = ctx.createGain();
    d.gain.value = o.am.depth / 2;
    lfo.connect(d).connect(amg.gain);
    lfo.start(o.t);
    lfo.stop(end);
    out = g.connect(amg);
  }
  chain(core, o.t, out, o.dest, o.filters ?? [], o.pan);
  if (o.echo && fin(o.echo)) {
    const s = ctx.createGain();
    s.gain.value = o.echo;
    out.connect(s).connect(core.echoIn);
  }
  // random start offset so repeated hits don't sound identical
  src.start(o.t, core.random() * (buf.duration * 0.9));
  src.stop(end + 0.01);
  return end;
}

// ------------------------------------------------------------ instruments --
// Music instruments: (core, dest, t, freq, dur, vel) -> end time.

type Instrument = (core: AudioCore, dest: AudioNode, t: number, f: number, dur: number, vel: number) => number;

export const INSTRUMENTS = {
  /** Arena organ lead: drawbar wave, two detuned ranks, 16' sub, percussion pop, key click. */
  organ(core, dest, t, f, dur, vel) {
    const v = 0.16 * vel;
    let end = tone(core, { t, f, dur, wave: 'organ', vol: v, env: ENV.organ, detune: -5, dest, leslie: true });
    tone(core, { t, f, dur, wave: 'organ', vol: v * 0.8, env: ENV.organ, detune: 6, dest, leslie: true });
    tone(core, { t, f: f / 2, dur, wave: 'sine', vol: v * 0.55, env: ENV.organ, dest });
    // 2nd-harmonic percussion: the "pop" that makes fast organ riffs speak
    end = Math.max(end, tone(core, { t, f: f * 2, dur: 0.01, wave: 'sine', vol: v * 0.5, env: { a: 0.002, d: 0.18, s: 0, r: 0.05 }, dest }));
    noise(core, { t, dur: 0.004, vol: v * 0.25, dest, env: { a: 0.001, d: 0.006, s: 0, r: 0.004 }, filters: [{ type: 'bandpass', f: 3000, q: 0.8 }] });
    return end;
  },
  /** Organ comping chords: same registration, softer, no percussion. */
  organChord(core, dest, t, f, dur, vel) {
    const v = 0.075 * vel;
    tone(core, { t, f, dur, wave: 'organ', vol: v, env: ENV.organ, detune: -4, dest, leslie: true });
    return tone(core, { t, f, dur, wave: 'organ', vol: v * 0.7, env: ENV.organ, detune: 5, dest, leslie: true });
  },
  /** SNES-ish brass: 25% pulse through a lowpass that opens on the attack, slight scoop. */
  brass(core, dest, t, f, dur, vel) {
    const v = 0.1 * vel;
    tone(core, { t, f: f * 0.985, dur, wave: 'p25', vol: v, env: { a: 0.015, d: 0.2, s: 0.75, r: 0.08 }, detune: -6, dest, sweep: { to: f, time: 0.045 }, filters: [{ type: 'lowpass', f: 700, q: 2, to: 3600, time: 0.05, settle: 1800, settleTime: 0.25 }] });
    return tone(core, { t, f, dur, wave: 'p50', vol: v * 0.6, env: { a: 0.02, d: 0.2, s: 0.75, r: 0.08 }, detune: 7, dest, filters: [{ type: 'lowpass', f: 600, q: 1, to: 2600, time: 0.06, settle: 1400, settleTime: 0.25 }] });
  },
  /** Sparkly 12.5% pluck for arpeggios. */
  sparkle(core, dest, t, f, dur, vel) {
    return tone(core, { t, f, dur: Math.min(dur, 0.05), wave: 'p125', vol: 0.06 * vel, env: { a: 0.002, d: 0.14, s: 0.15, r: 0.05 }, dest });
  },
  /** 25% pulse lead with delayed vibrato. */
  lead(core, dest, t, f, dur, vel) {
    return tone(core, { t, f, dur, wave: 'p25', vol: 0.11 * vel, env: { a: 0.006, d: 0.25, s: 0.7, r: 0.08 }, dest, vib: { rate: 5.8, depth: 14, delay: 0.18 }, filters: [{ type: 'lowpass', f: 5200 }] });
  },
  /** Mellow intermission lead: 50% pulse, lowpassed, slow vibrato, extra echo. */
  softLead(core, dest, t, f, dur, vel) {
    return tone(core, { t, f, dur, wave: 'p50', vol: 0.12 * vel, env: { a: 0.02, d: 0.4, s: 0.6, r: 0.18 }, dest, vib: { rate: 5.2, depth: 16, delay: 0.25 }, filters: [{ type: 'lowpass', f: 1900, q: 0.8 }], echo: 0.25 });
  },
  /** Rhodes-like comping: 25% pulse + sine, quick decay. */
  epiano(core, dest, t, f, dur, vel) {
    const v = 0.06 * vel;
    tone(core, { t, f, dur, wave: 'sine', vol: v, env: { a: 0.004, d: 0.9, s: 0.3, r: 0.2 }, dest });
    return tone(core, { t, f, dur, wave: 'p25', vol: v * 0.6, env: { a: 0.003, d: 0.35, s: 0.12, r: 0.15 }, dest, filters: [{ type: 'lowpass', f: 1600, q: 0.6 }] });
  },
  /**
   * Bass: a triangle body plus a 25% pulse "growl" lowpassed at 1.3 kHz. The
   * pulse's harmonics (2f..8f, 130-1000 Hz) are what a laptop speaker plays,
   * so the line still walks where the fundamental is gone; the triangle
   * keeps the warmth on headphones. Lines are written C2 (65 Hz) and up;
   * anything lower is folded up an octave rather than feeding the master
   * compressor sub it can't use.
   */
  bass(core, dest, t, f, dur, vel) {
    if (f < 65) f *= 2;
    const v = 0.22 * vel;
    const end = tone(core, { t, f, dur, wave: 'tri', vol: v * 0.5, env: { a: 0.003, d: 0.25, s: 0.75, r: 0.05 }, dest });
    tone(core, { t, f, dur, wave: 'p125', vol: v * 0.75, env: { a: 0.002, d: 0.2, s: 0.65, r: 0.04 }, dest, filters: [{ type: 'highpass', f: 70, q: 0.7 }, { type: 'lowpass', f: 1400, q: 0.7 }] });
    return end;
  },
  /** Sad trombone: 50% pulse with a "wah" filter on every note and a lazy vibrato. */
  trombone(core, dest, t, f, dur, vel) {
    return tone(core, { t, dur, wave: 'p50', vol: 0.15 * vel, env: { a: 0.03, d: 0.3, s: 0.8, r: 0.12 }, dest, f: f * 0.97, sweep: { to: f, time: 0.06 }, vib: { rate: 4.6, depth: 32, delay: 0.25 }, filters: [{ type: 'lowpass', f: 320, q: 4, to: 1500, time: 0.12, settle: 650, settleTime: Math.max(0.2, dur) }] });
  },
} satisfies Record<string, Instrument>;

export type InstrumentName = keyof typeof INSTRUMENTS;

// ------------------------------------------------------------- drum kit ----

type DrumHit = (core: AudioCore, dest: AudioNode, t: number, vel: number) => number;

export const DRUMS: Record<string, DrumHit> = {
  // kick: sine drop 170 -> 55 Hz plus a 2.6 kHz beater click, so the beat
  // still reads on speakers that can't move air at 55 Hz
  k(core, dest, t, vel) {
    noise(core, { t, dur: 0.003, vol: 0.28 * vel, dest, env: { a: 0.001, d: 0.012, s: 0, r: 0.005 }, filters: [{ type: 'bandpass', f: 2600, q: 0.9 }] });
    tone(core, { t, f: 2600, dur: 0.002, wave: 'tri', vol: 0.12 * vel, env: { a: 0.0005, d: 0.01, s: 0, r: 0.004 }, dest, sweep: { to: 1400, time: 0.01 } });
    return tone(core, { t, f: 170, dur: 0.02, wave: 'sine', vol: 0.36 * vel, env: { a: 0.001, d: 0.18, s: 0, r: 0.05 }, dest, sweep: { to: 55, time: 0.09 } });
  },
  // snare: band-passed noise + triangle body
  s(core, dest, t, vel) {
    tone(core, { t, f: 200, dur: 0.01, wave: 'tri', vol: 0.22 * vel, env: { a: 0.001, d: 0.08, s: 0, r: 0.02 }, dest, sweep: { to: 140, time: 0.06 } });
    return noise(core, { t, dur: 0.02, vol: 0.2 * vel, dest, buf: 'lfsr', rate: 0.9, env: { a: 0.001, d: 0.16, s: 0, r: 0.04 }, filters: [{ type: 'bandpass', f: 1900, q: 0.7 }] });
  },
  // hand clap: three quick bursts then a short tail
  c(core, dest, t, vel) {
    let end = t;
    for (let i = 0; i < 3; i++) end = noise(core, { t: t + i * 0.011, dur: 0.003, vol: 0.18 * vel, dest, env: { a: 0.001, d: 0.012, s: 0, r: 0.005 }, filters: [{ type: 'bandpass', f: 1250, q: 1.4 }] });
    return Math.max(end, noise(core, { t: t + 0.033, dur: 0.01, vol: 0.16 * vel, dest, env: { a: 0.001, d: 0.12, s: 0, r: 0.03 }, filters: [{ type: 'bandpass', f: 1100, q: 1.1 }] }));
  },
  // closed hat: metallic LFSR noise, highpassed
  h(core, dest, t, vel) {
    return noise(core, { t, dur: 0.005, vol: 0.07 * vel, dest, buf: 'metal', rate: 1.6, env: { a: 0.001, d: 0.04, s: 0, r: 0.01 }, filters: [{ type: 'highpass', f: 6500 }] });
  },
  // open hat
  o(core, dest, t, vel) {
    return noise(core, { t, dur: 0.02, vol: 0.06 * vel, dest, buf: 'metal', rate: 1.6, env: { a: 0.001, d: 0.3, s: 0, r: 0.05 }, filters: [{ type: 'highpass', f: 6000 }] });
  },
  // crash cymbal
  x(core, dest, t, vel) {
    noise(core, { t, dur: 0.02, vol: 0.06 * vel, dest, buf: 'metal', rate: 1.1, env: { a: 0.001, d: 1.1, s: 0, r: 0.2 }, filters: [{ type: 'highpass', f: 4200 }] });
    return noise(core, { t, dur: 0.02, vol: 0.09 * vel, dest, env: { a: 0.001, d: 1.3, s: 0, r: 0.3 }, filters: [{ type: 'highpass', f: 5000 }] });
  },
  // rim click
  r(core, dest, t, vel) {
    return tone(core, { t, f: 1700, dur: 0.003, wave: 'tri', vol: 0.12 * vel, env: { a: 0.001, d: 0.025, s: 0, r: 0.01 }, dest, filters: [{ type: 'bandpass', f: 1800, q: 2 }] });
  },
  // low tom
  t(core, dest, t, vel) {
    return tone(core, { t, f: 190, dur: 0.02, wave: 'sine', vol: 0.32 * vel, env: { a: 0.001, d: 0.25, s: 0, r: 0.05 }, dest, sweep: { to: 110, time: 0.18 } });
  },
  // crowd "HEY!" shout (used by stingers)
  H(core, dest, t, vel) {
    return crowdShout(core, dest, t, vel, 'hey');
  },
  // crowd "CHARGE!" (end of the charge stinger)
  Y(core, dest, t, vel) {
    return crowdShout(core, dest, t, vel, 'charge');
  },
};

// ---------------------------------------------------------- crowd voices ----

/** Vowel formants (F1, F2) for crowd voice clusters. */
const VOWELS = {
  oo: [320, 800],
  aw: [620, 1000],
  ah: [750, 1250],
  eh: [550, 1850],
  ae: [680, 1700],
} as const;
type Vowel = keyof typeof VOWELS;

interface CrowdVoiceOpts {
  t: number;
  dur: number;
  vol: number;
  dest: AudioNode;
  vowel: Vowel;
  voices?: number;
  f0?: number; // center pitch of the crowd
  /** pitch contour multipliers over the duration [fraction 0..1, mult] */
  contour?: [number, number][];
  env?: Env;
  breath?: number; // noise layer amount (a crowd is mostly breath: ~0.8-1)
  /** max onset scatter (s); default min(0.25, 0.15 * dur), so short shouts stay tight */
  jitter?: number;
}

/** voiced level relative to the breath (people in a crowd don't sing in tune) */
const CROWD_VOICED = 0.6;
/**
 * Breath noise make-up: white noise through the formant bandpasses keeps a
 * few % of its power, a voice's harmonic sitting in a formant keeps nearly
 * all of it, so `breath: 1` has to be this much louder to weigh as much.
 */
const CROWD_BREATH = 4.5;

/**
 * A crowd singing/shouting a vowel: a cluster of loose voices at scattered
 * pitches through two broad formant bandpasses, over a lot of breath noise.
 * Pitch contours sell the emotion (ooh rises then falls, aww falls). What
 * keeps it a crowd and not a kazoo choir: breath-heavy, voices entering at
 * different times (onset scatter), each on its own contour timing (+-25%)
 * and with its own vibrato (15-60 cents at 3.5-7.5 Hz), broad formants.
 */
export function crowdVoices(core: AudioCore, o: CrowdVoiceOpts): number {
  const ctx = core.ctx;
  const [f1, f2] = VOWELS[o.vowel];
  const bus = ctx.createGain();
  bus.gain.value = 1;
  const fa = ctx.createBiquadFilter();
  fa.type = 'bandpass';
  fa.frequency.value = f1;
  fa.Q.value = 1.8;
  const fb = ctx.createBiquadFilter();
  fb.type = 'bandpass';
  fb.frequency.value = f2;
  fb.Q.value = 2.5;
  const fbGain = ctx.createGain();
  fbGain.gain.value = 0.6;
  bus.connect(fa).connect(o.dest);
  bus.connect(fb).connect(fbGain).connect(o.dest);
  const env = o.env ?? { a: 0.15, d: o.dur, s: 0.6, r: 0.4 };
  const n = o.voices ?? 7;
  const f0 = o.f0 ?? 240;
  const scatter = fin(o.jitter) ? Math.max(0, o.jitter) : Math.min(0.25, 0.15 * o.dur);
  let end = o.t;
  for (let i = 0; i < n; i++) {
    const spread = 0.7 + core.random() * 0.75;
    const f = f0 * spread;
    const jitter = core.random() * scatter;
    // each voice runs the contour on its own clock (+-25%)
    const pace = 0.75 + core.random() * 0.5;
    const pitch: [number, number][] = (o.contour ?? [[1, 1]]).map(([fr, m]) => [Math.max(0.01, fr * o.dur * pace), f * m]);
    end = Math.max(
      end,
      tone(core, {
        t: o.t + jitter,
        f,
        dur: o.dur,
        wave: i % 2 ? 'saw' : 'p25',
        vol: (o.vol / Math.sqrt(n)) * 2.2 * CROWD_VOICED,
        env,
        dest: bus,
        pitch,
        vib: { rate: 3.5 + core.random() * 4, depth: 15 + core.random() * 45 },
        pan: (core.random() - 0.5) * 1.2,
      }),
    );
  }
  if (o.breath) {
    // two breath layers, spread left and right
    for (const pan of [-0.45, 0.45]) {
      end = Math.max(end, noise(core, { t: o.t, dur: o.dur, vol: (o.vol * o.breath * CROWD_BREATH) / Math.SQRT2, dest: bus, env, pan }));
    }
  }
  return end;
}

/** One short crowd shout ("HEY!" / "CHARGE!"). */
function crowdShout(core: AudioCore, dest: AudioNode, t: number, vel: number, word: 'hey' | 'charge'): number {
  if (word === 'hey') {
    return crowdVoices(core, { t, dur: 0.16, vol: 0.2 * vel, dest, vowel: 'eh', voices: 8, f0: 300, contour: [[0.3, 1.08], [1, 0.9]], env: { a: 0.02, d: 0.25, s: 0.4, r: 0.12 }, breath: 0.5 });
  }
  // "CHAR-": breathy onset then 'ah' with a falling pitch, "-GE" as a short buzz
  noise(core, { t, dur: 0.06, vol: 0.12 * vel, dest, env: { a: 0.005, d: 0.06, s: 0.3, r: 0.03 }, filters: [{ type: 'bandpass', f: 2600, q: 1.2 }] });
  return crowdVoices(core, { t: t + 0.04, dur: 0.38, vol: 0.22 * vel, dest, vowel: 'ah', voices: 9, f0: 290, contour: [[0.2, 1.1], [1, 0.82]], env: { a: 0.03, d: 0.4, s: 0.5, r: 0.15 }, breath: 0.4 });
}
