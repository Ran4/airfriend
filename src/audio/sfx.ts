// Sound effects. Each recipe layers a few oscillator/noise voices the way an
// SPC700 sound designer would layer short samples: a transient, a body and a
// tail. Recipes take an absolute start time and return their end time.

import type { AudioCore } from './core';
import { noise, tone } from './synth';

export interface SfxParams {
  vol?: number; // 0..1 intensity (speed / force / power), default 1
  pan?: number; // -1..1
  good?: boolean; // home-team flavor (steal blips go up, not down)
}

type Recipe = (core: AudioCore, t: number, v: number, pan: number, p: SfxParams, d: AudioNode) => number;

/** 0..1, and 0 for NaN (Math.min/max pass NaN straight through) */
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : x === Infinity ? 1 : 0);

/** Ref's pea whistle: a sine with the pea's rattle as fast FM + AM, plus breath. */
function whistleBlast(core: AudioCore, d: AudioNode, t: number, f: number, dur: number, vol: number, pan: number): number {
  const ctx = core.ctx;
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(f * 0.96, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.02);
  const amp = ctx.createGain();
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vol, t + 0.012);
  env.gain.setValueAtTime(vol, t + dur);
  env.gain.linearRampToValueAtTime(0, t + dur + 0.03);
  const rattle = ctx.createOscillator();
  rattle.type = 'triangle';
  rattle.frequency.value = 27 + core.random() * 4;
  const fm = ctx.createGain();
  fm.gain.value = f * 0.035;
  const am = ctx.createGain();
  am.gain.value = 0.3;
  amp.gain.value = 0.7;
  rattle.connect(fm).connect(osc.frequency);
  rattle.connect(am).connect(amp.gain);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  osc.connect(amp).connect(env).connect(p).connect(d);
  const send = ctx.createGain();
  send.gain.value = 0.1;
  env.connect(send).connect(core.echoIn);
  const end = t + dur + 0.04;
  osc.start(t);
  rattle.start(t);
  osc.stop(end);
  rattle.stop(end);
  noise(core, { t, dur, vol: vol * 0.25, dest: d, env: { a: 0.01, d: dur, s: 0.6, r: 0.03 }, filters: [{ type: 'bandpass', f: f * 1.1, q: 2 }], pan });
  return end;
}

/**
 * One ~60 ms chirp of PAL's "yip": a 25% pulse that flicks up and back down
 * around `f` through a single nasal formant, with a little dry body.
 */
function yipChirp(core: AudioCore, d: AudioNode, t: number, f: number, vol: number, pan: number): number {
  const ctx = core.ctx;
  const end = t + 0.065;
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(core.waves.p25);
  osc.frequency.setValueAtTime(f * 0.86, t);
  osc.frequency.exponentialRampToValueAtTime(f * 1.08, t + 0.014);
  osc.frequency.exponentialRampToValueAtTime(f * 0.9, t + 0.055);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vol, t + 0.004);
  env.gain.setTargetAtTime(vol * 0.55, t + 0.012, 0.015);
  env.gain.setValueAtTime(vol * 0.5, t + 0.045);
  env.gain.linearRampToValueAtTime(0, t + 0.06);
  osc.connect(env);
  const out = ctx.createStereoPanner();
  out.pan.value = pan;
  out.connect(d);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 4;
  bp.frequency.setValueAtTime(f * 2.1, t);
  bp.frequency.exponentialRampToValueAtTime(f * 1.7, t + 0.055);
  const fg = ctx.createGain();
  fg.gain.value = 1.3;
  env.connect(bp).connect(fg).connect(out);
  const body = ctx.createGain();
  body.gain.value = 0.25;
  env.connect(body).connect(out);
  const send = ctx.createGain();
  send.gain.value = 0.06;
  out.connect(send).connect(core.echoIn);
  osc.start(t);
  osc.stop(end);
  return end;
}

// ------------------------------------------------------------------ bark --
// A bichon's bark is a yip, not a beep: a hard onset that decays straight
// away (no held level), a pitch flick, vocal-fold roughness (the ~80 Hz AM)
// and breath in the formants. Three variants rotate so a run of barks
// doesn't sound like one sample on repeat.

export type BarkVariant = 'arf' | 'yip' | 'ruff';
export const BARK_VARIANTS: readonly BarkVariant[] = ['arf', 'yip', 'ruff'];

interface BarkShape {
  /** pitch multiplier on the arf's 780 -> 930 -> 560 Hz contour */
  k: number;
  /** total length (s) and decay time constant (s) after the 6 ms peak */
  len: number;
  tau: number;
  /** formants: [from, to] Hz (each variant has its own mouth shape) */
  f1: [number, number];
  f2: [number, number];
  /** roughness: AM rate (Hz) and depth (gain swings 1 - depth .. 1) */
  am: number;
  amDepth: number;
  /** breath noise share (of the pulse's level) through the formants */
  breath: number;
  peak: number;
}

