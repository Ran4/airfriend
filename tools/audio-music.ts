// Music checks that need a render: low end, swing, and the intermission fit.
// Imported by tools/audio-test.ts (its failures join the report) and run on
// its own by tools/audio-music.html, which takes ~3 s instead of ~50:
//
//   node tools/playtest.mjs --page /tools/audio-music.html --seconds 12 \
//        --eval "window.__musicReport" --out tools/out/audio-music
//
// LOW END. Laptop speakers roll off below ~150 Hz, so a groove carried by
// 45 Hz fundamentals vanishes on them, and on headphones that sub energy
// drives the master compressor. Asserted on the THEME (the cue heard most):
//   - full mix: < 45% of the spectral energy below 250 Hz
//   - bass channel alone: < 50% of its energy below 120 Hz
//   (the kick's share below 120 Hz and above 1 kHz is printed, not asserted:
//   its 170 -> 55 Hz body is low by design, the 2.6 kHz beater click is
//   what a small speaker plays)
//   - no clipping (peak <= 0.95 with and without the safety clipper)
// SWING. Each swung song's off-beat notes are rendered solo per channel and
// their onsets found in the audio; the measured delay of the swung notes
// against the on-beats must match swingOffset() within 4 ms on the drums
// (sharp attacks) and 10 ms on the bass and chords (soft, pitched attacks
// read less precisely), and be clearly late (swing ratio >= 1.25 : 1). The same song with the swing
// grid forced to 16ths is rendered too, as the "this is what straight
// sounds like" baseline the 8th-grid intermission used to be.
// INTERMISSION FIT. The engine starts the cue 0.4 s into the 9.0 s phase:
// start + song length must be <= 9.0, the audible tail (> -50 dBFS) must end
// by 9.0, and the last lead and bass notes and the last chord must be the
// tonic.

import { AudioCore } from '../src/audio/core';
import { compileSong, MusicPlayer, swingOffset, type ChannelName, type SongDef } from '../src/audio/sequencer';
import { SONGS, type SongName } from '../src/audio/songs';
import { DRUMS } from '../src/audio/synth';
import { RULES } from '../src/config';

const SR = 32000;
const THRESH = 0.003; // ~ -50 dBFS, same as audio-test
/** where enterPhase('intermission') starts the cue (audio.ts) */
const INTERMISSION_START = 0.4;

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
        const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
      }
    }
  }
}

const mono = (buf: AudioBuffer): Float32Array => {
  if (buf.numberOfChannels < 2) return buf.getChannelData(0);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const m = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) / 2;
  return m;
};

/** % of the spectral energy below `cut` Hz, Hann-windowed 4096-point frames over the sounding part */
function shareBelow(x: Float32Array, cut: number): number {
  const n = 4096;
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > THRESH) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return 0;
  let lo = 0;
  let tot = 0;
  // anything shorter than a frame gets one frame centred on it (not at the
  // frame's edge, where the window would zero it)
  const short = last - first < n;
  for (let c = short ? Math.round((first + last) / 2) : first + n / 2; c < (short ? Math.round((first + last) / 2) + 1 : last); c += n / 2) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = c - n / 2 + i;
      re[i] = (k >= 0 && k < x.length ? x[k] : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    fft(re, im);
    for (let i = 1; i < n / 2; i++) {
      const e = re[i] * re[i] + im[i] * im[i];
      tot += e;
      if ((i * SR) / n < cut) lo += e;
    }
  }
  return tot ? Math.round((1000 * lo) / tot) / 10 : 0;
}

function peakOf(buf: AudioBuffer): number {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) p = Math.max(p, Math.abs(v));
  return Math.round(p * 1000) / 1000;
}

function lastSounding(x: Float32Array): number {
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > THRESH) return i / SR;
  return 0;
}

// --------------------------------------------------------------- render ----

function songSteps(def: SongDef): number {
  const song = compileSong(def);
  let steps = 0;
  for (const o of def.order) steps += song.patterns.get(o)!.steps;
  return steps;
}

async function renderSong(def: SongDef, opts: { solo?: ChannelName; t0?: number; tail?: number; safetyClip?: boolean; fadeIn?: number; dry?: boolean } = {}): Promise<{ buf: AudioBuffer; player: MusicPlayer }> {
  const song = compileSong(def);
  const t0 = opts.t0 ?? 0.3; // let the master chain settle
  const dur = t0 + songSteps(def) * song.stepDur + (opts.tail ?? 1.5);
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * dur), SR);
  const core = new AudioCore(ctx, { seed: 7, safetyClip: opts.safetyClip });
  if (opts.dry) core.echoIn.gain.value = 0;
  // as AudioEngine.playCue does: the echo repeats on the song's 8th notes
  core.setEchoTempo(def.bpm, 0);
  const player = new MusicPlayer(core, song, t0, { solo: opts.solo, fadeIn: opts.fadeIn });
  player.pump(dur);
  return { buf: await ctx.startRendering(), player };
}

async function renderKick(): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, SR, SR);
  const core = new AudioCore(ctx, { seed: 7 });
  DRUMS.k(core, core.music, 0.3, 1);
  return (await ctx.startRendering()).getChannelData(0);
}

