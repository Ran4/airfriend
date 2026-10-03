// Offline audio verification (we can't listen, so we measure).
//
// Renders every SFX (through the real event mapping), every music cue, the
// crowd bed, two phase-flow scenarios (music state machine driven by a fake
// GameState, ticked via OfflineAudioContext.suspend) and an event-spam stress
// test. Each item is rendered twice: with the safety clipper (what players
// hear) and without it (true headroom). Every item also gets a K-weighted
// loudness (LUFS) and the mix is asserted: goal loudest, whistle >= 7.5 dB
// under it, slap shot within 6 dB of the whistle, crowd bed @ 0.5 quiet and
// dark, the delayed-penalty cue >= 3 dB under the whistle (see mixChecks),
// and pass/wrist shot >= 3 dB, pickup >= 6 dB over a live crowd bed at 0.5
// and at the 0.65 cap; the delayed-penalty cue stays out of the stick band,
// stands clear in its own and leaves pickups >= 3 dB clear (see maskChecks).
// ?quick=1 renders only the single sounds, the crowd and those two checks
// (for tuning; not the gate). The phase
// flows also fail if any music is still sounding when a faceoff puck drops
// (the drop is a reaction cue; the engine hushes the organ before it). The
// stall scenarios pump the theme only every 0.25 s / 1 s and fail on any note
// starting > 30 ms late (missed steps must be skipped, not clumped), and the
// robust scenario feeds NaN/Infinity/junk events through every sound, voice
// and onEvents: anything that throws fails the item. The call-for-the-puck
// cues (PAL's yip, a kid's HEY!) must hold their 0.6 s rate limit under a
// mashed button; the shot wind-up pulse must track the charge (300 -> 900 Hz,
// checked on the render) and stop on the shot, a control switch, a pause,
// the puck lost, a hidden tab and a whistle, with every source node it
// started ended afterwards (no leaked voices after 10 wind-ups). The music
// checks in tools/audio-music.ts join the report: theme < 45% of its energy
// below 250 Hz and its bass < 50% below 120 Hz (audible on laptop speakers),
// no clipping, swung 8ths measured in the intermission render, and the
// intermission cue ending on the tonic inside its 9 s phase. The lead
// transcription places each note with the sequencer's own swingOffset().
// The character checks in tools/audio-character.ts join it too: crowd ooh/boo
// breathy (spectral flatness 0.2-0.4) and the bed babbling (0.6-0.7), each
// bark variant a decaying yip with no plateau and the variants distinct,
// pause ducking the music bus >= 12 dB within 0.15 s (jingle unducked), and
// the echo's first repeat dark and on the cue's 8th note.
// Results go
// to window.__audioReport (report.loudness is the printed table); a
// spectrogram grid is drawn so a screenshot shows what everything "looks" like.
//
//   node tools/playtest.mjs --page /tools/audio-test.html --seconds 45 \
//        --eval "window.__audioReport" --shots 44 --out tools/out/audio
//   (table only: --eval "window.__audioReport.loudness"; levels only, ~30 s:
//    --params quick=1)

import { AudioEngine } from '../src/audio/audio';
import { AudioCore } from '../src/audio/core';
import { compileSong, LATE_STEP, midiToFreq, MusicPlayer, swingOffset } from '../src/audio/sequencer';
import { playSfx, SFX, type SfxName } from '../src/audio/sfx';
import { noise, tone } from '../src/audio/synth';
import { SONGS, type SongName } from '../src/audio/songs';
import type { GameEvent, GameState, Phase, Skater } from '../src/types';
import { characterChecks } from './audio-character';
import { musicChecks } from './audio-music';

const SR = 32000; // the SPC700's own output rate

// ------------------------------------------------------------ fake state ----

function fakeState(): GameState {
  const skaters: Skater[] = [];
  for (let id = 0; id < 10; id++) {
    const team = id < 5 ? 0 : 1;
    skaters.push({
      id,
      team,
      kind: id === 0 ? 'dog' : id % 5 === 4 ? 'goalie' : 'kid',
      position: (['C', 'W', 'LD', 'RD', 'G'] as const)[id % 5],
      name: 'TEST',
      number: String(id),
      pos: { x: ((id % 5) - 2) * 4, z: team === 0 ? -6 : 6 },
      vel: { x: 0, z: 0 },
      facing: 0,
      state: 'skate',
      stateTime: 0,
      windup: 0,
      stamina: 1,
      turboActive: false,
      barkCooldown: 0,
      stun: 0,
      invuln: 0,
    } as unknown as Skater);
  }
  return {
    phase: 'play',
    phaseTime: 0,
    period: 1,
    clock: 100,
    score: [0, 0],
    shots: [0, 0],
    hits: [0, 0],
    periodGoals: [[0, 0]],
    skaters,
    puck: { pos: { x: 0, z: 0 }, y: 0, vel: { x: 0, z: 0 }, vy: 0, owner: null, lastTouch: null, prevTouch: null, pickupBlock: 0, blockId: null, spin: 0 },
    referee: { pos: { x: 4, z: 0 }, vel: { x: 0, z: 0 }, facing: 0, state: 'skate', stateTime: 0 },
    penalties: [],
    faceoff: null,
    goals: [],
    lastPenaltyCall: null,
    controlledId: 0,
    winner: null,
    events: [],
    tick: 0,
    time: 0,
    paused: false,
    autoplay: true,
  };
}

const goalInfo = (team: 0 | 1) => ({ team, scorer: team ? 5 : 0, assists: [], period: 1, clock: 60, powerPlay: false, shortHanded: false });
const pen = (team: 0 | 1) => ({ skaterId: team ? 7 : 2, team, infraction: 'ROUGHING', duration: 30, remaining: 30, major: false });

// ------------------------------------------------------------- scenarios ----

interface Scenario {
  name: string;
  group: 'sfx' | 'music' | 'crowd' | 'flow' | 'stress';
  dur: number;
  minDur: number; // expected non-silent duration range
  maxDur: number;
  ambience?: boolean;
  start?: (e: AudioEngine, st: GameState) => void;
  tick?: (e: AudioEngine, st: GameState, t: number, dt: number, log: string[]) => void;
  tickDt?: number;
  /** inspect the finished render (as heard); push FAIL lines into log */
  check?: (buf: AudioBuffer, log: string[]) => void;
}

// the echo bus keeps short sounds audible (above -50 dBFS) ~0.45 s longer
const ECHO_TAIL = 0.45;
const ev = (name: string, events: GameEvent[], minDur: number, maxDur: number, dur = 3, setup?: (st: GameState) => void): Scenario => ({
  name,
  group: 'sfx',
  dur,
  minDur,
  maxDur: maxDur && maxDur + ECHO_TAIL,
  start: (e, st) => {
    setup?.(st);
    e.onEvents(events, st);
  },
  // keep pumping in case the event started music (goal fanfare)
  tick: (e) => e.pump(),
  tickDt: 0.05,
});

