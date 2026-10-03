// Top-down AI debugger: renders PNG strips of the rink (players, AI roles,
// velocities, puck) so formations can be inspected without a browser.
//   npx tsx tools/ai-topdown.ts goals [games=1] [seed=1] [out=tools/out/ai-top]
//       -> for each goal, a strip of 4 frames at -2.0/-1.3/-0.6/0 s
//   npx tsx tools/ai-topdown.ts times 30,45,60 [seed] [out]
//       -> one strip with a frame at each game time (seconds of sim time)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';
import { RINK } from '../src/config';
import { aiMem } from '../src/ai/memory';
import type { GameState } from '../src/types';

const mode = process.argv[2] ?? 'goals';
const arg = process.argv[3] ?? '1';
const seed = Number(process.argv[4] ?? 1);
const outDir = process.argv[5] ?? 'tools/out/ai-top';
setRandom(mulberry32(seed));
fs.mkdirSync(outDir, { recursive: true });

const PX = Number(process.env.PX ?? 10); // pixels per meter
const FW = Math.ceil(RINK.halfWidth * 2 * PX) + 8;
const FH = Math.ceil(RINK.halfLength * 2 * PX) + 8;

interface Snap {
  t: number;
  label: string;
  skaters: { x: number; z: number; vx: number; vz: number; team: number; kind: string; role: string; has: boolean; state: string }[];
  puck: { x: number; z: number };
  period: number;
}

function snap(st: GameState, label: string): Snap {
  const mem = aiMem(st);
  return {
    t: st.time,
    label,
    period: st.period,
    puck: { ...st.puck.pos },
    skaters: st.skaters
      .filter((s) => s.state !== 'box')
      .map((s) => ({
        x: s.pos.x,
        z: s.pos.z,
        vx: s.vel.x,
        vz: s.vel.z,
        team: s.team,
        kind: s.kind,
        state: s.state,
        has: st.puck.owner === s.id,
        role: mem.teams[s.team].assign.get(s.id)?.role ?? (s.kind === 'goalie' ? 'g' : '?'),
      })),
  };
}

// --- tiny raster
class Img {
  data: Uint8Array;
  constructor(public w: number, public h: number) {
    this.data = new Uint8Array(w * h * 3).fill(30);
  }
  px(x: number, y: number, c: [number, number, number]) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
  }
  disc(x: number, y: number, r: number, c: [number, number, number]) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 0.5) this.px(x + dx, y + dy, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) this.px(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      Buffer.from(this.data.buffer, y * this.w * 3, this.w * 3).copy(raw, y * (this.w * 3 + 1) + 1);
    }
    const crcT = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
    const crc = (b: Buffer) => {
      let c = -1;
      for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8);
      return (c ^ -1) >>> 0;
    };
    const chunk = (type: string, d: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(d.length);
      const td = Buffer.concat([Buffer.from(type), d]);
      const c = Buffer.alloc(4);
      c.writeUInt32BE(crc(td));
      return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}

// 3x5 glyphs for role letters
const GLYPH: Record<string, string> = {
  C: '111100100100111', P: '111101111100100', M: '101111111101101', B: '110101110101110', S: '111100111001111',
  K: '101110100110101', I: '111010010010111', G: '111100101101111', '?': '111001011000010', L: '100100100100111',
};
function letter(img: Img, ch: string, x: number, y: number, c: [number, number, number]) {
  const g = GLYPH[ch] ?? GLYPH['?'];
  for (let i = 0; i < 15; i++) if (g[i] === '1') img.px(x + (i % 3), y + Math.floor(i / 3), c);
}

