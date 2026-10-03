// Faceoff: a rhythm presser (counts from the lineup, never watches the puck) vs a reaction presser.
import { emptyPad } from '../src/core/input';
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, setRandom } from '../src/sim/util';
const r = mulberry32(5);
function gaussish() { return (r() + r() + r() - 1.5) * 2; }
for (const [label, mode, mu, sd] of [['rhythm press at lineup+1.18s (sd 40ms)', 'rhythm', 1.18, 0.04], ['rhythm press at lineup+1.15s (sd 60ms)', 'rhythm', 1.15, 0.06], ['reaction: drop+0.25s (sd 50ms)', 'react', 0.25, 0.05], ['reaction: drop+0.32s (sd 60ms)', 'react', 0.32, 0.06]] as [string, string, number, number][]) {
  let win = 0, fs = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    setRandom(mulberry32(i + 1));
    const st = createGame({ autoplay: false });
    while (st.phase !== 'faceoff') stepGame(st, emptyPad());
    const pressAt = (mode === 'rhythm' ? mu : 1.1 + mu) + gaussish() * sd;
    let pressed = false, done = false;
    for (let k = 0; k < 200 && !done; k++) {
      const p = emptyPad();
      const now = st.phaseTime + 1 / 60;
      const press = !pressed && now >= pressAt;
      if (press) pressed = true;
      p.shoot = { held: press, pressed: press, released: false };
      stepGame(st, p);
      for (const e of st.events) {
        if (e.type === 'falseStart' && e.team === 0) fs++;
        if (e.type === 'faceoffWin') { if (e.team === 0) win++; done = true; }
      }
    }
  }
  console.log(`${label.padEnd(42)} win ${(100 * win / N).toFixed(0)}%  false starts ${(100 * fs / N).toFixed(0)}%`);
}
