// Crowd: a continuous ambience bed (what plays during live action instead of
// music, like the 16-bit hockey games) plus one-shot reactions.
//
// The bed is stereo noise split into three bands. A bigger, more excited
// crowd is not only louder but brighter (screams, whistles), so intensity
// raises the mid/high bands and opens a lowpass. A slow random "murmur"
// modulates the level so the bed breathes instead of hissing, and a babble
// layer (noise in the bands where voices live, ~450/900/1600 Hz, each
// bobbing on its own 3-7 Hz syllable-rate wobble) makes it people talking
// rather than air: spectral flatness ~0.65, not the 0.9 of plain hiss
// (measured by tools/audio-character.ts). The goal roar gets a burst of the
// same babble.
//
// The bed sits UNDER the stick-and-puck layer: pickups, passes and wrist
// shots (~2 kHz clicks) must poke out of it even when the crowd is up, so
// its top end opens only gently (1.1-3.1 kHz lowpass, a small 2.7 kHz band)
// and impacts duck it for a moment (duck(), a side-chain dip). tools/audio-
// test asserts bed @ 0.5 <= -29 LUFS with < 15% of its energy above 2 kHz,
// and that pass/wrist shot clear the bed by >= 3 dB and pickups by >= 6 dB,
// at 0.5 and at the 0.65 live-play cap.

import { gain, type AudioCore } from './core';
import { crowdVoices, envelope, noise, tone, type Env } from './synth';

/** babble bands: [center Hz, Q, level]; voices' F1/F2 region, weighted low */
const BABBLE: readonly [number, number, number][] = [
  [450, 3, 1],
  [900, 3.5, 0.75],
  [1600, 4, 0.3],
];
/** babble wobble: random partials in this range (Hz), baked into a loop this long (s) */
const BABBLE_RATE: [number, number] = [3, 7];
const BABBLE_LOOP = 8;

/** side-chain dip on impacts: depth, attack and release time constants */
const DUCK_DB = 4;
const DUCK_ATTACK = 0.03;
const DUCK_RELEASE = 0.25;
/** how long the dip holds before releasing (~3 attack time constants: near full depth) */
const DUCK_HOLD = 0.09;

/**
 * Bed level trim. The babble adds ~3 dB of loudness, mostly in the voice
 * bands, so the whole bed comes down to keep it at the same LUFS (and the
 * stick clicks clear of it).
 */
const BED_GAIN = 0.6;
/** babble level in the bed (x 0.6..1.4 with the crowd level) */
const BABBLE_BED = 1.4;
/** delayed-penalty murmur: level and darkening lowpass (Hz, applied twice) */
const MURMUR_VOL = 0.065;
const MURMUR_LP = 1000;
/** goal roar: plain noise swell vs babble burst */
const ROAR_NOISE = 0.35;
const ROAR_BABBLE = 0.7;

/**
 * A seamless -1..1 loop of random partials in BABBLE_RATE: each partial's
 * frequency is a whole number of cycles per loop, so it wraps cleanly.
 */