const SCENARIOS: Scenario[] = [
  ev('pickup', [{ type: 'pickup', skaterId: 0 }], 0.05, 0.45),
  ev('pass', [{ type: 'pass', from: 0, to: 1, speed: 17 }], 0.08, 0.55),
  ev('passReceived', [{ type: 'passReceived', from: 0, to: 1 }], 0.03, 0.35),
  ev('shot wrist (0.15)', [{ type: 'shot', shooter: 0, power: 0.15, lifted: false }], 0.08, 0.8),
  ev('shot slap (1.0)', [{ type: 'shot', shooter: 0, power: 1, lifted: true }], 0.2, 1.2),
  ev('save (pad)', [{ type: 'save', goalie: 9, caught: false }], 0.08, 1.6),
  ev('save (caught)', [{ type: 'save', goalie: 4, caught: true }], 0.05, 1.6),
  ev('post', [{ type: 'post', pos: { x: 0.9, z: 26.5 } }], 0.6, 2.5),
  ev('boards (slow)', [{ type: 'boards', pos: { x: 13, z: 5 }, speed: 4 }], 0.02, 0.6),
  ev('boards (fast)', [{ type: 'boards', pos: { x: -13, z: 5 }, speed: 28 }], 0.08, 0.8),
  ev('bodyBoards', [{ type: 'bodyBoards', skaterId: 6, speed: 8 }], 0.25, 1.3),
  ev('netHit', [{ type: 'netHit', pos: { x: 0, z: 27 } }], 0.05, 0.45),
  ev('check (light)', [{ type: 'check', hitter: 7, victim: 1, force: 3, knockedDown: false }], 0.08, 0.6),
  ev('check (knockdown)', [{ type: 'check', hitter: 8, victim: 2, force: 12, knockedDown: true }], 0.25, 1.9),
  ev('whistle (offIce)', [{ type: 'whistle', reason: 'offIce' }], 0.5, 1.3),
  ev('whistle (freeze)', [{ type: 'whistle', reason: 'freeze' }], 0.45, 1.2),
  ev('whistle (goal) = silent', [{ type: 'whistle', reason: 'goal' }], 0, 0),
  ev('penalty (PUPS boxed)', [{ type: 'penalty', penalty: pen(0) }], 1.2, 2.8),
  ev('penalty (BLZ boxed)', [{ type: 'penalty', penalty: pen(1) }], 0.8, 2.2),
  // foul in live play, whistle delayed: ref's arm-up chime + a crowd murmur (team = offender)
  ev('delayedPenalty (BLZ foul)', [{ type: 'delayedPenalty', team: 1, skaterId: 7 }], 0.4, 1.6),
  ev('delayedPenalty (PUPS foul)', [{ type: 'delayedPenalty', team: 0, skaterId: 2 }], 0.4, 1.6),
  ev('penaltyExpired', [{ type: 'penaltyExpired', skaterId: 2 }], 0.05, 0.4),
  ev('periodStart', [{ type: 'periodStart', period: 2 }], 0.5, 2.2),
  ev('periodEnd (horn)', [{ type: 'periodEnd', period: 1 }], 1.4, 3.8),
  ev('faceoffDrop', [{ type: 'faceoffDrop' }], 0.02, 0.3, 1, (st) => (st.faceoff = { spot: { x: 0, z: 0 }, dropped: true, dropTime: 0, earlyPress: [false, false] })),
  ev('faceoffWin', [{ type: 'faceoffWin', team: 0, skaterId: 0 }], 0.05, 0.4),
  ev('bark', [{ type: 'bark', skaterId: 0, startled: [6] }], 0.12, 0.7),
  ev('callFor (PAL yip)', [{ type: 'callFor', kind: 'pass', skaterId: 0, carrier: 1 }], 0.1, 0.5),
  ev('callFor (kid HEY)', [{ type: 'callFor', kind: 'shot', skaterId: 2, carrier: 1 }], 0.12, 0.55),
  ev('falseStart', [{ type: 'falseStart', team: 0, skaterId: 0 }], 0.15, 0.6),
  ev('turboStart', [{ type: 'turboStart', skaterId: 0 }], 0.2, 0.8),
  ev('hardStop', [{ type: 'hardStop', skaterId: 0, speed: 9 }], 0.15, 0.8),
  ev('clockWarning', [{ type: 'clockWarning' }], 0.07, 0.4),
  ev('fumble', [{ type: 'fumble', skaterId: 6 }], 0.1, 0.5),
  ev('steal (PUPS)', [{ type: 'steal', skaterId: 1, fromId: 6 }], 0.1, 1.4),
  ev('steal (BLZ)', [{ type: 'steal', skaterId: 6, fromId: 1 }], 0.1, 0.6),
  ev('poke (miss)', [{ type: 'poke', skaterId: 0, success: false }], 0.04, 0.3),
  ev('poke (hit)', [{ type: 'poke', skaterId: 0, success: true }], 0.06, 0.4),
  ev('controlSwitch', [{ type: 'controlSwitch', skaterId: 1 }], 0.08, 0.6),
  ev('rematch', [{ type: 'rematch' }], 0.25, 1.2),
  ev('goal (PUPS): horn+roar+fanfare', [{ type: 'goal', info: goalInfo(0) }], 5, 9, 9),
  ev('goal (BLZ): whistle+aww', [{ type: 'goal', info: goalInfo(1) }], 1.0, 2.6),
  ev('gameOver (win)', [{ type: 'gameOver', winner: 0 }], 1.2, 5),
  ev('gameOver (loss)', [{ type: 'gameOver', winner: 1 }], 1.0, 2.6),
  ev('gameOver (tie)', [{ type: 'gameOver', winner: 'tie' }], 0.5, 2.2),
];

const music = (name: SongName, dur: number, minDur: number, maxDur: number): Scenario => ({
  name: `music: ${name}`,
  group: 'music',
  dur,
  minDur,
  maxDur,
  start: (e) => e.playCue(name, 0.02),
  tick: (e) => e.pump(),
  tickDt: 0.05,
});
SCENARIOS.push(
  music('theme', 24, 22, 24),
  music('charge', 4.5, 2.8, 4.4),
  music('goal', 6, 4.2, 5.8),
  // a one-shot now (it used to loop): 7.9 s of song plus its ring-out must
  // fit the 9 s intermission it starts 0.4 s into (see audio-music.ts)
  music('intermission', 10, 7.6, 8.5),
  music('victory', 7.5, 5.3, 7.2),
  music('defeat', 8, 6.1, 7.8),
  music('tie', 8, 6.1, 7.8),
);

// 0.65 is the loudest the engine ever drives the bed (updateCrowd caps live
// play there; every other phase targets less). 0.5 is a typical live-play
// level and carries the bed checks in mixChecks.
for (const level of [0.1, 0.3, 0.5, 0.65]) {
  SCENARIOS.push({
    name: `crowd bed @ ${level}`,
    group: 'crowd',
    dur: 3,
    minDur: 2.5,
    maxDur: 3,
    ambience: true,
    start: (e) => e.crowd!.setLevel(level, 0, 0.05),
  });
}
for (const [name, fn] of [
  // direct crowd calls bypass the engine's chain-settle deferral
  ['crowd ooh', (e: AudioEngine) => e.crowd!.ooh(0.3)],
  ['crowd aww', (e: AudioEngine) => e.crowd!.aww(0.3)],
  ['crowd boo', (e: AudioEngine) => e.crowd!.boo(0.3)],
  ['crowd cheer', (e: AudioEngine) => e.crowd!.cheer(0.3)],
  ['crowd roar', (e: AudioEngine) => e.crowd!.roar(0.3)],
] as const) {
  SCENARIOS.push({ name, group: 'crowd', dur: 5, minDur: 0.6, maxDur: 5, start: (e) => fn(e) });
}

/**
 * Phase flow #1: intro -> faceoff -> drop -> play (puck carried into the
 * zone, shot) -> PUPS goal -> faceoff -> drop -> play -> freeze stoppage ->
 * faceoff -> play -> BLZ penalty (power play: CHARGE!) -> faceoff -> drop.
 */
interface Step {
  at: number;
  phase?: Phase;
  /** faceoff steps: phaseTime of the drop (the sim randomizes it; default 1.1) */
  dropTime?: number;
  dropped?: boolean;
  events?: GameEvent[];
  set?: (st: GameState) => void;
}
/** a flow log line starting with this fails the item (see main) */
const FAIL = '!! ';

/** music players still audible at `t`: not stopped, or still fading */
function soundingMusic(e: AudioEngine, t: number): string[] {
  const x = e as unknown as { player: MusicPlayer | null; fading: MusicPlayer[] };
  return [x.player, ...x.fading]
    .filter((p): p is MusicPlayer => !!p && (!p.stopped || (p as unknown as { stopAt: number }).stopAt > t + 0.02))
    .map((p) => p.song.def.name);
}
function flow(name: string, dur: number, steps: Step[], during?: (st: GameState, t: number) => void): Scenario {
  return {
    name,
    group: 'flow',
    dur,
    minDur: dur - 0.5,
    maxDur: dur,
    ambience: true,
    tickDt: 1 / 60,
    tick: (e, st, t, dt, log) => {
      // like the sim: phaseTime runs while unpaused (update hushes the music off it)
      if (!st.paused) st.phaseTime += dt;
      for (const s of steps) {
        if (t >= s.at && t - dt < s.at) {
          if (s.phase) {
            st.phase = s.phase;
            st.phaseTime = 0;
            if (s.phase === 'faceoff') st.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime: s.dropTime ?? 1.1, earlyPress: [false, false] };
          }
          if (s.dropped && st.faceoff && !st.faceoff.dropped) {
            // the drop is a reaction cue: no music may still be sounding
            const loud = soundingMusic(e, t);
            if (loud.length) log.push(`${FAIL}music at the drop (t=${t.toFixed(2)}): ${loud.join(', ')}`);
            st.faceoff.dropped = true;
          }
          s.set?.(st);
          if (s.events) e.onEvents(s.events, st);
        }
      }
      during?.(st, t);
      e.update(st, dt);
      const cue = (e as unknown as { cue: string | null }).cue;
      const last = log[log.length - 1];
      const entry = `${cue ?? '-'}`;
      if (!last || !last.endsWith(` ${entry}`)) log.push(`${t.toFixed(2)} ${entry}`);
    },
  };
}

