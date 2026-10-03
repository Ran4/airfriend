// Acceptance test for the main loop's fixed-step clock and render
// interpolation (src/core/loop.ts, used by src/main.ts). Node only, no browser.
//
//   ./node_modules/.bin/tsx tools/integ-loop.ts [seconds=120]
//
// 1. Clock: replays vsync timestamps for several displays through the real
//    FixedClock and counts frames that ran 0 or 2+ sim steps. Near-60 Hz
//    displays (59.94 / 60 / 60.05 Hz with +-0.3 ms timestamp jitter, also
//    starting right at the tick boundary) must run exactly 1 step per frame.
//    The old unsnapped accumulator is replayed alongside for comparison.
//    For every display, the drawn game time (last tick - 1 + alpha) must
//    advance by exactly the credited frame time: that is what makes 144 Hz
//    smooth even though its step pattern is irregular.
// 2. Interp: plays real AI-vs-AI ticks through the same loop (144 Hz frames,
//    snapshot before each step, apply/restore around a fake draw) and checks
//    that the draw saw lerped positions between prev and cur, that teleports
//    (faceoff setup) are drawn at cur, that every value is restored
//    bit-for-bit, and that the final state is identical to a run of the same
//    seed that never interpolated (sim determinism intact).
//
// Exits non-zero on any failure.

import { SIM_DT } from '../src/config';
import { emptyPad } from '../src/core/input';
import { FixedClock, RenderInterp, TELEPORT } from '../src/core/loop';
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, setRandom } from '../src/sim/util';
import type { GameState } from '../src/types';

const seconds = Number(process.argv[2] ?? 120);
let failures = 0;
function check(ok: boolean, msg: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
}

// ------------------------------------------------------------------ clock ---

interface Display {
  name: string;
  hz: number;
  jitterMs: number; // +- uniform jitter on each vsync timestamp
  startAcc?: number; // accumulator at the first frame
  nearSixty: boolean; // must run exactly one step per frame
}

const displays: Display[] = [
  { name: '59.94 Hz +-0.3 ms', hz: 59.94, jitterMs: 0.3, nearSixty: true },
  { name: '60.05 Hz +-0.3 ms', hz: 60.05, jitterMs: 0.3, nearSixty: true },
  { name: '60 Hz +-0.3 ms, starts at the tick boundary', hz: 60, jitterMs: 0.3, startAcc: SIM_DT * 0.9999, nearSixty: true },
  { name: '60 Hz +-0.3 ms, starts just past the boundary', hz: 60, jitterMs: 0.3, startAcc: SIM_DT * 0.0001, nearSixty: true },
  { name: '144 Hz +-0.3 ms', hz: 144, jitterMs: 0.3, nearSixty: false },
  { name: '120 Hz +-0.3 ms', hz: 120, jitterMs: 0.3, nearSixty: false },
  { name: '75 Hz', hz: 75, jitterMs: 0, nearSixty: false },
  { name: '30 Hz', hz: 30, jitterMs: 0, nearSixty: false },
];

/** the accumulator main.ts had before this change, for comparison */
function oldSteps(acc: { v: number }, dt: number): number {
  acc.v += dt;
  let n = 0;
  while (acc.v >= SIM_DT && n < 8) {
    acc.v -= SIM_DT;
    n++;
  }
  if (n >= 8) acc.v = 0;
  return n;
}

