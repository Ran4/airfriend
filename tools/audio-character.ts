// Character checks: does it sound like a dog, a crowd and an arena, and does
// pause actually go quiet? Imported by tools/audio-test.ts (its failures join
// the report) and run on its own by tools/audio-character.html (~3 s):
//
//   node tools/playtest.mjs --page /tools/audio-character.html --seconds 15 \
//        --eval "window.__characterReport" --out tools/out/audio-character
//
// FLATNESS (spectral flatness 150-3000 Hz of the long-term spectrum: 1 =
// noise, 0 = pure tones; the same measure as tools/qa-audio-probe3.ts, mono,
// 32 kHz, seed 11). A crowd is mostly breath: the ooh and boo must sit at
// 0.2-0.4 (they were 0.03 "kazoo choirs"), and the bed at 0.6-0.7 (voices in
// it: plain hiss is 0.9). The other crowd sounds and the bark are printed.
// BARK. Each variant is rendered dry (sfx bus straight to the output: no
// echo, no master compressor reshaping the decay). After its peak the
// envelope must only fall: >= 6 dB down 40 ms after the peak and >= 12 dB
// down after 80 ms (the old bark held a flat 30-120 ms plateau), peak within
// 12 ms, length (to -30 dB) 90-140 ms. The variants must differ from each
// other (pitch >= 10% apart, or length >= 15 ms apart), and a run of barks
// through the real event mapping must never repeat a variant back to back.
// PAUSE DUCK. A home goal's fanfare is paused 1 s in; the music bus (tapped
// straight to the output) must be >= 12 dB under an unpaused render of the
// same moment within 0.15 s, and back within 2 dB of it 0.5 s after resume
// (both renders shifted by the pause). The pause jingle (ui bus) must come
// out at the same level paused as not.
// ECHO. A noise burst into the sfx bus: the first repeat must arrive on the
// cue's 8th note (60/bpm/2, clamped to 0.15-0.33 s) once a cue has set the
// tempo, and be darker than the dry burst (share above 4 kHz less than half
// of the dry burst's).

import { AudioEngine } from '../src/audio/audio';
import { PAUSE_DUCK } from '../src/audio/core';
import { BARK_VARIANTS, barkVoice, type BarkVariant } from '../src/audio/sfx';
import { noise } from '../src/audio/synth';
import { SONGS } from '../src/audio/songs';
import type { GameEvent, GameState, Skater } from '../src/types';

const SR = 32000;

function fakeState(): GameState {
  const skaters = Array.from({ length: 10 }, (_, id) => ({
    id,
    team: id < 5 ? 0 : 1,
    kind: id === 0 ? 'dog' : id % 5 === 4 ? 'goalie' : 'kid',
    pos: { x: 0, z: 0 },
    vel: { x: 0, z: 0 },
    state: 'skate',
    windup: 0,
  })) as unknown as Skater[];
  return {
    phase: 'play',
    phaseTime: 0,
    period: 1,
    clock: 100,
    score: [0, 0],
    skaters,
    puck: { pos: { x: 0, z: 0 }, owner: null },
    referee: { pos: { x: 0, z: 0 } },
    penalties: [],
    faceoff: null,
    lastPenaltyCall: null,
    controlledId: 0,
    winner: null,
    events: [],
    paused: false,
  } as unknown as GameState;
}

// ------------------------------------------------------------- spectrum ----

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k + len / 2;
        const ar = re[a] * wr - im[a] * wi;
        const ai = re[a] * wi + im[a] * wr;
        re[a] = re[i + k] - ar;
        im[a] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
      }
    }
  }
}

