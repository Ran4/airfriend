// Pickup rhythm in real AI games: how often the stick-handling sound fires
// and how close together pickups come (what the 'pickup' rate limit in
// src/audio/sfx.ts has to tame), plus delayed-penalty cues per game.
//
//   ./node_modules/.bin/tsx tools/audio-pickuprate.ts [games=3] [seed=7]

import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';

const games = Number(process.argv[2] ?? 3);
setRandom(mulberry32(Number(process.argv[3] ?? 7)));
const gaps: number[] = [];
let pickups = 0;
let delayed = 0;
let live = 0;
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: true });
  let last = -1;
  for (let n = 0; st.phase !== 'gameOver' && n < 30 * 60 * 60; n++) {
    stepGame(st, emptyPad());
    if (st.phase === 'play') live += 1 / 60;
    for (const e of st.events) {
      if (e.type === 'delayedPenalty') delayed++;
      if (e.type !== 'pickup') continue;
      pickups++;
      if (last >= 0) gaps.push(st.time - last);
      last = st.time;
    }
  }
}
gaps.sort((a, b) => a - b);
const under = (s: number) => ((100 * gaps.filter((x) => x < s).length) / Math.max(1, gaps.length)).toFixed(1);
console.log(`${games} games: ${(pickups / games).toFixed(0)} pickups/game, ${(pickups / live).toFixed(2)}/s of live play, ${(delayed / games).toFixed(1)} delayed-penalty cues/game`);
console.log(`gap to the previous pickup: median ${gaps[gaps.length >> 1]?.toFixed(2)} s; < 0.07 s ${under(0.07)}%, < 0.12 s ${under(0.12)}%, < 0.25 s ${under(0.25)}%, < 0.5 s ${under(0.5)}%`);
