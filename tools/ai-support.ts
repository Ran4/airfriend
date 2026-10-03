// Home-team support metrics against the scripted pad-only human (tools/ai-bot-lib.ts):
//  - home AI -> PAL pass completion (all, and called-for: a "HEY!" from PAL within 1.3 s)
//  - away offensive-zone possessions: how long they last and how they end
//  - PAL's pokes and barks on Blizzard carriers
//
//   npx tsx tools/ai-support.ts [games=20] [seed=55] [skill=1]
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, setRandom } from '../src/sim/util';
import { isGoalie } from '../src/sim/query';
import { attackGoalZ } from '../src/sim/rink';
import { RINK } from '../src/config';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const games = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 55);
const skill = Number(process.argv[4] ?? 1);
setRandom(mulberry32(seed));
configureBot(seed, skill);
const C: Record<string, number> = {};
const add = (k: string, n = 1) => (C[k] = (C[k] ?? 0) + n);
let w = 0;
let gf = 0;
let ga = 0;
let sf = 0;
let sa = 0;

for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: false });
  const bot = newBot();
  let pend: { from: number; t: number; key: string } | null = null;
  let lastCall = -10;
  let awayOZ: { t: number } | null = null;
  while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 25) {
    stepGame(st, botPad(st, bot));
    for (const e of st.events) {
      if (e.type === 'callFor' && e.skaterId === 0) lastCall = st.time;
      if (e.type === 'pass') {
        const s = st.skaters[e.from];
        if (s.kind === 'goalie' || s.team !== 0 || s.id === 0 || e.to !== 0) {
          pend = null;
        } else {
          pend = { from: e.from, t: st.time, key: st.time - lastCall < 1.3 ? 'called' : 'uncalled' };
          add(`n_${pend.key}`);
        }
      } else if (pend && e.type === 'pickup') {
        const ok = st.skaters[e.skaterId].team === 0;
        add(`${ok ? 'ok' : 'int'}_${pend.key}`);
        pend = null;
      } else if (pend && (e.type === 'whistle' || e.type === 'shot')) pend = null;
      // PAL vs Blizzard carriers
      if (e.type === 'poke' && e.skaterId === 0) add(e.success ? 'palPokeOk' : 'palPokeMiss');
      if (e.type === 'steal' && e.skaterId === 0) add('palSteal');
      if (e.type === 'fumble' && st.skaters[e.skaterId].team === 1) add('awayFumble');
      if (e.type === 'bark' && e.skaterId === 0) add('palBark');
      if (awayOZ) {
        const end =
          e.type === 'shot' && st.skaters[e.shooter].team === 1
            ? 'shot'
            : e.type === 'steal'
              ? 'steal'
              : e.type === 'fumble'
                ? 'barkFumble'
                : e.type === 'check' && st.skaters[e.hitter].team === 0
                  ? 'checked'
                  : e.type === 'pickup' && st.skaters[e.skaterId].team === 0
                    ? 'homePickup'
                    : e.type === 'whistle'
                      ? 'whistle'
                      : null;
        if (end) {
          const dur = st.time - awayOZ.t;
          add(`oz_${end}`);
          add(`ozdur_${end}`, dur);
          add('oz_total');
          add('oz_dur', dur);
          awayOZ = null;
        }
      }
    }
    if (pend && st.time - pend.t > 2.5) {
      add(`lost_${pend.key}`);
      pend = null;
    }
    const o = st.puck.owner;
    if (st.phase === 'play' && o !== null && st.skaters[o].team === 1 && !isGoalie(st.skaters[o]) && !awayOZ) {
      const along = st.puck.pos.z * Math.sign(attackGoalZ(1, st.period));
      if (along > RINK.blueLineZ) awayOZ = { t: st.time };
    }
  }
  if (st.winner === 0) w++;
  gf += st.score[0];
  ga += st.score[1];
  sf += st.shots[0];
  sa += st.shots[1];
}
if (process.env.JSON === '1') {
  console.log(JSON.stringify({ ...C, games, w, gf, ga, sf, sa }));
  process.exit(0);
}
const pct = (a: number, b: number) => `${((a / Math.max(1, b)) * 100).toFixed(0)}%`;
for (const k of ['called', 'uncalled']) {
  const n = C[`n_${k}`] ?? 0;
  console.log(`AI->PAL ${k.padEnd(8)} n/g=${(n / games).toFixed(1)} completed ${pct(C[`ok_${k}`] ?? 0, n)} intercepted ${pct(C[`int_${k}`] ?? 0, n)} died ${pct(C[`lost_${k}`] ?? 0, n)}`);
}
const nAll = (C.n_called ?? 0) + (C.n_uncalled ?? 0);
console.log(`AI->PAL overall n/g=${(nAll / games).toFixed(1)} completed ${pct((C.ok_called ?? 0) + (C.ok_uncalled ?? 0), nAll)}`);
const T = C.oz_total ?? 1;
console.log(
  `away OZ possessions n/g=${(T / games).toFixed(1)} mean ${((C.oz_dur ?? 0) / T).toFixed(2)} s: ` +
    ['shot', 'steal', 'barkFumble', 'checked', 'homePickup', 'whistle']
      .map((k) => `${k}=${pct(C[`oz_${k}`] ?? 0, T)}(${((C[`ozdur_${k}`] ?? 0) / Math.max(1, C[`oz_${k}`] ?? 0)).toFixed(1)}s)`)
      .join(' '),
);
const pk = (C.palPokeOk ?? 0) + (C.palPokeMiss ?? 0);
console.log(
  `PAL per game: pokes ${(pk / games).toFixed(1)} (steals ${((C.palSteal ?? 0) / games).toFixed(1)}, ${pct(C.palSteal ?? 0, pk)}), barks ${((C.palBark ?? 0) / games).toFixed(1)}, Blizzard fumbles ${((C.awayFumble ?? 0) / games).toFixed(1)}`,
);
console.log(`human bot skill ${skill}: won ${w}/${games} (${pct(w, games)}) goals ${(gf / games).toFixed(2)}-${(ga / games).toFixed(2)} shots ${(sf / games).toFixed(1)}-${(sa / games).toFixed(1)}`);
