// RINK: camera framing check through the real CameraRig in node (autoplay games).
//   ./node_modules/.bin/tsx tools/rink-frame.ts [games=3] [seed=7]
//   BOT=1 ...   PAL is played by the scripted pad-only human (tools/ai-bot-lib.ts)
// Live play only. Reports: puck off-screen share + longest streak, puck / PAL
// behind the HUD, PAL off-screen (with why), and, with the puck past ZMIN (15)
// in HOME's attacking zone, where the far crossbar and the AWAY goalie's head land.
// Acceptance (camera task): puck off < 0.5%, streak <= 0.3 s; crossbar above
// screen < 5%, goalie head under the score bug < 5%.
import * as THREE from 'three';
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { CameraRig } from '../src/render/camera';
import { attackDir } from '../src/sim/rink';
import { RINK } from '../src/config';
import { mulberry32, setRandom } from '../src/sim/util';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const games = Number(process.argv[2] ?? 3);
const seed = Number(process.argv[3] ?? 7);
setRandom(mulberry32(seed));
const BOT = process.env.BOT === '1';
if (BOT) configureBot(seed, 1);
const ZMIN = Number(process.env.ZMIN ?? 15);
const v = new THREE.Vector3();
const proj = (cam: THREE.Camera, x: number, y: number, z: number) => {
  v.set(x, y, z).project(cam);
  return { x: (v.x * 0.5 + 0.5) * 256, y: (-v.y * 0.5 + 0.5) * 224, z: v.z };
};
const inBug = (p: { x: number; y: number }) => p.y < 27 && p.x > 38 && p.x < 218;
const inPalBox = (p: { x: number; y: number }) => p.y > 194 && p.y < 216 && p.x > 8 && p.x < 106; // hud.ts TURBO window (98x22 at 8,194)
const off = (p: { x: number; y: number; z: number }) => p.z > 1 || p.x < 0 || p.x > 256 || p.y < 0 || p.y > 224;
const side = (p: { x: number; y: number; z: number }) => (p.z > 1 ? 'behind' : p.y > 224 ? 'bottom' : p.y < 0 ? 'top' : 'side');

let n = 0, nz = 0;
const c = { puckOff: 0, puckBug: 0, puckBox: 0, palOff: 0, palOffCtl: 0, palBug: 0, ctrlOff: 0, ctrlHeadBug: 0, maxStreak: 0, barOff: 0, barBug: 0, gkHead: 0 };
const palSides: Record<string, number> = {};
const yHist = new Array(8).fill(0);
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: !BOT });
  const bot = newBot();
  const rig = new CameraRig();
  let streak = 0, ticks = 0;
  while (st.phase !== 'gameOver' && ticks < 60 * 60 * 12) {
    stepGame(st, BOT ? botPad(st, bot) : emptyPad());
    rig.update(st, 1 / 60);
    ticks++;
    if (st.phase !== 'play') continue;
    n++;
    const cam = rig.camera;
    const pk = proj(cam, st.puck.pos.x, st.puck.y, st.puck.pos.z);
    yHist[Math.min(7, Math.max(0, Math.floor(pk.y / 28)))]++;
    if (off(pk)) {
      c.puckOff++;
      c.maxStreak = Math.max(c.maxStreak, ++streak);
    } else {
      streak = 0;
      if (inBug(pk)) c.puckBug++;
      if (inPalBox(pk)) c.puckBox++;
    }
    const dog = st.skaters[0];
    if (dog.state !== 'box') {
      const dp = proj(cam, dog.pos.x, 0.9, dog.pos.z);
      if (off(dp)) {
        c.palOff++;
        if (st.controlledId === 0) c.palOffCtl++;
        const key = side(dp) + (st.puck.owner !== null && st.skaters[st.puck.owner].team === 1 ? '/oppPuck' : st.puck.owner === null ? '/loose' : '/homePuck');
        palSides[key] = (palSides[key] ?? 0) + 1;
      } else if (inBug(dp)) c.palBug++;
    }
    const ctl = st.skaters[st.controlledId];
    if (ctl.state !== 'box') {
      if (off(proj(cam, ctl.pos.x, 0.9, ctl.pos.z))) c.ctrlOff++;
      const h = proj(cam, ctl.pos.x, 1.9, ctl.pos.z);
      if (!off(h) && inBug(h)) c.ctrlHeadBug++;
    }
    const d = attackDir(0, st.period);
    if (st.puck.pos.z * d >= ZMIN) {
      nz++;
      const bar = proj(cam, 0, 1.2, d * RINK.goalLineZ);
      if (bar.y < 0) c.barOff++;
      else if (inBug(bar)) c.barBug++;
      const gk = st.skaters.find((s) => s.team === 1 && s.kind === 'goalie')!;
      if (inBug(proj(cam, gk.pos.x, 1.6, gk.pos.z))) c.gkHead++;
    }
  }
}
const pct = (k: number, of = n) => ((100 * k) / of).toFixed(2) + '%';
console.log(`live-play frames: ${n}`);
console.log(`puck off-screen ${pct(c.puckOff)} (longest streak ${(c.maxStreak / 60).toFixed(2)} s); behind score bug ${pct(c.puckBug)}, behind PAL box ${pct(c.puckBox)}`);
console.log(`PAL off-screen ${pct(c.palOff)} (while controlled ${pct(c.palOffCtl)}), PAL body behind bug ${pct(c.palBug)}; controlled skater off-screen ${pct(c.ctrlOff)}, controlled head behind bug ${pct(c.ctrlHeadBug)}`);
console.log('PAL off by side/possession', palSides);
console.log('puck screen-y histogram (28px bands, top->bottom):', yHist.map((k) => pct(k)).join(' '));
console.log(`offensive zone (puck >= ${ZMIN} m) frames ${nz}: crossbar above screen ${pct(c.barOff, nz)}, crossbar under bug ${pct(c.barBug, nz)}, goalie head under bug ${pct(c.gkHead, nz)}`);