/** averaged power spectrum of x[from..to) s (Hann, 4096, 50% overlap); a short span gets one zero-padded frame */
function powerSpectrum(x: Float32Array, from: number, to: number, n = 4096): Float64Array {
  const acc = new Float64Array(n / 2);
  const a = Math.round(from * SR);
  const b = Math.min(x.length, Math.round(to * SR));
  const frame = (c: number, len: number) => {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < len; i++) re[i] = (x[c + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
    fft(re, im);
    for (let i = 0; i < n / 2; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
  };
  if (b - a < n) frame(a, b - a);
  else for (let c = a; c + n <= b; c += n / 2) frame(c, n);
  return acc;
}

/** spectral flatness 150-3000 Hz (geometric / arithmetic mean of the power spectrum) */
function flatness(x: Float32Array, from: number, to: number): number {
  const n = 4096;
  const p = powerSpectrum(x, from, to, n);
  const lo = Math.round((150 * n) / SR);
  const hi = Math.round((3000 * n) / SR);
  let lg = 0;
  let ar = 0;
  for (let i = lo; i < hi; i++) {
    const v = p[i] + 1e-20;
    lg += Math.log(v);
    ar += v;
  }
  const m = hi - lo;
  return Math.round((Math.exp(lg / m) / (ar / m)) * 1000) / 1000;
}

/** share (0..1) of the power above `cut` Hz in x[from..to) */
function shareAbove(x: Float32Array, from: number, to: number, cut: number): number {
  const n = 2048;
  const p = powerSpectrum(x, from, to, n);
  let hi = 0;
  let tot = 0;
  for (let i = 1; i < n / 2; i++) {
    tot += p[i];
    if ((i * SR) / n >= cut) hi += p[i];
  }
  return tot ? hi / tot : 0;
}

const db = (x: number) => 20 * Math.log10(x + 1e-12);

function rms(x: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.round(from * SR));
  const b = Math.min(x.length, Math.round(to * SR));
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

function mono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels < 2) return buf.getChannelData(0);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const m = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) / 2;
  return m;
}

/** autocorrelation pitch (Hz) of x[from..to), searched 250-2000 Hz */
function pitchOf(x: Float32Array, from: number, to: number): number {
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.floor(SR / 2000); lag <= Math.ceil(SR / 250); lag++) {
    let s = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = a; i + lag < b; i++) {
      s += x[i] * x[i + lag];
      e0 += x[i] * x[i];
      e1 += x[i + lag] * x[i + lag];
    }
    const r = s / Math.sqrt(e0 * e1 + 1e-20);
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return bestLag ? Math.round(SR / bestLag) : 0;
}

// --------------------------------------------------------------- render ----

/** offline engine render; `setup` runs before rendering, `ticks` at the given times */
async function render(dur: number, opts: { channels?: number; ambience?: boolean; seed?: number }, setup: (e: AudioEngine, ctx: OfflineAudioContext) => void, ticks: [number, (e: AudioEngine) => void][] = []): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(opts.channels ?? 1, Math.ceil(SR * dur), SR);
  const e = new AudioEngine({ context: ctx, ambience: opts.ambience ?? false, seed: opts.seed ?? 11 });
  e.unlock();
  setup(e, ctx);
  let prev = -1;
  for (const [at, f] of ticks) {
    // suspend times are quantized to 128-frame render quanta
    const q = Math.round((at * SR) / 128) * 128;
    if (q <= prev || q >= ctx.length) continue;
    prev = q;
    void ctx.suspend(q / SR).then(() => {
      f(e);
      void ctx.resume();
    });
  }
  return ctx.startRendering();
}

// ------------------------------------------------------------- flatness ----

interface FlatRow {
  name: string;
  flat: number;
  want?: [number, number];
}

