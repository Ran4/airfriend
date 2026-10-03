// One shared character -> color table for every sprite. Sprites are authored
// as string grids where each char is a palette slot, so a team recolor is just
// a different table (the classic SNES palette swap). Pure data + color math:
// no DOM, so node tools can render sprites too.

import type { TeamColors } from '../../config';

export const EMPTY = '.';

/** Palette: char -> CSS hex (#rrggbb or #rrggbbaa). */
export type Palette = Record<string, string>;

// Light comes from the top-left. Shadows lean toward a cool purple instead of
// black, highlights toward a warm white: that hue shift is what makes 16-bit
// sprites look painted rather than just darkened.
const SHADOW = '#1c1040';
const LIGHT = '#fff8e8';

const BASE: Palette = {
  // --- PAL's fur: warm off-white with cream shading so it pops on cool ice.
  W: '#ffffff', // highlight
  w: '#f6f0e0', // base fur
  c: '#e0cca8', // cream shade
  C: '#b4a090', // deep shade (between curls, under the belly)
  O: '#7880a8', // fur outline, lit side (top edges only)
  o: '#283058', // fur outline: sides, ears, underside (near the kids' navy)
  // --- generic outlines + black details
  k: '#141420', // outline / eyes / nose
  q: '#3c3858', // lit-side outline for dark materials
  // --- mouth
  r: '#f87898', // tongue
  R: '#a02848', // open mouth
  // --- kid skin + hair
  f: '#f8c898',
  F: '#d08c60',
  u: '#8c4c20', // hair
  U: '#5c2c10',
  // --- skates
  b: '#28283c', // boot
  B: '#646884', // boot highlight
  e: '#e0e8f8', // blade steel
  E: '#8890b0',
  // --- stick
  y: '#e0a858', // shaft
  Y: '#a06828', // shaft shade
  x: '#28283c', // black blade tape
  X: '#f8f8f8', // white tape
  // --- helmet cage
  m: '#c0c8d8',
  M: '#6c7490',
  // --- goalie pads / mask (white leather)
  a: '#f8f8f8',
  A: '#b8c0d8',
  // --- referee
  v: '#f8f8f8', // shirt white
  V: '#c0c8e0',
  z: '#181820', // stripe black
  n: '#f88820', // orange armband
  N: '#b85010',
  l: '#202030', // ref pants
  L: '#505870',
  // --- misc
  '1': '#f8e040', // marker yellow
  '2': '#e09010', // marker gold shade
  '3': '#ffffff',
  '4': '#ffffff', // spray
  '5': '#c0dcf8',
  '6': '#7c9cd0',
  '7': '#000818', // puck (near-black: the darkest value on the ice)
  '8': '#405070', // puck rim glint
  '9': '#08103080', // shadow (translucent)
  '0': '#08103094', // puck shadow (translucent, ~58%: darker than the blobs)
};

// Team slots (filled per team at atlas-build time):
//   J jersey  j jersey dark  K jersey light   t trim  T trim shade
//   p pants   P pants light   Q pants shade   h helmet  H helmet shade  i helmet light
//   s socks   S socks shade   g glove  G glove shade

// --------------------------------------------------------------- color math --
function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hex(rgb: number[]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** Linear mix of two colors, f = 0 -> a, f = 1 -> b. */
function mix(a: string, b: string, f: number): string {
  const A = parse(a);
  const B = parse(b);
  return hex(A.map((v, i) => v + (B[i] - v) * f));
}

function shade(c: string, f: number): string {
  return mix(c, SHADOW, f);
}

function light(c: string, f: number): string {
  return mix(c, LIGHT, f);
}

/** Relative luminance 0..1, used to pick shading strength for very light colors. */
function luma(c: string): number {
  const [r, g, b] = parse(c);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** The full palette for one team. `null` = neutral (the referee). */
export function teamPalette(colors: TeamColors | null): Palette {
  const t: TeamColors = colors ?? {
    jersey: '#f8f8f8',
    jerseyDark: '#c0c8e0',
    trim: '#181820',
    pants: '#202030',
    helmet: '#202030',
    socks: '#202030',
  };
  // White helmets (BLIZZARD) need a stronger relative shade to read at all.
  const hs = luma(t.helmet) > 0.85 ? 0.3 : 0.38;
  return {
    ...BASE,
    J: t.jersey,
    j: t.jerseyDark,
    K: light(t.jersey, 0.32),
    t: t.trim,
    T: luma(t.trim) > 0.85 ? '#b8c0d8' : shade(t.trim, 0.3),
    p: t.pants,
    P: light(t.pants, 0.22),
    Q: shade(t.pants, 0.45),
    h: t.helmet,
    H: shade(t.helmet, hs),
    i: light(t.helmet, 0.5),
    s: t.socks,
    S: shade(t.socks, 0.35),
    g: light(t.pants, 0.3),
    G: t.pants,
  };
}

/** #rrggbb(aa) -> [r, g, b, a] bytes. */
export function rgba(c: string): [number, number, number, number] {
  const h = c.replace('#', '');
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}
