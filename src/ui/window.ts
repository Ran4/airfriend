// SNES-style window boxes, team chips, meters and small pixel icons. All of
// it is fillRect on integer coordinates: no paths, no antialiasing.

import { TEAMS } from '../config';
import type { TeamId } from '../types';
import { drawText } from './font';
import { C, mix, ramp, snes, TEAM_PAL } from './palette';

export type G = CanvasRenderingContext2D;

export function rect(g: G, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  g.fillStyle = color;
  g.fillRect(Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h));
}

/** rounded rect via per-row insets (r = how many corner pixels to cut) */
function rrect(g: G, x: number, y: number, w: number, h: number, r: number, color: string): void {
  g.fillStyle = color;
  // corner profile for r=1..3: a pixel-art quarter circle
  const prof = r <= 0 ? [] : r === 1 ? [1] : r === 2 ? [2, 1] : [3, 1, 1];
  for (let i = 0; i < prof.length && i < h / 2; i++) {
    g.fillRect(x + prof[i], y + i, w - prof[i] * 2, 1);
    g.fillRect(x + prof[i], y + h - 1 - i, w - prof[i] * 2, 1);
  }
  g.fillRect(x, y + prof.length, w, h - prof.length * 2);
}

export interface WindowTheme {
  top: string;
  bottom: string;
  edge: string; // outermost dark line
  light: string; // bevel highlight (top/left)
  mid: string; // bevel lowlight (bottom/right)
  inner: string; // dark line between bevel and fill
}

export const THEMES = {
  blue: { top: C.winTop, bottom: C.winBot, edge: C.winEdge, light: C.winLight, mid: C.winMid, inner: C.winShade },
  red: {
    top: snes('#e04848'),
    bottom: snes('#600818'),
    edge: C.winEdge,
    light: C.winLight,
    mid: snes('#d8a0a8'),
    inner: snes('#580010'),
  },
  dark: {
    top: snes('#283058'),
    bottom: snes('#080c20'),
    edge: C.black,
    light: snes('#c8d0e8'),
    mid: snes('#687090'),
    inner: snes('#000410'),
  },
  gold: {
    top: snes('#f8d048'),
    bottom: snes('#a05800'),
    edge: C.winEdge,
    light: snes('#f8f8d8'),
    mid: snes('#d8a040'),
    inner: snes('#583000'),
  },
} satisfies Record<string, WindowTheme>;

export function teamTheme(t: TeamId): WindowTheme {
  const p = TEAM_PAL[t];
  return {
    top: mix(p.main, '#ffffff', 0.15),
    bottom: mix(p.dark, '#000000', 0.3),
    edge: C.winEdge,
    light: C.winLight,
    mid: mix(p.light, '#a0a0a0', 0.4),
    inner: mix(p.dark, '#000000', 0.5),
  };
}

/**
 * A 16-bit dialog box: dark rim, 1 px white/gray bevel, dark inner line and
 * a vertical gradient quantized into flat bands (with a 1-row checker dither
 * at each band seam, like the PPU color-math gradients of the era).
 */
export function drawWindow(g: G, x: number, y: number, w: number, h: number, theme: WindowTheme = THEMES.blue): void {
  x = Math.floor(x);
  y = Math.floor(y);
  w = Math.floor(w);
  h = Math.floor(h);
  if (w < 8 || h < 8) return;
  rrect(g, x, y, w, h, 2, theme.edge);
  // bevel: light on top/left, mid on bottom/right
  rrect(g, x + 1, y + 1, w - 2, h - 2, 1, theme.mid);
  rrect(g, x + 1, y + 1, w - 3, h - 3, 1, theme.light);
  rect(g, x + 2, y + 2, w - 4, h - 4, theme.inner);
  // gradient body
  const bx = x + 3;
  const by = y + 3;
  const bw = w - 6;
  const bh = h - 6;
  const bands = Math.max(2, Math.min(8, Math.round(bh / 6)));
  const cols = ramp(theme.top, theme.bottom, bands);
  for (let i = 0; i < bands; i++) {
    const y0 = by + Math.floor((i * bh) / bands);
    const y1 = by + Math.floor(((i + 1) * bh) / bands);
    rect(g, bx, y0, bw, y1 - y0, cols[i]);
    if (i > 0) {
      // checker dither row on the seam
      g.fillStyle = cols[i - 1];
      for (let px = bx + (i & 1); px < bx + bw; px += 2) g.fillRect(px, y0, 1, 1);
    }
  }
}