async function flatnessRows(): Promise<FlatRow[]> {
  const rows: FlatRow[] = [];
  const crowd: [string, 'ooh' | 'aww' | 'boo' | 'cheer' | 'roar', [number, number] | undefined][] = [
    ['ooh', 'ooh', [0.2, 0.4]],
    ['aww', 'aww', undefined],
    ['boo', 'boo', [0.2, 0.4]],
    ['cheer', 'cheer', undefined],
    ['roar', 'roar', undefined],
  ];
  for (const [name, k, want] of crowd) {
    const x = (await render(4, {}, (e) => e.crowd![k](0.3))).getChannelData(0);
    rows.push({ name, flat: flatness(x, 0.4, k === 'cheer' ? 1.0 : 1.6), want });
  }
  const bed = (await render(3, { ambience: true }, (e) => e.crowd!.setLevel(0.5, 0, 0.02))).getChannelData(0);
  rows.push({ name: 'bed @ 0.5', flat: flatness(bed, 0.5, 2.9), want: [0.6, 0.7] });
  const bark = (await render(1, {}, (e) => e.onEvents([{ type: 'bark', skaterId: 0, startled: [] } as unknown as GameEvent], fakeState()))).getChannelData(0);
  rows.push({ name: 'bark', flat: flatness(bark, 0.2, 0.42) });
  return rows;
}

// ----------------------------------------------------------------- bark ----

interface BarkRow {
  variant: string;
  peakMs: number;
  /** dB under the peak 40 / 80 ms after it */
  d40: number;
  d80: number;
  lenMs: number;
  f0: number;
  centroid: number;
}

/** short-time RMS envelope: 12.5 ms windows (one 80 Hz AM cycle), 1 ms hop */
function envelopeOf(x: Float32Array, from: number, to: number): number[] {
  const w = Math.round(0.0125 * SR);
  const hop = Math.round(0.001 * SR);
  const out: number[] = [];
  for (let c = Math.round(from * SR); c + w <= Math.round(to * SR); c += hop) {
    let s = 0;
    for (let i = c; i < c + w; i++) s += x[i] * x[i];
    out.push(Math.sqrt(s / w));
  }
  return out;
}

function barkRow(variant: string, x: Float32Array, t0: number): BarkRow {
  const env = envelopeOf(x, t0, t0 + 0.4);
  let pk = 0;
  for (let i = 1; i < env.length; i++) if (env[i] > env[pk]) pk = i;
  const ref = env[pk];
  const at = (ms: number) => Math.round(db(env[Math.min(env.length - 1, pk + ms)] / ref) * 10) / 10;
  let last = pk;
  for (let i = pk; i < env.length; i++) if (env[i] > ref * Math.pow(10, -30 / 20)) last = i;
  // window centres sit 6 ms in; length runs from the onset (window start) to the last window above -30 dB
  const sp = powerSpectrum(x, t0, t0 + 0.15, 4096);
  let num = 0;
  let den = 0;
  for (let i = 1; i < sp.length; i++) {
    num += ((i * SR) / 4096) * sp[i];
    den += sp[i];
  }
  return {
    variant,
    peakMs: pk + 6,
    d40: -at(40),
    d80: -at(80),
    lenMs: last + 12,
    f0: pitchOf(x, t0 + 0.005, t0 + 0.05),
    centroid: Math.round(num / (den || 1)),
  };
}

