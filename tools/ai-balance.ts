// One-shot balance report: AI-vs-AI games plus the scripted human bot at three
// skill levels.
//   npx tsx tools/ai-balance.ts [aiGames=30] [botGames=12] [seed=1]
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';
import type { GameState, PadState } from '../src/types';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const aiGames = Number(process.argv[2] ?? 30);
const botGames = Number(process.argv[3] ?? 12);
const seed = Number(process.argv[4] ?? 1);

interface Agg {
  n: number;
  w: number;
  l: number;
  t: number;
  g: [number, number];
  s: [number, number];
  pen: [number, number];
  pim: [number, number];
  pal: number;
  hits: number;
}

function play(autoplay: boolean, pad: (st: GameState) => PadState, agg: Agg): void {
  const st = createGame({ autoplay });
  let ticks = 0;
  while (st.phase !== 'gameOver' && ticks < 60 * 60 * 25) {
    stepGame(st, pad(st));
    ticks++;
    for (const e of st.events) {
      if (e.type === 'penalty') {
        agg.pen[e.penalty.team]++;
        agg.pim[e.penalty.team] += e.penalty.duration;
      }
    }
  }
  agg.n++;
  if (st.winner === 0) agg.w++;
  else if (st.winner === 1) agg.l++;
  else agg.t++;
  agg.g[0] += st.score[0];
  agg.g[1] += st.score[1];
  agg.s[0] += st.shots[0];
  agg.s[1] += st.shots[1];
  agg.pal += st.skaters[0].stats.goals;
  agg.hits += st.hits[0] + st.hits[1];
}

const blank = (): Agg => ({ n: 0, w: 0, l: 0, t: 0, g: [0, 0], s: [0, 0], pen: [0, 0], pim: [0, 0], pal: 0, hits: 0 });
const f = (v: number, n: number) => (v / n).toFixed(2);
function report(label: string, a: Agg): void {
  console.log(
    `${label.padEnd(14)} W-L-T ${a.w}-${a.l}-${a.t} (${((a.w / a.n) * 100).toFixed(0)}%)  goals ${f(a.g[0], a.n)}-${f(a.g[1], a.n)} (tot ${f(a.g[0] + a.g[1], a.n)})  ` +
      `shots ${f(a.s[0], a.n)}-${f(a.s[1], a.n)} (tot ${f(a.s[0] + a.s[1], a.n)})  pens ${f(a.pen[0], a.n)}-${f(a.pen[1], a.n)} (tot ${f(a.pen[0] + a.pen[1], a.n)}) ` +
      `pim ${f(a.pim[0], a.n)}-${f(a.pim[1], a.n)}  PAL ${f(a.pal, a.n)}  hits ${f(a.hits, a.n)}`,
  );
}

setRandom(mulberry32(seed));
const ai = blank();
for (let i = 0; i < aiGames; i++) play(true, () => emptyPad(), ai);
if (aiGames) report('AI vs AI', ai);
for (const skill of (process.env.SKILLS ?? '0.6,1,1.3').split(',').map(Number)) {
  setRandom(mulberry32(seed + 100));
  configureBot(seed, skill);
  const a = blank();
  if (!botGames) break;
  for (let i = 0; i < botGames; i++) {
    const b = newBot();
    play(false, (st) => botPad(st, b), a);
  }
  report(`bot ${skill}`, a);
}
