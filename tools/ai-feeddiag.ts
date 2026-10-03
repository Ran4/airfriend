// Diagnostics for home AI -> PAL feeds (bot games): outcome by passRisk at the moment of
// the pass, where along the lane interceptions happen, and how far the interceptor stood
// from PAL when the pass left.
//   npx tsx tools/ai-feeddiag.ts [games=20] [seed=55]
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, segDist, setRandom } from '../src/sim/util';
import { passRisk } from '../src/ai/util';
import type { Vec2 } from '../src/types';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const games = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 55);
setRandom(mulberry32(seed));
configureBot(seed, 1);
const C: Record<string, number> = {};
const add = (k: string, n = 1) => (C[k] = (C[k] ?? 0) + n);
const bucket = (r: number) => (r < 0.1 ? '<0.10' : r < 0.25 ? '<0.25' : r < 0.5 ? '<0.50' : r < 0.8 ? '<0.80' : r < 1.2 ? '<1.20' : '>1.2');
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: false });
  const bot = newBot();
  let pend: { t: number; b: string; L: string; from: Vec2; to: Vec2; opp: Vec2[]; vy: number } | null = null;
  while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 25) {
    stepGame(st, botPad(st, bot));
    for (const e of st.events) {
      if (e.type === 'pass') {
        const s = st.skaters[e.from];
        pend = null;
        if (s.team === 0 && s.id !== 0 && s.kind !== 'goalie' && e.to === 0) {
          const r = passRisk(st, st.puck.pos, st.skaters[0], 0);
          const L = Math.hypot(st.skaters[0].pos.x - st.puck.pos.x, st.skaters[0].pos.z - st.puck.pos.z);
          pend = {
            t: st.time,
            b: bucket(r),
            L: L < 6 ? '<6m' : L < 10 ? '6-10m' : L < 15 ? '10-15m' : '>15m',
            from: { ...st.puck.pos },
            to: { ...st.skaters[0].pos },
            opp: st.skaters.map((o) => ({ ...o.pos })),
            vy: st.puck.vy,
          };
          add(`n_${pend.b}`);
          add(`len_${pend.L}_n`);
          add(pend.vy > 0 ? 'saucer' : 'flat');
        }
      } else if (pend && e.type === 'pickup') {
        const who = st.skaters[e.skaterId];
        add(`len_${pend.L}_${who.team === 0 ? 'ok' : 'int'}`);
        if (who.team === 0) add(`ok_${pend.b}`);
        else {
          add(`int_${pend.b}`);
          const o0 = pend.opp[who.id];
          const { d, t } = segDist(o0, pend.from, pend.to);
          const dPal = Math.hypot(o0.x - pend.to.x, o0.z - pend.to.z);
          add(`intF_${t < 0.33 ? 'near passer' : t < 0.67 ? 'mid' : t < 1 ? 'near PAL' : 'beyond PAL'}`);
          add(`intD_${dPal < 2 ? '<2m from PAL' : dPal < 4 ? '2-4m' : '>4m'}`);
          add(`intLat_${d < 1 ? '<1m off lane' : d < 2.5 ? '1-2.5m' : '>2.5m'}`);
          add(`intVy_${pend.vy > 0 ? 'saucer' : 'flat'}`);
          const dt = st.time - pend.t;
          add(`intT_${['<0.10', '<0.25', '<0.50'].includes(pend.b) ? 'lo' : 'hi'}_${dt < 0.05 ? '<0.05s' : dt < 0.15 ? '<0.15s' : dt < 0.4 ? '<0.4s' : '>0.4s'}`);
        }
        pend = null;
      } else if (pend && (e.type === 'whistle' || e.type === 'shot')) pend = null;
    }
    if (pend && st.time - pend.t > 2.5) {
      add(`len_${pend.L}_died`);
      pend = null;
    }
  }
}
for (const b of ['<0.10', '<0.25', '<0.50', '<0.80', '<1.20', '>1.2']) {
  const n = C[`n_${b}`] ?? 0;
  console.log(`risk ${b}: n/g=${(n / games).toFixed(1)} ok ${(((C[`ok_${b}`] ?? 0) / Math.max(1, n)) * 100).toFixed(0)}% int ${(((C[`int_${b}`] ?? 0) / Math.max(1, n)) * 100).toFixed(0)}%`);
}
for (const pre of ['intT_', 'intF_', 'intD_', 'intLat_', 'intVy_']) {
  console.log(pre, Object.entries(C).filter(([k]) => k.startsWith(pre)).map(([k, v]) => `${k.slice(pre.length)}=${v}`).join('  '));
}
for (const L of ['<6m', '6-10m', '10-15m', '>15m']) {
  const n = C[`len_${L}_n`] ?? 0;
  console.log(`len ${L}: n/g=${(n / games).toFixed(1)} ok ${(((C[`len_${L}_ok`] ?? 0) / Math.max(1, n)) * 100).toFixed(0)}% int ${(((C[`len_${L}_int`] ?? 0) / Math.max(1, n)) * 100).toFixed(0)}% died ${(((C[`len_${L}_died`] ?? 0) / Math.max(1, n)) * 100).toFixed(0)}%`);
}
console.log(`saucer ${C.saucer ?? 0} flat ${C.flat ?? 0}`);
