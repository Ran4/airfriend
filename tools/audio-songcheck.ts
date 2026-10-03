// Music-theory lint for src/audio/songs.ts. Run: npx tsx tools/audio-songcheck.ts
//
// - compiles every song (bar lengths, channel lengths, note names)
// - every note must be in the song's key (plus declared accidentals)
// - harmony and bass notes must be chord tones of the bar's chord symbol
// - lead notes that are NOT chord tones are listed when they fall on a beat
//   and last >= an 8th (a sustained dissonance is usually a typo; quick
//   passing/neighbor tones are fine)
// Exit code 1 on errors.

import { CHANNELS, compileSong, type ChannelName } from '../src/audio/sequencer';
import { SONGS } from '../src/audio/songs';

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

const QUALITIES: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
};

function chordPcs(sym: string): number[] {
  const m = /^([A-G][#b]?)(.*)$/.exec(sym);
  if (!m || !(m[1] in PC) || !(m[2] in QUALITIES)) throw new Error(`unknown chord "${sym}"`);
  return QUALITIES[m[2]].map((i) => (PC[m[1]] + i) % 12);
}

function scalePcs(key: string): number[] {
  const minor = key.endsWith('m');
  const root = PC[minor ? key.slice(0, -1) : key];
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return steps.map((s) => (root + s) % 12);
}

let errors = 0;
let warnings = 0;
for (const def of Object.values(SONGS)) {
  let song;
  try {
    song = compileSong(def);
  } catch (e) {
    console.log(`ERROR ${def.name}: ${(e as Error).message}`);
    errors++;
    continue;
  }
  const scale = new Set([...scalePcs(def.key), ...(def.accidentals ?? []).map((a) => PC[a])]);
  const spb = def.stepsPerBeat ?? 4;
  const bar = spb * (def.beatsPerBar ?? 4);
  let totalSteps = 0;
  let notes = 0;
  for (const name of def.order) totalSteps += song.patterns.get(name)!.steps;
  for (const [pname, pat] of song.patterns) {
    const chordBars = (def.patterns[pname].chords ?? '').trim().split(/\s+/).filter(Boolean);
    const chordAt = (step: number): number[] | null => {
      const b = chordBars[Math.floor(step / bar)];
      if (!b) return null;
      const parts = b.split(',');
      const within = step % bar;
      return chordPcs(parts[Math.min(parts.length - 1, Math.floor((within / bar) * parts.length))]);
    };
    for (const ch of CHANNELS) {
      if (ch === 'drums') continue;
      for (const e of pat.channels[ch as ChannelName] ?? []) {
        for (const m of e.midi) {
          notes++;
          const pc = m % 12;
          const where = `${def.name}/${pname}/${ch} bar ${Math.floor(e.step / bar) + 1} step ${(e.step % bar) + 1} ${NAMES[pc]}${Math.floor(m / 12) - 1}`;
          if (!scale.has(pc)) {
            console.log(`ERROR out of key (${def.key}): ${where}`);
            errors++;
          }
          const chord = chordAt(e.step);
          if (!chord) continue;
          if (chord.includes(pc)) continue;
          const strong = e.step % spb === 0 && e.len >= 2;
          if (ch === 'harm' || (ch === 'bass' && strong)) {
            console.log(`ERROR non-chord tone in ${ch}: ${where} (chord tones ${chord.map((c) => NAMES[c]).join(' ')})`);
            errors++;
          } else if (ch === 'lead' && strong) {
            console.log(`warn  lead non-chord tone on a beat: ${where}`);
            warnings++;
          }
        }
      }
    }
  }
  const secs = totalSteps * song.stepDur;
  console.log(`ok    ${def.name.padEnd(13)} ${def.key.padEnd(3)} ${String(def.bpm).padStart(3)} bpm  ${(totalSteps / bar).toFixed(2)} bars  ${secs.toFixed(2)} s  ${notes} notes${def.loop !== null ? '  (loops)' : ''}`);
}
console.log(`\n${errors} errors, ${warnings} warnings`);
process.exit(errors ? 1 : 0);
