// Sprite-facing flicker, measured with the renderer's own sector logic
// (src/render/sector.ts) on AI-vs-AI games in node. Counts sector changes and
// A-B-A flickers (back to the old sector within 0.4 s) per skater-minute of play.
//   ./node_modules/.bin/tsx tools/render-flicker.ts [games] [seed]
import { emptyPad } from '../src/core/input';
import { stepSector, type SectorMemory } from '../src/render/sector';
import { createGame, stepGame } from '../src/sim/game';
import { isGoalie, onIce } from '../src/sim/query';
import { cameraHeading } from '../src/sim/rink';
import { mulberry32, setRandom } from '../src/sim/util';

const games = Number(process.argv[2] ?? 4);
const seed = Number(process.argv[3] ?? 5);
setRandom(mulberry32(seed));

let changes = 0;
let flickers = 0;
let skSec = 0;
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: true });
  const mem: SectorMemory[] = st.skaters.map(() => ({ sector: -1, since: 0 }));
  const hist: { s: number; t: number }[][] = st.skaters.map(() => []);
  let last = st.time;
  while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 25) {
    stepGame(st, emptyPad());
    const dt = st.time - last;
    last = st.time;
    const h = cameraHeading(st.period);
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    for (const s of st.skaters) {
      // the renderer animates every skater every frame; count only live play
      const dx = Math.sin(s.facing);
      const dz = Math.cos(s.facing);
      const xs = dx * -fz + dz * fx; // camera right = (-cos h, sin h)
      const ys = dx * fx + dz * fz;
      const m = mem[s.id];
      const before = m.sector;
      const sec = stepSector(m, Math.atan2(xs, ys), dt);
      const counted = st.phase === 'play' && onIce(s) && !isGoalie(s);
      if (counted) skSec += dt;
      if (before < 0 || sec === before) continue;
      const hs = hist[s.id];
      hs.push({ s: sec, t: st.time });
      if (hs.length > 3) hs.shift();
      if (!counted) continue;
      changes++;
      if (hs.length === 3 && st.time - hs[1].t < 0.4 && sec === hs[0].s) flickers++;
    }
  }
}
const perMin = (n: number) => ((n / skSec) * 60).toFixed(2);
console.log(`games ${games} seed ${seed}: ${(skSec / 60).toFixed(0)} skater-min of play`);
console.log(`sector changes per skater-min: ${perMin(changes)}; A-B-A flickers (<0.4 s) per skater-min: ${perMin(flickers)}`);