/** a thin horizontal rule inside a window */
export function drawRule(g: G, x: number, y: number, w: number): void {
  rect(g, x, y, w, 1, C.winShade);
  rect(g, x, y + 1, w, 1, C.winMid);
}

/** team abbreviation in a little team-colored plate */
export function drawChip(g: G, x: number, y: number, team: TeamId, label: string, w = 32): void {
  const p = TEAM_PAL[team];
  const h = 11;
  rrect(g, x, y, w, h, 1, C.winEdge);
  rect(g, x + 1, y + 1, w - 2, h - 2, p.main);
  rect(g, x + 1, y + 1, w - 2, 1, p.light);
  rect(g, x + 1, y + h - 2, w - 2, 1, p.dark);
  // trim-colored end caps, like jersey sleeve stripes
  rect(g, x + 1, y + 2, 1, h - 4, p.trim);
  rect(g, x + w - 2, y + 2, 1, h - 4, p.trim);
  drawText(g, label, x + w / 2 + 1, y + 2, { align: 'center', color: C.white, shadow: C.ink });
}

/** segmented meter: frame + fill 0..1, colors picked by fill level */
export function drawMeter(
  g: G,
  x: number,
  y: number,
  w: number,
  h: number,
  v: number,
  colors: [string, string, string] = [C.green, C.yellow, C.red],
  flash = false,
): void {
  rrect(g, x, y, w, h, 1, C.winEdge);
  rect(g, x + 1, y + 1, w - 2, h - 2, snes('#182040'));
  const inner = w - 2;
  const fillW = Math.round(Math.max(0, Math.min(1, v)) * inner);
  const col = flash ? C.white : v > 0.5 ? colors[0] : v > 0.25 ? colors[1] : colors[2];
  const light = mix(col, '#ffffff', 0.5);
  const dark = mix(col, '#000000', 0.35);
  rect(g, x + 1, y + 1, fillW, h - 2, col);
  rect(g, x + 1, y + 1, fillW, 1, light);
  rect(g, x + 1, y + h - 2, fillW, 1, dark);
  // segment notches every 4 px sell the "LED bar" look
  g.fillStyle = snes('#101830');
  for (let sx = x + 4; sx < x + 1 + fillW; sx += 4) g.fillRect(sx, y + 1, 1, h - 2);
}

// ------------------------------------------------------------- icons ----
// Pixel art with a tiny per-icon palette. '.' is transparent.
interface Icon {
  rows: string[];
  pal: Record<string, string>;
}

export function drawIcon(g: G, icon: Icon, x: number, y: number, scale = 1, override?: Record<string, string>): void {
  x = Math.floor(x);
  y = Math.floor(y);
  icon.rows.forEach((row, iy) => {
    for (let ix = 0; ix < row.length; ix++) {
      const k = row[ix];
      if (k === '.') continue;
      const col = override?.[k] ?? icon.pal[k];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x + ix * scale, y + iy * scale, scale, scale);
    }
  });
}