SCENARIOS.push(
  flow(
    'flow: intro/goal/stoppage/PP',
    26,
    [
      { at: 0.02, phase: 'intro', events: [{ type: 'introStart' }] },
      { at: 3.2, phase: 'faceoff', events: [{ type: 'faceoffSetup', spot: { x: 0, z: 0 } }] },
      { at: 4.3, dropped: true, events: [{ type: 'faceoffDrop' }] },
      { at: 4.6, phase: 'play', events: [{ type: 'faceoffWin', team: 0, skaterId: 0 }, { type: 'pickup', skaterId: 0 }] },
      { at: 8.5, events: [{ type: 'shot', shooter: 0, power: 0.9, lifted: true }] },
      { at: 8.9, phase: 'goal', events: [{ type: 'goal', info: goalInfo(0) }] },
      // shortest lineup right after the goal: the fanfare must be gone by the drop
      { at: 12.9, phase: 'faceoff', dropTime: 0.8, events: [{ type: 'faceoffSetup', spot: { x: 0, z: 0 } }] },
      { at: 13.7, dropped: true, events: [{ type: 'faceoffDrop' }] },
      { at: 14.4, phase: 'play' },
      { at: 16, phase: 'stoppage', events: [{ type: 'save', goalie: 9, caught: true }, { type: 'whistle', reason: 'freeze' }] },
      { at: 17.6, phase: 'faceoff' },
      { at: 18.7, dropped: true, events: [{ type: 'faceoffDrop' }] },
      { at: 19.0, phase: 'play' },
      { at: 20, phase: 'penalty', set: (st) => (st.lastPenaltyCall = pen(1)), events: [{ type: 'whistle', reason: 'penalty' }, { type: 'penalty', penalty: pen(1) }] },
      { at: 22.8, phase: 'faceoff', set: (st) => (st.penalties = [pen(1)]) },
      { at: 23.9, dropped: true, events: [{ type: 'faceoffDrop' }] },
      { at: 24.3, phase: 'play' },
    ],
    // puck carried from center ice toward the BLZ net during the first shift
    (st, t) => {
      if (st.phase === 'play' && t < 9) st.puck.pos.z = Math.min(24, (t - 4.6) * 5.5);
      else if (st.phase === 'play') st.puck.pos.z = 0;
    },
  ),
  flow('flow: periodEnd/intermission/pause/gameOver', 20, [
    { at: 0.02, phase: 'play' },
    { at: 0.5, events: [{ type: 'clockWarning' }] },
    { at: 1.5, events: [{ type: 'clockWarning' }] },
    { at: 2.5, phase: 'periodEnd', events: [{ type: 'periodEnd', period: 1 }] },
    { at: 5, phase: 'intermission', events: [{ type: 'intermissionStart', nextPeriod: 2 }], set: (st) => (st.period = 2) },
    // period opener (long lineup), paused for 1 s in the middle
    { at: 11, phase: 'faceoff', dropTime: 2.2, events: [{ type: 'periodStart', period: 2 }, { type: 'faceoffSetup', spot: { x: 0, z: 0 } }] },
    { at: 11.5, set: (st) => (st.paused = true) },
    { at: 12.5, set: (st) => (st.paused = false) },
    { at: 14.2, dropped: true, events: [{ type: 'faceoffDrop' }] },
    { at: 14.5, phase: 'play' },
    { at: 15.5, phase: 'gameOver', set: (st) => (st.winner = 0), events: [{ type: 'periodEnd', period: 3 }, { type: 'gameOver', winner: 0 }] },
  ]),
);

// Event spam: every tick for 2 s, a pile of boards/pickups/checks/stops
// plus a slap shot and a post every 10 ticks. Must stay clean and bounded.
SCENARIOS.push({
  name: 'stress: event spam',
  group: 'stress',
  dur: 3,
  minDur: 1.9,
  maxDur: 3,
  ambience: true,
  tickDt: 1 / 60,
  tick: (e, st, t, dt, log) => {
    if (t > 2) return e.update(st, dt);
    const events: GameEvent[] = [];
    for (let i = 0; i < 5; i++) events.push({ type: 'boards', pos: { x: 13, z: i }, speed: 30 });
    events.push({ type: 'pickup', skaterId: 1 }, { type: 'check', hitter: 6, victim: 1, force: 14, knockedDown: true }, { type: 'hardStop', skaterId: 2, speed: 12 }, { type: 'turboStart', skaterId: 3 }, { type: 'bodyBoards', skaterId: 6, speed: 10 }, { type: 'pass', from: 1, to: 2, speed: 20 });
    const n = Math.round(t / dt);
    if (n % 10 === 0) events.push({ type: 'shot', shooter: 1, power: 1, lifted: true }, { type: 'post', pos: { x: 0.9, z: 26.5 } }, { type: 'bark', skaterId: 0, startled: [] });
    e.onEvents(events, st);
    e.update(st, dt);
    const v = e.core!.activeVoices;
    const max = Number(log[0] ?? 0);
    log[0] = String(Math.max(max, v));
  },
});

// Sequencer catch-up: the music is pumped only every 0.25 s / 1 s (a hitchy
// rAF, a throttled timer). Every source start is recorded; a note that
// starts more than LATE_STEP after its scheduled time is a failure. 0.25 s
// is covered by the lookahead; at 1 s the player has to skip missed steps
// instead of firing them late in one clump.
let starts: { when: number; now: number }[] | null = null;
/** maskChecks: sources started while set never sound (the bed-only twin render) */
let silenceStarts = false;
// AudioBufferSourceNode has its own start() (offset, duration), shadowing
// the base one: patch both, or noise voices and drums slip past
for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]) {
  if (!Object.prototype.hasOwnProperty.call(proto, 'start')) continue;
  const origStart = proto.start as (this: AudioScheduledSourceNode, ...a: unknown[]) => void;
  proto.start = function (this: AudioScheduledSourceNode, when?: number, ...rest: number[]) {
    if (silenceStarts) return;
    starts?.push({ when: when ?? 0, now: this.context.currentTime });
    if (liveSources) {
      const live = liveSources;
      live.add(this);
      this.addEventListener('ended', () => live.delete(this));
    }
    return origStart.call(this, when, ...rest);
  };
}
for (const interval of [0.25, 1]) {
  SCENARIOS.push({
    name: `stall: theme pumped every ${interval}s`,
    group: 'stress',
    dur: 8,
    minDur: 7,
    maxDur: 8,
    tickDt: interval,
    start: (e) => {
      starts = [];
      e.playCue('theme', 0.25, { orderIdx: 1 });
    },
    tick: (e, _st, t, _dt, log) => {
      const s0 = starts?.length ?? 0;
      e.pump();
      const late = (starts ?? []).slice(s0).filter((s) => s.now - s.when > LATE_STEP);
      if (late.length) log.push(`${FAIL}${late.length} notes started late at t=${t.toFixed(2)} (max ${Math.round(1000 * Math.max(...late.map((s) => s.now - s.when)))} ms)`);
      if (t > 7.5) starts = null;
    },
  });
}

// Call for the puck, mashed: PASS pressed every 0.1 s for 1.3 s. PAL may
// yip at most once per CALL_GAP (the yip sits on the stick layer, a mashed
// button must not turn into a yapping loop), and the kid HEY likewise.
const CALL_GAP = 0.6;
for (const [who, id, sound] of [
  ['PAL', 0, 'yip'],
  ['kid', 2, 'hey'],
] as const) {
  const plays: number[] = [];
  const clock = crossing();
  SCENARIOS.push({
    name: `callFor mashed (${who}): <= 1 per ${CALL_GAP}s`,
    group: 'stress',
    dur: 2.2,
    minDur: 0.5,
    maxDur: 2.2,
    tickDt: 0.1,
    start: () => {
      plays.length = 0;
      clock.reset();
    },
    tick: (e, st, t, _dt, log) => {
      const hit = clock.tick(t);
      if (t > 1.35) {
        if (hit(1.95)) {
          const gaps = plays.slice(1).map((p, i) => p - plays[i]);
          if (plays.length < 2) log.push(`${FAIL}only ${plays.length} ${sound} in 1.3 s of mashing`);
          if (gaps.some((g) => g < CALL_GAP - 1e-6)) log.push(`${FAIL}${sound} repeats ${gaps.map((g) => g.toFixed(2)).join(', ')} s apart (min ${CALL_GAP})`);
          log.push(`${sound} x${plays.length} at ${plays.map((p) => p.toFixed(2)).join(', ')}`);
        }
        return;
      }
      const n0 = e.stats.played[sound] ?? 0;
      e.onEvents([{ type: 'callFor', kind: 'pass', skaterId: id, carrier: 1 }], st);
      if ((e.stats.played[sound] ?? 0) > n0) plays.push(Math.max(t, e.core!.now(), 0.2));
    },
  });
}

/**
 * Fires once when the tick clock crosses `at`. Tick times are quantized to
 * 128-frame render quanta, so `t - dt < at` can skip a step or hit it twice;
 * this compares against the real previous tick instead.
 */
function crossing() {
  let prev = -Infinity;
  return {
    reset: () => (prev = -Infinity),
    /** call once per tick, before any hit() */
    tick: (t: number) => {
      const p = prev;
      prev = t;
      return (at: number) => p < at && t >= at;
    },
  };
}
const pulseClock = crossing();
const windClock = crossing();