function drawFrame(img: Img, ox: number, s: Snap) {
  // camera-like orientation: HOME always attacks UP (flip in even periods)
  const flip = s.period % 2 === 0 && s.period <= 3 ? -1 : 1;
  const X = (x: number) => ox + 4 + (RINK.halfWidth - x * flip) * PX; // screen right = world -x when attacking +z
  const Y = (z: number) => 4 + (RINK.halfLength - z * flip) * PX;
  for (let py = 0; py < FH; py++)
    for (let px = 0; px < FW; px++) {
      const x = (RINK.halfWidth - (px - 4) / PX) * flip;
      const z = (RINK.halfLength - (py - 4) / PX) * flip;
      const ix = Math.max(0, Math.abs(x) - (RINK.halfWidth - RINK.cornerRadius));
      const iz = Math.max(0, Math.abs(z) - (RINK.halfLength - RINK.cornerRadius));
      if (Math.abs(x) <= RINK.halfWidth && Math.abs(z) <= RINK.halfLength && Math.hypot(ix, iz) <= RINK.cornerRadius) img.px(ox + px, py, [225, 235, 245]);
    }
  const hline = (z: number, c: [number, number, number]) => {
    for (let x = -RINK.halfWidth + 0.5; x <= RINK.halfWidth - 0.5; x += 0.1) img.px(X(x), Y(z), c);
  };
  hline(0, [220, 40, 40]);
  hline(RINK.blueLineZ, [40, 60, 220]);
  hline(-RINK.blueLineZ, [40, 60, 220]);
  hline(RINK.goalLineZ, [220, 40, 40]);
  hline(-RINK.goalLineZ, [220, 40, 40]);
  for (const sz of [1, -1]) img.line(X(-0.9), Y(sz * RINK.goalLineZ), X(0.9), Y(sz * RINK.goalLineZ), [0, 0, 0]);
  for (const k of s.skaters) {
    const col: [number, number, number] = k.team === 0 ? (k.kind === 'dog' ? [255, 160, 0] : [210, 30, 30]) : [90, 50, 190];
    const x = X(k.x);
    const y = Y(k.z);
    img.line(x, y, X(k.x + k.vx * 0.5), Y(k.z + k.vz * 0.5), [120, 120, 120]);
    img.disc(x, y, k.kind === 'goalie' ? 4 : 3, k.state === 'fallen' ? [140, 140, 140] : col);
    if (k.has) img.disc(x, y, 1, [255, 255, 0]);
    const ch = k.role === 'carrier' ? 'K' : k.role === 'support' ? 'S' : k.role === 'g' ? 'G' : k.role[0]?.toUpperCase() ?? '?';
    letter(img, ch, x + 5, y - 2, [0, 0, 0]);
  }
  img.disc(X(s.puck.x), Y(s.puck.z), 1, [0, 0, 0]);
  img.px(X(s.puck.x) + 2, Y(s.puck.z), [0, 0, 0]);
}

/** half: 'top' | 'bottom' | 'all' (screen halves, HOME attacking up) */
function save(snaps: Snap[], name: string, half: 'top' | 'bottom' | 'all' = 'all') {
  const full = new Img(FW * snaps.length + 4 * (snaps.length - 1), FH);
  snaps.forEach((s, i) => drawFrame(full, i * (FW + 4), s));
  let img = full;
  if (half !== 'all') {
    const h = Math.ceil(FH * 0.56);
    const y0 = half === 'top' ? 0 : FH - h;
    img = new Img(full.w, h);
    img.data.set(full.data.subarray(y0 * full.w * 3, (y0 + h) * full.w * 3));
  }
  fs.writeFileSync(path.join(outDir, name), img.png());
  console.log('wrote', path.join(outDir, name), snaps.map((s) => `${s.label}@${s.t.toFixed(1)}`).join(' '));
}

const st = createGame({ autoplay: true });
const hist: Snap[] = [];
if (mode === 'goals') {
  const games = Number(arg);
  let n = 0;
  for (let g = 0; g < games; g++) {
    const game = g === 0 ? st : createGame({ autoplay: true });
    while (game.phase !== 'gameOver' && game.tick < 60 * 60 * 30) {
      stepGame(game, emptyPad());
      if (game.phase === 'play' && game.tick % 6 === 0) {
        hist.push(snap(game, ''));
        if (hist.length > 60) hist.shift();
      }
      for (const e of game.events) {
        if (e.type !== 'goal') continue;
        const now = game.time;
        const pick = [2.0, 1.3, 0.6, 0.05].map((dt) => hist.reduce((a, b) => (Math.abs(b.t - (now - dt)) < Math.abs(a.t - (now - dt)) ? b : a)));
        const sc = game.skaters[e.info.scorer];
        save(pick.map((p, i) => ({ ...p, label: `-${[2.0, 1.3, 0.6, 0][i]}` })), `goal-${String(++n).padStart(2, '0')}-${sc.team === 0 ? 'home' : 'away'}.png`, sc.team === 0 ? 'top' : 'bottom');
      }
    }
  }
} else {
  const times = arg.split(',').map(Number);
  const snaps: Snap[] = [];
  while (st.phase !== 'gameOver' && times.length) {
    stepGame(st, emptyPad());
    if (st.time >= times[0]) {
      snaps.push(snap(st, `${st.phase}`));
      times.shift();
    }
  }
  save(snaps, `times-${seed}.png`);
}
