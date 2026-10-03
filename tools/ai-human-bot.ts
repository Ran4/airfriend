// A scripted "human" that plays PAL through the gamepad ONLY (PadState: 8-way
// screen-relative directions + button presses with human-ish reaction times and
// sloppiness), against the real AI. It never touches the game state, it only
// reads it the way a player reads the screen (see tools/ai-bot-lib.ts).
//
//   npx tsx tools/ai-human-bot.ts [games=10] [seed=1] [skill=1]
//   EVENTS=1 ... also prints per-game event counts (pokes, steals, checks, barks...)
//
// skill: 0.6 = sloppy beginner, 1 = decent player, 1.3 = good player.
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, setRandom } from '../src/sim/util';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const games = Number(process.argv[2] ?? 10);
const seed = Number(process.argv[3] ?? 1);
const skill = Number(process.argv[4] ?? 1);
const verbose = process.env.VERBOSE === '1';
configureBot(seed, skill);

setRandom(mulberry32(seed));
let w = 0;
let l = 0;
let t = 0;
let gf = 0;
let ga = 0;
let sf = 0;
let sa = 0;
let palG = 0;
let pens = [0, 0];
const ev: Record<string, number> = {};
const bump = (k: string) => (ev[k] = (ev[k] ?? 0) + 1);
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: false });
  const b = newBot();
  let ticks = 0;
  while (st.phase !== 'gameOver' && ticks < 60 * 60 * 20) {
    stepGame(st, botPad(st, b));
    ticks++;
    for (const e of st.events) {
      if (e.type === 'penalty') pens[e.penalty.team]++;
      if (e.type === 'poke') bump(`poke ${st.skaters[e.skaterId].team ? 'away' : 'home'}${e.success ? ' ok' : ''}`);
      if (e.type === 'steal') bump(`steal by ${st.skaters[e.skaterId].team ? 'away' : 'home'}${e.fromId === 0 ? ' from PAL' : ''}`);
      if (e.type === 'check') bump(`check by ${st.skaters[e.hitter].team ? 'away' : 'home'}${e.victim === 0 ? ' on PAL' : ''}${e.knockedDown ? ' KD' : ''}`);
      if (e.type === 'fumble') bump(`fumble ${st.skaters[e.skaterId].team ? 'away' : 'home'}`);
      if (e.type === 'bark') bump('bark');
      if (e.type === 'shot') bump(`shot ${st.skaters[e.shooter].team ? 'away' : 'home'}${e.shooter === 0 ? ' PAL' : ''}`);
      if (e.type === 'pass') bump(`pass ${st.skaters[e.from].team ? 'away' : 'home'}`);
      if (e.type === 'passReceived') bump(`passReceived ${st.skaters[e.from].team ? 'away' : 'home'}`);
      if (e.type === 'save') bump(`save by ${e.goalie === 4 ? 'home' : 'away'} goalie${e.caught ? ' (catch)' : ''}`);
      if (e.type === 'pickup') bump(`pickup ${st.skaters[e.skaterId].team ? 'away' : 'home'}${e.skaterId === 0 ? ' PAL' : ''}`);
    }
  }
  const res = st.winner === 0 ? 'W' : st.winner === 1 ? 'L' : 'T';
  if (res === 'W') w++;
  else if (res === 'L') l++;
  else t++;
  gf += st.score[0];
  ga += st.score[1];
  sf += st.shots[0];
  sa += st.shots[1];
  palG += st.skaters[0].stats.goals;
  console.log(
    `game ${g + 1}: ${res} ${st.score[0]}-${st.score[1]} shots ${st.shots[0]}-${st.shots[1]} PAL ${st.skaters[0].stats.goals}G ${st.skaters[0].stats.assists}A ${st.skaters[0].stats.shots}S  hits ${st.hits.join('-')}  period ${st.period}`,
  );
  if (verbose) console.log('   ', JSON.stringify(st.skaters.map((s) => [s.name, s.stats.goals, s.stats.shots])));
}
const n = games;
if (process.env.EVENTS === '1') console.log(Object.entries(ev).sort().map(([k, v]) => `${k}: ${(v / n).toFixed(1)}`).join('\n'));
console.log(
  `HUMAN BOT (skill ${skill}): ${w}W ${l}L ${t}T  goals ${(gf / n).toFixed(2)}-${(ga / n).toFixed(2)}  shots ${(sf / n).toFixed(1)}-${(sa / n).toFixed(1)}  PAL goals/game ${(palG / n).toFixed(2)}  penalties home ${(pens[0] / n).toFixed(2)} away ${(pens[1] / n).toFixed(2)}`,
);