const BARKS: Record<BarkVariant, BarkShape> = {
  // the house bark: "arf!"
  arf: { k: 1, len: 0.125, tau: 0.035, f1: [1150, 780], f2: [2300, 1500], am: 80, amDepth: 0.3, breath: 0.28, peak: 0.62 },
  // a fifth up, tighter: "yip!"
  yip: { k: 1.5, len: 0.115, tau: 0.03, f1: [1400, 1050], f2: [2700, 2000], am: 85, amDepth: 0.25, breath: 0.25, peak: 0.55 },
  // shorter, lower, rougher: "ruff"
  ruff: { k: 0.72, len: 0.11, tau: 0.032, f1: [900, 640], f2: [1900, 1300], am: 72, amDepth: 0.4, breath: 0.3, peak: 0.68 },
};

/** last variant per engine (a WeakMap: test renders each get their own) */
const lastBark = new WeakMap<AudioCore, BarkVariant>();

/** the next bark: either variant that isn't the last one */
function nextBark(c: AudioCore): BarkVariant {
  const last = lastBark.get(c);
  const pool = BARK_VARIANTS.filter((b) => b !== last);
  const pick = pool[Math.min(pool.length - 1, Math.floor(c.random() * pool.length))];
  lastBark.set(c, pick);
  return pick;
}

/**
 * One bark. Pulse + formant-filtered breath noise share an envelope that
 * peaks at 6 ms and then only decays (setTargetAtTime toward 0), so there is
 * no plateau; the pulse's dry body is lowpassed at 1.5 kHz so the buzz
 * stays in the chest. Pitch is randomized +-10% per bark.
 */
export function barkVoice(c: AudioCore, d: AudioNode, t: number, v: number, pan: number, variant: BarkVariant): number {
  const ctx = c.ctx;
  const b = BARKS[variant] ?? BARKS.arf;
  const k = b.k * (0.9 + c.random() * 0.2);
  // formants follow the random part of the pitch only halfway (same dog, other mood)
  const fk = Math.sqrt(k / b.k);
  const end = t + b.len;
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(c.waves.p25);
  // a quick flick up (peaking with the envelope, so the formants ring at
  // once and the level never builds after the onset), then down
  osc.frequency.setValueAtTime(780 * k, t);
  osc.frequency.exponentialRampToValueAtTime(930 * k, t + 0.01);
  osc.frequency.exponentialRampToValueAtTime(560 * k, end);
  // breath: white noise at a random offset, riding the same envelope
  const br = ctx.createBufferSource();
  br.buffer = c.noise.white;
  br.loop = true;
  const brg = ctx.createGain();
  brg.gain.value = b.breath;
  // roughness: an ~80 Hz wobble on the level (gain 1 - depth .. 1)
  const rough = ctx.createGain();
  rough.gain.value = 1 - b.amDepth / 2;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = b.am * (0.95 + c.random() * 0.1);
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = b.amDepth / 2;
  lfo.connect(lfoDepth).connect(rough.gain);
  // envelope: 6 ms attack, then a pure decay; the last 10 ms close it out
  const peak = b.peak * v;
  const env = ctx.createGain();
  const tp = t + 0.006;
  const tz = end - 0.01;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, tp);
  env.gain.setTargetAtTime(0, tp, b.tau);
  env.gain.setValueAtTime(peak * Math.exp(-(tz - tp) / b.tau), tz);
  env.gain.linearRampToValueAtTime(0, end);
  osc.connect(rough);
  br.connect(brg).connect(rough);
  rough.connect(env);
  const out = ctx.createStereoPanner();
  out.pan.value = pan;
  out.connect(d);
  const send = ctx.createGain();
  send.gain.value = 0.1;
  out.connect(send).connect(c.echoIn);
  // "a" -> "r": both formants fall (the r colouring)
  const formant = (f: [number, number], q: number, g: number) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(f[0] * fk, t);
    bp.frequency.exponentialRampToValueAtTime(f[1] * fk, end);
    const gg = ctx.createGain();
    gg.gain.value = g;
    env.connect(bp).connect(gg).connect(out);
  };
  formant(b.f1, 3, 1.4);
  formant(b.f2, 5, 0.9);
  // dry body, lowpassed: warmth without the buzzer edge
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1500;
  lp.Q.value = 0.6;
  const body = ctx.createGain();
  body.gain.value = 0.2;
  env.connect(lp).connect(body).connect(out);
  osc.start(t);
  lfo.start(t);
  br.start(t, c.random() * (c.noise.white.duration * 0.9));
  for (const s of [osc, lfo, br]) s.stop(end + 0.005);
  // breathy onset ("h")
  noise(c, { t, dur: 0.015, vol: 0.08 * v, dest: d, env: { a: 0.002, d: 0.025, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 1800 * fk, q: 1 }], pan });
  return end;
}

/** Goal / period horn: a big detuned buzzy chord with the pitch sag of a real air horn. */
function horn(core: AudioCore, d: AudioNode, t: number, notes: number[], dur: number, vol: number): number {
  let end = t;
  for (const f of notes) {
    for (const [wave, det] of [
      ['p50', -9],
      ['saw', 8],
    ] as const) {
      end = tone(core, {
        t,
        f: f * 0.955,
        dur,
        wave,
        vol: vol / notes.length,
        dest: d,
        detune: det,
        sweep: { to: f, time: 0.18 },
        env: { a: 0.07, d: 0.4, s: 0.85, r: 0.35 },
        vib: { rate: 5.5, depth: 6 },
        filters: [{ type: 'lowpass', f: 900, q: 1.5, to: 2200, time: 0.15 }],
        echo: 0.12,
        pan: det < 0 ? -0.25 : 0.25,
      });
    }
  }
  return end;
}

