// Tiny pixel-grid toolkit used to author and compose sprite frames.
// A Grid holds one palette char per pixel ('.' = transparent). Frames are
// built by stamping hand-pixelled parts (string grids) and drawing a few
// lines (sticks, arms), then a selective outline pass wraps the silhouette.

import { EMPTY } from './palette';

export interface Grid {
  w: number;
  h: number;
  d: string[]; // row-major, d[y * w + x]
}

export function grid(w: number, h: number): Grid {
  return { w, h, d: new Array(w * h).fill(EMPTY) };
}

/** Parse rows of chars. Spaces count as transparent; short rows are padded. */
export function parse(rows: string[]): Grid {
  const w = Math.max(...rows.map((r) => r.length));
  const g = grid(w, rows.length);
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      const c = r[x];
      if (c !== ' ' && c !== EMPTY) g.d[y * w + x] = c;
    }
  });
  return g;
}

export function clone(g: Grid): Grid {
  return { w: g.w, h: g.h, d: g.d.slice() };
}

function get(g: Grid, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return EMPTY;
  return g.d[y * g.w + x];
}

export function put(g: Grid, x: number, y: number, c: string): void {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= g.w || y >= g.h || c === EMPTY || c === ' ') return;
  g.d[y * g.w + x] = c;
}

export function flipped(g: Grid): Grid {
  const o = grid(g.w, g.h);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) o.d[y * g.w + x] = g.d[y * g.w + (g.w - 1 - x)];
  return o;
}

interface StampOpts {
  flip?: boolean; // mirror the part horizontally
  under?: boolean; // only fill pixels that are still transparent (draw "behind")
  map?: Record<string, string>; // recolor chars while stamping
}

/** Copy `src` onto `dst` with its top-left at (ox, oy). */
export function stamp(dst: Grid, src: Grid, ox: number, oy: number, o: StampOpts = {}): void {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      let c = src.d[y * src.w + (o.flip ? src.w - 1 - x : x)];
      if (c === EMPTY) continue;
      if (o.map && o.map[c]) c = o.map[c];
      const dx = ox + x;
      const dy = oy + y;
      if (o.under && get(dst, dx, dy) !== EMPTY) continue;
      put(dst, dx, dy, c);
    }
  }
}

/** Bresenham line. `c` may be a function of the step index (for two-tone sticks, armbands...). */
export function line(
  g: Grid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: string | ((i: number, n: number) => string),
  under = false,
): void {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  const n = Math.max(dx, -dy);
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (let i = 0; ; i++) {
    const ch = typeof c === 'string' ? c : c(i, n);
    if (!under || get(g, x, y) === EMPTY) put(g, x, y, ch);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

// ------------------------------------------------------------- outlining ----

/**
 * Outline class per material: [lit-side outline, shadow-side outline], or null
 * for materials that carry their own edge (sticks, already-dark parts).
 * Light comes from the top-left, so edges facing up/left get the softer color.
 */
type OutlineRule = (c: string) => [string, string] | null;

const FUR = new Set(['W', 'w', 'c', 'C']);
const NO_OUTLINE = new Set(['y', 'Y', 'x', 'X', 'O', 'o', 'k', 'q', '4', '5', '6', '9', '0']);

export const defaultOutline: OutlineRule = (c) => {
  if (FUR.has(c)) return ['O', 'o'];
  if (NO_OUTLINE.has(c)) return null;
  return ['q', 'k'];
};

/**
 * Wrap the silhouette in a 1 px, 4-connected outline (diagonal corners stay
 * open, which keeps round shapes round - classic hand-pixelled look).
 * `litLeft` false keeps the softer lit color for top edges only: left edges
 * get the dark shadow-side color too (PAL, whose white fur needs a firm edge).
 */
export function outline(g: Grid, rule: OutlineRule = defaultOutline, litLeft = true): void {
  const src = g.d.slice();
  const at = (x: number, y: number): string => (x < 0 || y < 0 || x >= g.w || y >= g.h ? EMPTY : src[y * g.w + x]);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (src[y * g.w + x] !== EMPTY) continue;
      const down = at(x, y + 1);
      const up = at(x, y - 1);
      const right = at(x + 1, y);
      const left = at(x - 1, y);
      const rDown = down !== EMPTY ? rule(down) : null;
      const rUp = up !== EMPTY ? rule(up) : null;
      const rRight = right !== EMPTY ? rule(right) : null;
      const rLeft = left !== EMPTY ? rule(left) : null;
      let pick: [string, string] | null = null;
      let lit = false;
      if (rDown && !rUp) {
        pick = rDown;
        lit = true;
      } else if (rUp && !rDown) {
        pick = rUp;
      } else if (rRight && !rLeft) {
        pick = rRight;
        lit = litLeft;
      } else {
        pick = rLeft ?? rDown ?? rUp ?? rRight;
      }
      if (pick) g.d[y * g.w + x] = lit ? pick[0] : pick[1];
    }
  }
}

/** Rotate 90 degrees clockwise (used for pads lying flat, sideways bodies). */
export function rotCW(g: Grid): Grid {
  const o = grid(g.h, g.w);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) o.d[x * o.w + (g.h - 1 - y)] = g.d[y * g.w + x];
  return o;
}

/** Rotate 90 degrees counter-clockwise. */
export function rotCCW(g: Grid): Grid {
  const o = grid(g.h, g.w);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) o.d[(g.w - 1 - x) * o.w + y] = g.d[y * g.w + x];
  return o;
}

/** Replace chars throughout a grid. */
export function recolor(g: Grid, map: Record<string, string>): Grid {
  return { w: g.w, h: g.h, d: g.d.map((c) => map[c] ?? c) };
}