// Shot wind-up pulse (windup.ts). One wind-up from 0 to full charge, held,
// then the shot: the pulse's fundamental must follow the charge (300 Hz at
// the start, 900 Hz at full) and stop on the shot.
const WINDUP_T = 0.3;
const WINDUP_FULL = 0.9; // PHYS.windupTime
const WINDUP_SHOT = 1.5;
/** the pulse is a quiet guide, under the stick-and-puck layer (pickup ~-27, wrist shot ~-25 LUFS) */
const WINDUP_MAX_LUFS = -28;
const strongest = (x: Float32Array, from: number, to: number) => {
  let best = 0;
  let bestF = 0;
  for (let f = 240; f <= 1100; f += 10) {
    const p = goertzel(x, from, to, f);
    if (p > best) {
      best = p;
      bestF = f;
    }
  }
  return bestF;
};
SCENARIOS.push({
  name: 'windup: charge pulse 300->900 Hz, stops on shot',
  group: 'sfx',
  dur: 2.2,
  minDur: 1.1,
  // the shot's own boom and echo ring on after the pulse
  maxDur: WINDUP_SHOT - WINDUP_T + 1.2 + ECHO_TAIL,
  tickDt: 1 / 60,
  start: () => pulseClock.reset(),
  tick: (e, st, t, dt, log) => {
    const k = st.skaters[0];
    const hit = pulseClock.tick(t);
    if (hit(WINDUP_T)) {
      k.state = 'windup';
      k.windup = 0;
    }
    if (k.state === 'windup') k.windup = Math.min(1, (t - WINDUP_T) / WINDUP_FULL);
    if (hit(WINDUP_SHOT)) {
      e.onEvents([{ type: 'shot', shooter: 0, power: 1, lifted: true }], st);
      if (e.charge?.active) log.push(`${FAIL}charge tone still on after the shot event`);
      k.state = 'shoot';
      k.windup = 0;
    }
    e.update(st, dt);
    if (k.state === 'windup' && !e.charge?.active) log.push(`${FAIL}no charge tone at t=${t.toFixed(2)} during the wind-up`);
  },
  check: (buf, log) => {
    const x = buf.getChannelData(0);
    const at = (a: number, b: number) => strongest(x, Math.round(a * SR), Math.round(b * SR));
    const lo = at(WINDUP_T + 0.03, WINDUP_T + 0.2); // charge ~0.03..0.2 -> 320-430 Hz
    const hi = at(WINDUP_T + WINDUP_FULL + 0.05, WINDUP_SHOT - 0.02); // full charge
    const cum = kCum(x, buf.getChannelData(1), SR);
    const lu = lufsOf(cum, Math.round((WINDUP_SHOT - 0.42) * SR), Math.round((WINDUP_SHOT - 0.02) * SR));
    log.push(`pulse fundamental ${lo} Hz early, ${hi} Hz at full charge; ${lu.toFixed(1)} LUFS (400 ms at full charge)`);
    if (!(lu <= WINDUP_MAX_LUFS)) log.push(`${FAIL}charge pulse ${lu.toFixed(1)} LUFS, louder than ${WINDUP_MAX_LUFS} (it must sit under the stick sounds)`);
    if (!(lo >= 290 && lo <= 460)) log.push(`${FAIL}early wind-up pulse at ${lo} Hz (want ~300-430)`);
    if (!(hi >= 850 && hi <= 950)) log.push(`${FAIL}full-charge pulse at ${hi} Hz (want ~900)`);
  },
});

// Ten wind-ups, each ended by a different path (the shot, a control switch
// with the old skater still winding, a pause, the puck lost, a hidden tab,
// a whistle). The tone must stop on the frame it happens, never restart for
// the wrong skater, and leave nothing behind: every source node started in
// the scene must have ended once it is over (node count back to baseline).
let liveSources: Set<AudioScheduledSourceNode> | null = null;
const STOPS = ['shot', 'controlSwitch', 'pause', 'puck lost', 'hidden', 'whistle', 'shot', 'controlSwitch', 'pause', 'puck lost'] as const;
const WIND_EVERY = 0.7;
SCENARIOS.push({
  name: `windup: ${STOPS.length} wind-ups, every stop path, no leaks`,
  group: 'stress',
  dur: 0.3 + STOPS.length * WIND_EVERY + 1,
  minDur: 0.3,
  maxDur: 0.3 + STOPS.length * WIND_EVERY + 1,
  tickDt: 1 / 60,
  start: () => {
    liveSources = new Set();
    windClock.reset();
  },
  tick: (e, st, t, dt, log) => {
    const k0 = st.skaters[0];
    const hit = windClock.tick(t);
    const i = Math.floor((t - 0.3) / WIND_EVERY);
    const base = 0.3 + i * WIND_EVERY;
    const kind = i >= 0 && i < STOPS.length ? STOPS[i] : null;
    let mustBeOff = false;
    if (kind && hit(base)) {
      k0.state = 'windup';
      k0.windup = 0;
    }
    if (k0.state === 'windup') k0.windup = Math.min(1, k0.windup + dt / WINDUP_FULL);
    if (kind && hit(base + 0.35)) {
      mustBeOff = true;
      if (kind === 'shot') {
        e.onEvents([{ type: 'shot', shooter: 0, power: 0.6, lifted: false }], st);
        k0.state = 'shoot';
      } else if (kind === 'controlSwitch') {
        // the old skater is still in 'windup': the tone must not follow it
        st.controlledId = 1;
        e.onEvents([{ type: 'controlSwitch', skaterId: 1 }], st);
      } else if (kind === 'pause') st.paused = true;
      else if (kind === 'puck lost') k0.state = 'skate';
      else if (kind === 'hidden') e.setHidden(true);
      else if (kind === 'whistle') st.phase = 'stoppage';
    }
    // clean up for the next wind-up
    if (kind && hit(base + 0.55)) {
      k0.state = 'skate';
      k0.windup = 0;
      st.controlledId = 0;
      st.paused = false;
      st.phase = 'play';
      e.setHidden(false);
    }
    e.update(st, dt);
    const on = !!e.charge?.active;
    const phaseIn = t - base;
    if (kind && phaseIn > 0.05 && phaseIn < 0.34 && !on) log.push(`${FAIL}wind-up ${i + 1}: no tone at t=${t.toFixed(2)}`);
    if (kind && (mustBeOff || (phaseIn >= 0.35 && phaseIn < 0.55)) && on) log.push(`${FAIL}wind-up ${i + 1}: tone still on after '${kind}' (t=${t.toFixed(2)})`);
    if (hit(0.3 + STOPS.length * WIND_EVERY + 0.6)) {
      const c = e.charge!;
      log.push(`charge voices started ${c.started}, ended ${c.ended}; live sources ${liveSources?.size}`);
      if (c.started !== STOPS.length) log.push(`${FAIL}${c.started} charge voices for ${STOPS.length} wind-ups`);
      if (c.ended !== c.started) log.push(`${FAIL}${c.started - c.ended} charge voices never ended`);
      if (liveSources && liveSources.size) log.push(`${FAIL}${liveSources.size} source nodes still live after the scene`);
      liveSources = null;
    }
  },
});

// Robustness: sim values reach WebAudio (power, force, positions). A NaN or
// Infinity in an AudioParam throws, and a throw would freeze the game, so
// every sound, voice and event must shrug off junk. Valid sounds in the
// same batch must still play (the whistle at the end keeps this non-silent).
SCENARIOS.push({
  name: 'robust: NaN/Infinity params, malformed events',
  group: 'stress',
  dur: 2,
  minDur: 0.4,
  maxDur: 2,
  start: (e, st) => {
    const core = e.core!;
    const bad = [NaN, Infinity, -Infinity];
    const tryIt = (what: string, fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        throw new Error(`${what} threw ${(err as Error).message}`);
      }
    };
    for (const name of Object.keys(SFX) as SfxName[]) {
      for (const x of bad) {
        tryIt(`playSfx ${name} vol ${x}`, () => playSfx(core, name, 0.3, { vol: x, pan: x }));
        tryIt(`playSfx ${name} t ${x}`, () => playSfx(core, name, x));
      }
    }
    tryIt('playSfx unknown name', () => playSfx(core, 'nope' as SfxName, 0.3));
    for (const x of bad) {
      const d = core.sfx;
      tryIt(`tone ${x}`, () => tone(core, { t: 0.3, f: x, dur: 0.1, wave: 'sine', vol: 0.1, dest: d }));
      tryIt(`tone vol ${x}`, () => tone(core, { t: 0.3, f: 440, dur: 0.1, wave: 'sine', vol: x, dest: d }));
      tryIt(`tone sweep ${x}`, () => tone(core, { t: 0.3, f: 440, dur: 0.1, wave: 'sine', vol: 0, dest: d, sweep: { to: x, time: 0.1 }, pitch: [[0.05, x]], vib: { rate: x, depth: x }, detune: x, filters: [{ type: 'lowpass', f: x, to: x, settle: x }], pan: x, echo: x }));
      tryIt(`tone sweep to 0`, () => tone(core, { t: 0.3, f: 440, dur: 0.1, wave: 'sine', vol: 0, dest: d, sweep: { to: 0, time: 0.1 }, filters: [{ type: 'lowpass', f: 900, to: 0 }] }));
      tryIt(`noise ${x}`, () => noise(core, { t: 0.3, dur: x, vol: 0.1, dest: d, rate: x, rateTo: x }));
      tryIt(`noise rateTo 0`, () => noise(core, { t: 0.3, dur: 0.05, vol: 0, dest: d, rateTo: 0, am: { rate: x, depth: x } }));
      tryIt(`crowd level ${x}`, () => e.crowd!.setLevel(x, 0.3, x));
    }
    const junk = [
      { type: 'shot', shooter: 0, power: NaN, lifted: true },
      { type: 'check', hitter: 7, victim: 1, force: Infinity, knockedDown: true },
      { type: 'check', hitter: 7, victim: 99, force: NaN, knockedDown: true },
      { type: 'pass', from: 0, to: 1, speed: NaN },
      { type: 'boards', pos: { x: NaN, z: 0 }, speed: 30 },
      { type: 'boards' },
      { type: 'post' },
      { type: 'goal' },
      { type: 'penalty' },
      { type: 'hardStop', skaterId: 0, speed: -Infinity },
      { type: 'save', goalie: 'x' },
      { type: 'whatever' },
      null,
      undefined,
      42,
      { type: 'whistle', reason: 'offIce' },
    ] as unknown as GameEvent[];
    tryIt('onEvents(junk)', () => e.onEvents(junk, st));
    tryIt('onEvents(null)', () => e.onEvents(null as unknown as GameEvent[], st));
    const nanState = fakeState();
    for (const k of nanState.skaters) k.pos.x = NaN;
    nanState.puck.pos.z = NaN;
    nanState.referee.pos.x = NaN;
    tryIt('onEvents(NaN state)', () => e.onEvents([{ type: 'bark', skaterId: 0, startled: [] }, { type: 'post', pos: { x: NaN, z: NaN } }], nanState));
    tryIt('update(NaN state)', () => e.update({ ...nanState, phase: 'play' }, NaN));
  },
});

