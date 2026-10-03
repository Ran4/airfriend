// Frame-set description shared by the sprite modules and the atlas builder.
// Each character module (dog, kid, goalie, ref) produces a KindArt: for every
// animation, a list of frames per authored direction. Pure data, no DOM.

import type { Grid } from './grid';
import type { SpriteAnim } from './index';

/** The five authored directions; W, SW, NW are mirrors of E, SE, NE. */
export type Dir5 = 'N' | 'NE' | 'E' | 'SE' | 'S';
export const DIR5: Dir5[] = ['N', 'NE', 'E', 'SE', 'S'];

/**
 * Optional explicitly authored NW (used instead of mirroring NE) for frames
 * with text on them - jersey numbers must not read backwards.
 */
export type DirKey = Dir5 | 'NW';
export const DIR_KEYS: DirKey[] = [...DIR5, 'NW'];

export interface ArtFrame {
  g: Grid; // full cell (w x h of the KindArt)
  /** ice contact point, pixels from the cell's bottom-left */
  ax: number;
  ay: number;
}

export interface AnimDef {
  fps: number;
  loop: boolean;
  /** frames per authored direction; missing directions fall back to the nearest authored one */
  dirs: Partial<Record<DirKey, ArtFrame[]>>;
  /**
   * Screen-space anims (goalie dives) ignore the facing for mirroring: the
   * frame is always drawn as authored (dive left) and `mirror` flips it.
   */
  screenSpace?: boolean;
}

export interface KindArt {
  w: number;
  h: number;
  anims: Partial<Record<SpriteAnim, AnimDef>>;
  /** anims this kind lacks map to one it has (e.g. a kid asked to 'bark' idles) */
  fallback: Partial<Record<SpriteAnim, SpriteAnim>>;
  /** the anim used when nothing else matches */
  defaultAnim: SpriteAnim;
}

/** Nearest authored direction, by angular distance (N=0 .. S=4 in 45 degree steps). */
export function nearestDir(want: Dir5, have: Dir5[]): Dir5 {
  const idx = DIR5.indexOf(want);
  let best = have[0];
  let bd = 99;
  for (const d of have) {
    const dd = Math.abs(DIR5.indexOf(d) - idx);
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return best;
}
