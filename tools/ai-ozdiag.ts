// Away offensive-zone possessions (bot games): duration histogram by ending, and for the
// ones ending in a shot, where it came from (distance to net, nearest checker).
//   npx tsx tools/ai-ozdiag.ts [games=20] [seed=55]
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, setRandom } from '../src/sim/util';
import { isGoalie, onIce } from '../src/sim/query';
import { attackGoalZ } from '../src/sim/rink';
import { RINK } from '../src/config';
import { botPad, configureBot, newBot } from './ai-bot-lib';
const games = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 55);
setRandom(mulberry32(seed));
configureBot(seed, 1);
const C: Record<string, number> = {};
const add = (k: string, n = 1) => (C[k] = (C[k] ?? 0) + n);
const db = (t: number) => (t < 0.5 ? 'a<0.5' : t < 1 ? 'b<1' : t < 2 ? 'c<2' : t < 4 ? 'd<4' : 'e>4');
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: false });
  const bot = newBot();
  let oz: { t: number; passes: number } | null = null;
  while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 25) {
    stepGame(st, botPad(st, bot));
    for (const e of st.events) {
      if (!oz) continue;
      if (e.type === 'pass' && st.skaters[e.from].team === 1) oz.passes++;
      let end: string | null = null;
      if (e.type === 'shot' && st.skaters[e.shooter].team === 1) {
        end = 'shot';
        const s = st.skaters[e.shooter];
        const gz = attackGoalZ(1, st.period);
        const d = Math.hypot(s.pos.x, gz - s.pos.z);
        let near = 99;
        for (const o of st.skaters) if (o.team === 0 && onIce(o) && !isGoalie(o)) near = Math.min(near, Math.hypot(o.pos.x - s.pos.x, o.pos.z - s.pos.z));
        add(`shotD_${d < 7 ? 'a<7' : d < 11 ? 'b7-11' : d < 15 ? 'c11-15' : 'd>15'}`);
        add(`shotNear_${near < 1.9 ? 'a<1.9' : near < 3.5 ? 'b<3.5' : 'c>3.5'}`);
      } else if (e.type === 'steal') end = 'steal';
      else if (e.type === 'fumble') end = 'fumble';
      else if (e.type === 'check' && st.skaters[e.hitter].team === 0) end = 'checked';
      else if (e.type === 'pickup' && st.skaters[e.skaterId].team === 0) end = 'homePickup';
      else if (e.type === 'whistle') end = 'whistle';
      if (end) {
        add(`dur_${end}_${db(st.time - oz.t)}`);
        add(`passes_${end}`, oz.passes);
        add(`n_${end}`);
        oz = null;
      }
    }
    const o = st.puck.owner;
    if (st.phase === 'play' && o !== null && st.skaters[o].team === 1 && !isGoalie(st.skaters[o]) && !oz) {
      if (st.puck.pos.z * Math.sign(attackGoalZ(1, st.period)) > RINK.blueLineZ) oz = { t: st.time, passes: 0 };
    }
  }
}
for (const end of ['shot', 'steal', 'fumble', 'checked', 'homePickup']) {
  const n = C[`n_${end}`] ?? 0;
  const ks = Object.keys(C).filter((k) => k.startsWith(`dur_${end}_`)).sort();
  console.log(`${end.padEnd(10)} n/g=${(n / games).toFixed(1)} passes/poss ${((C[`passes_${end}`] ?? 0) / Math.max(1, n)).toFixed(2)}  ${ks.map((k) => `${k.slice(5 + end.length)}=${C[k]}`).join(' ')}`);
}
for (const pre of ['shotD_', 'shotNear_']) console.log(pre, Object.keys(C).filter((k) => k.startsWith(pre)).sort().map((k) => `${k.slice(pre.length)}=${C[k]}`).join('  '));
