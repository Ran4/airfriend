// The soundtrack, as tracker data (format: see sequencer.ts).
// 16 steps per bar. Chord symbols are documentation for humans and for
// tools/audio-songcheck.ts, which checks every note against key and chord.
//
// Cues:
//   THEME         arena organ "LET'S GO PUPS!" theme: intro + stoppages (C major, 150)
//   CHARGE        the stadium bugle call + crowd "CHARGE!" (C major, 160)
//   GOAL          brass fanfare that answers the goal horn (D major, 168;
//                 the horn is an A major chord, i.e. V of D, so it resolves)
//   INTERMISSION  swung I-vi-IV-iii-ii-V-I one-shot that fits the 9 s break (F, 106)
//   VICTORY       fanfare ending on the bVI-bVII-I "level clear" cadence (C, 132)
//   DEFEAT        sad organ + "wah wah wah wahhh" trombone (A minor, 96)
//   TIE           same opening, resolves to A major instead (Picardy third)

import type { SongDef } from './sequencer';

// ---------------------------------------------------------------- THEME ----
// Two-bar riffs. Stoppages are short (~3 s), so each stoppage starts at the
// next riff in the rotation and the arena organist never repeats himself.
const THEME: SongDef = {
  name: 'theme',
  bpm: 150,
  key: 'C',
  accidentals: ['Bb', 'Ab', 'Eb'],
  loop: 1,
  order: ['intro', 'chantA', 'chantB', 'chantA', 'walk1', 'walk2', 'build'],
  channels: {
    lead: { inst: 'organ', vol: 1, gate: 0.85 },
    harm: { inst: 'organChord', vol: 1, gate: 0.9 },
    bass: { inst: 'bass', vol: 1, gate: 0.8 },
    drums: { inst: 'drums', vol: 0.9 },
  },
  patterns: {
    // fanfare flourish: C arpeggio up, G7 back down into the chant
    intro: {
      chords: 'C G7',
      lead: 'C5:2 E5:2 G5:2 C6:2 E6!:6 -:2 | D6:2 -:2 B5:2 -:2 G5:2 -:2 F5:2 D5:2',
      harm: 'C4+E4+G4:8 C4+E4+G4:6 -:2 | B3+D4+F4:4 -:4 B3+D4+F4:4 G3+B3+D4+F4:4',
      bass: 'C2:4 C3:4 C2:4 C3:4 | G2:4 G3:4 G2:4 B2:4',
      drums: 'kx:4 s:4 k:2 k:2 s:4 | k:4 s:4 k:2 s:1 s:1 s:1 s:1 s:1 s:1',
    },
    // "Let's - go - PUPS! (clap) (clap)" - the hook sits an octave above the
    // chord stabs so it never hides inside them
    chantA: {
      chords: 'C G',
      lead: 'G5:2 G5:2 C6!:4 -:8 | G5:2 G5:2 D6!:4 -:8',
      harm: 'C4+E4+G4:4 -:4 C4+E4+G4:2 -:2 C4+E4+G4:2 -:2 | B3+D4+G4:4 -:4 B3+D4+G4:2 -:2 B3+D4+G4:2 -:2',
      bass: 'C2:4 -:4 C2:2 -:2 C2:2 -:2 | G2:4 -:4 G2:2 -:2 G2:2 -:2',
      drums: 'k:4 s:4 kc:4 kc:4 | k:4 s:4 kc:4 kc:4',
    },
    chantB: {
      chords: 'Am F,G',
      lead: 'A5:2 A5:2 E6!:4 -:8 | F5:2 F5:2 C6!:4 -:4 B5:2 D6:2',
      harm: 'A3+C4+E4:4 -:4 A3+C4+E4:2 -:2 A3+C4+E4:2 -:2 | A3+C4+F4:4 -:4 B3+D4+G4:2 -:2 B3+D4+G4:2 -:2',
      bass: 'A2:4 -:4 A2:2 -:2 A2:2 -:2 | F2:4 -:4 G2:2 -:2 G2:2 -:2',
      drums: 'k:4 s:4 kc:4 kc:4 | k:4 s:4 kc:2 s:1 s:1 kc:2 s:1 s:1',
    },
    // ballpark-organ arpeggios over I-vi-ii-V with a walking bass
    walk1: {
      chords: 'C,Am Dm,G7',
      lead: 'E5:2 G5:2 C6:2 G5:2 A5:2 C6:2 E6:2 C6:2 | F5:2 A5:2 D6:2 A5:2 G5:2 B5:2 D6:2 F6:2',
      harm: 'C4+E4+G4:8 A3+C4+E4:8 | A3+D4+F4:8 G3+B3+D4+F4:8',
      bass: 'C2:4 E2:4 A2:4 C2:4 | D2:4 F2:4 G2:4 B2:4',
      drums: 'k:2 h:2 s:2 h:2 k:2 h:2 s:2 h:2 | k:2 h:2 s:2 h:2 k:2 h:2 s:2 s:1 s:1',
    },
    // I - I7 - IV - iv7: the minor iv is the bittersweet "organ" move
    walk2: {
      chords: 'C,C7 F,Fm7',
      lead: 'E6:4 C6:2 G5:2 Bb5:4 G5:2 E5:2 | A5:2 C6:2 F6:4 F6:2 Eb6:2 C6:2 Ab5:2',
      harm: 'C4+E4+G4:8 Bb3+E4+G4:8 | A3+C4+F4:8 Ab3+C4+F4:8',
      bass: 'C2:4 G2:4 C2:4 Bb2:4 | F2:4 A2:4 F2:4 Ab2:4',
      drums: 'k:2 h:2 s:2 h:2 k:2 h:2 s:2 h:2 | k:2 h:2 s:2 h:2 k:2 s:2 t:2 t:2',
    },
    // chromatic climb over a G pedal: the classic hockey-organ tension build
    build: {
      chords: 'G7 G7',
      lead: 'G4:2 G4:2 Ab4:2 Ab4:2 A4:2 A4:2 Bb4:2 Bb4:2 | B4:2 B4:2 C5:2 C5:2 D5:2 D5:2 F5:2 G5!:2',
      harm: 'G3+B3+F4:16 | G3+B3+D4+F4:16',
      bass: 'G2:2 G3:2 G2:2 G3:2 G2:2 G3:2 G2:2 G3:2 | G2:2 G3:2 G2:2 G3:2 G2:2 G3:2 G2:2 G3:2',
      drums: 'k:2 s:2 k:2 s:2 k:2 s:2 k:2 s:2 | ks:2 s:2 ks:2 s:2 s:1 s:1 s:1 s:1 s:1 s:1 s:1 s:1',
    },
  },
};

