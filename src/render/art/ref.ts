// The referee: the kid rig as a grown-up (longer legs), black helmet without
// a cage, black-and-white striped shirt, orange armbands, black pants and
// socks, no stick. Uses the neutral palette (team null).

import { v } from './body';
import type { KindArt } from './frames';
import { DIR5, type Dir5 } from './frames';
import { grid, recolor, type Grid } from './grid';
import { animFrom, KID_LOOK, KID_POSES, type KidPose, type Look } from './kid';

// Kid heads with the cage removed (bars become skin).
const NO_CAGE = { m: 'f', M: 'F' };
const HEAD = Object.fromEntries(DIR5.map((d) => [d, recolor(KID_LOOK.head[d], NO_CAGE)])) as Record<Dir5, Grid>;

/** Vertical referee stripes over the jersey shape (light/shade kept for form). */
function stripes(t: Grid): Grid {
  const o = grid(t.w, t.h);
  for (let y = 0; y < t.h; y++) {
    for (let x = 0; x < t.w; x++) {
      const c = t.d[y * t.w + x];
      if (c === '.') continue;
      const shade = c === 'j' || c === 'T';
      o.d[y * t.w + x] = x % 3 === 1 ? 'z' : shade ? 'V' : 'v';
    }
  }
  return o;
}

const REF_LOOK: Look = {
  head: HEAD,
  torso: KID_LOOK.torso,
  legLen: 1,
  torsoFx: stripes,
  // white sleeves with the orange armband just below the shoulder
  armCol: (t, k) => (t > 0.15 && t < 0.42 ? (k ? 'N' : 'n') : k ? 'z' : 'v'),
};

const HANDS_DOWN: KidPose = { handL: v(1, 6, 9), handR: v(1, -6, 9) };

export function buildRefArt(): KindArt {
  const skate: KidPose[] = KID_POSES.skate.map((p, i) => ({
    ankleL: p.ankleL,
    ankleR: p.ankleR,
    bob: p.bob,
    lean: 1,
    // arms swing opposite to the legs
    handL: v(i === 0 ? -2 : i === 2 ? 3 : 0.5, 6, 9),
    handR: v(i === 0 ? 3 : i === 2 ? -2 : 0.5, -6, 9),
  }));
  return {
    w: 32,
    h: 32,
    defaultAnim: 'refSkate',
    fallback: {
      skate: 'refSkate',
      celebrate: 'refPoint',
      gSkate: 'refSkate',
      faceoff: 'idle',
      fallen: 'idle',
      bark: 'refWhistle',
    },
    anims: {
      idle: animFrom(REF_LOOK, 2, true, [HANDS_DOWN, { ...HANDS_DOWN, bob: 1 }]),
      refSkate: animFrom(REF_LOOK, 8, true, skate),
      // whistle up to the mouth, other arm raised to signal
      refWhistle: animFrom(REF_LOOK, 6, false, [
        { handR: v(3, -1, 19), handL: v(1, 6, 9) },
        { handR: v(3, -1, 20), handL: v(0, 6, 24) },
      ]),
      // arm straight out toward the penalty box / the spot
      refPoint: animFrom(REF_LOOK, 1, false, [{ handR: v(2, -11, 17), handL: v(1, 6, 9) }]),
    },
  };
}
