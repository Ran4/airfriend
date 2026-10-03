// Crowding metrics: how often players swarm the puck or bunch up with teammates.
//   npx tsx tools/ai-crowd.ts [games=10] [seed=1]
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';
import { aiMem } from '../src/ai/memory';

const games = Number(process.argv[2] ?? 10);
setRandom(mulberry32(Number(process.argv[3] ?? 1)));
let ticks = 0;
let nearSum = 0;
let crowd4 = 0;
let mateClose = 0;
let mateSamples = 0;
const roleNear: Record<string, number> = {};
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: true });
  while (st.phase !== 'gameOver') {
    stepGame(st, emptyPad());
    if (st.phase !== 'play') continue;
    ticks++;
    const p = st.puck.pos;
    const sk = st.skaters.filter((s) => s.kind !== 'goalie' && s.state !== 'box');
    const near = sk.filter((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < 2.5);
    nearSum += near.length;
    if (near.length >= 4) {
      crowd4++;
      const mem = aiMem(st);
      for (const s of near) {
        const r = st.puck.owner === s.id ? 'carrier' : mem.teams[s.team].assign.get(s.id)?.key ?? '?';
        const k = `${s.team === (st.puck.owner !== null ? st.skaters[st.puck.owner].team : -1) ? 'own' : 'opp'}:${r.replace(/:\d+/, '')}`;
        roleNear[k] = (roleNear[k] ?? 0) + 1;
      }
    }
    for (let i = 0; i < sk.length; i++)
      for (let j = i + 1; j < sk.length; j++) {
        if (sk[i].team !== sk[j].team) continue;
        mateSamples++;
        if (Math.hypot(sk[i].pos.x - sk[j].pos.x, sk[i].pos.z - sk[j].pos.z) < 2.5) mateClose++;
      }
  }
}
console.log(`avg skaters within 2.5 m of puck: ${(nearSum / ticks).toFixed(2)}   >=4 near: ${((crowd4 / ticks) * 100).toFixed(1)}% of play   teammate pairs < 2.5 m: ${((mateClose / mateSamples) * 100).toFixed(1)}%`);
console.log('who is in the crowds:', Object.entries(roleNear).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