// --------------------------------------------------------------- CHARGE ----
// "da-da-da DAAH, da DAAAAH ... CHARGE!"
const CHARGE: SongDef = {
  name: 'charge',
  bpm: 160,
  key: 'C',
  loop: null,
  order: ['charge'],
  channels: {
    lead: { inst: 'organ', vol: 1.1, gate: 0.9 },
    harm: { inst: 'organChord', vol: 1.1 },
    bass: { inst: 'bass', vol: 1 },
    drums: { inst: 'drums', vol: 1 },
  },
  patterns: {
    charge: {
      chords: 'C C',
      lead: 'G5:2 C6:2 E6:2 G6!:5 E6:1 G6!:4 | .:6 -:10',
      harm: 'C4+E4:2 C4+E4:2 C4+G4:2 C4+E4+G4:10 | C4+E4+G4:6 -:2 E4+G4+C5!:4 -:4',
      bass: 'C2:6 G2:4 C2:6 | C2:8 C2:4 -:4',
      drums: 'k:2 k:2 k:2 ks:4 s:1 s:1 ks:4 | x:8 kcY:4 -:4',
    },
  },
};

// ----------------------------------------------------------------- GOAL ----
const GOAL: SongDef = {
  name: 'goal',
  bpm: 168,
  key: 'D',
  loop: null,
  order: ['fanfare'],
  channels: {
    lead: { inst: 'brass', vol: 1.15 },
    harm: { inst: 'brass', vol: 0.5 },
    arp: { inst: 'sparkle', vol: 0.8 },
    bass: { inst: 'bass', vol: 1 },
    drums: { inst: 'drums', vol: 0.95 },
  },
  patterns: {
    fanfare: {
      chords: 'D G,A D',
      lead: 'D5:2 F#5:1 A5:1 D6!:4 A5:2 D6:2 F#6:4 | G6:3 F#6:1 E6:2 D6:2 E6:4 C#6:2 A5:2 | D6!:12 -:4',
      harm: 'D4+F#4+A4:8 D4+F#4+A4:8 | D4+G4+B4:8 C#4+E4+A4:8 | D4+F#4+A4+D5:12 -:4',
      arp: 'D5 F#5 A5 D6 D5 F#5 A5 D6 D5 F#5 A5 D6 D5 F#5 A5 D6 | G5 B5 D6 G6 G5 B5 D6 G6 A5 C#6 E6 A6 A5 C#6 E6 A6 | D6 A5 F#5 D5 D6 A5 F#5 D5 -:8',
      bass: 'D2:2 D3:2 D2:2 D3:2 D2:2 D3:2 D2:2 D3:2 | G2:2 G3:2 G2:2 G3:2 A2:2 A3:2 A2:2 A3:2 | D2:12 -:4',
      drums: 'kx:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2 | k:2 h:2 s:2 h:2 k:2 s:1 s:1 s:1 s:1 s:1 s:1 | kx:12 -:4',
    },
  },
};

