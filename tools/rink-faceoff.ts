// RINK: faceoff framing through the real CameraRig in node (autoplay games).
//   ./node_modules/.bin/tsx tools/rink-faceoff.ts [games=3] [seed=7]
//   BOT=1 ...   PAL is played by the scripted pad-only human (tools/ai-bot-lib.ts)
// For every faceoff, by the phase it came from (goal, penalty, stoppage, ...):
// where the faceoff dot lands on screen during the faceoff, bucketed by
// phaseTime, and the share of faceoffs whose dot is framed (screen y 30..200,
// x 8..248: clear of the score bug and the TURBO window) on every frame from
// 0.25 s on. Acceptance (camera task): framed by 0.25 s in > 95% of faceoffs.
import * as THREE from 'three';
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { CameraRig } from '../src/render/camera';
import { mulberry32, setRandom } from '../src/sim/util';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const games = Number(process.argv[2] ?? 3);
const seed = Number(process.argv[3] ?? 7);
setRandom(mulberry32(seed));
const BOT = process.env.BOT === '1';
if (BOT) configureBot(seed, 1);
const BY = Number(process.env.BY ?? 0.25);
const v = new THREE.Vector3();
const framed = (x: number, y: number, z: number) => z <= 1 && y >= 30 && y <= 200 && x >= 8 && x <= 248;

type Row = { n: number; off: number; ymax: number; ysum: number };
const rows: Record<string, Row> = {};
const per: Record<string, { n: number; ok: number; worst: number }> = {};
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: !BOT });
  const bot = newBot();
  const rig = new CameraRig();
  let prev = st.phase;
  let from = '';
  let fo: typeof st.faceoff = null;
  let ok = true;
  let lastOff = 0; // latest phaseTime with the dot unframed
  const close = () => {
    if (!fo) return;
    const p = (per[from] ??= { n: 0, ok: 0, worst: 0 });
    p.n++;
    if (ok) p.ok++;
    p.worst = Math.max(p.worst, lastOff);
    fo = null;
  };
  for (let t = 0; st.phase !== 'gameOver' && t < 60 * 60 * 12; t++) {
    stepGame(st, BOT ? botPad(st, bot) : emptyPad());
    rig.update(st, 1 / 60);
    if (st.phase !== prev) {
      if (st.phase === 'faceoff') from = prev;
      prev = st.phase;
    }
    if (st.phase !== 'faceoff' || !st.faceoff) {
      close();
      continue;
    }
    if (st.faceoff !== fo) {
      close();
      fo = st.faceoff;
      ok = true;
      lastOff = 0;
    }
    v.set(fo.spot.x, 0, fo.spot.z).project(rig.camera);
    const x = (v.x * 0.5 + 0.5) * 256;
    const y = (-v.y * 0.5 + 0.5) * 224;
    const inFrame = framed(x, y, v.z);
    if (!inFrame) {
      lastOff = st.phaseTime;
      if (st.phaseTime >= BY) ok = false;
    }
    const b = st.phaseTime < 0.1 ? '0-0.1' : st.phaseTime < BY ? `0.1-${BY}` : st.phaseTime < 0.8 ? `${BY}-0.8` : '0.8+';
    const r = (rows[`${from}/${b}`] ??= { n: 0, off: 0, ymax: 0, ysum: 0 });
    r.n++;
    r.ysum += y;
    r.ymax = Math.max(r.ymax, y);
    if (!inFrame) r.off++;
  }
  close();
}
for (const [k, r] of Object.entries(rows).sort())
  console.log(k.padEnd(24), `n ${r.n}`.padEnd(8), `dot y mean ${(r.ysum / r.n).toFixed(0)} max ${r.ymax.toFixed(0)}  unframed ${((100 * r.off) / r.n).toFixed(1)}%`);
let n = 0;
let okAll = 0;
for (const [k, p] of Object.entries(per).sort()) {
  n += p.n;
  okAll += p.ok;
  console.log(`after ${k.padEnd(13)} faceoffs ${String(p.n).padEnd(4)} framed from ${BY} s on: ${((100 * p.ok) / p.n).toFixed(1)}%  (latest unframed frame ${p.worst.toFixed(2)} s)`);
}
console.log(`ALL faceoffs ${n}: dot framed from ${BY} s on in ${((100 * okAll) / Math.max(1, n)).toFixed(1)}%`);