export const ICONS = {
  paw: {
    rows: [
      '.kk.kk...',
      'kppkppk..',
      'kppkppkk.',
      '.kkkkkppk',
      'kkkwwkppk',
      'kppwwwkk.',
      'kpwwwwwk.',
      '.kwwwwwk.',
      '..kkkkk..',
    ],
    pal: { k: C.ink, p: snes('#f8a8c0'), w: snes('#f8f0f0') },
  },
  dog: makeDogIcon(),
  // PAL's mugshot for the scorer window's portrait inset (same face, native size)
  dogFace: makeDogIcon(1),
  // generic kid in a caged helmet for the scorer inset; h/H/w are the helmet
  // shell, brim and shine (recolor them per team, see kidFaceColors)
  kidFace: {
    rows: [
      '.....kkkkkkkk.....',
      '...kkhhhhhhhhkk...',
      '..khhhhhhhhwwhhk..',
      '.khhhhhhhhhhwhhhk.',
      '.khhhhhhhhhhhhhhk.',
      'khhhhhhhhhhhhhhhhk',
      'kHHHHHHHHHHHHHHHHk',
      'kHkuuuuuuuuuuuukHk',
      'kHkuussssssssuukHk',
      'kHksssssssssssskHk',
      'kHksskwsssskwsskHk',
      'kHksskksssskksskHk',
      'kHkcccccccccccckHk',
      'kHksscssSSsscsskHk',
      'kHksscksssskcsskHk',
      'kHksscskkkkscsskHk',
      'kHkcccccccccccckHk',
      '.kkkSSSSSSSSSSkkk.',
      '....kkkkkkkkkk....',
    ],
    pal: {
      k: C.ink,
      h: snes('#d82828'),
      H: snes('#8c1010'),
      w: snes('#f8f8f8'),
      u: snes('#8c4c20'),
      s: snes('#f8c898'),
      S: snes('#d08c60'),
      c: snes('#c0c8d8'),
    },
  },
  // tiny puck for the logo
  puck: {
    rows: ['.kkkkkk.', 'kddddddk', 'kkddddkk', '.kkkkkk.'],
    pal: { k: C.black, d: snes('#384058') },
  },
  sparkle: {
    rows: ['...w...', '...w...', '..www..', 'wwwywww', '..www..', '...w...', '...w...'],
    pal: { w: C.white, y: C.yellow },
  },
} satisfies Record<string, Icon>;

/** 3x5 digits for the tiny jersey icon (and anything else that needs a number in a 12 px slot) */
const MINI_DIGITS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
};

function miniText(g: G, text: string, x: number, y: number, color: string): void {
  g.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const rows = MINI_DIGITS[ch];
    if (rows) rows.forEach((r, iy) => [...r].forEach((c, ix) => c === '#' && g.fillRect(cx + ix, y + iy, 1, 1)));
    cx += 4;
  }
}

/** jersey silhouette with sleeves; 'j' body, 'd' shading, 't' trim stripes */
const JERSEY = [
  '..kkkk.kkkk..',
  '.kjjjjkjjjjk.',
  'kjjjjjjjjjjjk',
  'kttjjjjjjjttk',
  'kjjjjjjjjjjjk',
  'kkkjjjjjjjkkk',
  '..kjjjjjjjk..',
  '..kjjjjjjjk..',
  '..kjjjjjjjk..',
  '..kdddddddk..',
  '..kkkkkkkkk..',
];

/**
 * A 13x11 jersey in team colors with the skater's number on its chest: the
 * turbo window's icon for a kid (PAL gets the paw).
 */
export function drawJerseyIcon(g: G, x: number, y: number, team: TeamId, number: string): void {
  const p = TEAM_PAL[team];
  drawIcon(g, { rows: JERSEY, pal: { k: C.ink, j: p.main, d: p.dark, t: p.trim } }, x, y);
  const n = number.slice(0, 2);
  const w = n.length * 4 - 1;
  const nx = Math.floor(x) + 3 + Math.floor((7 - w) / 2);
  // one-pixel ink drop under the digits keeps them readable on any jersey color
  miniText(g, n, nx + 1, Math.floor(y) + 4, mix(p.dark, '#000000', 0.4));
  miniText(g, n, nx, Math.floor(y) + 3, team === 0 ? C.white : p.trim);
}

/** speech bubble with a tail, matching the in-world ARF! balloon (15x12) */
const BUBBLE = [
  '.kkkkkkkkkkkkk.',
  'kfffffffffffffk',
  'kfffffffffffffk',
  'kfffffffffffffk',
  'kfffffffffffffk',
  'kfffffffffffffk',
  'kfffffffffffffk',
  'kfffffffffffffk',
  '.kkkfkkkkkkkkk.',
  '...kfk.........',
  '...kk..........',
  '..k............',
];
/** A R F in a 3x5 hand (the in-world bubble's letters) */
const ARF_LETTERS = [
  ['.#.', '#.#', '###', '#.#', '#.#'],
  ['##.', '#.#', '##.', '#.#', '#.#'],
  ['###', '#..', '##.', '#..', '#..'],
];

type BarkLamp = 'ready' | 'flash' | 'cooling';

/**
 * The turbo window's bark lamp: a little ARF balloon like the one over PAL's
 * head. 'ready' = white balloon, red letters; 'flash' = the white flash on
 * recharge; 'cooling' = a hollow outline whose inside refills from the
 * bottom with `charge` (0..1).
 */
