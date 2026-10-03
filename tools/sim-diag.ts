// Diagnostics for balance tuning: what happens to every shot, hit force
// distribution, possession stats.  npx tsx tools/sim-diag.ts [games=10] [seed]

import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';

const games = Number(process.argv[2] ?? 10);
if (process.argv[3] !== undefined) setRandom(mulberry32(Number(process.argv[3])));

const outcomes: Record<string, number> = {};
const forces: number[] = [];
const shotDist: number[] = [];
const shotPower: number[] = [];
let knock = 0;
let ticksTotal = 0;
const poss = [0, 0, 0];
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: true });
  let pending: { t: number; team: number } | null = null;
  const close = (k: string) => {
    if (pending) outcomes[k] = (outcomes[k] ?? 0) + 1;
    pending = null;
  };
  while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 30) {
    stepGame(st, emptyPad());
    ticksTotal++;
    if (st.phase === 'play') poss[st.puck.owner === null ? 2 : st.skaters[st.puck.owner].team]++;
    for (const e of st.events) {
      if (e.type === 'shot') {
        close('superseded');
        pending = { t: st.time, team: st.skaters[e.shooter].team };
        const s = st.skaters[e.shooter];
        const gz = (st.skaters[e.shooter].team === 0 ? 1 : -1) * (st.period % 2 === 1 || st.period > 3 ? 1 : -1) * 26.5;
        shotDist.push(Math.hypot(s.pos.x, s.pos.z - gz));
        shotPower.push(e.power);
      } else if (e.type === 'goal') close('goal');
      else if (e.type === 'save') close(e.caught ? 'save-catch' : 'save-rebound');
      else if (e.type === 'post') close('post');
      else if (e.type === 'netHit') close('netHit');
      else if (e.type === 'boards') close('boards(miss)');
      else if (e.type === 'pickup') close(st.skaters[e.skaterId].team === pending?.team ? 'pickup-own' : 'pickup-opp');
      else if (e.type === 'check') {
        forces.push(e.force);
        if (e.knockedDown) knock++;
      }
    }
    if (pending && st.time - pending.t > 3) close('timeout');
  }
}
console.log('shot outcomes:', JSON.stringify(outcomes));
const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * f)]?.toFixed(1);
console.log(`shot distance p10/50/90: ${q(shotDist, 0.1)} ${q(shotDist, 0.5)} ${q(shotDist, 0.9)}  power p50 ${q(shotPower, 0.5)}`);
console.log(`hits/game ${(forces.length / games).toFixed(1)} knockdowns/game ${(knock / games).toFixed(1)} force p10/50/90/max: ${q(forces, 0.1)} ${q(forces, 0.5)} ${q(forces, 0.9)} ${q(forces, 0.999)}`);
const pt = poss[0] + poss[1] + poss[2];
console.log(`possession home ${((poss[0] / pt) * 100).toFixed(0)}% away ${((poss[1] / pt) * 100).toFixed(0)}% loose ${((poss[2] / pt) * 100).toFixed(0)}%`);