function wobbleBuffer(core: AudioCore): AudioBuffer {
  const ctx = core.ctx;
  // a low control rate is plenty for a 7 Hz wobble (and keeps the buffer small)
  const sr = 3000;
  const len = sr * BABBLE_LOOP;
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const parts = Array.from({ length: 6 }, () => {
    const f = BABBLE_RATE[0] + core.random() * (BABBLE_RATE[1] - BABBLE_RATE[0]);
    return { f: Math.round(f * BABBLE_LOOP) / BABBLE_LOOP, ph: core.random() * 2 * Math.PI, a: 0.5 + core.random() * 0.5 };
  });
  let peak = 0;
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (const p of parts) v += p.a * Math.sin(2 * Math.PI * p.f * (i / sr) + p.ph);
    d[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  for (let i = 0; i < len; i++) d[i] /= peak || 1;
  return buf;
}

export class Crowd {
  private core: AudioCore;
  private bed: GainNode;
  private mid: GainNode;
  private hi: GainNode;
  private bright: BiquadFilterNode;
  private babble: GainNode;
  /** one baked 3-7 Hz wobble per babble band (-1..1, loops seamlessly) */
  private wobble: AudioBuffer[];
  /** side-chain dip (bed only: reactions like the save cheer stay at full level) */
  private ducker: GainNode;
  level = 0;

  constructor(core: AudioCore) {
    this.core = core;
    const ctx = core.ctx;
    const mix = ctx.createGain();
    for (const [pan, offset] of [
      [-0.55, 0],
      [0.55, 0.9],
    ] as const) {
      const src = ctx.createBufferSource();
      src.buffer = core.noise.white;
      src.loop = true;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(p).connect(mix);
      src.start(0, offset);
    }
    const band = (f: number, q: number, g: number): GainNode => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const out = gain(ctx, g);
      mix.connect(bp).connect(out);
      return out;
    };
    const low = band(380, 0.8, 0.6);
    this.mid = band(1050, 1.0, 0.3);
    this.hi = band(2700, 1.4, 0);
    this.bright = ctx.createBiquadFilter();
    this.bright.type = 'lowpass';
    this.bright.frequency.value = 1100;
    for (const b of [low, this.mid, this.hi]) b.connect(this.bright);
    // babble: the shared noise through the voice bands, each band on its
    // own wobble, into the same brightness lowpass and level as the rest
    this.wobble = BABBLE.map(() => wobbleBuffer(core));
    this.babble = gain(ctx, 0);
    BABBLE.forEach(([f, q, g], i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      mix.connect(bp).connect(this.bobbing(this.wobble[i], g, 0)).connect(this.babble);
    });
    this.babble.connect(this.bright);
    this.bed = gain(ctx, 0);
    const murmur = gain(ctx, 1);
    this.ducker = gain(ctx, 1);
    this.bright.connect(this.bed).connect(murmur).connect(this.ducker).connect(core.crowd);

    // murmur: a slow random wobble (sum of incommensurate sines baked into a
    // buffer) added onto the level gain
    const len = Math.floor(ctx.sampleRate * 9);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const parts = [0.23, 0.61, 1.37, 2.9].map((f) => ({ f, ph: core.random() * 6.28, a: 1 / (1 + f) }));
    let norm = 0;
    for (const p of parts) norm += p.a;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      let v = 0;
      for (const p of parts) v += p.a * Math.sin(2 * Math.PI * p.f * t + p.ph);
      d[i] = v / norm;
    }
    const mod = ctx.createBufferSource();
    mod.buffer = buf;
    mod.loop = true;
    mod.connect(gain(ctx, 0.22)).connect(murmur.gain);
    mod.start(0);
  }

  /** Glide the bed toward `level` (0 = empty arena .. 1 = roaring) with time constant `tau`. */
  setLevel(level: number, t: number, tau = 0.5): void {
    // setTargetAtTime throws on a non-finite value or time constant
    if (!Number.isFinite(level) || !Number.isFinite(t) || !(tau > 0) || !Number.isFinite(tau)) return;
    const l = Math.max(0, Math.min(1, level));
    this.level = l;
    this.bed.gain.setTargetAtTime(BED_GAIN * (0.04 + 0.16 * Math.pow(l, 1.5)), t, tau);
    this.mid.gain.setTargetAtTime(0.2 + 0.6 * l, t, tau);
    this.hi.gain.setTargetAtTime(0.08 * l * l, t, tau);
    // more people talking as the crowd gets into it
    this.babble.gain.setTargetAtTime(BABBLE_BED * (0.6 + 0.8 * l), t, tau);
    this.bright.frequency.setTargetAtTime(1100 + 2000 * l, t, tau);
  }

  /**
   * A gain that bobs on `buf` (a -1..1 wobble): level*(1 + 0.9*wobble), so
   * the band dips nearly to silence between "syllables". Started at `t`
   * with a random offset; stopped at `stop` if given (one-shots).
   */
  private bobbing(buf: AudioBuffer, level: number, t: number, stop?: number): GainNode {
    const ctx = this.core.ctx;
    const g = gain(ctx, level);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain(ctx, 0.9 * level)).connect(g.gain);
    src.start(t, this.core.random() * buf.duration);
    if (stop !== undefined) src.stop(stop);
    return g;
  }

  /** a one-shot burst of babble (the roar's crowd of voices), returns its end */
  private babbleBurst(t: number, dur: number, vol: number, env: Env): number {
    const c = this.core;
    const ctx = c.ctx;
    const out = ctx.createGain();
    const end = envelope(out.gain, t, dur, env, vol);
    out.connect(c.crowd);
    BABBLE.forEach(([f, q, g], i) => {
      const src = ctx.createBufferSource();
      src.buffer = c.noise.white;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      // an excited crowd shouts higher
      bp.frequency.value = f * 1.15;
      bp.Q.value = q;
      const p = ctx.createStereoPanner();
      p.pan.value = (i - 1) * 0.5;
      src.connect(bp).connect(this.bobbing(this.wobble[i], g, t, end + 0.01)).connect(p).connect(out);
      src.start(t, c.random() * (src.buffer.duration * 0.9));
      src.stop(end + 0.01);
    });
    return end;
  }

  /**
   * Side-chain dip: the bed ducks DUCK_DB under an impact (shot, save, post,
   * check) so the hit cuts through, then swells back. A new hit restarts the
   * dip from wherever the bed is.
   */
  duck(t: number, db = DUCK_DB): void {
    if (!Number.isFinite(t) || !Number.isFinite(db)) return;
    const g = this.ducker.gain;
    // drop the pending release of an earlier dip; one already under way keeps
    // gliding from its current value
    g.cancelScheduledValues(t);
    g.setTargetAtTime(Math.pow(10, -Math.max(0, db) / 20), t, DUCK_ATTACK);
    g.setTargetAtTime(1, t + DUCK_HOLD, DUCK_RELEASE);
  }

  /** Goal roar: noise swell + a cluster of "YEAHH" voices + fan whistles. */
  roar(t: number, size = 1): number {
    const c = this.core;
    const dest = c.crowd;
    const swell: Env = { a: 0.35, d: 2.4, s: 0.55, r: 2.2 };
    let end = noise(c, { t, dur: 2.6 * size, vol: ROAR_NOISE * size, dest, env: swell, filters: [{ type: 'bandpass', f: 1100, q: 0.55 }, { type: 'lowpass', f: 4500 }] });
    end = Math.max(end, this.babbleBurst(t + 0.03, 2.6 * size, ROAR_BABBLE * size, swell));
    end = Math.max(end, crowdVoices(c, { t: t + 0.05, dur: 2.2 * size, vol: 0.2 * size, dest, vowel: 'ae', voices: 10, f0: 330, contour: [[0.12, 1.18], [0.6, 1.05], [1, 0.9]], env: { a: 0.2, d: 2.2, s: 0.5, r: 1.2 }, breath: 0.9 }));
    for (let i = 0; i < Math.round(3 * size); i++) {
      const wt = t + 0.3 + c.random() * 1.6;
      const f = 1700 + c.random() * 700;
      tone(c, { t: wt, f, dur: 0.35 + c.random() * 0.3, wave: 'sine', vol: 0.035, dest, env: { a: 0.04, d: 0.4, s: 0.7, r: 0.15 }, pitch: [[0.15, f * 1.35], [0.6, f * 1.1]], pan: c.random() * 1.6 - 0.8 });
    }
    return end;
  }

  /** "Ooooh!" (post, big hit, near miss): pitch rises then falls. */
  ooh(t: number, amount = 1): number {
    return crowdVoices(this.core, { t, dur: 1.1, vol: 0.2 * amount, dest: this.core.crowd, vowel: 'oo', voices: 9, f0: 250, contour: [[0.35, 1.2], [1, 0.76]], env: { a: 0.12, d: 1.0, s: 0.45, r: 0.35 }, breath: 0.9 });
  }

  /** "Awww" (opponent scores): falls and deflates. */
  aww(t: number): number {
    return crowdVoices(this.core, { t, dur: 1.4, vol: 0.2, dest: this.core.crowd, vowel: 'aw', voices: 9, f0: 270, contour: [[0.15, 1.05], [1, 0.68]], env: { a: 0.1, d: 1.4, s: 0.4, r: 0.4 }, breath: 0.9 });
  }

  /** "Boooo" (home player penalized). */
  boo(t: number): number {
    return crowdVoices(this.core, { t, dur: 1.7, vol: 0.2, dest: this.core.crowd, vowel: 'oo', voices: 10, f0: 150, contour: [[0.2, 1.02], [0.8, 0.97], [1, 0.86]], env: { a: 0.2, d: 1.7, s: 0.7, r: 0.4 }, breath: 0.85 });
  }

  /**
   * Murmur under live play (delayed penalty: the ref's arm is up). Small,
   * low and dark (the voices' breath goes through a MURMUR_LP lowpass), so it
   * never covers the stick clicks: "ooOOh" rising when the PUPS are getting
   * a power play (`excited`), a falling "mmrrr" grumble when one of ours is
   * going to the box.
   */
  murmur(t: number, excited: boolean): number {
    const c = this.core;
    const ctx = c.ctx;
    let dest: AudioNode = c.crowd;
    for (let i = 0; i < 2; i++) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = MURMUR_LP;
      lp.Q.value = 0.6;
      lp.connect(dest);
      dest = lp;
    }
    const env: Env = { a: 0.25, d: 0.8, s: 0.6, r: 0.3 };
    return excited
      ? crowdVoices(c, { t, dur: 0.8, vol: MURMUR_VOL, dest, vowel: 'oo', voices: 8, f0: 210, contour: [[0.7, 1.16], [1, 1.1]], env, breath: 0.8 })
      : crowdVoices(c, { t, dur: 0.8, vol: MURMUR_VOL, dest, vowel: 'oo', voices: 8, f0: 160, contour: [[0.3, 1.02], [1, 0.88]], env, breath: 0.8 });
  }

  /** Short cheer burst (saves, steals, period start). */
  cheer(t: number, amount = 1): number {
    const c = this.core;
    noise(c, { t, dur: 0.6, vol: 0.32 * amount, dest: c.crowd, env: { a: 0.08, d: 0.7, s: 0.35, r: 0.5 }, filters: [{ type: 'bandpass', f: 1200, q: 0.6 }] });
    return crowdVoices(c, { t, dur: 0.7, vol: 0.13 * amount, dest: c.crowd, vowel: 'ae', voices: 7, f0: 320, contour: [[0.2, 1.12], [1, 0.95]], env: { a: 0.06, d: 0.7, s: 0.4, r: 0.4 }, breath: 0.8 });
  }
}