export const SFX = {
  // puck onto the blade: a woody "tok" and a softer second tap. The body is
  // a short round triangle (~60 ms, 1 kHz falling) rather than a louder
  // click, so it carries over the crowd bed without turning sharp.
  pickup(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.004, vol: 0.16 * v, dest: d, env: { a: 0.001, d: 0.03, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 2100, q: 2 }], pan });
    tone(c, { t, f: 1050, dur: 0.035, wave: 'tri', vol: 0.12 * v, dest: d, env: { a: 0.002, d: 0.09, s: 0, r: 0.02 }, sweep: { to: 820, time: 0.05 }, pan });
    noise(c, { t: t + 0.055, dur: 0.003, vol: 0.1 * v, dest: d, env: { a: 0.001, d: 0.02, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 1800, q: 2 }], pan });
    return tone(c, { t: t + 0.055, f: 860, dur: 0.025, wave: 'tri', vol: 0.08 * v, dest: d, env: { a: 0.002, d: 0.07, s: 0, r: 0.02 }, sweep: { to: 700, time: 0.04 }, pan });
  },
  // stick slap + swish
  pass(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.004, vol: 0.28 * v, dest: d, env: { a: 0.001, d: 0.04, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 1800, q: 1.6 }], pan });
    tone(c, { t, f: 620, dur: 0.01, wave: 'tri', vol: 0.14 * v, dest: d, env: { a: 0.001, d: 0.05, s: 0, r: 0.01 }, sweep: { to: 300, time: 0.05 }, pan });
    return noise(c, { t: t + 0.01, dur: 0.1, vol: 0.06 * v, dest: d, env: { a: 0.02, d: 0.1, s: 0.2, r: 0.04 }, filters: [{ type: 'bandpass', f: 2000, q: 1.2, to: 5000, time: 0.12 }], pan });
  },
  // soft "tuk" of a pass landing on the blade
  receive(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.004, vol: 0.2 * v, dest: d, env: { a: 0.001, d: 0.03, s: 0, r: 0.01 }, filters: [{ type: 'lowpass', f: 1300 }], pan });
    return tone(c, { t, f: 520, dur: 0.01, wave: 'tri', vol: 0.1 * v, dest: d, env: { a: 0.001, d: 0.04, s: 0, r: 0.01 }, pan });
  },
  // slap shot: crack + wood clack + low thump, whoosh and boom scale with power
  shot(c, t, v, pan, p, d) {
    const pw = clamp01(v);
    noise(c, { t, dur: 0.006, vol: 0.18 + 0.45 * pw, dest: d, env: { a: 0.001, d: 0.05 + 0.05 * pw, s: 0, r: 0.01 }, filters: [{ type: 'highpass', f: 1500 }, { type: 'lowpass', f: 7000 }], pan, echo: 0.15 });
    tone(c, { t, f: 1150, dur: 0.008, wave: 'tri', vol: 0.12, dest: d, env: { a: 0.001, d: 0.04, s: 0, r: 0.01 }, sweep: { to: 700, time: 0.04 }, pan });
    let end = tone(c, { t, f: 150, dur: 0.01, wave: 'sine', vol: 0.1 + 0.26 * pw, dest: d, env: { a: 0.001, d: 0.13, s: 0, r: 0.03 }, sweep: { to: 45, time: 0.1 }, pan });
    if (pw > 0.3) end = Math.max(end, noise(c, { t: t + 0.01, dur: 0.18, vol: 0.1 * pw, dest: d, env: { a: 0.01, d: 0.25, s: 0.2, r: 0.08 }, filters: [{ type: 'bandpass', f: 3200, q: 1.4, to: 1100, time: 0.28 }], pan }));
    if (pw > 0.7) end = Math.max(end, tone(c, { t, f: 85, dur: 0.02, wave: 'sine', vol: 0.22 * pw, dest: d, env: { a: 0.002, d: 0.22, s: 0, r: 0.05 }, sweep: { to: 38, time: 0.2 }, echo: 0.2 }));
    return end;
  },
  // goalie pad thud
  save(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.01, vol: 0.4 * v, dest: d, env: { a: 0.001, d: 0.1, s: 0, r: 0.02 }, filters: [{ type: 'lowpass', f: 520 }], pan });
    noise(c, { t, dur: 0.004, vol: 0.12 * v, dest: d, env: { a: 0.001, d: 0.04, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 950, q: 1.2 }], pan });
    return tone(c, { t, f: 115, dur: 0.01, wave: 'sine', vol: 0.36 * v, dest: d, env: { a: 0.001, d: 0.11, s: 0, r: 0.02 }, sweep: { to: 60, time: 0.1 }, pan });
  },
  // glove pop
  catch(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.004, vol: 0.26 * v, dest: d, env: { a: 0.001, d: 0.03, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 1400, q: 1.5 }], pan });
    noise(c, { t, dur: 0.01, vol: 0.18 * v, dest: d, env: { a: 0.001, d: 0.07, s: 0, r: 0.02 }, filters: [{ type: 'lowpass', f: 1800 }], pan });
    return tone(c, { t, f: 720, dur: 0.01, wave: 'sine', vol: 0.32 * v, dest: d, env: { a: 0.001, d: 0.06, s: 0, r: 0.02 }, sweep: { to: 180, time: 0.05 }, pan });
  },
  // "TING!": inharmonic metal-bar partials + a chip pulse + echo
  post(c, t, v, pan, p, d) {
    const f0 = 1180 * (0.97 + c.random() * 0.06);
    noise(c, { t, dur: 0.003, vol: 0.22 * v, dest: d, buf: 'metal', rate: 2.5, env: { a: 0.001, d: 0.012, s: 0, r: 0.005 }, filters: [{ type: 'highpass', f: 3500 }], pan });
    tone(c, { t, f: f0, dur: 0.01, wave: 'p125', vol: 0.06 * v, dest: d, env: { a: 0.001, d: 0.15, s: 0, r: 0.03 }, pan });
    let end = t;
    const partials: [number, number, number][] = [
      [1, 0.24, 1.3],
      [2.76, 0.12, 0.7],
      [5.4, 0.06, 0.35],
      [8.93, 0.035, 0.18],
    ];
    for (const [m, a, dec] of partials) {
      end = Math.max(end, tone(c, { t, f: f0 * m, dur: 0.005, wave: 'sine', vol: a * v, dest: d, env: { a: 0.001, d: dec, s: 0, r: 0.05 }, pan, echo: 0.35 }));
    }
    return end;
  },
  // puck into the boards: dull thud, board clack, glass buzz when hard
  boards(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.01, vol: 0.45 * v, dest: d, env: { a: 0.001, d: 0.12, s: 0, r: 0.02 }, filters: [{ type: 'lowpass', f: 300 }], pan });
    noise(c, { t, dur: 0.004, vol: 0.14 * v, dest: d, env: { a: 0.001, d: 0.05, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 720, q: 1.5 }], pan });
    let end = tone(c, { t, f: 80, dur: 0.01, wave: 'sine', vol: 0.36 * v, dest: d, env: { a: 0.001, d: 0.11, s: 0, r: 0.02 }, sweep: { to: 50, time: 0.09 }, pan });
    if (v > 0.6) end = Math.max(end, noise(c, { t, dur: 0.1, vol: 0.06 * v, dest: d, env: { a: 0.002, d: 0.15, s: 0.2, r: 0.05 }, filters: [{ type: 'bandpass', f: 2300, q: 3 }], am: { rate: 34, depth: 0.8 }, pan }));
    return end;
  },
  // body slammed into the boards: big thud + glass rattle
  bodyBoards(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.02, vol: 0.45 * v, dest: d, env: { a: 0.001, d: 0.2, s: 0, r: 0.03 }, filters: [{ type: 'lowpass', f: 420 }], pan });
    tone(c, { t, f: 62, dur: 0.02, wave: 'sine', vol: 0.45 * v, dest: d, env: { a: 0.002, d: 0.22, s: 0, r: 0.04 }, sweep: { to: 38, time: 0.2 }, pan });
    noise(c, { t, dur: 0.25 + 0.15 * v, vol: 0.2 * v, dest: d, env: { a: 0.002, d: 0.35, s: 0.3, r: 0.15 }, filters: [{ type: 'bandpass', f: 1900, q: 1.8 }], am: { rate: 27, depth: 0.85 }, pan });
    return noise(c, { t: t + 0.01, dur: 0.05, vol: 0.06 * v, dest: d, buf: 'metal', rate: 2.2, env: { a: 0.001, d: 0.35, s: 0, r: 0.08 }, filters: [{ type: 'highpass', f: 3000 }], pan, echo: 0.2 });
  },
  // puck hits the outside of the net
  netHit(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.01, vol: 0.22 * v, dest: d, env: { a: 0.002, d: 0.09, s: 0, r: 0.02 }, filters: [{ type: 'lowpass', f: 900 }], pan });
    noise(c, { t, dur: 0.02, vol: 0.06 * v, dest: d, env: { a: 0.004, d: 0.08, s: 0, r: 0.02 }, filters: [{ type: 'bandpass', f: 3200, q: 0.8 }], pan });
    return tone(c, { t, f: 410, dur: 0.01, wave: 'tri', vol: 0.06 * v, dest: d, env: { a: 0.001, d: 0.06, s: 0, r: 0.02 }, pan });
  },
  // body check crunch; heavier = longer, lower, louder
  check(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.01, vol: 0.32 * v, dest: d, buf: 'lfsr', rate: 0.45, env: { a: 0.001, d: 0.08 + 0.1 * v, s: 0, r: 0.02 }, filters: [{ type: 'bandpass', f: 750, q: 1 }], pan });
    noise(c, { t, dur: 0.004, vol: 0.18 * v, dest: d, env: { a: 0.001, d: 0.03, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 2100, q: 1.2 }], pan });
    return tone(c, { t, f: 95, dur: 0.01, wave: 'sine', vol: 0.42 * v, dest: d, env: { a: 0.001, d: 0.15, s: 0, r: 0.03 }, sweep: { to: 45, time: 0.13 }, pan });
  },
  // player hits the ice + equipment rattle
  fall(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.01, vol: 0.3 * v, dest: d, env: { a: 0.001, d: 0.12, s: 0, r: 0.02 }, filters: [{ type: 'lowpass', f: 350 }], pan });
    noise(c, { t: t + 0.03, dur: 0.06, vol: 0.06 * v, dest: d, buf: 'metal', rate: 1.3, env: { a: 0.001, d: 0.1, s: 0, r: 0.03 }, filters: [{ type: 'highpass', f: 2500 }], pan });
    return tone(c, { t, f: 75, dur: 0.01, wave: 'sine', vol: 0.3 * v, dest: d, env: { a: 0.001, d: 0.13, s: 0, r: 0.02 }, sweep: { to: 42, time: 0.12 }, pan });
  },
  // two-tone pea whistle: short "tweet", then a long lower "tweeeet"
  whistle(c, t, v, pan, p, d) {
    whistleBlast(c, d, t, 3050, 0.09, 0.16 * v, pan);
    return whistleBlast(c, d, t + 0.16, 2800, 0.42, 0.16 * v, pan);
  },
  // single long blast (stoppages, goals)
  whistleLong(c, t, v, pan, p, d) {
    return whistleBlast(c, d, t, 2850, 0.5, 0.16 * v, pan);
  },
  // goal horn: A major (A2 E3 A3 C#4 E4), the dominant of the D major fanfare
  horn(c, t, v, pan, p, d) {
    return horn(c, d, t, [110, 164.81, 220, 277.18, 329.63], 2.0, 0.42 * v);
  },
  periodHorn(c, t, v, pan, p, d) {
    return horn(c, d, t, [110, 164.81, 220, 277.18], 1.4, 0.4 * v);
  },
  // delayed penalty: the ref's arm goes up. A two-note chime ("di-DONG",
  // G4 -> C5): a triangle strike for the chip edge over a sine that rings
  // out in ~0.3 s, plus a faint octave for the bell. It sits around 520 Hz,
  // under the pickup's ~1 kHz "tok" and the stick clicks' 1.5-5 kHz, with
  // no noise in it (audio-test checks both bands stay clear).
  refArm(c, t, v, pan, p, d) {
    tone(c, { t, f: 392, dur: 0.03, wave: 'tri', vol: 0.075 * v, dest: d, env: { a: 0.002, d: 0.06, s: 0, r: 0.02 }, pan });
    tone(c, { t: t + 0.07, f: 523.25, dur: 0.02, wave: 'tri', vol: 0.045 * v, dest: d, env: { a: 0.002, d: 0.06, s: 0, r: 0.02 }, pan });
    tone(c, { t: t + 0.07, f: 1046.5, dur: 0.01, wave: 'sine', vol: 0.015 * v, dest: d, env: { a: 0.002, d: 0.1, s: 0, r: 0.02 }, pan });
    return tone(c, { t: t + 0.07, f: 523.25, dur: 0.05, wave: 'sine', vol: 0.09 * v, dest: d, env: { a: 0.003, d: 0.3, s: 0, r: 0.04 }, pan, echo: 0.15 });
  },
  // scoreboard penalty buzzer: two beating saws + a square an octave up
  buzzer(c, t, v, pan, p, d) {
    const f = [{ type: 'lowpass' as BiquadFilterType, f: 1400, q: 1 }];
    tone(c, { t, f: 110, dur: 0.55, wave: 'saw', vol: 0.13 * v, dest: d, env: { a: 0.005, d: 0.1, s: 1, r: 0.03 }, filters: f });
    tone(c, { t, f: 116.5, dur: 0.55, wave: 'saw', vol: 0.13 * v, dest: d, env: { a: 0.005, d: 0.1, s: 1, r: 0.03 }, filters: f });
    return tone(c, { t, f: 220, dur: 0.55, wave: 'p25', vol: 0.06 * v, dest: d, env: { a: 0.005, d: 0.1, s: 1, r: 0.03 }, filters: f });
  },
  // puck dropped on the ice: the cue a faceoff is a reaction test on, so a
  // sharp rubber-on-ice "clack" (bright 3-4 kHz transient, a wood click) on a
  // short 180 Hz thump that reads through the crowd bed
  faceoffDrop(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.005, vol: 0.09 * v, dest: d, env: { a: 0.001, d: 0.03, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 3500, q: 1.4 }], pan });
    tone(c, { t, f: 2300, dur: 0.004, wave: 'tri', vol: 0.025 * v, dest: d, env: { a: 0.001, d: 0.025, s: 0, r: 0.01 }, sweep: { to: 1500, time: 0.02 }, pan });
    return tone(c, { t, f: 180, dur: 0.01, wave: 'sine', vol: 0.075 * v, dest: d, env: { a: 0.001, d: 0.08, s: 0, r: 0.02 }, sweep: { to: 110, time: 0.07 }, pan });
  },
  // sticks clacking on the draw
  faceoffWin(c, t, v, pan, p, d) {
    for (const dt of [0, 0.045]) {
      noise(c, { t: t + dt, dur: 0.003, vol: 0.18 * v, dest: d, env: { a: 0.001, d: 0.03, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 2600, q: 2 }], pan });
      tone(c, { t: t + dt, f: 1350 - dt * 3000, dur: 0.005, wave: 'tri', vol: 0.08 * v, dest: d, env: { a: 0.001, d: 0.03, s: 0, r: 0.01 }, pan });
    }
    return t + 0.1;
  },
  // PAL's bark: one of three yips (see barkVoice), never the same twice running
  bark(c, t, v, pan, p, d) {
    return barkVoice(c, d, t, v, pan, nextBark(c));
  },
  // "yip-yip!": PAL calls for the puck. Two quick high chirps (higher and
  // shorter than the bark, so it never reads as one), the second a step up.
  yip(c, t, v, pan, p, d) {
    const k = 0.95 + c.random() * 0.1;
    yipChirp(c, d, t, 1150 * k, 0.4 * v, pan);
    return yipChirp(c, d, t + 0.085, 1320 * k, 0.36 * v, pan);
  },
  // a kid's "HEY!" (call for the puck): breathy "h", then an "eh" that
  // rises and falls with the F2 lifting into the "y" offglide
  hey(c, t, v, pan, p, d) {
    const ctx = c.ctx;
    const k = 0.94 + c.random() * 0.12;
    noise(c, { t, dur: 0.025, vol: 0.09 * v, dest: d, env: { a: 0.004, d: 0.03, s: 0.4, r: 0.015 }, filters: [{ type: 'bandpass', f: 2000, q: 0.9 }], pan });
    const t0 = t + 0.02;
    const end = t0 + 0.18;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(c.waves.p25);
    osc.frequency.setValueAtTime(470 * k, t0);
    osc.frequency.exponentialRampToValueAtTime(590 * k, t0 + 0.04);
    osc.frequency.exponentialRampToValueAtTime(450 * k, t0 + 0.16);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.42 * v, t0 + 0.012);
    env.gain.setTargetAtTime(0.3 * v, t0 + 0.03, 0.04);
    env.gain.setValueAtTime(0.26 * v, t0 + 0.13);
    env.gain.linearRampToValueAtTime(0, t0 + 0.17);
    osc.connect(env);
    const out = ctx.createStereoPanner();
    out.pan.value = pan;
    out.connect(d);
    const send = ctx.createGain();
    send.gain.value = 0.08;
    out.connect(send).connect(c.echoIn);
    // "eh" formants (F1 550, F2 1850); F2 lifts toward "y" at the end
    const formant = (f: number, to: number, q: number, g: number) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(f * k, t0);
      bp.frequency.exponentialRampToValueAtTime(to * k, t0 + 0.16);
      const gg = ctx.createGain();
      gg.gain.value = g;
      env.connect(bp).connect(gg).connect(out);
    };
    formant(600, 520, 3, 1.3);
    formant(1850, 2200, 5, 0.9);
    const body = ctx.createGain();
    body.gain.value = 0.15;
    env.connect(body).connect(out);
    osc.start(t0);
    osc.stop(end);
    return end;
  },
  // false start: the ref's sharp "tweet!" and a comic low "bonk"
  falseStart(c, t, v, pan, p, d) {
    whistleBlast(c, d, t, 3300, 0.06, 0.16 * v, pan);
    tone(c, { t: t + 0.08, f: 220, dur: 0.02, wave: 'tri', vol: 0.2 * v, dest: d, env: { a: 0.002, d: 0.16, s: 0, r: 0.04 }, sweep: { to: 110, time: 0.14 }, pan });
    return tone(c, { t: t + 0.08, f: 440, dur: 0.01, wave: 'p50', vol: 0.05 * v, dest: d, env: { a: 0.001, d: 0.06, s: 0, r: 0.02 }, sweep: { to: 220, time: 0.08 }, pan });
  },
  // turbo whoosh with a chip "zip"
  turbo(c, t, v, pan, p, d) {
    tone(c, { t, f: 300, dur: 0.12, wave: 'p125', vol: 0.035 * v, dest: d, env: { a: 0.005, d: 0.1, s: 0.5, r: 0.04 }, sweep: { to: 950, time: 0.15 }, pan });
    return noise(c, { t, dur: 0.28, vol: 0.2 * v, dest: d, env: { a: 0.06, d: 0.3, s: 0.3, r: 0.1 }, filters: [{ type: 'bandpass', f: 500, q: 1.5, to: 2800, time: 0.3 }], pan });
  },
  // skates biting the ice: "shhhk"
  hardStop(c, t, v, pan, p, d) {
    const dur = 0.14 + 0.2 * v;
    noise(c, { t, dur, vol: 0.05 * v, dest: d, buf: 'metal', rate: 3, env: { a: 0.005, d: dur, s: 0.5, r: 0.08 }, filters: [{ type: 'highpass', f: 4000 }], pan });
    return noise(c, { t, dur, vol: 0.2 * (0.5 + 0.5 * v), dest: d, env: { a: 0.005, d: dur * 0.8, s: 0.55, r: 0.1 }, filters: [{ type: 'highpass', f: 2500 }, { type: 'bandpass', f: 5500, q: 0.6 }], am: { rate: 41, depth: 0.35 }, pan });
  },
  // arena clock: last ten seconds
  clockBeep(c, t, v, pan, p, d) {
    tone(c, { t, f: 2000, dur: 0.08, wave: 'sine', vol: 0.04 * v, dest: d, env: { a: 0.002, d: 0.05, s: 0.8, r: 0.01 } });
    return tone(c, { t, f: 1000, dur: 0.08, wave: 'p50', vol: 0.09 * v, dest: d, env: { a: 0.002, d: 0.05, s: 0.8, r: 0.01 } });
  },
  // fumbled puck: comic falling "bonk" + puck rattle
  fumble(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.003, vol: 0.15 * v, dest: d, env: { a: 0.001, d: 0.02, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 2200, q: 2 }], pan });
    noise(c, { t: t + 0.06, dur: 0.003, vol: 0.1 * v, dest: d, env: { a: 0.001, d: 0.02, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 1900, q: 2 }], pan });
    return tone(c, { t, f: 520, dur: 0.1, wave: 'p25', vol: 0.07 * v, dest: d, env: { a: 0.002, d: 0.15, s: 0.3, r: 0.04 }, sweep: { to: 240, time: 0.14 }, pan });
  },
  // swipe + two-note blip (up for us, down for them)
  steal(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.06, vol: 0.12 * v, dest: d, env: { a: 0.004, d: 0.07, s: 0.2, r: 0.03 }, filters: [{ type: 'bandpass', f: 2600, q: 1.2, to: 1200, time: 0.08 }], pan });
    const [a, b] = p.good ? [880, 1318.5] : [784, 587.3];
    tone(c, { t: t + 0.03, f: a, dur: 0.04, wave: 'p125', vol: 0.05 * v, dest: d, env: { a: 0.002, d: 0.05, s: 0.5, r: 0.02 }, pan });
    return tone(c, { t: t + 0.08, f: b, dur: 0.06, wave: 'p125', vol: 0.05 * v, dest: d, env: { a: 0.002, d: 0.06, s: 0.5, r: 0.03 }, pan, echo: 0.2 });
  },
  // poke check: stick swish, a clack if it connects
  poke(c, t, v, pan, p, d) {
    return noise(c, { t, dur: 0.06, vol: 0.1 * v, dest: d, env: { a: 0.006, d: 0.07, s: 0.2, r: 0.03 }, filters: [{ type: 'bandpass', f: 3200, q: 1.2, to: 1500, time: 0.08 }], pan });
  },
  pokeHit(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.06, vol: 0.1 * v, dest: d, env: { a: 0.006, d: 0.07, s: 0.2, r: 0.03 }, filters: [{ type: 'bandpass', f: 3200, q: 1.2, to: 1500, time: 0.08 }], pan });
    noise(c, { t: t + 0.04, dur: 0.003, vol: 0.2 * v, dest: d, env: { a: 0.001, d: 0.03, s: 0, r: 0.01 }, filters: [{ type: 'bandpass', f: 2300, q: 2 }], pan });
    return tone(c, { t: t + 0.04, f: 1100, dur: 0.005, wave: 'tri', vol: 0.09 * v, dest: d, env: { a: 0.001, d: 0.035, s: 0, r: 0.01 }, pan });
  },
  // control switch: menu-style blip
  blip(c, t, v, pan, p, d) {
    tone(c, { t, f: 1046.5, dur: 0.035, wave: 'p125', vol: 0.07 * v, dest: d, env: { a: 0.002, d: 0.04, s: 0.6, r: 0.01 } });
    return tone(c, { t: t + 0.05, f: 1568, dur: 0.05, wave: 'p125', vol: 0.07 * v, dest: d, env: { a: 0.002, d: 0.05, s: 0.6, r: 0.02 }, echo: 0.2 });
  },
  // penalty box door swings open
  boxDoor(c, t, v, pan, p, d) {
    noise(c, { t, dur: 0.01, vol: 0.14 * v, dest: d, env: { a: 0.001, d: 0.05, s: 0, r: 0.01 }, filters: [{ type: 'lowpass', f: 900 }] });
    return tone(c, { t, f: 230, dur: 0.01, wave: 'tri', vol: 0.18 * v, dest: d, env: { a: 0.001, d: 0.08, s: 0, r: 0.02 }, sweep: { to: 150, time: 0.07 } });
  },
  // pause: the classic menu arpeggio, down to pause, up to resume
  pause(c, t, v, pan, p, d) {
    const notes = p.good ? [659.25, 987.77, 1318.5] : [1318.5, 987.77, 659.25];
    let end = t;
    notes.forEach((f, i) => {
      end = tone(c, { t: t + i * 0.045, f, dur: 0.04, wave: 'p50', vol: 0.08 * v, dest: d, env: { a: 0.002, d: 0.05, s: 0.6, r: 0.03 }, echo: 0.2 });
    });
    return end;
  },
  // rematch: "press start" arpeggio
  rematch(c, t, v, pan, p, d) {
    let end = t;
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
      end = tone(c, { t: t + i * 0.055, f, dur: 0.05, wave: 'p25', vol: 0.08 * v, dest: d, env: { a: 0.002, d: 0.08, s: 0.5, r: 0.04 }, echo: 0.3 });
    });
    return end;
  },
} satisfies Record<string, Recipe>;