// --------------------------------------------------------- INTERMISSION ----
// A one-shot that fits the 9.0 s intermission (RULES.intermissionTime). The
// engine starts it 0.4 s in, so the song is 3.5 bars at 106 bpm = 7.9 s and
// lands on the tonic at 6.8 s: I-vi | IV-iii | ii-V | I, then the epiano and
// the echo ring out before the period-opener riff takes over. It is written
// on an 8th grid and swings 8ths (swingGrid 8): every off-beat 8th (the
// ride's "da", the comping push, the bass pickups) sits late.
const push = (a: string, b: string) => `${a}:2 -:4 ${a}:2 ${b}:2 -:4 ${b}:2`; // Charleston comp, one chord per half bar
const ride = 'kh:4 rh:2 h:2 kh:4 rh:2 h:2'; // "ding, ding-da ding, ding-da"

const INTERMISSION: SongDef = {
  name: 'intermission',
  bpm: 106,
  swing: 0.17,
  swingGrid: 8,
  key: 'F',
  loop: null,
  order: ['head', 'tag'],
  channels: {
    lead: { inst: 'softLead', vol: 1 },
    harm: { inst: 'epiano', vol: 1 },
    bass: { inst: 'bass', vol: 0.85, gate: 0.85 },
    drums: { inst: 'drums', vol: 0.55 },
  },
  patterns: {
    head: {
      chords: 'Fmaj7,Dm7 Bbmaj7,Am7 Gm7,C7',
      lead: 'A4:2 C5:2 E5:2 G5:2 F5:4 D5:2 A4:2 | D5:2 F5:2 A5:4 G5:2 E5:2 C5:2 E5:2 | Bb5:2 A5:2 G5:2 F5:2 E5:2 G5:2 Bb5:2 G5:2',
      harm: [push('A3+C4+E4', 'A3+C4+F4'), push('A3+D4+F4', 'G3+C4+E4'), push('Bb3+D4+F4', 'Bb3+E4+G4')].join(' | '),
      bass: 'F2:4 A2:2 C3:2 D2:4 F2:2 A2:2 | Bb2:4 F2:2 D2:2 A2:4 E2:2 C3:2 | G2:4 Bb2:2 D2:2 C2:4 G2:2 E2:2',
      drums: [ride, ride, ride].join(' | '),
    },
    // the resolution: two beats of Fmaj7, released a little early so the
    // ring-out (epiano tail + echo) is over before the phase ends
    tag: {
      chords: 'Fmaj7',
      lead: 'F5:6 -:2',
      harm: 'F3+A3+C4+E4:6 -:2',
      bass: 'F2:6 -:2',
      drums: 'ko:8',
    },
  },
};