// ------------------------------------------------------------- rendering ----

async function render(sc: Scenario, safetyClip: boolean): Promise<{ buf: AudioBuffer; log: string[] }> {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * sc.dur), SR);
  const eng = new AudioEngine({ context: ctx, safetyClip, ambience: sc.ambience ?? false, seed: 1234 });
  eng.unlock();
  const st = fakeState();
  const log: string[] = [];
  sc.start?.(eng, st);
  if (sc.tick) {
    const dt = sc.tickDt ?? 0.05;
    const tick = sc.tick;
    let prev = -1;
    for (let i = 1; i * dt < sc.dur - 0.01; i++) {
      // suspend times are quantized to 128-frame render quanta
      const q = Math.round((i * dt * SR) / 128) * 128;
      if (q <= prev) continue;
      prev = q;
      const t = q / SR;
      void ctx.suspend(t).then(() => {
        tick(eng, st, t, dt, log);
        void ctx.resume();
      });
    }
  }
  const buf = await ctx.startRendering();
  return { buf, log };
}

interface Metrics {
  peak: number;
  rms: number;
  start: number;
  end: number;
  dur: number;
  nan: number;
  clip: number;
  centroid: number;
  domHz: number;
  /** % of spectral energy below 250 Hz / 250-2000 Hz / above 2 kHz (mix balance) */
  bands: [number, number, number];
}

const THRESH = 0.003; // ~ -50 dBFS counts as sound

function measure(buf: AudioBuffer): Metrics {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let peak = 0;
  let nan = 0;
  let clip = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < L.length; i++) {
    for (const v of [L[i], R[i]]) {
      if (!Number.isFinite(v)) {
        nan++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a > 0.95) clip++;
      if (a > THRESH) {
        if (first < 0) first = i;
        last = i;
      }
    }
  }
  let sum = 0;
  if (first >= 0) for (let i = first; i <= last; i++) sum += (L[i] * L[i] + R[i] * R[i]) / 2;
  const n = Math.max(1, last - first + 1);
  const { centroid, domHz } = spectrumStats(L, R);
  const bands = bandEnergy(L, R, first, last);
  return {
    peak: r3(peak),
    rms: r3(Math.sqrt(sum / n)),
    start: r3(Math.max(0, first) / SR),
    end: r3(Math.max(0, last) / SR),
    dur: first < 0 ? 0 : r3((last - first) / SR),
    nan,
    clip,
    centroid: Math.round(centroid),
    domHz: Math.round(domHz),
    bands,
  };
}