// ---------------------------------------------------------------- swing ----

/**
 * Onset of the note expected near `t` (straight-grid time): where the level
 * first climbs halfway from what was sounding 10 ms before `t` to the note's
 * peak within one step. Measured from that floor, the previous note's
 * ringing tail doesn't count as an attack. The level is the RMS over a
 * trailing 24 ms: longer than a period of the lowest bass note and than the
 * beating inside a close-voiced chord, both of which would otherwise wobble
 * across the threshold. Its fixed lag cancels out of the swing delay, which
 * is a difference of two onsets.
 */
function onsetNear(cum: Float64Array, t: number, stepDur: number): number {
  const win = Math.round(SR * 0.024);
  const hop = Math.round(SR * 0.00025);
  const from = Math.max(win, Math.floor((t - 0.01) * SR));
  const to = Math.min(cum.length - 1, Math.floor((t + stepDur) * SR));
  const level = (s: number) => Math.sqrt(Math.max(0, cum[s] - cum[s - win]) / win);
  const floor = level(from);
  let peak = floor;
  for (let s = from; s < to; s += hop) peak = Math.max(peak, level(s));
  const thr = floor + 0.5 * (peak - floor);
  for (let s = from; s < to; s += hop) if (level(s) >= thr) return s / SR;
  return to / SR;
}

/** running sum of x^2 (cum[i] = sum of x[0..i-1]^2) for O(1) windowed RMS */
function energySum(x: Float32Array): Float64Array {
  const cum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cum[i + 1] = cum[i] + x[i] * x[i];
  return cum;
}

interface SwingRow {
  song: string;
  channel: ChannelName;
  grid: string;
  /** expected and measured delay of the swung notes vs the on-beats, ms */
  want: number;
  got: number;
  ratio: number;
  n: number;
}

/**
 * Delay of the swung notes against the on-beats, as heard. `grid` is the
 * grid the song is written on (which positions to compare); `def` may force
 * a different swing grid to measure what the song would sound like with it.
 */
