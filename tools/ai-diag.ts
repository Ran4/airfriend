// AI diagnostics: per-shot context (distance, angle, charge, goalie offset from
// the ideal angle line, goalie state, what led to the shot) and outcome tables.
//   npx tsx tools/ai-diag.ts [games] [seed]
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';
import { attackGoalZ } from '../src/sim/rink';
import type { GameState } from '../src/types';

const games = Number(process.argv[2] ?? 10);
setRandom(mulberry32(Number(process.argv[3] ?? 7)));

interface ShotRec {
  dist: number;
  angle: number;
  power: number;
  goalieOff: number;
  goalieState: string;
  src: string;
  outcome: string;
  team: number;
}
const shots: ShotRec[] = [];
let lastPassRecv = -10;
let lastPickup = -10;
let lastPickupKind = '';

for (let g = 0; g < games; g++) {
  const st: GameState = createGame({ autoplay: true });
  let pending: ShotRec | null = null;
  let pendingT = 0;
  const close = (o: string) => {
    if (pending) {
      pending.outcome = o;
      shots.push(pending);
    }
    pending = null;
  };
  while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 30) {
    stepGame(st, emptyPad());
    for (const e of st.events) {
      if (e.type === 'passReceived') lastPassRecv = st.time;
      if (e.type === 'pickup') {
        lastPickup = st.time;
        const s = st.skaters[e.skaterId];
        lastPickupKind = st.puck.prevTouch !== null && st.skaters[st.puck.prevTouch]?.kind === 'goalie' ? 'rebound' : s.kind;
      }
      if (e.type === 'shot') {
        close('superseded');
        const s = st.skaters[e.shooter];
        const gz = attackGoalZ(s.team, st.period);
        const out = Math.abs(gz - s.pos.z);
        const gl = st.skaters[s.team === 0 ? 9 : 4];
        // ideal: goalie on the line puck->goal center; measure lateral error at its depth
        const gout = Math.abs(gz - gl.pos.z);
        const idealX = st.puck.pos.x * (gout / Math.max(0.3, out));
        const src =
          st.time - lastPassRecv < 0.05 ? 'one-timer' : st.time - lastPassRecv < 1.0 ? 'after-pass' : st.time - lastPickup < 0.8 ? `quick-${lastPickupKind}` : 'carry';
        pending = {
          dist: Math.hypot(s.pos.x, out),
          angle: (Math.atan2(Math.abs(s.pos.x), out) * 180) / Math.PI,
          power: e.power,
          goalieOff: gl.pos.x - idealX,
          goalieState: gl.state,
          src,
          outcome: '',
          team: s.team,
        };
        pendingT = st.time;
      } else if (e.type === 'goal') close('goal');
      else if (e.type === 'save') close(e.caught ? 'catch' : 'rebound');
      else if (e.type === 'post') close('post');
      else if (e.type === 'boards' || e.type === 'netHit') close('miss');
      else if (e.type === 'pickup' && pending) close('picked');
    }
    if (pending && st.time - pendingT > 3) close('timeout');
  }
}

const tab = (label: string, key: (s: ShotRec) => string) => {
  const m = new Map<string, { n: number; g: number }>();
  for (const s of shots) {
    const k = key(s);
    const e = m.get(k) ?? { n: 0, g: 0 };
    e.n++;
    if (s.outcome === 'goal') e.g++;
    m.set(k, e);
  }
  console.log(`-- ${label}`);
  for (const [k, e] of [...m.entries()].sort()) console.log(`   ${k.padEnd(14)} n=${String(e.n).padStart(4)} goal%=${((e.g / e.n) * 100).toFixed(0)}`);
};
console.log(`shots: ${shots.length} (${(shots.length / games).toFixed(1)}/game)  goals ${shots.filter((s) => s.outcome === 'goal').length}`);
tab('distance', (s) => (s.dist < 3 ? '0-3' : s.dist < 6 ? '3-6' : s.dist < 10 ? '6-10' : s.dist < 15 ? '10-15' : '15+'));
tab('source', (s) => s.src);
tab('power', (s) => (s.power < 0.2 ? '<0.2' : s.power < 0.5 ? '0.2-0.5' : s.power < 0.8 ? '0.5-0.8' : '0.8+'));
tab('goalie off-line', (s) => (Math.abs(s.goalieOff) < 0.25 ? '<0.25' : Math.abs(s.goalieOff) < 0.6 ? '0.25-0.6' : '0.6+'));
tab('goalie state', (s) => s.goalieState);
tab('angle', (s) => (s.angle < 20 ? '<20' : s.angle < 45 ? '20-45' : '45+'));
tab('team', (s) => String(s.team));
tab('outcome', (s) => s.outcome);