async function barkChecks(failures: string[]): Promise<string> {
  // each variant dry: sfx bus straight to the output
  const at = (i: number) => 0.3 + i * 0.5;
  const buf = await render(0.3 + BARK_VARIANTS.length * 0.5 + 0.2, {}, (e) => {
    const core = e.core!;
    core.echoIn.gain.value = 0;
    core.sfx.disconnect();
    core.sfx.connect(core.ctx.destination);
    BARK_VARIANTS.forEach((v, i) => barkVoice(core, core.sfx, at(i), 1, 0, v));
  });
  const x = buf.getChannelData(0);
  const rows = BARK_VARIANTS.map((v, i) => barkRow(v, x, at(i)));
  for (const r of rows) {
    if (r.peakMs > 12) failures.push(`bark ${r.variant}: peak at ${r.peakMs} ms (want <= 12)`);
    if (r.d40 < 6) failures.push(`bark ${r.variant}: only ${r.d40} dB down 40 ms after the peak (plateau; want >= 6)`);
    if (r.d80 < 12) failures.push(`bark ${r.variant}: only ${r.d80} dB down 80 ms after the peak (want >= 12)`);
    if (r.lenMs < 90 || r.lenMs > 140) failures.push(`bark ${r.variant}: ${r.lenMs} ms long (want 90-140)`);
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const pitch = Math.max(a.f0, b.f0) / Math.max(1, Math.min(a.f0, b.f0));
      if (pitch < 1.1 && Math.abs(a.lenMs - b.lenMs) < 15) failures.push(`bark ${a.variant} vs ${b.variant}: too alike (pitch x${pitch.toFixed(2)}, ${a.lenMs} vs ${b.lenMs} ms)`);
    }
  }
  // the real mapping: 8 barks in a row, no variant twice running (read from the pitch)
  const st = fakeState();
  const seq: number[] = [];
  const run = await render(
    4.3,
    {},
    (e) => {
      e.core!.echoIn.gain.value = 0;
    },
    Array.from({ length: 8 }, (_, i) => [0.3 + i * 0.5, (e: AudioEngine) => e.onEvents([{ type: 'bark', skaterId: 0, startled: [] } as unknown as GameEvent], st)] as [number, (e: AudioEngine) => void]),
  );
  const rx = run.getChannelData(0);
  for (let i = 0; i < 8; i++) {
    // onEvents schedules at max(now, readyAt); find the onset after the tick
    const t = 0.3 + i * 0.5;
    let on = Math.round(t * SR);
    while (on < rx.length && Math.abs(rx[on]) < 0.01) on++;
    seq.push(pitchOf(rx, on / SR + 0.005, on / SR + 0.05));
  }
  const near = (a: number, b: number) => Math.max(a, b) / Math.max(1, Math.min(a, b)) < 1.22;
  // +-10% random pitch: two of the same variant land within x1.22, different ones (x1.5, x0.72) don't
  for (let i = 1; i < seq.length; i++) if (near(seq[i], seq[i - 1])) failures.push(`bark run: bark ${i} repeats the variant before it (${seq[i - 1]} -> ${seq[i]} Hz)`);
  const head = 'bark      peak  -dB@40  -dB@80   len    f0  centroid   (dry, envelope = 12.5 ms RMS)';
  const lines = rows.map((r) => `${r.variant.padEnd(8)} ${String(r.peakMs).padStart(4)}ms ${r.d40.toFixed(1).padStart(6)} ${r.d80.toFixed(1).padStart(7)} ${String(r.lenMs).padStart(4)}ms ${String(r.f0).padStart(5)} ${String(r.centroid).padStart(8)}`);
  return [head, ...lines, `run of 8 through onEvents (f0, Hz): ${seq.join(' ')}`].join('\n');
}

// ----------------------------------------------------------- pause duck ----

/** fanfare start (goal at 0.3 + FANFARE_DELAY 1.55) and the moments around the pause */
const GOAL_AT = 0.3;
const PAUSE_AT = 2.85;
const RESUME_AT = 3.85;

/** context time of the tick that paused / resumed (set by pauseRender) */
const edges = { pause: 0, resume: 0 };

async function pauseRender(pause: boolean): Promise<Float32Array> {
  const st = fakeState();
  st.phase = 'goal';
  const ticks: [number, (e: AudioEngine) => void][] = [];
  for (let t = GOAL_AT + 0.05; t < 6; t += 1 / 60) {
    const tt = t;
    ticks.push([
      tt,
      (e) => {
        const p = pause && tt >= PAUSE_AT && tt < RESUME_AT;
        if (p !== st.paused) edges[p ? 'pause' : 'resume'] = e.core!.now();
        st.paused = p;
        e.update(st, 1 / 60);
      },
    ]);
  }
  const buf = await render(
    6,
    { channels: 2 },
    (e, ctx) => {
      // tap the music bus straight to the output, nothing else
      const core = e.core!;
      core.master.disconnect();
      core.music.connect(ctx.destination);
      e.update(st, 0);
      e.onEvents([{ type: 'goal', info: { team: 0, scorer: 1, assists: [], period: 1, clock: 60, powerPlay: false, shortHanded: false } } as unknown as GameEvent], st);
    },
    [[GOAL_AT - 0.01, () => {}], ...ticks],
  );
  return mono(buf);
}