export function drawBarkBubble(g: G, x: number, y: number, lamp: BarkLamp, charge = 1): void {
  x = Math.floor(x);
  y = Math.floor(y);
  const red = TEAM_PAL[0].main;
  if (lamp === 'cooling') {
    // hollow: a dark, empty balloon in a pale outline, with a charge level
    // rising inside it like a tiny meter; the letters show only as ghosts
    const level = Math.round(Math.max(0, Math.min(1, charge)) * 7);
    const top = y + 8 - level; // first charged row
    drawIcon(g, { rows: BUBBLE, pal: { k: C.winMid, f: snes('#182040') } }, x, y);
    if (level > 0) rect(g, x + 1, top, 13, level, mix(C.winMid, C.winTop, 0.45));
    ARF_LETTERS.forEach((L, i) =>
      L.forEach((r, iy) =>
        [...r].forEach((c, ix) => {
          if (c !== '#') return;
          const py = y + 2 + iy;
          rect(g, x + 2 + i * 4 + ix, py, 1, 1, py >= top ? C.winShade : snes('#4050a0'));
        }),
      ),
    );
    return;
  }
  // the flash turns the outline white too: for a moment the balloon glows
  const flash = lamp === 'flash';
  drawIcon(g, { rows: BUBBLE, pal: { k: flash ? C.white : C.ink, f: C.white } }, x, y);
  if (!flash) rect(g, x + 1, y + 7, 13, 1, C.gray);
  ARF_LETTERS.forEach((L, i) =>
    L.forEach((r, iy) =>
      [...r].forEach((c, ix) => {
        if (c !== '#') return;
        const px = x + 2 + i * 4 + ix;
        const py = y + 2 + iy;
        if (!flash) rect(g, px, py + 1, 1, 1, TEAM_PAL[0].dark);
        rect(g, px, py, 1, 1, flash ? C.yellow : red);
      }),
    ),
  );
}

/** helmet colors for ICONS.kidFace in team `t`'s gear */
function kidFaceColors(t: TeamId): Record<string, string> {
  const shell = snes(TEAMS[t].colors.helmet);
  return { h: shell, H: TEAM_PAL[t].dark, w: mix(shell, '#ffffff', 0.7) };
}

/**
 * Portrait inset for a window: a recessed frame with a sky backdrop and the
 * scorer's face sitting on its bottom edge (PAL's mugshot, or a kid in team
 * colors). Returns the inset's width so the caller can lay text beside it.
 */
export function drawPortrait(g: G, x: number, y: number, w: number, h: number, who: 'dog' | 'kid', team: TeamId): number {
  // recessed: dark rim, a shadowed top/left inner line, a light bottom/right
  rect(g, x, y, w, h, C.winEdge);
  rect(g, x + 1, y + 1, w - 2, h - 2, mix(TEAM_PAL[team].dark, '#000000', 0.4));
  const ix = x + 2;
  const iy = y + 2;
  const iw = w - 4;
  const ih = h - 4;
  // banded sky, lighter toward the bottom, like the window gradients
  const sky = ramp(snes('#3870d0'), snes('#a8d8f8'), 4);
  for (let i = 0; i < ih; i++) rect(g, ix, iy + i, iw, 1, sky[Math.min(3, Math.floor((i / ih) * 4))]);
  const icon = who === 'dog' ? ICONS.dogFace : ICONS.kidFace;
  const fw = icon.rows[0].length;
  const fh = icon.rows.length;
  g.save();
  g.beginPath();
  g.rect(ix, iy, iw, ih);
  g.clip();
  drawIcon(g, icon, ix + Math.floor((iw - fw) / 2), iy + ih - fh + (who === 'dog' ? 1 : 0), 1, who === 'kid' ? kidFaceColors(team) : undefined);
  g.restore();
  return w;
}

/**
 * PAL's face for the title logo, generated rather than hand-plotted so the
 * powder-puff outline gets an even ring of curls: a bumpy circle for the head,
 * two bumpy droops for the ears, cream shading on the lower right, then
 * button eyes, nose and a little pink tongue painted on top. `S` scales the
 * shape while outlines stay 1 px, so the result looks drawn at native size
 * instead of blown up.
 */
