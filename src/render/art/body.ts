// Shared skeleton helpers for the human sprites (kids, goalies, referee).
// Heads/torsos are hand-pixelled per direction; limbs and sticks are placed
// from points in BODY space and projected into each of the five authored
// directions, so one pose definition stays consistent all the way round.
//
// Body space (sprite pixels): f = forward (facing), l = the player's left,
// h = height above the ice. Screen: the facing direction rotates on the ice
// plane; ice depth is foreshortened (3/4 top-down view), height is not.

import type { Dir5 } from './frames';
import { line, put, stamp, type Grid } from './grid';

export interface V3 {
  f: number;
  l: number;
  h: number;
}

export const v = (f: number, l: number, h: number): V3 => ({ f, l, h });

const ANGLE: Record<Dir5, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180 };
/** how much ice depth shrinks on screen (camera looks down at ~50 deg; sprites read better flatter) */
const DEPTH = 0.4;

interface Basis {
  F: [number, number]; // screen vector of "forward"
  L: [number, number]; // screen vector of "player's left"
}

export function basis(dir: Dir5): Basis {
  const a = (ANGLE[dir] * Math.PI) / 180;
  const F: [number, number] = [Math.sin(a), -Math.cos(a)];
  // left of the facing, seen from above with y pointing down the screen
  const L: [number, number] = [F[1], -F[0]];
  return { F, L };
}

interface Proj {
  x: number;
  y: number;
  depth: number; // > 0 = nearer the camera than the body's center
}

/** Round symmetrically around the cell's center column so S/N views stay mirror-perfect. */
function rx(x: number, cx: number): number {
  return x < cx ? Math.ceil(x - 0.5) : Math.floor(x + 0.5);
}

export function project(b: Basis, p: V3, cx: number, groundY: number): Proj {
  const depth = p.f * b.F[1] + p.l * b.L[1];
  const x = cx + p.f * b.F[0] + p.l * b.L[0];
  const y = groundY - p.h + depth * DEPTH;
  return { x: rx(x, cx), y: Math.round(y), depth };
}

/**
 * Thick line (limb). `col(t, k)` picks the char for position t (0..1 along
 * the limb) and strand k (0 = top/left strand).
 */
export function limb(
  g: Grid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  col: (t: number, k: number) => string,
  under = false,
): void {
  const steep = Math.abs(y1 - y0) >= Math.abs(x1 - x0);
  const lo = -Math.floor((width - 1) / 2);
  for (let k = 0; k < width; k++) {
    const o = lo + k;
    const dx = steep ? o : 0;
    const dy = steep ? 0 : o;
    line(g, x0 + dx, y0 + dy, x1 + dx, y1 + dy, (i, n) => col(n ? i / n : 0, k), under);
  }
}

/** Hockey stick: two-tone shaft grip -> heel, taped blade from the heel toward `toe` (screen vector). */
export function hockeyStick(
  g: Grid,
  gx: number,
  gy: number,
  hx: number,
  hy: number,
  toe: [number, number],
  bladeLen = 4,
  under = false,
): void {
  const steep = Math.abs(hy - gy) > Math.abs(hx - gx);
  line(g, gx + (steep ? 1 : 0), gy + (steep ? 0 : 1), hx + (steep ? 1 : 0), hy + (steep ? 0 : 1), 'Y', under);
  line(g, gx, gy, hx, hy, 'y', under);
  // blade: normalize the toe vector so the blade always reads as ~bladeLen px
  let [tx, ty] = toe;
  const L = Math.hypot(tx, ty) || 1;
  tx = (tx / L) * (bladeLen - 1);
  ty = (ty / L) * (bladeLen - 1);
  line(g, hx, hy, Math.round(hx + tx), Math.round(hy + ty), (i) => (i === 0 ? 'Y' : 'x'), under);
}

/** Stamp a part so that its `anchor` pixel lands on (x, y). */
export function stampAt(g: Grid, part: Grid, anchor: [number, number], x: number, y: number, map?: Record<string, string>, flip = false): void {
  const ax = flip ? part.w - 1 - anchor[0] : anchor[0];
  stamp(g, part, x - ax, y - anchor[1], { map, flip });
}

export { put };
