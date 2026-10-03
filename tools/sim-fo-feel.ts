// Faceoff feel: can a human win draws by counting from the lineup instead of
// watching the puck? Like tools/qa-feel-fo.ts, but on normal (mid-period)
// faceoffs and with the reaction pressers timed from the real drop.
//   ./node_modules/.bin/tsx tools/sim-fo-feel.ts [N]
// Prints win / false-start rates for a sweep of fixed lineup->press times
// (the best one is the most a rhythm presser can get), for reaction pressers,
// and for period openers.

import { SIM_DT } from '../src/config';
import { emptyPad } from '../src/core/input';
import { setupFaceoff } from '../src/sim/faceoff';
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, setRandom } from '../src/sim/util';
import type { GameState } from '../src/types';

const N = Number(process.argv[2] ?? 400);
const noise = mulberry32(5);
const gaussish = () => (noise() + noise() + noise() - 1.5) * 2;

/** A fresh mid-period faceoff (or a period opener) with the human taking it. */
function faceoff(seed: number, opener: boolean): GameState {
  setRandom(mulberry32(seed));
  const st = createGame({ autoplay: false });
  while (st.phase !== 'faceoff') stepGame(st, emptyPad());
  if (!opener) setupFaceoff(st, { x: 0, z: 0 });
  return st;
}

/** Press SHOOT at `pressAt(st)` s of phase time; returns [won, falseStart]. */
function draw(st: GameState, pressAt: (st: GameState) => number): [boolean, boolean] {
  const at = pressAt(st);
  let pressed = false;
  let fs = false;
  for (let k = 0; k < 400; k++) {
    const p = emptyPad();
    const press = !pressed && st.phaseTime + SIM_DT >= at;
    if (press) pressed = true;
    p.shoot = { held: press, pressed: press, released: false };
    stepGame(st, p);
    for (const e of st.events) {
      if (e.type === 'falseStart' && e.team === 0) fs = true;
      if (e.type === 'faceoffWin') return [e.team === 0, fs];
    }
  }
  return [false, fs];
}

function row(label: string, opener: boolean, pressAt: (st: GameState) => number): number {
  let win = 0;
  let fs = 0;
  for (let i = 0; i < N; i++) {
    const [w, f] = draw(faceoff(i + 1, opener), pressAt);
    if (w) win++;
    if (f) fs++;
  }
  console.log(`${label.padEnd(44)} win ${((100 * win) / N).toFixed(0).padStart(3)}%  false starts ${((100 * fs) / N).toFixed(0).padStart(3)}%`);
  return win / N;
}

console.log(`normal faceoffs (N=${N})`);
let best = 0;
for (let t = 0.8; t <= 1.81; t += 0.1) {
  const mu = t;
  best = Math.max(best, row(`rhythm press at lineup+${mu.toFixed(2)}s (sd 40ms)`, false, () => mu + gaussish() * 0.04));
}
row('rhythm press at lineup+1.18s (sd 40ms)', false, () => 1.18 + gaussish() * 0.04);
row('reaction: drop+0.25s (sd 50ms)', false, (st) => st.faceoff!.dropTime + 0.25 + gaussish() * 0.05);
row('reaction: drop+0.32s (sd 60ms)', false, (st) => st.faceoff!.dropTime + 0.32 + gaussish() * 0.06);
console.log(`best fixed rhythm: ${(100 * best).toFixed(0)}%  (target < 60%)`);
console.log('period openers');
row('rhythm press at lineup+2.20s (sd 40ms)', true, () => 2.2 + gaussish() * 0.04);
row('reaction: drop+0.25s (sd 50ms)', true, (st) => st.faceoff!.dropTime + 0.25 + gaussish() * 0.05);
