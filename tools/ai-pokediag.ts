// PAL's pokes on Blizzard carriers (bot games): success by where PAL stands relative to
// the carrier's facing (front / side / behind) and by distance to the puck.
//   npx tsx tools/ai-pokediag.ts [games=20] [seed=5]
import { createGame, stepGame } from '../src/sim/game';
import { angleDiff, headingOf, mulberry32, setRandom } from '../src/sim/util';
import { botPad, configureBot, newBot } from './ai-bot-lib';
const games = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 5);
setRandom(mulberry32(seed));
configureBot(seed, 1);
const C: Record<string, number> = {};
const add = (k: string) => (C[k] = (C[k] ?? 0) + 1);
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: false });
  const bot = newBot();
  let snap: { rel: string; dist: string; carrier: number } | null = null;
  while (st.phase !== 'gameOver') {
    // snapshot the geometry when PAL starts a poke on a Blizzard carrier
    const pal = st.skaters[0];
    const o = st.puck.owner;
    stepGame(st, botPad(st, bot));
    if (pal.state === 'poke' && pal.stateTime < 0.02 && o !== null && st.skaters[o].team === 1) {
      const c = st.skaters[o];
      const a = Math.abs(angleDiff(headingOf(pal.pos.x - c.pos.x, pal.pos.z - c.pos.z), c.facing));
      const dp = Math.hypot(st.puck.pos.x - pal.pos.x, st.puck.pos.z - pal.pos.z);
      snap = { rel: a < 0.8 ? 'front' : a < 2.2 ? 'side' : 'behind', dist: dp < 1.0 ? '<1.0' : dp < 1.5 ? '<1.5' : '>1.5', carrier: o };
    }
    for (const e of st.events) {
      if (e.type === 'poke' && e.skaterId === 0 && snap) {
        const ok = st.events.some((x) => x.type === 'steal' && x.skaterId === 0);
        add(`${snap.rel}_n`);
        if (ok) add(`${snap.rel}_ok`);
        add(`d${snap.dist}_n`);
        if (ok) add(`d${snap.dist}_ok`);
        snap = null;
      }
    }
  }
}
for (const k of ['front', 'side', 'behind', 'd<1.0', 'd<1.5', 'd>1.5']) {
  const n = C[`${k}_n`] ?? 0;
  console.log(`${k.padEnd(7)} pokes/g ${(n / games).toFixed(1)} success ${(((C[`${k}_ok`] ?? 0) / Math.max(1, n)) * 100).toFixed(0)}%`);
}
