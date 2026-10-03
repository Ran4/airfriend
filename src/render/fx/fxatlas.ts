// Tiny pixel-art atlas for effect bits the sprite library doesn't provide:
// streak dots, ice chips, dizzy stars, the "!" startle mark, puff rings and a
// solid texel for flashes. Drawn from character grids, Nearest-filtered.

import * as THREE from 'three';
import type { SpriteFrame } from '../art';

type FxName =
  | 'dot1' // 1x1 white
  | 'dot2' // 2x2 white
  | 'chip' // 2x2 ice chip (white + pale blue)
  | 'chipS' // 1x1 pale blue
  | 'streak0' // 2x2 fast-puck streak, fresh
  | 'streak1' // 2x1 streak, fading
  | 'streak2' // 1x1 streak, nearly gone
  | 'dizzy' // 5x5 yellow star
  | 'dizzyS' // 3x3 twinkle
  | 'bang' // "!" startle mark
  | 'puff0' // ring puffs, small -> big
  | 'puff1'
  | 'puff2'
  | 'spark' // 7x7 impact burst (hits, posts, glove saves)
  | 'confetti' // 2x1 white (tinted per team)
  | 'solid'; // 1x1 white, stretched for flashes

const PAL: Record<string, string> = {
  W: '#f8f8f8',
  B: '#a8d8f8', // pale ice blue
  b: '#5890d0',
  Y: '#f8e030',
  O: '#e88820',
  R: '#e82828',
  K: '#181820',
  G: '#98b0d8', // cool gray-blue (puffs read on white ice)
  D: '#384058', // streak core (near the puck's own black)
  M: '#7888a8', // streak mid
  L: '#a8b8d8', // streak tail
};

// grids are drawn top row first; '.' = transparent
const ART: Record<FxName, string[]> = {
  dot1: ['W'],
  dot2: ['WW', 'WW'],
  chip: ['WB', 'Bb'],
  chipS: ['b'],
  // a dark smear behind the black puck: white ice needs dark motion trails
  streak0: ['DD', 'DM'],
  streak1: ['MM'],
  streak2: ['L'],
  dizzy: ['..Y..', '.YYY.', 'YYOYY', '.YYY.', '.Y.Y.'],
  dizzyS: ['.Y.', 'YWY', '.Y.'],
  bang: ['KKK', 'KRK', 'KRK', 'KRK', 'KRK', 'KKK', 'KRK', 'KKK'],
  puff0: ['.G.', 'G.G', '.G.'],
  puff1: ['.GGG.', 'G...G', 'G...G', 'G...G', '.GGG.'],
  puff2: ['..G.G..', '.......', 'G.....G', '.......', 'G.....G', '.......', '..G.G..'],
  // impact burst: yellow spikes so it reads on white ice
  spark: ['...Y...', '.Y.W.Y.', '..WOW..', 'YWOWOWY', '..WOW..', '.Y.W.Y.', '...Y...'],
  confetti: ['WW'],
  solid: ['W'],
};

let atlas: Record<FxName, SpriteFrame> | null = null;

/** Built lazily on first use (needs a DOM canvas). */
export function fxFrame(name: FxName): SpriteFrame {
  if (!atlas) atlas = build();
  return atlas[name];
}

function build(): Record<FxName, SpriteFrame> {
  const names = Object.keys(ART) as FxName[];
  // one row strip with a 1 px gutter so Nearest sampling never bleeds
  let W = 1;
  let H = 1;
  for (const n of names) {
    W += ART[n][0].length + 1;
    H = Math.max(H, ART[n].length + 2);
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const place: Record<string, { x: number; w: number; h: number }> = {};
  let x = 1;
  for (const n of names) {
    const rows = ART[n];
    const w = rows[0].length;
    rows.forEach((row, j) => {
      for (let i = 0; i < w; i++) {
        const col = PAL[row[i]];
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(x + i, 1 + j, 1, 1);
      }
    });
    place[n] = { x, w, h: rows.length };
    x += w + 1;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const out = {} as Record<FxName, SpriteFrame>;
  for (const n of names) {
    const p = place[n];
    out[n] = {
      texture: tex,
      u0: p.x / W,
      u1: (p.x + p.w) / W,
      // flipY canvas texture: v = 0 is the canvas bottom
      v0: 1 - (1 + p.h) / H,
      v1: 1 - 1 / H,
      flipX: false,
      w: p.w,
      h: p.h,
      ax: p.w / 2,
      ay: p.h / 2,
    };
  }
  return out;
}