function makeDogIcon(S = 1.7): Icon {
  const w = Math.ceil(26 * S);
  const h = Math.ceil(22 * S);
  const cx = 12.5 * S;
  const cy = 10.5 * S;
  const grid: string[][] = Array.from({ length: h }, () => Array<string>(w).fill('.'));
  const inHead = (x: number, y: number) => {
    const dx = x - cx;
    const dy = (y - cy) * 1.08;
    const a = Math.atan2(dy, dx);
    return Math.hypot(dx, dy) < (8.7 + 0.7 * Math.cos(a * 11)) * S;
  };
  const inEar = (x: number, y: number) => {
    for (const ex of [cx - 8.0 * S, cx + 8.0 * S]) {
      const dx = x - ex;
      const dy = (y - (cy + 3.2 * S)) * 0.62;
      const a = Math.atan2(dy, dx);
      if (Math.hypot(dx, dy) < (2.8 + 0.45 * Math.cos(a * 7)) * S) return true;
    }
    return false;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const head = inHead(px, py);
      if (head) {
        // shading: lower-right crescent of the head
        grid[y][x] = (px - cx) * 0.55 + (py - cy) > 6.0 * S ? 'c' : 'w';
      } else if (inEar(px, py)) grid[y][x] = 'e';
    }
  // ears hang behind the head: an ink seam where they meet it
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++)
      if (grid[y][x] === 'e' && [grid[y][x - 1], grid[y][x + 1], grid[y - 1][x]].some((c) => c === 'w' || c === 'c')) grid[y][x] = 's';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (grid[y][x] === 's') grid[y][x] = 'k';
  // ink outline around every filled pixel (4-neighbourhood), separate pass
  const fur = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && 'wce'.includes(grid[y][x]);
  const edge: [number, number][] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (grid[y][x] === '.' && (fur(x - 1, y) || fur(x + 1, y) || fur(x, y - 1) || fur(x, y + 1))) edge.push([x, y]);
  for (const [x, y] of edge) grid[y][x] = 'k';
  // features, authored on the 1x grid and scaled
  const block = (x: number, y: number, bw: number, bh: number, c: string) => {
    const x0 = Math.round(cx + x * S);
    const y0 = Math.round(cy + y * S);
    const x1 = Math.round(cx + (x + bw) * S);
    const y1 = Math.round(cy + (y + bh) * S);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) if (xx >= 0 && yy >= 0 && xx < w && yy < h) grid[yy][xx] = c;
  };
  const dot = (x: number, y: number, c: string) => {
    const xx = Math.round(cx + x * S);
    const yy = Math.round(cy + y * S);
    if (xx >= 0 && yy >= 0 && xx < w && yy < h) grid[yy][xx] = c;
  };
  for (const ex of [-5.6, 3.3]) {
    block(ex, -1.8, 2.4, 3, 'k');
    dot(ex + 0.7, -1.1, 'g');
  }
  block(-1.5, 2.5, 3, 2, 'k'); // nose
  dot(-1, 2.8, 'n');
  block(-0.25, 4.5, 0.6, 1.2, 'k'); // philtrum
  block(-2.5, 5.4, 2.3, 0.6, 'k'); // smile
  block(0.4, 5.4, 2.3, 0.6, 'k');
  block(-1, 6, 2.2, 1.8, 'p'); // tongue
  block(-1.5, 7.8, 3, 0.6, 'k');
  block(-7, 2.5, 2, 1, 'b'); // blush
  block(5, 2.5, 2, 1, 'b');
  return {
    rows: grid.map((r) => r.join('')),
    pal: {
      k: C.ink,
      w: snes('#f8f8f8'),
      c: snes('#e0d8c8'),
      e: snes('#d8d0c0'),
      g: snes('#f8f8f8'),
      n: snes('#686880'),
      p: snes('#f87898'),
      b: snes('#f8c0c8'),
    },
  };
}

/** keyboard keycap with a letter, 11x11 */
export function drawKey(g: G, x: number, y: number, label: string): number {
  const w = label.length > 1 ? label.length * 8 + 3 : 11;
  rrect(g, x, y, w, 11, 1, C.winEdge);
  rect(g, x + 1, y + 1, w - 2, 9, snes('#d8d8e8'));
  rect(g, x + 1, y + 8, w - 2, 2, snes('#8890a8'));
  rect(g, x + 1, y + 1, w - 2, 1, C.white);
  drawText(g, label, x + 2, y + 1, { color: C.ink, shadow: null });
  return w;
}
