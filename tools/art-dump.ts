// ART iteration helper (node, no browser): renders a sprite kind's frames to
// a PNG so they can be inspected quickly.
//   npx tsx tools/art-dump.ts <dog|kid|goalie|ref|misc> [scale=6] [team=0] [anim]
// Writes tools/out/art/dump-<kind>-<team>.png. Rows = anims, columns = the
// authored directions (N NE E SE S, plus NW when authored), frames side by side. Each row also
// gets a strip at 1x and 2x on ice so the real on-screen size can be judged.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { TEAMS } from '../src/config';
import { DIR_KEYS, type KindArt } from '../src/render/art/frames';
import { teamPalette, rgba } from '../src/render/art/palette';
import { kindArt, miscArt } from '../src/render/art/library';

const [kind = 'dog', scaleArg = '6', teamArg = '0', only] = process.argv.slice(2);
const S = Number(scaleArg);
const team = Number(teamArg) as 0 | 1;
const pal = teamPalette(kind === 'ref' ? null : TEAMS[team].colors);

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function png(w: number, h: number, px: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

class Img {
  px: Uint8Array;
  constructor(public w: number, public h: number, bg: string) {
    this.px = new Uint8Array(w * h * 4);
    const c = rgba(bg);
    for (let i = 0; i < w * h; i++) this.px.set(c, i * 4);
  }
  fill(x: number, y: number, w: number, h: number, c: string) {
    const [r, g, b, a] = rgba(c);
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        const o = (j * this.w + i) * 4;
        const f = a / 255;
        this.px[o] = this.px[o] * (1 - f) + r * f;
        this.px[o + 1] = this.px[o + 1] * (1 - f) + g * f;
        this.px[o + 2] = this.px[o + 2] * (1 - f) + b * f;
      }
  }
}

const ICE = '#e4ecf8';
let rows: { label: string; cells: { d: string[]; w: number; h: number; ax: number; ay: number }[] }[] = [];

if (kind === 'misc') {
  for (const [name, frames] of Object.entries(miscArt())) {
    rows.push({ label: name, cells: frames.map((f) => ({ d: f.g.d, w: f.g.w, h: f.g.h, ax: f.ax, ay: f.ay })) });
  }
} else {
  const art: KindArt = kindArt(kind as 'dog' | 'kid' | 'goalie' | 'ref');
  for (const [anim, def] of Object.entries(art.anims)) {
    if (only && anim !== only) continue;
    const cells: (typeof rows)[number]['cells'] = [];
    for (const d of DIR_KEYS) {
      const fr = def!.dirs[d];
      if (!fr) continue;
      for (const f of fr) cells.push({ d: f.g.d, w: f.g.w, h: f.g.h, ax: f.ax, ay: f.ay });
      cells.push({ d: [], w: 4, h: 0, ax: 0, ay: 0 }); // spacer between directions
    }
    rows.push({ label: anim, cells });
  }
}

const pad = 2;
const rowH = Math.max(...rows.flatMap((r) => r.cells.map((c) => c.h))) + pad;
const widths = rows.map((r) => r.cells.reduce((s, c) => s + c.w + pad, 0));
const W = Math.max(...widths) * S + 8;
// below the big sheet: an in-context strip at 1x and 2x
const H = rows.length * rowH * S + 8 + rows.length * (rowH * 3 + 4) + 8;
const img = new Img(W, H, '#303038');

let y = 4;
for (const r of rows) {
  let x = 4;
  for (const c of r.cells) {
    if (c.d.length) {
      img.fill(x, y, c.w * S, c.h * S, ICE);
      for (let j = 0; j < c.h; j++)
        for (let i = 0; i < c.w; i++) {
          const ch = c.d[j * c.w + i];
          if (ch !== '.') img.fill(x + i * S, y + j * S, S, S, pal[ch] ?? '#ff00ff');
        }
      // anchor tick
      img.fill(x + c.ax * S - 1, y + (c.h - c.ay) * S - 1, 2, 2, '#ff0000');
    }
    x += (c.w + pad) * S;
  }
  y += rowH * S;
}
// 1x + 2x strip on ice
y += 8;
img.fill(0, y - 4, W, H - y + 4, ICE);
for (const r of rows) {
  let x = 4;
  for (const sc of [1, 2]) {
    for (const c of r.cells) {
      if (!c.d.length) continue;
      for (let j = 0; j < c.h; j++)
        for (let i = 0; i < c.w; i++) {
          const ch = c.d[j * c.w + i];
          if (ch !== '.') img.fill(x + i * sc, y + j * sc, sc, sc, pal[ch] ?? '#ff00ff');
        }
      x += c.w * sc + 2;
    }
    x += 12;
  }
  y += rowH * 3 + 4;
}

const out = path.join('tools/out/art');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, `dump-${kind}-${team}${only ? '-' + only : ''}.png`);
fs.writeFileSync(file, png(W, H, img.px));
console.log(file, `${W}x${H}`, rows.map((r) => `${r.label}:${r.cells.filter((c) => c.d.length).length}`).join(' '));