async function measureSwing(def: SongDef, channel: ChannelName, label: string, grid: 8 | 16 = def.swingGrid ?? 16): Promise<SwingRow> {
  const song = compileSong(def);
  const t0 = 0.3;
  // Rendered dry and with a short gate on chords: the previous note's echo
  // repeats (172/184 ms) and two chords sharing a note interfering while the
  // first rings out both read as late attacks. Swing moves the note start,
  // which neither the echo nor the gate touches.
  const cd = def.channels[channel];
  const solo = channel === 'harm' && cd ? { ...def, channels: { ...def.channels, harm: { ...cd, gate: 0.25 } } } : def;
  const cum = energySum(mono((await renderSong(solo, { solo: channel, t0, tail: 0.5, dry: true })).buf));
  const sd = song.stepDur;
  const swungPos = grid === 8 ? 2 : 1;
  const unit = grid === 8 ? 4 : 2; // steps per swing pair
  const on: number[] = [];
  const off: number[] = [];
  let base = 0;
  for (const o of def.order) {
    const pat = song.patterns.get(o)!;
    for (const e of pat.channels[channel] ?? []) {
      const pos = e.step % unit;
      if (pos !== 0 && pos !== swungPos) continue;
      const t = t0 + (base + e.step) * sd;
      (pos === 0 ? on : off).push(onsetNear(cum, t, sd) - t);
    }
    base += pat.steps;
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const d = mean(off) - mean(on);
  const want = swingOffset(def, swungPos, sd);
  const half = (unit / 2) * sd;
  return { song: def.name, channel, grid: label, want: Math.round(want * 1000), got: Math.round(d * 1000), ratio: Math.round(((half + d) / (half - d)) * 100) / 100, n: off.length };
}

// ----------------------------------------------------------------- main ----

const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

export interface MusicReport {
  failures: string[];
  table: string;
  lowEnd: Record<string, number>;
  swing: SwingRow[];
  intermission: Record<string, number | string | boolean>;
}

export async function musicChecks(): Promise<MusicReport> {
  const failures: string[] = [];
  const lines: string[] = ['MUSIC'];

  // ---- low end
  const theme = SONGS.theme;
  const full = await renderSong(theme);
  const fullRaw = await renderSong(theme, { safetyClip: false });
  const bass = await renderSong(theme, { solo: 'bass' });
  const kick = await renderKick();
  // the master chain's lookahead delays it ~16 ms: measure from where it sounds
  const kickAt = Math.max(0, kick.findIndex((v) => Math.abs(v) > THRESH));
  const lowEnd = {
    themeBelow250: shareBelow(mono(full.buf), 250),
    themeBelow120: shareBelow(mono(full.buf), 120),
    bassBelow120: shareBelow(mono(bass.buf), 120),
    bassBelow250: shareBelow(mono(bass.buf), 250),
    kickBelow120: shareBelow(kick, 120),
    // the first 15 ms: the beater click against the start of the body
    kickClick: Math.round((100 - shareBelow(kick.slice(kickAt, kickAt + Math.round(0.015 * SR)), 1000)) * 10) / 10,
    peak: peakOf(full.buf),
    rawPeak: peakOf(fullRaw.buf),
  };
  lines.push(
    `theme  < 250 Hz ${lowEnd.themeBelow250}% (max 45)   < 120 Hz ${lowEnd.themeBelow120}%   peak ${lowEnd.peak} raw ${lowEnd.rawPeak}`,
    `bass   < 120 Hz ${lowEnd.bassBelow120}% (max 50)   < 250 Hz ${lowEnd.bassBelow250}%`,
    `kick   < 120 Hz ${lowEnd.kickBelow120}%   > 1 kHz in the first 15 ms ${lowEnd.kickClick}% (info)`,
  );
  if (lowEnd.themeBelow250 >= 45) failures.push(`music low end: theme has ${lowEnd.themeBelow250}% of its energy below 250 Hz (max 45)`);
  if (lowEnd.bassBelow120 >= 50) failures.push(`music low end: theme bass has ${lowEnd.bassBelow120}% of its energy below 120 Hz (max 50)`);
  if (lowEnd.peak > 0.95 || lowEnd.rawPeak > 0.95) failures.push(`music low end: theme clips (peak ${lowEnd.peak}, raw ${lowEnd.rawPeak})`);

  // ---- swing
  const swing: SwingRow[] = [];
  for (const name of Object.keys(SONGS) as SongName[]) {
    const def = SONGS[name] as SongDef;
    if (!def.swing) continue;
    for (const ch of ['drums', 'harm', 'bass'] as const) {
      if (!def.channels[ch]) continue;
      const row = await measureSwing(def, ch, `grid ${def.swingGrid ?? 16}`);
      swing.push(row);
      if (row.n < 3) continue; // nothing on the swung position in this channel
      const tol = ch === 'drums' ? 4 : 10;
      if (Math.abs(row.got - row.want) > tol || row.ratio < 1.25) failures.push(`music swing: ${name}/${ch} swung notes ${row.got} ms late (want ${row.want} +-${tol}, ratio ${row.ratio})`);
    }
    // what it sounded like before swingGrid existed: an 8th-grid song
    // swinging odd 16ths it doesn't have, i.e. straight
    if (def.swingGrid === 8) swing.push(await measureSwing({ ...def, swingGrid: 16 }, 'drums', 'grid 16 (old)', 8));
  }
  lines.push('swing      channel grid               want  got  ratio  n');
  for (const r of swing) lines.push(`${r.song.padEnd(10)} ${r.channel.padEnd(7)} ${r.grid.padEnd(18)} ${String(r.want).padStart(4)} ${String(r.got).padStart(4)}  ${r.ratio.toFixed(2).padStart(5)} ${String(r.n).padStart(2)}`);

  // ---- intermission fit
  const def = SONGS.intermission as SongDef;
  const song = compileSong(def);
  const phase = RULES.intermissionTime;
  const length = songSteps(def) * song.stepDur;
  const r = await renderSong(def, { t0: INTERMISSION_START, tail: Math.max(0.5, phase + 1 - INTERMISSION_START - length), fadeIn: 1.2 });
  const tail = lastSounding(mono(r.buf));
  const lastPat = song.patterns.get(def.order[def.order.length - 1])!;
  const lastNote = (ch: ChannelName) => {
    const ev = lastPat.channels[ch] ?? [];
    const e = ev[ev.length - 1];
    return e ? e.midi[0] % 12 : -1;
  };
  const tonic = PC[def.key.replace(/m$/, '')];
  const chords = (def.patterns[def.order[def.order.length - 1]].chords ?? '').trim().split(/[\s,]+/);
  const lastChord = chords[chords.length - 1] ?? '';
  const chordRoot = PC[/^([A-G][#b]?)/.exec(lastChord)?.[1] ?? ''];
  const onTonic = def.loop === null && lastNote('lead') === tonic && lastNote('bass') === tonic && chordRoot === tonic;
  const intermission = {
    bpm: def.bpm,
    length: Math.round(length * 100) / 100,
    ends: Math.round((INTERMISSION_START + length) * 100) / 100,
    audibleUntil: Math.round(tail * 100) / 100,
    phase,
    lastChord,
    onTonic,
  };
  lines.push(`intermission ${def.bpm} bpm  ${intermission.length} s, starts ${INTERMISSION_START} -> ends ${intermission.ends} s, audible until ${intermission.audibleUntil} s (phase ${phase} s), last chord ${lastChord}, tonic ${onTonic}`);
  if (INTERMISSION_START + length > phase) failures.push(`intermission cue: 0.4 + ${intermission.length} s > ${phase} s phase`);
  if (tail > phase) failures.push(`intermission cue: still audible at ${intermission.audibleUntil} s (phase ends ${phase} s)`);
  if (!onTonic) failures.push(`intermission cue: does not end on the tonic (one-shot ${def.loop === null}, last chord ${lastChord})`);

  return { failures, table: lines.join('\n'), lowEnd, swing, intermission };
}
