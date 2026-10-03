// Tracker-style music sequencer.
//
// A song is a list of patterns played in `order`. Each pattern has up to five
// channels written as step strings (16 steps per 4/4 bar by default):
//
//   melodic:  'C5:2 E5:2 G5:4 -:8 | ...'   note[:steps]  '+' stacks a chord (C4+E4+G4)
//             '.' holds the previous note, '-' is a rest, '|' marks a bar line
//             a trailing '!' accents the note (C5!:2)
//   drums:    'k:4 s:4 kc:4 kc:4'          one char per drum (see synth DRUMS), '-' rest
//
// compileSong() turns that into note events and validates bar lengths, so a
// typo fails loudly in tools/audio-songcheck.ts instead of drifting the groove.
// MusicPlayer schedules events ahead of time against the AudioContext clock
// (the "lookahead scheduler" pattern): pump(until) is called often and
// schedules every step that starts before `until`. Steps whose time already
// passed during a stall (a hitch, a throttled timer) are skipped, not played
// late in a clump.

import type { AudioCore } from './core';
import { DRUMS, INSTRUMENTS, type InstrumentName } from './synth';

export type ChannelName = 'lead' | 'harm' | 'arp' | 'bass' | 'drums';
export const CHANNELS: ChannelName[] = ['lead', 'harm', 'arp', 'bass', 'drums'];

interface PatternDef {
  /** chord symbols for the theory checker, one token per bar ('C,Am' = half bars) */
  chords?: string;
  lead?: string;
  harm?: string;
  arp?: string;
  bass?: string;
  drums?: string;
}

interface ChannelDef {
  inst: InstrumentName | 'drums';
  vol: number;
  /** gate as a fraction of the written length (organ riffs want a bit of air) */
  gate?: number;
}

export interface SongDef {
  name: string;
  bpm: number;
  stepsPerBeat?: number; // default 4 (16th-note grid)
  beatsPerBar?: number; // default 4
  /** 0..0.5: how far the swung note is pushed late, as a fraction of its grid unit */
  swing?: number;
  /**
   * which subdivision swings (default 16): 16 delays odd 16th steps by
   * swing * step; 8 swings the 8th notes, delaying the off-beat 8th
   * (step % 4 === 2) by swing * 2 steps. Songs written on an 8th grid need
   * 8, or they play straight however much swing they ask for.
   */
  swingGrid?: 8 | 16;
  key: string; // e.g. 'C', 'F', 'Am' - used by the checker
  /** extra pitch classes allowed by the checker (borrowed chords, blues notes) */
  accidentals?: string[];
  /** order index to jump back to at the end, or null for a one-shot */
  loop: number | null;
  order: string[];
  channels: Partial<Record<ChannelName, ChannelDef>>;
  patterns: Record<string, PatternDef>;
}

interface NoteEvent {
  step: number;
  len: number; // steps
  midi: number[]; // melodic: one or more notes; drums: empty
  drums: string; // drum chars (drums channel only)
  accent: boolean;
}

interface CompiledPattern {
  name: string;
  steps: number;
  channels: Partial<Record<ChannelName, NoteEvent[]>>;
}