function bandEnergy(L: Float32Array, R: Float32Array, first: number, last: number): [number, number, number] {
  const n = 2048;
  const e = [0, 0, 0];
  if (first < 0) return [0, 0, 0];
  for (let c = first + n / 2; c < last; c += n) {
    const mag = frameMag(L, R, c, n);
    for (let i = 1; i < mag.length; i++) {
      const f = (i * SR) / n;
      e[f < 250 ? 0 : f < 2000 ? 1 : 2] += mag[i] * mag[i];
    }
  }
  const tot = e[0] + e[1] + e[2] || 1;
  return e.map((x) => Math.round((100 * x) / tot)) as [number, number, number];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

// -------------------------------------------------------------- loudness ----
// ITU-R BS.1770 K-weighting (high shelf + RLB highpass), designed for any
// sample rate the way libebur128 does it, then the loudest momentary window.
// This is the "how loud does it feel" number the mix assertions use: peaks
// say nothing about a 3 kHz whistle vs a 60 Hz thud.

function biquad(x: ArrayLike<number>, b: number[], a: number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

function kWeight(x: Float32Array, sr: number): Float64Array {
  // stage 1: +4 dB high shelf around 1.7 kHz (head diffraction)
  let f0 = 1681.974450955533;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sr);
  const vh = Math.pow(10, 3.999843853973347 / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let a0 = 1 + k / q + k * k;
  const shelf = biquad(x, [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0], [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]);
  // stage 2: RLB highpass at 38 Hz
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + k / q + k * k;
  return biquad(shelf, [1, -2, 1], [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]);
}

/** loudest K-weighted window of `win` seconds (0.4 = EBU momentary), in LUFS */
function loudness(buf: AudioBuffer, win = 0.4): number {
  const L = kWeight(buf.getChannelData(0), buf.sampleRate);
  const R = kWeight(buf.getChannelData(1), buf.sampleRate);
  const n = Math.min(L.length, Math.round(win * buf.sampleRate));
  const hop = Math.max(1, Math.round(n / 4));
  // prefix sums of channel power: every window is O(1)
  const cum = new Float64Array(L.length + 1);
  for (let i = 0; i < L.length; i++) cum[i + 1] = cum[i] + L[i] * L[i] + R[i] * R[i];
  let best = 0;
  for (let s = 0; s + n <= L.length; s += hop) best = Math.max(best, (cum[s + n] - cum[s]) / n);
  return Math.round((-0.691 + 10 * Math.log10(best + 1e-12)) * 10) / 10;
}

/** K-weighted channel power prefix sums: the power of samples [a, b) is (cum[b] - cum[a]) / (b - a) */
function kCum(L: Float32Array, R: Float32Array, sr: number): Float64Array {
  const kl = kWeight(L, sr);
  const kr = kWeight(R, sr);
  const cum = new Float64Array(kl.length + 1);
  for (let i = 0; i < kl.length; i++) cum[i + 1] = cum[i] + kl[i] * kl[i] + kr[i] * kr[i];
  return cum;
}
/** channel power prefix sums of [lo, hi] Hz (4x 2nd-order high- and lowpass, ~48 dB/oct), same use as kCum */
function bandCum(L: Float32Array, R: Float32Array, sr: number, [lo, hi]: [number, number]): Float64Array {
  const rbj = (f: number, high: boolean): [number[], number[]] => {
    const w = (2 * Math.PI * f) / sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const g = (high ? 1 + cos : 1 - cos) / 2 / a0;
    return [
      [g, (high ? -2 : 2) * g, g],
      [1, (-2 * cos) / a0, (1 - alpha) / a0],
    ];
  };
  const [hb, ha] = rbj(lo, true);
  const [lb, la] = rbj(hi, false);
  const band = (x: Float32Array) => {
    let y: ArrayLike<number> = x;
    for (let i = 0; i < 4; i++) y = biquad(biquad(y, hb, ha), lb, la);
    return y as Float64Array;
  };
  const bl = band(L);
  const br = band(R);
  const cum = new Float64Array(bl.length + 1);
  for (let i = 0; i < bl.length; i++) cum[i + 1] = cum[i] + bl[i] * bl[i] + br[i] * br[i];
  return cum;
}
const lufsOf = (cum: Float64Array, a: number, b: number) => -0.691 + 10 * Math.log10((cum[b] - cum[a]) / Math.max(1, b - a) + 1e-12);

// Masking: the crowd bed must not bury the stick-and-puck layer. The bed is
// held at a live-play level and the quiet puck sounds fire over it through
// the real event mapping (a wrist shot also ducks the bed). The same scene is
// rendered again with the same seed and every source started after setup
// silenced, which leaves exactly the bed (including its side-chain dips).
// The difference of the two is the event as it comes out of the master
// chain; each one's loudest 100 ms window must clear the bed in that same
// window by its margin. A third render with no events at all gives the
// undipped bed, so the shot's dip is measured too. Both levels run: 0.5
// (typical) and 0.65 (PLAY_CROWD_MAX, the most the engine ever drives it).
//
// The delayed-penalty cue (ref's arm-up chime + crowd murmur) plays under
// live play, so it must not mask the stick layer either: it fires late in
// the scene and pickups land on its chime and in its murmur. A fourth render
// keeps everything but those pickups, so the masker there is bed + cue. A
// broadband LUFS margin overstates what a 1 kHz chime does to a 2 kHz click,
// so the cue is also judged by band: it may lift the bed in the stick band
// (STICK_BAND, where the clicks' transients live) by CUE_STICK_LIFT dB at
// most, and must stand CUE_CLEAR dB over the bed in its own band (it has to
// be heard: the whistle is coming).
const MASK_LEVELS = [0.5, 0.65];
const MASK_MARGIN = 3;
/** pickups are the stick layer's backbone (~200 a game): clearly over the bed */
const PICKUP_MARGIN = 6;
/** bands (Hz): the stick clicks' transients / the ref chime's notes */
const STICK_BAND: [number, number] = [1500, 6000];
const CUE_BAND: [number, number] = [350, 700];
/** most the cue may raise the bed in STICK_BAND (dB, any 100 ms window) */
const CUE_STICK_LIFT = 1.5;
/** the cue over the bed in CUE_BAND (dB, its loudest 100 ms) */
const CUE_CLEAR = 6;
/** the shot's side-chain dip, 30-130 ms after it (crowd.duck: 4 dB, tau 30 ms) / left after 1 s */
const DUCK_MIN = 2.5;
const DUCK_RECOVERED = 0.5;
const CUE_AT = 3.8;
interface MaskEvent {
  at: number;
  name: string;
  event: GameEvent;
  /** dB it must clear its masker by; null = reported only; undefined = a masker itself */
  margin?: number | null;
  /** fired while the delayed-penalty cue sounds: measured against bed + cue */
  overCue?: boolean;
}
const MASK_EVENTS: MaskEvent[] = [
  { at: 1.0, name: 'pickup', event: { type: 'pickup', skaterId: 0 }, margin: PICKUP_MARGIN },
  { at: 1.7, name: 'pass', event: { type: 'pass', from: 0, to: 1, speed: 17 }, margin: MASK_MARGIN },
  { at: 2.4, name: 'shot wrist (0.15)', event: { type: 'shot', shooter: 0, power: 0.15, lifted: false }, margin: MASK_MARGIN },
  // the softest stick sound; reported, not asserted
  { at: 3.1, name: 'passReceived', event: { type: 'passReceived', from: 0, to: 1 }, margin: null },
  { at: CUE_AT, name: 'delayedPenalty cue', event: { type: 'delayedPenalty', team: 1, skaterId: 7 } },
  // the chime's main note rings from ~0.27 s after the event; the murmur swells after it
  { at: CUE_AT + 0.27, name: 'pickup on the ref chime', event: { type: 'pickup', skaterId: 0 }, margin: MASK_MARGIN, overCue: true },
  { at: CUE_AT + 0.75, name: 'pickup in the murmur', event: { type: 'pickup', skaterId: 0 }, margin: MASK_MARGIN, overCue: true },
];

async function maskChecks(): Promise<{ failures: string[]; table: string }> {
  const failures: string[] = [];
  const tables: string[] = [];
  for (const level of MASK_LEVELS) {
    const r = await maskAt(level);
    failures.push(...r.failures);
    tables.push(r.table);
  }
  return { failures, table: tables.join('\n') };
}

async function maskAt(level: number): Promise<{ failures: string[]; table: string }> {
  const fired: number[] = [];
  /** which events' sources are silenced: none (as heard), all (bed only), or the over-cue ones */
  let silence: 'none' | 'all' | 'overCue' = 'none';
  const sc: Scenario = {
    name: 'mask',
    group: 'crowd',
    dur: CUE_AT + 1.6,
    minDur: 0,
    maxDur: 0,
    ambience: true,
    tickDt: 0.05,
    start: (e) => e.crowd!.setLevel(level, 0, 0.05),
    tick: (e, st, t, dt) => {
      MASK_EVENTS.forEach((m, i) => {
        if (t >= m.at && t - dt < m.at) {
          fired[i] = Math.max(e.core!.now(), t);
          // the event still runs (same random draws, same rate limits), its sources just never start
          const mute = silence === 'all' || (silence === 'overCue' && !!m.overCue);
          silenceStarts = mute;
          try {
            e.onEvents([m.event], st);
          } finally {
            silenceStarts = false;
          }
        }
      });
    },
  };
  // the bed's own sources start in unlock(), before any tick: only the event voices go quiet
  const renderAs = async (mode: typeof silence, s: Scenario = sc) => {
    silence = mode;
    try {
      return (await render(s, true)).buf;
    } finally {
      silence = 'none';
      silenceStarts = false;
    }
  };
  const mix = await renderAs('none');
  const bed = await renderAs('all');
  const cueBed = await renderAs('overCue');
  // and the bed with no events at all: no side-chain dips either
  const plain = await renderAs('all', { ...sc, tick: undefined });
  const sr = mix.sampleRate;
  const mL = mix.getChannelData(0);
  const mR = mix.getChannelData(1);
  const diffCum = (ref: AudioBuffer) => {
    const rL = ref.getChannelData(0);
    const rR = ref.getChannelData(1);
    return kCum(
      mL.map((v, i) => v - rL[i]),
      mR.map((v, i) => v - rR[i]),
      sr,
    );
  };
  const evCum = diffCum(bed);
  const evCueCum = diffCum(cueBed);
  const bedCum = kCum(bed.getChannelData(0), bed.getChannelData(1), sr);
  const cueBedCum = kCum(cueBed.getChannelData(0), cueBed.getChannelData(1), sr);
  const win = Math.round(0.1 * sr);
  const hop = Math.round(0.005 * sr);
  const failures: string[] = [];
  const rows = [`${'over crowd bed @ ' + level}`.padEnd(24) + '   event  masker  margin  need  (LUFS, loudest 100 ms of the event)'];
  MASK_EVENTS.forEach((m, i) => {
    if (m.margin === undefined) return;
    const t0 = fired[i];
    if (t0 === undefined) {
      failures.push(`mask: ${m.name} never fired`);
      return;
    }
    const [ev, masker] = m.overCue ? [evCueCum, cueBedCum] : [evCum, bedCum];
    // pickups are ~0.1 s long; the window stops short of the next event
    const span = m.overCue ? 0.3 : 0.4;
    let best = -Infinity;
    let at = 0;
    for (let s = Math.max(0, Math.floor((t0 - 0.02) * sr)); s + win <= Math.min(mL.length, Math.floor((t0 + span) * sr)); s += hop) {
      const l = lufsOf(ev, s, s + win);
      if (l > best) {
        best = l;
        at = s;
      }
    }
    const maskL = lufsOf(masker, at, at + win);
    const margin = best - maskL;
    const need = m.margin === null ? '(info)' : `>= ${m.margin}`;
    rows.push(`${m.name.padEnd(24)} ${best.toFixed(1).padStart(7)} ${maskL.toFixed(1).padStart(7)} ${(margin >= 0 ? '+' : '') + margin.toFixed(1).padStart(5)}  ${need}`);
    if (m.margin !== null && !(margin >= m.margin)) failures.push(`mask: ${m.name} only ${margin.toFixed(1)} dB over the ${m.overCue ? 'bed + delayed-penalty cue' : 'crowd bed'} @ ${level} (need >= ${m.margin})`);
  });
  // the cue by band: out of the stick band, clear in its own (100 ms windows over its length)
  const cueT = fired[MASK_EVENTS.findIndex((m) => m.event.type === 'delayedPenalty')];
  if (cueT !== undefined) {
    const bL = bed.getChannelData(0);
    const bR = bed.getChannelData(1);
    const cL = cueBed.getChannelData(0);
    const cR = cueBed.getChannelData(1);
    const stickBed = bandCum(bL, bR, sr, STICK_BAND);
    const stickCue = bandCum(cL, cR, sr, STICK_BAND);
    const ownBed = bandCum(bL, bR, sr, CUE_BAND);
    const ownCue = bandCum(
      cL.map((v, i) => v - bL[i]),
      cR.map((v, i) => v - bR[i]),
      sr,
      CUE_BAND,
    );
    let lift = -Infinity;
    let clear = -Infinity;
    let best = -Infinity;
    for (let s = Math.floor(cueT * sr); s + win <= Math.min(mL.length, Math.floor((cueT + 1.5) * sr)); s += hop) {
      lift = Math.max(lift, lufsOf(stickCue, s, s + win) - lufsOf(stickBed, s, s + win));
      const own = lufsOf(ownCue, s, s + win);
      if (own > best) {
        best = own;
        clear = own - lufsOf(ownBed, s, s + win);
      }
    }
    rows.push(`delayed-penalty cue: lifts the bed ${lift.toFixed(1)} dB at ${STICK_BAND.join('-')} Hz (need <= ${CUE_STICK_LIFT}), ${(clear >= 0 ? '+' : '') + clear.toFixed(1)} dB over it at ${CUE_BAND.join('-')} Hz (need >= ${CUE_CLEAR})`);
    if (!(lift <= CUE_STICK_LIFT)) failures.push(`mask: the delayed-penalty cue lifts the crowd bed @ ${level} by ${lift.toFixed(1)} dB in the stick band (need <= ${CUE_STICK_LIFT})`);
    if (!(clear >= CUE_CLEAR)) failures.push(`mask: the delayed-penalty cue only ${clear.toFixed(1)} dB over the crowd bed @ ${level} in its band (need >= ${CUE_CLEAR})`);
  }
  // side-chain: the shot ducks the bed ~4 dB at once and lets it back up
  const shotT = fired[MASK_EVENTS.findIndex((m) => m.event.type === 'shot')];
  if (shotT !== undefined) {
    const plainCum = kCum(plain.getChannelData(0), plain.getChannelData(1), sr);
    const dip = (from: number) => {
      const a = Math.round((shotT + from) * sr);
      return lufsOf(plainCum, a, a + win) - lufsOf(bedCum, a, a + win);
    };
    const now = dip(0.03);
    const later = dip(1.0);
    rows.push(`bed duck under the shot: ${now.toFixed(1)} dB (+30 ms), ${later.toFixed(1)} dB (+1 s)`);
    if (!(now >= DUCK_MIN)) failures.push(`mask: the shot ducks the crowd bed @ ${level} only ${now.toFixed(1)} dB (need >= ${DUCK_MIN})`);
    if (!(Math.abs(later) <= DUCK_RECOVERED)) failures.push(`mask: crowd bed @ ${level} still ${later.toFixed(1)} dB ducked 1 s after the shot`);
  }
  return { failures, table: rows.join('\n') };
}

// Mix regression: the home goal (horn + roar + fanfare) is the loudest thing
// in the game, the ref's whistle sits well under it, and the puck layer
// (a full slap shot) isn't buried under the whistle. Names match SCENARIOS.
const GOAL = 'goal (PUPS): horn+roar+fanfare';
const WHISTLES = ['whistle (offIce)', 'whistle (freeze)'];
const SLAP = 'shot slap (1.0)';
const GOAL_OVER_ALL = 0.5; // dB the goal must beat every other sound by
// the ref sits ~8 dB under the goal; 7.5 leaves the margin room to drift without hitting 6
const WHISTLE_UNDER_GOAL = 7.5;
const SLAP_UNDER_WHISTLE = 6;
// the delayed-penalty cue plays under live play: clearly under the ref's real
// whistle (the stoppage outranks it). Heard over the bed: see maskChecks.
const CUES = ['delayedPenalty (BLZ foul)', 'delayedPenalty (PUPS foul)'];
const CUE_UNDER_WHISTLE = 3;
// the bed at a typical live level stays quiet and dark (crowd.ts)
const BED = 'crowd bed @ 0.5';
const BED_MAX_LUFS = -29;
const BED_MAX_HI = 15; // % of energy above 2 kHz

function mixChecks(items: Item[]): { failures: string[]; table: string } {
  const failures: string[] = [];
  const by = new Map(items.map((i) => [i.name, i]));
  const lu = (name: string) => by.get(name)?.lufs ?? NaN;
  const goal = lu(GOAL);
  const whistle = Math.max(...WHISTLES.map(lu));
  const slap = lu(SLAP);
  if (!Number.isFinite(goal) || !Number.isFinite(whistle) || !Number.isFinite(slap)) failures.push('mix: goal/whistle/slap loudness missing');
  // flows and the stress test contain goals themselves; compare single sounds, cues and the crowd
  const others = items.filter((i) => i.name !== GOAL && i.lufs !== undefined && (i.group === 'sfx' || i.group === 'music' || i.group === 'crowd'));
  for (const o of others) if (!(o.lufs! <= goal - GOAL_OVER_ALL)) failures.push(`mix: ${o.name} ${o.lufs} LUFS not under the goal ${goal} - ${GOAL_OVER_ALL}`);
  if (!(whistle <= goal - WHISTLE_UNDER_GOAL)) failures.push(`mix: whistle ${whistle} LUFS not ${WHISTLE_UNDER_GOAL} dB under the goal ${goal}`);
  if (!(slap >= whistle - SLAP_UNDER_WHISTLE)) failures.push(`mix: slap shot ${slap} LUFS more than ${SLAP_UNDER_WHISTLE} dB under the whistle ${whistle}`);
  const cueRows: string[] = [];
  for (const name of CUES) {
    const c = lu(name);
    cueRows.push(`${name} ${c} (whistle ${(c - whistle).toFixed(1)} dB, need <= -${CUE_UNDER_WHISTLE})`);
    if (!Number.isFinite(c)) failures.push(`mix: ${name} loudness missing`);
    if (!(c <= whistle - CUE_UNDER_WHISTLE)) failures.push(`mix: ${name} ${c} LUFS not ${CUE_UNDER_WHISTLE} dB under the whistle ${whistle}`);
  }
  const bed = by.get(BED);
  if (!bed || !(bed.lufs! <= BED_MAX_LUFS)) failures.push(`mix: ${BED} ${bed?.lufs} LUFS (need <= ${BED_MAX_LUFS})`);
  if (!bed || !(bed.bands[2] < BED_MAX_HI)) failures.push(`mix: ${BED} has ${bed?.bands[2]}% of its energy above 2 kHz (need < ${BED_MAX_HI}%)`);

  const rows = items
    .filter((i) => i.lufs !== undefined && i.group !== 'flow' && i.group !== 'stress')
    .sort((a, b) => b.lufs! - a.lufs!)
    .map((i) => `${i.name.padEnd(34)} ${i.lufs!.toFixed(1).padStart(6)} ${i.lufsS!.toFixed(1).padStart(6)} ${(i.lufs! - goal).toFixed(1).padStart(6)}  ${i.group}`);
  const table = [
    `${'sound'.padEnd(34)} ${'M400'.padStart(6)} ${'S100'.padStart(6)} ${'vsGoal'.padStart(6)}  (LUFS, K-weighted, loudest window)`,
    ...rows,
    `goal ${goal} | whistle ${whistle} (goal - ${(goal - whistle).toFixed(1)} dB, need >= ${WHISTLE_UNDER_GOAL}) | slap ${slap} (whistle ${(slap - whistle >= 0 ? '+' : '')}${(slap - whistle).toFixed(1)} dB, need >= -${SLAP_UNDER_WHISTLE})`,
    `${BED} ${bed?.lufs} LUFS (need <= ${BED_MAX_LUFS}), ${bed?.bands[2]}% above 2 kHz (need < ${BED_MAX_HI})`,
    ...cueRows,
  ].join('\n');
  return { failures, table };
}

// --------------------------------------------------------------- spectra ----

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

function frameMag(L: Float32Array, R: Float32Array, center: number, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = center - n / 2 + i;
    const v = k >= 0 && k < L.length ? (L[k] + R[k]) / 2 : 0;
    re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / (n / 4);
  return mag;
}

/** centroid + dominant frequency of the loudest 4096-sample window */
function spectrumStats(L: Float32Array, R: Float32Array): { centroid: number; domHz: number } {
  const n = 4096;
  let best = 0;
  let bestE = -1;
  for (let c = n / 2; c < L.length; c += n / 2) {
    let e = 0;
    for (let i = c - n / 2; i < Math.min(L.length, c + n / 2); i += 4) e += L[i] * L[i];
    if (e > bestE) {
      bestE = e;
      best = c;
    }
  }
  const mag = frameMag(L, R, best, n);
  let num = 0;
  let den = 0;
  let dom = 0;
  for (let i = 1; i < mag.length; i++) {
    const f = (i * SR) / n;
    num += f * mag[i];
    den += mag[i];
    if (mag[i] > mag[dom]) dom = i;
  }
  return { centroid: den ? num / den : 0, domHz: (dom * SR) / n };
}

function drawItem(buf: AudioBuffer, title: string, info: string, bad: boolean): void {
  const div = document.createElement('div');
  div.className = bad ? 'item bad' : 'item';
  const W = 240;
  const H = 72;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H + 22;
  const g = cv.getContext('2d')!;
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const img = g.createImageData(W, H);
  const n = 512;
  const fMin = 40;
  const fMax = SR / 2;
  for (let x = 0; x < W; x++) {
    const mag = frameMag(L, R, Math.floor(((x + 0.5) / W) * L.length), n);
    for (let y = 0; y < H; y++) {
      // log-frequency rows, high at the top
      const f = fMin * Math.pow(fMax / fMin, 1 - (y + 0.5) / H);
      const bin = Math.min(mag.length - 1, Math.round((f * n) / SR));
      const db = 20 * Math.log10(mag[bin] + 1e-9);
      const v = Math.max(0, Math.min(1, (db + 90) / 80));
      const o = (y * W + x) * 4;
      img.data[o] = Math.round(255 * Math.min(1, v * 2.2));
      img.data[o + 1] = Math.round(255 * Math.max(0, v * 2 - 0.7));
      img.data[o + 2] = Math.round(255 * Math.max(0, Math.min(1, v * 3)) * (1 - v) + 40 * v);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // waveform envelope strip
  g.fillStyle = '#000';
  g.fillRect(0, H, W, 22);
  g.fillStyle = '#58d858';
  const per = L.length / W;
  for (let x = 0; x < W; x++) {
    let m = 0;
    for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    const h = Math.round(m * 21);
    g.fillRect(x, H + 22 - h, 1, h);
  }
  g.fillStyle = '#f03030';
  g.fillRect(0, H + 22 - Math.round(0.95 * 21), W, 1);
  div.innerHTML = `<div class="t">${title}</div><div class="m">${info}</div>`;
  div.appendChild(cv);
  document.getElementById('grid')!.appendChild(div);
}

// --------------------------------------------------- transcription check ----
// Render each song's lead channel solo and verify, note by note, that the
// expected fundamental is present and stronger than its semitone neighbours
// at the scheduled time. Proves pitch + timing (steps, swing, note names).

function goertzel(x: Float32Array, from: number, to: number, f: number): number {
  const w = (2 * Math.PI * f) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from - 1));
    const s0 = x[i] * win + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

async function transcription(name: SongName): Promise<{ song: string; notes: number; hits: number; misses: string[] }> {
  const def = SONGS[name];
  const song = compileSong(def);
  const t0 = 0.3; // let the master chain settle
  let steps = 0;
  for (const o of def.order) steps += song.patterns.get(o)!.steps;
  const dur = t0 + steps * song.stepDur + 0.5;
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * dur), SR);
  const core = new AudioCore(ctx, { seed: 7 });
  const player = new MusicPlayer(core, song, t0, { solo: 'lead' });
  player.pump(dur);
  const x = (await ctx.startRendering()).getChannelData(0);
  const misses: string[] = [];
  let notes = 0;
  let base = 0;
  for (const o of def.order) {
    const pat = song.patterns.get(o)!;
    for (const e of pat.channels.lead ?? []) {
      const t = t0 + (base + e.step) * song.stepDur + swingOffset(def, e.step, song.stepDur);
      // analyse the body of the note, skipping the attack
      const len = Math.min(e.len * song.stepDur * 0.85, 0.25);
      const from = Math.floor((t + 0.02) * SR);
      const to = Math.floor((t + 0.02 + Math.max(0.05, len)) * SR);
      for (const m of e.midi) {
        notes++;
        const f = midiToFreq(m);
        const p = goertzel(x, from, to, f);
        const lo = goertzel(x, from, to, f / Math.pow(2, 1 / 12));
        const hi = goertzel(x, from, to, f * Math.pow(2, 1 / 12));
        if (!(p > 2 * Math.max(lo, hi))) misses.push(`${o}@${e.step} midi ${m} (${(10 * Math.log10(p / Math.max(lo, hi, 1e-12))).toFixed(1)} dB)`);
      }
    }
    base += pat.steps;
  }
  return { song: name, notes, hits: notes - misses.length, misses };
}

// ----------------------------------------------------------------- main ----

interface Item extends Metrics {
  name: string;
  group: string;
  rawPeak: number;
  ok: boolean;
  why: string[];
  log?: string[];
  /** raw (pre-clipper) peak per second, to find hot spots */
  rawPeaks?: number[];
  /** loudest K-weighted 400 ms / 100 ms window (LUFS), as heard (with the clipper) */
  lufs?: number;
  lufsS?: number;
}

function windowPeaks(buf: AudioBuffer, win: number): number[] {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const n = Math.round(win * SR);
  const out: number[] = [];
  for (let s = 0; s < L.length; s += n) {
    let m = 0;
    for (let i = s; i < Math.min(L.length, s + n); i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    out.push(Math.round(m * 100) / 100);
  }
  return out;
}

async function main(): Promise<void> {
  const status = document.getElementById('status')!;
  const items: Item[] = [];
  const t0 = performance.now();
  // ?quick=1: single sounds, the crowd and the mix/masking rules only (for
  // tuning levels); the report says so, and a quick run is never the gate
  const quick = new URLSearchParams(location.search).get('quick') === '1';
  const scenarios = quick ? SCENARIOS.filter((sc) => sc.group === 'sfx' || sc.group === 'crowd') : SCENARIOS;
  for (const sc of scenarios) {
    status.textContent = `rendering ${sc.name} (${items.length + 1}/${scenarios.length})`;
    let item: Item;
    try {
      const { buf, log } = await render(sc, true);
      sc.check?.(buf, log);
      const m = measure(buf);
      const rawBuf = (await render(sc, false)).buf;
      const raw = measure(rawBuf);
      const why: string[] = [];
      const silentOk = sc.maxDur === 0;
      if (silentOk) {
        if (m.peak > THRESH) why.push('should be silent');
      } else {
        if (m.peak < 0.02) why.push('silent');
        if (m.dur < sc.minDur) why.push(`short ${m.dur}s < ${sc.minDur}`);
        if (m.dur > sc.maxDur) why.push(`long ${m.dur}s > ${sc.maxDur}`);
      }
      if (m.peak > 0.95) why.push(`peak ${m.peak}`);
      if (m.nan || raw.nan) why.push(`NaN x${m.nan + raw.nan}`);
      for (const l of log) if (l.startsWith(FAIL)) why.push(l.slice(FAIL.length));
      const lufs = m.peak > THRESH ? loudness(buf, 0.4) : undefined;
      const lufsS = m.peak > THRESH ? loudness(buf, 0.1) : undefined;
      item = { name: sc.name, group: sc.group, ...m, rawPeak: raw.peak, ok: why.length === 0, why, log: log.length ? log : undefined, lufs, lufsS };
      if (sc.group === 'flow' || sc.group === 'stress') item.rawPeaks = windowPeaks(rawBuf, 1);
      drawItem(buf, `${item.ok ? '' : '!! '}${sc.name}`, `pk ${m.peak} raw ${raw.peak} rms ${m.rms} ${m.dur}s ${lufs ?? '-'}LU<br>c${m.centroid} f${m.domHz} L/M/H ${m.bands.join('/')}`, !item.ok);
    } catch (e) {
      item = { name: sc.name, group: sc.group, peak: 0, rms: 0, start: 0, end: 0, dur: 0, nan: 0, clip: 0, centroid: 0, domHz: 0, bands: [0, 0, 0], rawPeak: 0, ok: false, why: [`threw: ${(e as Error).message}`] };
    }
    items.push(item);
  }
  const failures = items.filter((i) => !i.ok).map((i) => `${i.name}: ${i.why.join(', ')}`);
  const mix = mixChecks(items);
  failures.push(...mix.failures);
  status.textContent = 'masking check...';
  const mask = await maskChecks();
  failures.push(...mask.failures);
  if (quick) {
    const loudness = `${mix.table}\n\n${mask.table}`;
    document.getElementById('loudness')!.textContent = loudness;
    const report = { quick: true, sampleRate: SR, renderMs: Math.round(performance.now() - t0), count: items.length, ok: failures.length === 0, failures, loudness, items };
    (window as unknown as { __audioReport: unknown }).__audioReport = report;
    status.textContent = `QUICK: ${items.length} items, ${failures.length} failures${failures.length ? ' :: ' + failures.join(' | ') : ''}`;
    return;
  }
  status.textContent = 'music low end / swing / intermission fit...';
  const musicReport = await musicChecks();
  failures.push(...musicReport.failures);
  status.textContent = 'character: crowd flatness / bark / pause duck / echo...';
  const character = await characterChecks();
  failures.push(...character.failures);
  const loudnessTable = `${mix.table}\n\n${mask.table}\n\n${musicReport.table}\n\n${character.table}`;
  document.getElementById('loudness')!.textContent = loudnessTable;
  status.textContent = 'transcription check...';
  const notes = [];
  for (const name of Object.keys(SONGS) as SongName[]) {
    const r = await transcription(name);
    notes.push(r);
    if (r.hits < r.notes) failures.push(`transcription ${name}: ${r.notes - r.hits}/${r.notes} lead notes not found`);
  }
  const report = { sampleRate: SR, renderMs: Math.round(performance.now() - t0), count: items.length, ok: failures.length === 0, failures, loudness: loudnessTable, music: musicReport, character, items, notes };
  (window as unknown as { __audioReport: unknown }).__audioReport = report;
  status.textContent = `${items.length} items, ${failures.length} failures, ${report.renderMs} ms${failures.length ? ' :: ' + failures.join(' | ') : ''}`;
}

void main();
