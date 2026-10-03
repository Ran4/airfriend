// Text trace of offensive-zone possessions (ai/ozone.ts): every 0.25 s the carrier and
// everybody's spot in the attacking team's frame (x, along; the goal line is at 26.5),
// plus the events, until the possession ends.
//   npx tsx tools/ai-cycletrace.ts [team=1] [possessions=8] [seed=3] [mode=bot|ai]
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';
import { isGoalie, onIce } from '../src/sim/query';
import { attackDir } from '../src/sim/rink';
import { RINK } from '../src/config';
import { aiMem } from '../src/ai/memory';
import { botPad, configureBot, newBot } from './ai-bot-lib';
import type { GameState } from '../src/types';

const team = Number(process.argv[2] ?? 1) as 0 | 1;
const want = Number(process.argv[3] ?? 8);
const seed = Number(process.argv[4] ?? 3);
const mode = process.argv[5] ?? 'bot';
setRandom(mulberry32(seed));
configureBot(seed, 1);
const st = createGame({ autoplay: mode === 'ai' });
const bot = newBot();
const fr = (s: GameState, x: number, z: number) => `(${x.toFixed(1)},${(z * attackDir(team, s.period)).toFixed(1)})`;
let on = false;
let t0 = 0;
let got = 0;
let nextPrint = 0;
while (st.phase !== 'gameOver' && got < want) {
  stepGame(st, mode === 'ai' ? emptyPad() : botPad(st, bot));
  const along = st.puck.pos.z * attackDir(team, st.period);
  const ow = st.puck.owner;
  if (!on && st.phase === 'play' && ow !== null && st.skaters[ow].team === team && !isGoalie(st.skaters[ow]) && along > RINK.blueLineZ) {
    on = true;
    t0 = st.time;
    nextPrint = st.time;
    console.log(`\n=== possession ${got + 1} at ${st.time.toFixed(1)} s`);
  }
  if (!on) continue;
  for (const e of st.events) {
    if (['pass', 'shot', 'steal', 'pickup', 'check', 'fumble', 'whistle', 'goal', 'save', 'bark', 'poke'].includes(e.type)) {
      const who = (id: number) => `${st.skaters[id].name}`;
      const ee = e as unknown as Record<string, number>;
      const ids = ['skaterId', 'from', 'to', 'shooter', 'hitter', 'victim', 'fromId'].filter((k) => ee[k] !== undefined).map((k) => `${k}=${who(ee[k])}`);
      console.log(`  ${(st.time - t0).toFixed(2)} ${e.type} ${ids.join(' ')}${ee.success !== undefined ? ` ok=${ee.success}` : ''}`);
    }
  }
  const lost = (ow !== null && st.skaters[ow].team !== team) || st.phase !== 'play' || along < RINK.blueLineZ - 0.2;
  if (st.time >= nextPrint || lost) {
    nextPrint = st.time + 0.25;
    const mem = aiMem(st);
    const parts = st.skaters
      .filter((s) => onIce(s) && !isGoalie(s))
      .map((s) => {
        const a = mem.teams[s.team].assign.get(s.id);
        const b = mem.brains[s.id];
        const tag = st.puck.owner === s.id ? '*' : '';
        const extra = st.puck.owner === s.id && st.time < b.protectUntil ? '[P]' : '';
        return `${tag}${s.name.slice(0, 4)}${extra}${fr(st, s.pos.x, s.pos.z)}${s.team === team ? ':' + (a?.key ?? '-') : ''}`;
      });
    console.log(`  ${(st.time - t0).toFixed(2)} puck${fr(st, st.puck.pos.x, st.puck.pos.z)} ${parts.join(' ')}`);
  }
  if (lost) {
    on = false;
    got++;
  }
}