async function pauseChecks(failures: string[]): Promise<string> {
  const plain = await pauseRender(false);
  const paused = await pauseRender(true);
  // measured from the tick that set paused (ticks land on render quanta)
  const tp = edges.pause;
  const tr = edges.resume;
  const lvl = (x: Float32Array, a: number, b: number) => db(rms(x, a, b));
  const before = lvl(paused, tp - 0.1, tp) - lvl(plain, tp - 0.1, tp);
  // "within 0.15 s": the level over the 20 ms ending 0.15 s after the pause
  const drop = lvl(plain, tp + 0.13, tp + 0.15) - lvl(paused, tp + 0.13, tp + 0.15);
  const deep = lvl(plain, tp + 0.4, tp + 0.9) - lvl(paused, tp + 0.4, tp + 0.9);
  // after resume the paused render is the plain one shifted by the pause
  const shift = tr - tp;
  const back = lvl(paused, tr + 0.5, tr + 0.9) - lvl(plain, tr + 0.5 - shift, tr + 0.9 - shift);
  if (Math.abs(before) > 0.5) failures.push(`pause duck: renders differ before the pause (${before.toFixed(1)} dB)`);
  if (drop < 12) failures.push(`pause duck: music bus only ${drop.toFixed(1)} dB down 0.13-0.15 s after pausing mid-fanfare (want >= 12)`);
  if (Math.abs(back) > 2) failures.push(`pause duck: music bus ${back.toFixed(1)} dB off the unpaused render 0.5 s after resume (want within 2)`);

  // the jingle itself goes around the duck
  const jingle = async (pausedJingle: boolean) => {
    const st = fakeState();
    const x = mono(
      await render(1.4, { channels: 2 }, () => {}, [
        [0.3, (e) => e.update(st, 0)],
        [
          0.5,
          (e) => {
            // the jingle under test plays on the pause edge (paused) or resume edge (not)
            if (!pausedJingle) {
              st.paused = true;
              e.update(st, 0);
            }
          },
        ],
        [
          0.9,
          (e) => {
            st.paused = pausedJingle;
            if (!pausedJingle) st.paused = false;
            e.update(st, 0);
          },
        ],
      ]),
    );
    return lvl(x, 0.9, 1.3);
  };
  // paused: the down-arpeggio while ducked; resume: the up-arpeggio as the duck lifts.
  // Same notes reversed: compare the ducked jingle against the full one.
  const jPaused = await jingle(true);
  const jResume = await jingle(false);
  const jd = jPaused - jResume;
  if (jd < -1.5) failures.push(`pause jingle: ${(-jd).toFixed(1)} dB quieter while paused (it must go around the duck)`);
  return [
    `pause duck (music bus, home goal fanfare paused ${(PAUSE_AT - GOAL_AT - 1.55).toFixed(2)} s in; ducked level ${db(PAUSE_DUCK).toFixed(1)} dB)`,
    `  before pause ${before.toFixed(1)} dB | +0.13-0.15 s ${(-drop).toFixed(1)} dB (need <= -12) | +0.4-0.9 s ${(-deep).toFixed(1)} dB | 0.5 s after resume ${back.toFixed(1)} dB`,
    `  pause jingle while paused vs on resume: ${jd.toFixed(1)} dB`,
  ].join('\n');
}

// ----------------------------------------------------------------- echo ----

