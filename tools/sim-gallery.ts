// Shooting gallery: the human dog vs the away goalie (placeholder/AI goalie
// positioning + the sim's automatic saves), everyone else off the ice. Prints
// goal% by spot, charge and aim so shot balance can be eyeballed.
//   npx tsx tools/sim-gallery.ts [trials=60]

import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { touchPuck } from '../src/sim/puckops';
import { carryPoint } from '../src/sim/query';
import { mulberry32, setRandom } from '../src/sim/util';
import type { PadState } from '../src/types';

const trials = Number(process.argv[2] ?? 60);
setRandom(mulberry32(7));
const spots = [
  { name: 'slot 8m', x: 0, z: 18.5 },
  { name: 'slot 12m', x: 1, z: 14.5 },
  { name: 'angle 10m', x: 6, z: 19 },
  { name: 'point 20m', x: 4, z: 7 },
  { name: 'doorstep 4m', x: 1.5, z: 23 },
];
const styles: { name: string; hold: number; up: boolean; side: 0 | 1 | -1 }[] = [
  { name: 'tap', hold: 0, up: false, side: 0 },
  { name: 'half', hold: 0.45, up: false, side: 0 },
  { name: 'full', hold: 1.0, up: false, side: 0 },
  { name: 'full+up', hold: 1.0, up: true, side: 0 },
  { name: 'full+side', hold: 1.0, up: false, side: 1 },
];
console.log('goal% (saves%)   ' + styles.map((s) => s.name.padEnd(14)).join(''));
for (const sp of spots) {
  const row: string[] = [];
  for (const sty of styles) {
    let goals = 0;
    let saves = 0;
    for (let t = 0; t < trials; t++) {
      const st = createGame({ autoplay: false });
      st.phase = 'play';
      st.tick = 100;
      for (const s of st.skaters) if (s.id !== 0 && s.id !== 9) s.state = 'box';
      const dog = st.skaters[0];
      dog.pos = { x: sp.x, z: sp.z };
      dog.facing = Math.atan2(-sp.x, 26.5 - sp.z);
      st.puck.owner = 0;
      st.puck.pos = carryPoint(dog, 0);
      touchPuck(st, 0);
      // let the goalie square up first
      for (let i = 0; i < 40; i++) stepGame(st, emptyPad());
      const holdTicks = Math.round(sty.hold * 60);
      for (let i = 0; i < holdTicks + 80 && st.phase === 'play'; i++) {
        const pad: PadState = emptyPad();
        pad.up = sty.up;
        pad.right = sty.side === 1;
        if (i === 0) pad.shoot = { held: true, pressed: true, released: holdTicks === 0 };
        else if (i < holdTicks) pad.shoot = { held: true, pressed: false, released: false };
        else if (i === holdTicks && holdTicks > 0) pad.shoot = { held: false, pressed: false, released: true };
        stepGame(st, pad);
        if (st.events.some((e) => e.type === 'goal')) goals++;
        if (st.events.some((e) => e.type === 'save')) saves++;
        if (st.events.some((e) => e.type === 'save' || e.type === 'goal')) break;
      }
    }
    row.push(`${String(Math.round((goals / trials) * 100)).padStart(3)}% (${String(Math.round((saves / trials) * 100)).padStart(3)}%)  `);
  }
  console.log(sp.name.padEnd(17) + row.join(''));
}

// --- money plays: cross-crease one-timer and a deke across the crease
import { gs } from '../src/sim/util';
let otGoals = 0;
let dkGoals = 0;
for (let t = 0; t < trials; t++) {
  const st = createGame({ autoplay: false });
  st.phase = 'play';
  st.tick = 100;
  for (const s of st.skaters) if (s.id !== 0 && s.id !== 9) s.state = 'box';
  const dog = st.skaters[0];
  dog.pos = { x: 2.5, z: 21.5 };
  dog.facing = -Math.PI / 2;
  st.puck.owner = null;
  st.puck.pos = { x: -7, z: 19 };
  for (let i = 0; i < 40; i++) stepGame(st, emptyPad()); // goalie squares up to the puck on the far side
  touchPuck(st, 1);
  const dx = dog.pos.x - st.puck.pos.x;
  const dz = dog.pos.z - st.puck.pos.z;
  const dd = Math.hypot(dx, dz);
  st.puck.vel = { x: (dx / dd) * 17, z: (dz / dd) * 17 };
  gs(st).pass = { from: 1, to: 0, time: st.time };
  for (let i = 0; i < 90 && st.phase === 'play'; i++) {
    const pad = emptyPad();
    pad.shoot = { held: true, pressed: i === 0, released: false };
    stepGame(st, pad);
    if (st.events.some((e) => e.type === 'goal')) otGoals++;
    if (st.events.some((e) => e.type === 'save' || e.type === 'goal')) break;
  }
}
for (let t = 0; t < trials; t++) {
  const st = createGame({ autoplay: false });
  st.phase = 'play';
  st.tick = 100;
  for (const s of st.skaters) if (s.id !== 0 && s.id !== 9) s.state = 'box';
  const dog = st.skaters[0];
  dog.pos = { x: -4, z: 20 };
  dog.facing = 0;
  st.puck.owner = 0;
  st.puck.pos = carryPoint(dog, 0);
  touchPuck(st, 0);
  for (let i = 0; i < 30; i++) stepGame(st, emptyPad());
  // skate hard across the slot (screen-left = world +x in P1), then a quick release
  for (let i = 0; i < 120 && st.phase === 'play'; i++) {
    const pad = emptyPad();
    pad.left = true;
    pad.up = i < 20;
    if (i === 40) pad.shoot = { held: true, pressed: true, released: true };
    stepGame(st, pad);
    if (st.events.some((e) => e.type === 'goal')) dkGoals++;
    if (st.events.some((e) => e.type === 'save' || e.type === 'goal')) break;
  }
}
console.log(`cross-crease one-timer: ${Math.round((otGoals / trials) * 100)}%   deke + quick shot: ${Math.round((dkGoals / trials) * 100)}%`);
