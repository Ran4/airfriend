import { emptyPad } from '../src/core/input';
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, setRandom } from '../src/sim/util';
const B = (h: boolean, p: boolean) => ({ held: h, pressed: h && !p, released: !h && p });
let swats = 0, N = 100, recv = 0;
for (let k = 0; k < N; k++) {
setRandom(mulberry32(k + 1));
const st = createGame({ autoplay: false, ai: true });
st.phase = 'play'; st.tick = 100; st.referee.state = 'skate';
const freeze = () => { for (const s of st.skaters) if (s.kind !== 'goalie' && s.id !== 0 && s.id !== 1) { s.pos = { x: s.team ? 12 : -12, z: -20 + s.id }; s.vel = { x: 0, z: 0 }; } };
const d = st.skaters[0], j = st.skaters[1];
j.pos = { x: -7, z: 23 }; j.facing = Math.PI / 2; st.puck.owner = 1;
d.pos = { x: 1.5, z: 19.5 }; d.facing = 0;
let prevS = false, prevP = false, passed = false, log = '';
for (let i = 0; i < 100; i++) {
  freeze();
  const p = emptyPad();
  p.pass = B(i === 0, prevP); prevP = i === 0;
  const near = Math.hypot(st.puck.pos.x - d.pos.x, st.puck.pos.z - d.pos.z);
  const h = passed && (near < 2.5 || prevS);
  p.shoot = B(h, prevS); prevS = h;
  stepGame(st, p);
  for (const e of st.events) { if (e.type === 'pass' && e.from === 1) passed = true; if (e.type === 'poke' && e.skaterId === 0) { log += `poke success=${e.success} `; if (e.success) swats++; } if (e.type === 'pickup' && e.skaterId === 0) recv++; }
}
if (k < 3) console.log(log);
}
console.log(`PAL poke-swatted the incoming pass in ${swats}/${N}; received ${recv}`);