export type SfxName = keyof typeof SFX;

/**
 * Mix + rate limits. `gain` = output level (the mix lives here, not in the
 * recipes), `gap` = minimum seconds between repeats, `prio` 0 (dropped
 * first) .. 2 (always plays), `len` = voice-budget estimate.
 *
 * Mix targets (K-weighted, asserted by tools/audio-test.ts): the home goal
 * (horn + roar + fanfare) is the loudest thing in the game; the ref's whistle
 * (~8 dB under it), buzzer, clock beep and skate scrapes sit under it and
 * don't bury the puck layer (a full slap shot stays within 6 dB of the
 * whistle). Pickups clear the live crowd bed by >= 6 dB even at its cap.
 */
const RULES: Record<SfxName, { gain: number; gap: number; prio: number; len: number; ui?: boolean }> = {
  // ~0.6 pickups/s of play; the gap only stops one restarting inside its own two taps
  pickup: { gain: 2.6, gap: 0.12, prio: 0, len: 0.12 },
  pass: { gain: 1.8, gap: 0.05, prio: 1, len: 0.15 },
  receive: { gain: 2.0, gap: 0.05, prio: 0, len: 0.06 },
  shot: { gain: 1.6, gap: 0.05, prio: 2, len: 0.35 },
  save: { gain: 1.5, gap: 0.08, prio: 2, len: 0.15 },
  catch: { gain: 1.5, gap: 0.08, prio: 2, len: 0.1 },
  post: { gain: 1.4, gap: 0.15, prio: 2, len: 1.3 },
  boards: { gain: 1, gap: 0.08, prio: 0, len: 0.15 },
  bodyBoards: { gain: 0.85, gap: 0.18, prio: 1, len: 0.5 },
  netHit: { gain: 1.05, gap: 0.1, prio: 0, len: 0.1 },
  check: { gain: 1.3, gap: 0.08, prio: 1, len: 0.25 },
  fall: { gain: 1, gap: 0.15, prio: 1, len: 0.2 },
  // ~8 dB under the goal (audio-test asserts >= 7.5): the ref is a signal, not a moment
  whistle: { gain: 0.66, gap: 0.6, prio: 2, len: 0.65 },
  whistleLong: { gain: 0.66, gap: 0.6, prio: 2, len: 0.55 },
  horn: { gain: 1.25, gap: 1.5, prio: 2, len: 2.4 },
  periodHorn: { gain: 1.35, gap: 1.5, prio: 2, len: 1.8 },
  buzzer: { gain: 0.6, gap: 0.8, prio: 2, len: 0.6 },
  // delayed penalty chime: one per foul run (a second foul in the same delay re-emits)
  refArm: { gain: 1, gap: 1, prio: 1, len: 0.45 },
  faceoffDrop: { gain: 3.0, gap: 0.3, prio: 2, len: 0.05 },
  faceoffWin: { gain: 1.3, gap: 0.3, prio: 1, len: 0.1 },
  bark: { gain: 1.0, gap: 0.25, prio: 2, len: 0.15 },
  // call for the puck: one per 0.6 s however fast the button is mashed
  yip: { gain: 1, gap: 0.6, prio: 1, len: 0.16 },
  hey: { gain: 0.75, gap: 0.6, prio: 1, len: 0.2 },
  falseStart: { gain: 0.8, gap: 0.4, prio: 2, len: 0.3 },
  turbo: { gain: 2.4, gap: 0.25, prio: 0, len: 0.4 },
  hardStop: { gain: 0.6, gap: 0.12, prio: 0, len: 0.4 },
  clockBeep: { gain: 0.8, gap: 0.5, prio: 2, len: 0.1 },
  fumble: { gain: 2.2, gap: 0.2, prio: 1, len: 0.2 },
  steal: { gain: 2.5, gap: 0.15, prio: 1, len: 0.15 },
  poke: { gain: 1.9, gap: 0.08, prio: 0, len: 0.1 },
  pokeHit: { gain: 1.6, gap: 0.08, prio: 1, len: 0.1 },
  blip: { gain: 1.7, gap: 0.2, prio: 2, len: 0.1 },
  boxDoor: { gain: 0.7, gap: 0.3, prio: 1, len: 0.1 },
  rematch: { gain: 2.2, gap: 0.5, prio: 2, len: 0.4 },
  // ui: on the ui bus, so the pause duck doesn't swallow its own jingle
  pause: { gain: 1.6, gap: 0.1, prio: 2, len: 0.2, ui: true },
};

/**
 * Play a sound if the rate limiter and voice budget allow it. Never throws:
 * params come from the sim (power, force, positions), and a NaN reaching an
 * AudioParam would raise inside the game loop. A bad start time, a NaN
 * volume or an unknown name drops the sound (an infinite volume clamps to
 * 0..1); a bad pan plays centered.
 */
export function playSfx(core: AudioCore, name: SfxName, t: number, p: SfxParams = {}): number | null {
  const r = RULES[name];
  const vol = p.vol ?? 1;
  if (!r || !Number.isFinite(t) || typeof vol !== 'number' || Number.isNaN(vol)) return null;
  if (!core.claim(name, t, r.gap, t + r.len, r.prio)) return null;
  const v = clamp01(vol);
  const pan = typeof p.pan === 'number' && Number.isFinite(p.pan) ? Math.max(-1, Math.min(1, p.pan)) : 0;
  try {
    const out = core.ctx.createGain();
    out.gain.value = r.gain;
    out.connect(r.ui ? core.ui : core.sfx);
    return SFX[name](core, t, v, pan, p, out);
  } catch {
    return null;
  }
}