async function echoChecks(failures: string[]): Promise<string> {
  const lines = ['echo   first repeat (L/R)   want     >4 kHz dry  first repeat'];
  for (const song of [null, 'theme', 'intermission'] as const) {
    const bpm = song ? SONGS[song].bpm : 0;
    const want = song ? Math.max(0.15, Math.min(0.33, 60 / bpm / 2)) : 0.172;
    const BURST = 1.2;
    const buf = await render(1.9, { channels: 2 }, (e) => {
      const core = e.core!;
      if (song) core.setEchoTempo(bpm, 0.1);
      // the wet return only: the dry sfx bus no longer reaches the master
      core.sfx.disconnect(core.master);
      noise(core, { t: BURST, dur: 0.004, vol: 0.5, dest: core.sfx, env: { a: 0.001, d: 0.006, s: 0, r: 0.002 } });
    });
    const dryBuf = await render(1.9, { channels: 2 }, (e) => {
      const core = e.core!;
      core.echoIn.gain.value = 0;
      noise(core, { t: BURST, dur: 0.004, vol: 0.5, dest: core.sfx, env: { a: 0.001, d: 0.006, s: 0, r: 0.002 } });
    });
    // loudest sample in [from, to) s; the master chain's lookahead delays
    // dry and wet alike, so repeats are timed against the dry burst's peak
    const peakAt = (x: Float32Array, from: number, to: number) => {
      let pk = 0;
      let at = 0;
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
        if (Math.abs(x[i]) > pk) {
          pk = Math.abs(x[i]);
          at = i / SR;
        }
      }
      return at;
    };
    const t0 = peakAt(mono(dryBuf), BURST, BURST + 0.05);
    // each channel's loudest repeat is its own tap (pans +-0.6), the first one round
    const aL = peakAt(buf.getChannelData(0), BURST + 0.05, BURST + 0.4) - t0;
    const aR = peakAt(buf.getChannelData(1), BURST + 0.05, BURST + 0.4) - t0;
    const wet = mono(buf);
    const hiDry = shareAbove(mono(dryBuf), BURST, BURST + 0.03, 4000);
    const hiWet = shareAbove(wet, t0 + aL - 0.01, t0 + aL + 0.04, 4000);
    lines.push(`${(song ?? 'default').padEnd(12)} ${aL.toFixed(3)} / ${aR.toFixed(3)}   ${want.toFixed(3)}    ${(hiDry * 100).toFixed(1).padStart(5)}%  ${(hiWet * 100).toFixed(1).padStart(5)}%`);
    if (Math.abs(aL - want) > 0.006 || Math.abs(aR - (want + 0.012)) > 0.006) failures.push(`echo ${song ?? 'default'}: first repeat at ${aL.toFixed(3)}/${aR.toFixed(3)} s, want ${want.toFixed(3)}/${(want + 0.012).toFixed(3)}`);
    if (hiWet > hiDry * 0.5) failures.push(`echo ${song ?? 'default'}: first repeat bright (${(hiWet * 100).toFixed(1)}% above 4 kHz vs dry ${(hiDry * 100).toFixed(1)}%)`);
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------- main ----

export async function characterChecks(): Promise<{ failures: string[]; table: string; flatness: FlatRow[] }> {
  const failures: string[] = [];
  const flat = await flatnessRows();
  for (const r of flat) if (r.want && (r.flat < r.want[0] || r.flat > r.want[1])) failures.push(`flatness ${r.name}: ${r.flat} (want ${r.want[0]}-${r.want[1]})`);
  const flatTable = ['CHARACTER', 'flatness 150-3000 Hz (1 noise .. 0 tones)', ...flat.map((r) => `  ${r.name.padEnd(10)} ${r.flat.toFixed(3)}${r.want ? `   want ${r.want[0]}-${r.want[1]}` : ''}`)].join('\n');
  const bark = await barkChecks(failures);
  const pause = await pauseChecks(failures);
  const echo = await echoChecks(failures);
  return { failures, table: [flatTable, bark, pause, echo].join('\n\n'), flatness: flat };
}
