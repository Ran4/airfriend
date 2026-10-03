// Tiny pixel fonts for jersey numbers and the dog's K9. Kept separate from
// the jersey art so the text can be re-stamped un-mirrored on frames that
// are mirrored (NW = flipped NE would otherwise read backwards).

import { flipped, parse, stamp, type Grid } from './grid';

// 3x5 digits in trim color
const D5: Record<string, string[]> = {
  '0': ['ttt', 't.t', 't.t', 't.t', 'ttt'],
  '1': ['.t.', 'tt.', '.t.', '.t.', 'ttt'],
  '2': ['ttt', '..t', 'ttt', 't..', 'ttt'],
  '3': ['ttt', '..t', '.tt', '..t', 'ttt'],
  '4': ['t.t', 't.t', 'ttt', '..t', '..t'],
  '5': ['ttt', 't..', 'ttt', '..t', 'ttt'],
  '6': ['ttt', 't..', 'ttt', 't.t', 'ttt'],
  '7': ['ttt', '..t', '.t.', '.t.', '.t.'],
  '8': ['ttt', 't.t', 'ttt', 't.t', 'ttt'],
  '9': ['ttt', 't.t', 'ttt', '..t', 'ttt'],
};
// 3x4 glyphs for the dog's tiny jersey
const D4: Record<string, string[]> = {
  K: ['t.t', 'tt.', 't.t', 't.t'],
  '9': ['ttt', 't.t', 'ttt', '..t'],
};

export interface Decal {
  text: string;
  x: number; // relative to the part it sits on
  y: number;
  small?: boolean; // 3x4 font
}

/**
 * Stamp `d` onto `g` at (ox + d.x, oy + d.y). With `mirrorSrc` the glyphs are
 * pre-mirrored (each flipped, order reversed) so that flipping the whole frame
 * afterwards makes the text read correctly.
 */
export function stampDecal(g: Grid, d: Decal, ox: number, oy: number, mirrorSrc = false, color?: string): void {
  const font = d.small ? D4 : D5;
  const chars = [...d.text];
  const glyphs = chars.map((c) => parse(font[c] ?? font['0'] ?? ['t']));
  const order = mirrorSrc ? glyphs.slice().reverse() : glyphs;
  let x = ox + d.x;
  for (const gl of order) {
    stamp(g, mirrorSrc ? flipped(gl) : gl, x, oy + d.y, color ? { map: { t: color } } : {});
    x += gl.w + 1;
  }
}