// -------------------------------------------------------------- VICTORY ----
const VICTORY: SongDef = {
  name: 'victory',
  bpm: 132,
  key: 'C',
  accidentals: ['Ab', 'Bb', 'Eb'],
  loop: null,
  order: ['win'],
  channels: {
    lead: { inst: 'brass', vol: 1.15 },
    harm: { inst: 'brass', vol: 0.5 },
    arp: { inst: 'sparkle', vol: 0.8 },
    bass: { inst: 'bass', vol: 1 },
    drums: { inst: 'drums', vol: 0.95 },
  },
  patterns: {
    win: {
      chords: 'C,F G,G,Ab,Bb C',
      lead: 'C5:2 E5:2 G5:2 C6:2 A5:2 C6:2 F6:4 | G5:2 B5:2 D6:2 G6:2 Eb6:4 F6:4 | G6!:2 -:1 E6:1 G6:2 C6!:6 -:4',
      harm: 'C4+E4+G4:8 C4+F4+A4:8 | B3+D4+G4:8 C4+Eb4+Ab4:4 D4+F4+Bb4:4 | C4+E4+G4:2 -:1 C4+E4+G4:1 C4+E4+G4:2 E4+G4+C5:6 -:4',
      arp: 'C5 E5 G5 C6 C5 E5 G5 C6 C5 F5 A5 C6 C5 F5 A5 C6 | B4 D5 G5 B5 B4 D5 G5 B5 Ab4 C5 Eb5 Ab5 Bb4 D5 F5 Bb5 | C6 G5 E5 C5 C6 G5 E5 C5 -:8',
      bass: 'C2:2 C3:2 C2:2 C3:2 F2:2 F3:2 F2:2 F3:2 | G2:2 G3:2 G2:2 G3:2 Ab2:4 Bb2:4 | C2:2 -:1 C2:1 C2:2 C2:6 -:4',
      drums: 'kx:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2 | k:2 h:2 s:2 h:2 ks:4 ks:2 s:1 s:1 | kx:2 -:1 k:1 k:2 kx:6 -:4',
    },
  },
};

// ------------------------------------------------------- DEFEAT and TIE ----
const sadOpening = {
  chords: 'Am,Dm',
  lead: 'E5:2 C5:2 A4:2 C5:2 D5:2 F5:2 A5:2 F5:2',
  harm: 'A3+C4+E4:8 A3+D4+F4:8',
  bass: 'A2:4 E2:4 D2:4 A2:4',
  drums: 'k:4 h:4 k:4 h:4',
};

const DEFEAT: SongDef = {
  name: 'defeat',
  bpm: 96,
  key: 'Am',
  accidentals: ['G#', 'C#'],
  loop: null,
  order: ['open', 'wah', 'tail'],
  channels: {
    lead: { inst: 'trombone', vol: 1 },
    harm: { inst: 'organChord', vol: 0.9 },
    bass: { inst: 'bass', vol: 0.9 },
    drums: { inst: 'drums', vol: 0.6 },
  },
  patterns: {
    open: sadOpening,
    // "wah - wah - wah - wahhh": chromatic slide down over E7, then home to Am
    wah: {
      chords: 'E7',
      lead: 'D5:3 -:1 C#5:3 -:1 C5:3 -:1 B4:4',
      harm: 'G#3+B3+D4+E4:16',
      bass: 'E3:4 -:4 E3:4 E2:4',
      drums: 'k:4 -:12',
    },
    tail: {
      chords: 'Am',
      lead: 'A4:7 -:1',
      harm: 'A3+C4+E4:7 -:1',
      bass: 'A2:7 -:1',
      drums: 'k:8',
    },
  },
};

const TIE: SongDef = {
  name: 'tie',
  bpm: 96,
  key: 'Am',
  accidentals: ['G#', 'C#'],
  loop: null,
  order: ['open', 'turn', 'tail'],
  channels: {
    lead: { inst: 'lead', vol: 1 },
    harm: { inst: 'organChord', vol: 0.9 },
    bass: { inst: 'bass', vol: 0.9 },
    drums: { inst: 'drums', vol: 0.6 },
  },
  patterns: {
    open: sadOpening,
    turn: {
      chords: 'Dm,E7',
      lead: 'F5:4 E5:4 D5:4 B4:4',
      harm: 'A3+D4+F4:8 G#3+B3+D4+E4:8',
      bass: 'D2:4 A2:4 E3:4 E2:4',
      drums: 'k:4 h:4 k:4 h:4',
    },
    // Picardy third: a shrug that ends on a major chord
    tail: {
      chords: 'A',
      lead: 'C#5:7 -:1',
      harm: 'A3+C#4+E4:7 -:1',
      bass: 'A2:7 -:1',
      drums: 'kx:8',
    },
  },
};

export const SONGS = { theme: THEME, charge: CHARGE, goal: GOAL, intermission: INTERMISSION, victory: VICTORY, defeat: DEFEAT, tie: TIE };
export type SongName = keyof typeof SONGS;