function hist(counts: Map<number, number>, frames: number): string {
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}-step ${((100 * v) / frames).toFixed(1)}%`)
    .join(', ');
}

/** longest run of consecutive frames that were not 1-step, plus how many such bursts */
function bursts(steps: number[]): { count: number; longest: number } {
  let count = 0;
  let longest = 0;
  let run = 0;
  for (const n of steps) {
    if (n !== 1) {
      if (run === 0) count++;
      run++;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return { count, longest };
}

console.log(`-- clock: ${seconds} s per display`);
for (const d of displays) {
  const rng = mulberry32(1234);
  const periodMs = 1000 / d.hz;
  const frames = Math.round(seconds * d.hz);
  const clock = new FixedClock();
  clock.acc = d.startAcc ?? 0;
  const old = { v: d.startAcc ?? 0 };
  const newSteps: number[] = [];
  const oldStepList: number[] = [];
  const newHist = new Map<number, number>();
  const oldHist = new Map<number, number>();
  let ticks = 0;
  let drawnPrev = (ticks - 1 + clock.alpha) * SIM_DT;
  let credited = 0;
  let maxDrawErr = 0;
  let lastMs = 0;
  for (let k = 1; k <= frames; k++) {
    const nowMs = k * periodMs + (rng() * 2 - 1) * d.jitterMs;
    const raw = (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    const dt = FixedClock.frameSeconds(raw);
    const n = clock.advance(dt, 1, () => {
      ticks++;
      return true;
    });
    newSteps.push(n);
    newHist.set(n, (newHist.get(n) ?? 0) + 1);
    const o = oldSteps(old, Math.min(0.1, raw));
    oldStepList.push(o);
    oldHist.set(o, (oldHist.get(o) ?? 0) + 1);
    // drawn game time must advance by exactly the frame time credited
    credited += dt;
    const drawn = (ticks - 1 + clock.alpha) * SIM_DT;
    maxDrawErr = Math.max(maxDrawErr, Math.abs(drawn - drawnPrev - dt));
    drawnPrev = drawn;
  }
  const b = bursts(newSteps);
  const ob = bursts(oldStepList);
  console.log(`   ${d.name}`);
  console.log(`     new: ${hist(newHist, frames)}; non-1-step bursts ${b.count} (longest ${b.longest} frames)`);
  console.log(`     old: ${hist(oldHist, frames)}; non-1-step bursts ${ob.count} (longest ${ob.longest} frames)`);
  if (d.nearSixty) check(b.count === 0, `${d.name}: every frame runs exactly one sim step`);
  check(maxDrawErr < 1e-9, `${d.name}: drawn time advances by exactly the frame time (max err ${maxDrawErr.toExponential(1)} s)`);
  check(Math.abs(ticks * SIM_DT + clock.acc - (d.startAcc ?? 0) - credited) < 1e-6, `${d.name}: no game time lost or invented`);
}

// a long hitch is dropped, not replayed as a 6-step burst
{
  const c = new FixedClock();
  const dt = FixedClock.frameSeconds(5);
  let n = c.advance(dt, 1, () => true);
  check(dt === 0.1 && n === 6, `5 s hitch credited as 0.1 s (${n} steps)`);
  n = c.advance(FixedClock.frameSeconds(-0.01), 1, () => true);
  check(n === 0, 'negative frame time runs nothing');
  // a throwing sim: one attempt, backlog dropped
  let calls = 0;
  n = c.advance(0.1, 4, () => (calls++, false));
  check(calls === 1 && n === 0 && c.acc === 0, 'sim fault: one attempt per frame, backlog dropped');
}

// ----------------------------------------------------------------- interp ---

const SEED = 7;
const TICKS = 60 * 60 * 4; // four minutes of game time: faceoffs, goals, a period end

function numbers(s: GameState): number[] {
  // every number in the state, in a fixed order (deep walk)
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const k of Object.keys(v).sort()) walk((v as Record<string, unknown>)[k]);
  };
  walk(s);
  return out;
}

function drawn(s: GameState): number[] {
  const out: number[] = [];
  for (const sk of s.skaters) out.push(sk.pos.x, sk.pos.z);
  out.push(s.puck.pos.x, s.puck.pos.z, s.puck.y, s.referee.pos.x, s.referee.pos.z);
  return out;
}

const sameBits = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

console.log(`-- interp: ${TICKS} ticks, seed ${SEED}, 144 Hz frames`);

// reference run: the plain sim, never interpolated
setRandom(mulberry32(SEED));
const ref = createGame({ autoplay: true });
for (let i = 0; i < TICKS; i++) stepGame(ref, emptyPad());
const refNums = numbers(ref);

// interpolated run through the real clock + interp
setRandom(mulberry32(SEED));
const st = createGame({ autoplay: true });
const clock = new FixedClock();
const interp = new RenderInterp();
let ticks = 0;
let prevDrawn = drawn(st);
let frames = 0;
let lerpedFrames = 0;
let restoreBad = 0;
let outOfRange = 0;
let teleports = 0;
let teleportBad = 0;
let otherState = 0;
const rng = mulberry32(99);
while (ticks < TICKS) {
  const dt = FixedClock.frameSeconds(1 / 144 + (rng() * 2 - 1) * 0.0003);
  clock.advance(dt, 1, () => {
    if (ticks >= TICKS) return true; // keep the tick count exact; acc is irrelevant here
    prevDrawn = drawn(st);
    interp.snapshot(st);
    stepGame(st, emptyPad());
    ticks++;
    return true;
  });
  frames++;
  const before = drawn(st);
  const allBefore = numbers(st);
  const a = clock.alpha;
  const lerped = interp.apply(st, a);
  try {
    if (lerped) {
      lerpedFrames++;
      const mid = drawn(st);
      // each drawn object is between prev and cur (or at cur after a teleport)
      const groups: number[][] = st.skaters.map((_, k) => [2 * k, 2 * k + 1]);
      const j = 2 * st.skaters.length;
      groups.push([j, j + 1, j + 2], [j + 3, j + 4]);
      for (const g of groups) {
        const d2 = g.reduce((acc, i) => acc + (before[i] - prevDrawn[i]) ** 2, 0);
        if (d2 > TELEPORT * TELEPORT) {
          teleports++;
          if (!g.every((i) => Object.is(mid[i], before[i]))) teleportBad++;
          continue;
        }
        for (const i of g) {
          const want = prevDrawn[i] + (before[i] - prevDrawn[i]) * a;
          if (Math.abs(mid[i] - want) > 1e-9) outOfRange++;
        }
      }
      // a draw that writes into the state (it must not) is undone by restore too
      st.skaters[0].pos.x = 1e9;
    }
    // another state (restart) or a forgotten snapshot never lerps
    const other = createGame({ autoplay: true });
    if (interp.apply(other, 0.5)) {
      otherState++;
      interp.restore();
    }
  } finally {
    if (lerped) interp.restore();
  }
  if (!sameBits(drawn(st), before) || !sameBits(numbers(st), allBefore)) restoreBad++;
}
console.log(`   ${frames} frames, ${lerpedFrames} lerped, ${teleports} teleports drawn at cur`);
check(lerpedFrames > frames * 0.9, 'nearly every frame draws interpolated positions');
check(outOfRange === 0, `lerped positions = lerp(prev, cur, alpha) (${outOfRange} off)`);
check(teleports > 0 && teleportBad === 0, `teleports (faceoff setup) drawn at cur, not slid (${teleports} seen, ${teleportBad} bad)`);
check(restoreBad === 0, `after every draw the whole state equals the pre-draw state bit-for-bit (${restoreBad} bad)`);
check(otherState === 0, 'a different GameState is never lerped');
check(sameBits(numbers(st), refNums), 'final state identical to the never-interpolated run of the same seed');

// invalidate(): draws show the raw state until the next snapshot
interp.invalidate();
check(!interp.apply(st, 0.5), 'after invalidate() nothing is lerped');
interp.snapshot(st);
check(interp.apply(st, 0.5), 'the next snapshot re-arms it');
check(!interp.apply(st, 0.5), 'a second apply before restore is refused');
interp.restore();
interp.restore(); // harmless
check(sameBits(numbers(st), refNums), 'double restore leaves the state intact');

setRandom(null);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