export interface CompiledSong {
  def: SongDef;
  stepDur: number;
  patterns: Map<string, CompiledPattern>;
}

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteToMidi(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note "${name}"`);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + acc;
}

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

interface Token {
  body: string; // note(s), drum chars, '.', '-'
  len: number;
  bar: number;
}

function tokenize(src: string): { tokens: Token[]; barLens: number[] } {
  const tokens: Token[] = [];
  const barLens: number[] = [0];
  for (const raw of src.trim().split(/\s+/)) {
    if (raw === '|') {
      barLens.push(0);
      continue;
    }
    const [body, n] = raw.split(':');
    const len = n === undefined ? 1 : Number(n);
    if (!Number.isInteger(len) || len < 1) throw new Error(`bad length in token "${raw}"`);
    tokens.push({ body, len, bar: barLens.length - 1 });
    barLens[barLens.length - 1] += len;
  }
  return { tokens, barLens };
}

function compileChannel(src: string, drums: boolean, ctx: string, barSteps: number): { events: NoteEvent[]; steps: number } {
  const { tokens, barLens } = tokenize(src);
  barLens.forEach((l, i) => {
    // a final partial bar is allowed for tails, but only in whole beats
    const last = i === barLens.length - 1;
    const ok = last ? l > 0 && l <= barSteps && l % (barSteps / 4) === 0 : l === barSteps;
    if (!ok) throw new Error(`${ctx}: bar ${i + 1} has ${l} steps, expected ${barSteps}`);
  });
  const events: NoteEvent[] = [];
  let step = 0;
  let cur: NoteEvent | null = null;
  for (const t of tokens) {
    if (t.body === '.') {
      if (cur) cur.len += t.len;
    } else if (t.body === '-') {
      cur = null;
    } else {
      const accent = t.body.endsWith('!');
      const body = accent ? t.body.slice(0, -1) : t.body;
      if (drums) {
        for (const ch of body) if (!DRUMS[ch]) throw new Error(`${ctx}: unknown drum "${ch}"`);
        cur = { step, len: t.len, midi: [], drums: body, accent };
      } else {
        cur = { step, len: t.len, midi: body.split('+').map(noteToMidi), drums: '', accent };
      }
      events.push(cur);
    }
    step += t.len;
  }
  return { events, steps: step };
}

export function compileSong(def: SongDef): CompiledSong {
  const spb = def.stepsPerBeat ?? 4;
  const barSteps = spb * (def.beatsPerBar ?? 4);
  const patterns = new Map<string, CompiledPattern>();
  for (const [name, p] of Object.entries(def.patterns)) {
    let steps = -1;
    const channels: CompiledPattern['channels'] = {};
    for (const ch of CHANNELS) {
      const src = p[ch];
      if (!src) continue;
      if (!def.channels[ch]) throw new Error(`${def.name}/${name}: channel ${ch} has no instrument`);
      // patterns may end on a partial bar (tails); only full bars are checked
      const c = compileChannel(src, ch === 'drums', `${def.name}/${name}/${ch}`, barSteps);
      if (steps >= 0 && c.steps !== steps) throw new Error(`${def.name}/${name}: ${ch} has ${c.steps} steps, others ${steps}`);
      steps = c.steps;
      channels[ch] = c.events;
    }
    patterns.set(name, { name, steps: Math.max(0, steps), channels });
  }
  for (const o of def.order) if (!patterns.has(o)) throw new Error(`${def.name}: order references missing pattern ${o}`);
  return { def, stepDur: 60 / def.bpm / spb, patterns };
}

/**
 * Swing offset (seconds) of a step within its beat. Shared by MusicPlayer and
 * tools/audio-test's transcription check so both agree on when a note sounds.
 * On the 8th grid the beat's first half is stretched and the second squeezed:
 * the off-beat 8th moves late by d = swing * 2 steps, and the 16ths either
 * side of it move by d/2, keeping them evenly inside their half.
 */
export function swingOffset(def: SongDef, step: number, stepDur: number): number {
  const swing = def.swing ?? 0;
  if (!swing) return 0;
  if (def.swingGrid === 8) {
    const pos = step % 4;
    const d = swing * 2 * stepDur;
    return pos === 2 ? d : pos === 0 ? 0 : d / 2;
  }
  return step % 2 === 1 ? swing * stepDur : 0;
}

/**
 * A step that should have started more than this long ago is dropped: a note
 * up to 30 ms late still sounds on the beat, later ones would smear the
 * groove (a 1 s stall used to fire ~30 notes in one 20 ms burst).
 */
export const LATE_STEP = 0.03;

/**
 * Plays one compiled song through its own gain node (so it can fade out while
 * another song fades in). Organ voices go through a per-player leslie stage.
 */
export class MusicPlayer {
  readonly song: CompiledSong;
  readonly out: GainNode;
  private organIn: GainNode;
  private trem: GainNode;
  private pan: StereoPannerNode;
  private disposed = false;
  private core: AudioCore;
  private orderIdx: number;
  private step = 0;
  private nextTime: number;
  private stopAt = Infinity;
  private pausedAt: number | null = null;
  /** context time the song finishes (one-shots), once known */
  endTime: number | null = null;
  readonly startTime: number;
  /** play only this channel (tools/audio-test transcription check) */
  private solo: ChannelName | null;

  constructor(core: AudioCore, song: CompiledSong, startTime: number, opts: { orderIdx?: number; vol?: number; fadeIn?: number; solo?: ChannelName } = {}) {
    this.solo = opts.solo ?? null;
    this.core = core;
    this.song = song;
    this.orderIdx = Math.max(0, Math.min(song.def.order.length - 1, opts.orderIdx ?? 0));
    this.nextTime = startTime;
    this.startTime = startTime;
    const ctx = core.ctx;
    this.out = ctx.createGain();
    const vol = opts.vol ?? 1;
    if (opts.fadeIn) {
      this.out.gain.setValueAtTime(0, startTime);
      this.out.gain.linearRampToValueAtTime(vol, startTime + opts.fadeIn);
    } else {
      this.out.gain.value = vol;
    }
    this.out.connect(core.music);
    // leslie: amplitude wobble + gentle auto-pan
    this.organIn = ctx.createGain();
    this.trem = ctx.createGain();
    this.trem.gain.value = 0.88;
    core.leslieTrem.connect(this.trem.gain);
    this.pan = ctx.createStereoPanner();
    core.lesliePan.connect(this.pan.pan);
    this.organIn.connect(this.trem).connect(this.pan).connect(this.out);
  }

  /** current order index (the pattern that will play next) */
  get position(): number {
    return this.orderIdx;
  }

  get stopped(): boolean {
    return this.stopAt !== Infinity;
  }

  /** true once the music has fully ended (one-shot finished or fade complete) */
  finished(now: number): boolean {
    if (this.stopAt !== Infinity) return now > this.stopAt + 0.1;
    return this.endTime !== null && now > this.endTime + 1.5;
  }

  pause(now: number): void {
    if (this.pausedAt === null) this.pausedAt = now;
  }

  resume(now: number): void {
    if (this.pausedAt === null) return;
    // shift the timeline so the song continues where it was
    this.nextTime = Math.max(now + 0.03, this.nextTime + (now - this.pausedAt));
    this.pausedAt = null;
  }

  /** Fade out and stop scheduling. */
  stop(t: number, fade = 0.3): void {
    if (this.stopAt !== Infinity) return;
    this.stopAt = t + fade;
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
  }

  /** Unhook from the shared LFOs and the bus (call once finished). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.core.leslieTrem.disconnect(this.trem.gain);
    this.core.lesliePan.disconnect(this.pan.pan);
    this.out.disconnect();
  }

  /** Schedule every step that starts before `until` (skipping ones already too late). */
  pump(until: number): void {
    if (this.pausedAt !== null || this.endTime !== null) return;
    const def = this.song.def;
    const sd = this.song.stepDur;
    const tooLate = this.core.now() - LATE_STEP;
    while (this.nextTime < until && this.nextTime < this.stopAt) {
      const pat = this.song.patterns.get(def.order[this.orderIdx])!;
      const t = this.nextTime + swingOffset(def, this.step, sd);
      // missed during a stall: advance the position without scheduling
      if (t >= tooLate) this.scheduleStep(pat, t);
      this.step++;
      this.nextTime += sd;
      if (this.step >= pat.steps) {
        this.step = 0;
        this.orderIdx++;
        if (this.orderIdx >= def.order.length) {
          if (def.loop === null) {
            this.endTime = this.nextTime;
            return;
          }
          this.orderIdx = def.loop;
        }
      }
    }
  }

  private scheduleStep(pat: CompiledPattern, t: number): void {
    const def = this.song.def;
    const sd = this.song.stepDur;
    for (const ch of CHANNELS) {
      const events = pat.channels[ch];
      const cd = def.channels[ch];
      if (!events || !cd || (this.solo && ch !== this.solo)) continue;
      for (const e of events) {
        if (e.step !== this.step) continue;
        const vel = cd.vol * (e.accent ? 1.25 : 1);
        if (ch === 'drums') {
          for (const d of e.drums) DRUMS[d](this.core, this.out, t, vel);
        } else {
          const inst = INSTRUMENTS[cd.inst as InstrumentName];
          const dest = cd.inst === 'organ' || cd.inst === 'organChord' ? this.organIn : this.out;
          const dur = Math.max(0.03, e.len * sd * (cd.gate ?? 0.92));
          for (const m of e.midi) inst(this.core, dest, t, midiToFreq(m), dur, vel);
        }
      }
    }
  }
}
