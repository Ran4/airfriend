// Dasher boards (white, yellow kick plate, pixel-art sponsor panels), the top
// rail, and faint glass with stanchions, all following the rink outline.
import * as THREE from 'three';
import { RINK } from '../../config';
import { splitSides } from './blocks';
import { bandGeometry, ringPath, wallGeometry } from './geom';
import { Pix, rgba } from './pixels';
import { textWidth } from './font';

/**
 * Board texture density. The far boards are seen ~40 deg from above, so the
 * 1.07 m wall covers only ~10 screen rows; 12 texel rows keep the 7-row
 * lettering at ~1 texel per pixel there (a denser texture would squash it).
 */
const BOARD_PX = 12;
const BPPM = BOARD_PX / RINK.boardHeight;
/** the top rail: one clean bright line that outlines the whole bowl */
const RAIL_WHITE = '#f8f8f8';

interface Ad {
  text: string;
  bg: string;
  fg: string;
  shade: string; // text drop shadow + panel border
  icon?: 'bone' | 'crown' | 'paw' | 'bottle' | 'note' | 'flake' | 'star';
}

const ADS: Ad[] = [
  { text: 'KIBBLE KING', bg: '#d82020', fg: '#f8d800', shade: '#801010', icon: 'crown' },
  { text: 'WOOF MART', bg: '#2050c8', fg: '#f8f8f8', shade: '#102068', icon: 'paw' },
  { text: 'BONE ZONE', bg: '#202028', fg: '#f8f8f8', shade: '#585868', icon: 'bone' },
  { text: 'PUP SODA', bg: '#f87800', fg: '#f8f8f8', shade: '#a04000', icon: 'bottle' },
  { text: 'SNOW CONE', bg: '#f8f8f8', fg: '#2878f8', shade: '#a8c8f8', icon: 'flake' },
  { text: 'FETCH FM', bg: '#f8d800', fg: '#202028', shade: '#b89000', icon: 'note' },
  { text: 'AIR FRIEND', bg: '#188840', fg: '#f8f8f8', shade: '#085020', icon: 'star' },
  { text: 'GO PUPS!', bg: '#f8f8f8', fg: '#d82020', shade: '#f8a8a8', icon: 'paw' },
];

// 5-px-tall icons, '#' = fg, 'o' = shade
const ICONS: Record<NonNullable<Ad['icon']>, string[]> = {
  bone: ['##...##', '.#####.', '.#####.', '##...##', '.......'],
  crown: ['#.#.#', '#####', '#####', '#o#o#', '#####'],
  paw: ['#.#.#', '.....', '.###.', '#####', '.###.'],
  bottle: ['.#.', '.#.', '###', '#o#', '###'],
  note: ['..##', '..#.', '..#.', '###.', '##..'],
  flake: ['#.#.#', '.###.', '##.##', '.###.', '#.#.#'],
  star: ['..#..', '#####', '.###.', '.#.#.', '#...#'],
};

/** Where things sit along ringPath(0), in meters of s. */
interface Slot {
  s0: number;
  s1: number;
  ad: number;
  /**
   * Lettered panels go only where the camera sees the boards face-on: the far
   * end and the corners. The long sides are seen edge-on, where the 9-row band
   * collapses to 2-3 screen rows and nearest sampling turns lettering into
   * sparkle, so side panels are plain sponsor-color blocks.
   */
  lettered: boolean;
}

function boardLayout(): { total: number; slots: Slot[]; doors: number[]; faceOn: Array<[number, number]> } {
  const pts = ringPath(0);
  const total = pts[pts.length - 1].s;
  const side = RINK.halfLength - RINK.cornerRadius; // 22: straight half-length of the long sides
  const end = RINK.halfWidth - RINK.cornerRadius; // 4.5
  const arc = (Math.PI / 2) * RINK.cornerRadius;
  // segment starts (s) — see ringPath: +x side from z=0 runs toward +z
  const S = {
    xp0: 0,
    ne: side,
    zp: side + arc,
    nw: side + arc + end * 2,
    xn: side + arc * 2 + end * 2,
    sw: side * 3 + arc * 2 + end * 2,
    zn: side * 3 + arc * 3 + end * 2,
    se: side * 3 + arc * 3 + end * 4,
    xp1: side * 3 + arc * 4 + end * 4,
  };
  const slots: Slot[] = [];
  let k = 0;
  const run = (s0: number, s1: number, n: number, lettered: boolean, gap = 0.5) => {
    const w = (s1 - s0 - gap * (n + 1)) / n;
    for (let i = 0; i < n; i++) {
      const a = s0 + gap + i * (w + gap);
      slots.push({ s0: a, s1: a + w, ad: k++ % ADS.length, lettered });
    }
  };
  // +x side (penalty boxes in the middle, |z| < 6.3)
  run(S.xp0 + 6.3, S.ne, 3, false);
  run(S.ne, S.zp, 2, true);
  run(S.zp, S.nw, 1, true, 1.2); // far end, behind the net: the premium panel
  run(S.nw, S.xn, 2, true);
  // -x side: benches at 2.5 < |z| < 12.5
  const zToS = (z: number) => S.xn + (side - z);
  run(S.xn, zToS(12.6), 2, false);
  run(zToS(2.4), zToS(-2.4), 1, false);
  run(zToS(-12.6), S.sw, 2, false);
  run(S.sw, S.zn, 2, true);
  run(S.zn, S.se, 1, true, 1.2);
  run(S.se, S.xp1, 2, true);
  run(S.xp1, total - 6.3, 3, false);
  // gates: bench doors and penalty box doors
  const doors = [zToS(12.3), zToS(2.7), zToS(-2.7), zToS(-12.3), 2.2, 5.8, total - 2.2, total - 5.8];
  // the stretches seen face-on: both ends with their corners
  const faceOn: Array<[number, number]> = [[S.ne, S.xn], [S.sw, S.xp1]];
  return { total, slots, doors, faceOn };
}

function buildBoardTexture(): { tex: THREE.CanvasTexture; total: number } {
  const lay = boardLayout();
  const W = Math.ceil(lay.total * BPPM);
  const p = new Pix(W, BOARD_PX, rgba('#f0f0f0'));
  // canvas row 0 = top of the boards: white rail lip (continuing the cap),
  // 9-row panel band, kick plate
  p.rect(0, 0, W, 1, rgba(RAIL_WHITE));
  p.rect(0, 10, W, 1, rgba('#f8c000'));
  p.rect(0, 11, W, 1, rgba('#c08800'));
  // puck marks on the kick plate and boards, only where the boards are seen
  // face-on: single texels on the edge-on sides just flicker in and out
  const faceOn = (x: number) => lay.faceOn.some(([a, b]) => x >= a * BPPM && x < b * BPPM);
  for (let x = 3; x < W; x += 7 + ((x * 37) % 23)) {
    if (!faceOn(x)) continue;
    p.set(x, 10 + (x % 2), rgba('#383838'));
    if (x % 3 === 0) p.set(x + 1, 6 + (x % 3), rgba('#c8c8d0'));
  }

  for (const slot of lay.slots) {
    const ad = ADS[slot.ad];
    const x0 = Math.round(slot.s0 * BPPM);
    const x1 = Math.round(slot.s1 * BPPM);
    const bg = rgba(ad.bg);
    const fg = rgba(ad.fg);
    const sh = rgba(ad.shade);
    if (!slot.lettered) {
      // edge-on side panel: a solid sponsor block with 1 px light pinstripes
      // top and bottom, and nothing narrower than the panel itself
      const { fill, edge } = sideColors(ad);
      p.rect(x0, 1, x1 - x0, 9, rgba(fill));
      p.rect(x0, 1, x1 - x0, 1, rgba(edge));
      p.rect(x0, 9, x1 - x0, 1, rgba(edge));
      continue;
    }
    p.rect(x0, 1, x1 - x0, 9, bg);
    p.rect(x0, 1, 1, 9, sh);
    p.rect(x1 - 1, 1, 1, 9, sh);
    const icon = ad.icon ? ICONS[ad.icon] : null;
    const iw = icon ? icon[0].length + 3 : 0;
    const tw = textWidth(ad.text) + iw;
    const tx = Math.round((x0 + x1) / 2 - tw / 2);
    if (icon) {
      icon.forEach((row, iy) =>
        [...row].forEach((ch, ix) => {
          if (ch === '#') p.set(tx + ix, 3 + iy, fg);
          else if (ch === 'o') p.set(tx + ix, 3 + iy, sh);
        }),
      );
      // the same icon after the text, so short names fill the panel symmetrically
      const ax = tx + tw + 2;
      icon.forEach((row, iy) =>
        [...row].forEach((ch, ix) => {
          if (ch === '#') p.set(ax + ix, 3 + iy, fg);
          else if (ch === 'o') p.set(ax + ix, 3 + iy, sh);
        }),
      );
    }
    p.text(ad.text, tx + iw, 2, fg, 1, { shadow: sh });
  }
  for (const s of lay.doors) {
    const x = Math.round(s * BPPM);
    p.rect(x, 1, 1, 9, rgba('#9098a8'));
    p.set(x + 2, 5, rgba('#606878')); // latch
  }
  return { tex: p.texture(), total: lay.total };
}

/**
 * Colors of an unlettered side panel: its sponsor color with light-tint
 * pinstripes. A white panel would vanish into the white boards, so it shows
 * its (light) shade color with white pinstripes instead.
 */
function sideColors(ad: Ad): { fill: string; edge: string } {
  const bg = new THREE.Color(ad.bg);
  if (bg.r + bg.g + bg.b > 2.4) return { fill: ad.shade, edge: ad.bg };
  return { fill: ad.bg, edge: `#${bg.lerp(new THREE.Color('#f8f8f8'), 0.55).getHexString()}` };
}

/** 2 m glass panel: almost clear, bright stanchion, a top edge and a glare streak */
function buildGlassTexture(): THREE.CanvasTexture {
  const w = 32;
  const h = 21;
  const p = new Pix(w, h, rgba('#c8e0f8', 22));
  p.rect(0, 0, w, 1, rgba('#e8f4ff', 150));
  p.rect(0, 0, 2, h, rgba('#d0d8e8', 210)); // stanchion
  p.rect(2, 0, 1, h, rgba('#8890a8', 120));
  for (let y = 2; y < h - 2; y++) {
    p.set(18 + Math.floor(y / 2), y, rgba('#f8fcff', 64));
    p.set(19 + Math.floor(y / 2), y, rgba('#f8fcff', 64));
  }
  return p.texture({ repeat: true });
}

export function buildBoards(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'boards';
  const { tex, total } = buildBoardTexture();
  const inner = new THREE.Mesh(
    wallGeometry(0, 0, RINK.boardHeight, 1 / total),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
  );
  // top rail cap: a light ledge that outlines the whole bowl from above
  const cap = new THREE.Mesh(
    bandGeometry(0, RINK.boardHeight, 0.2, RINK.boardHeight, 1),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(RAIL_WHITE), side: THREE.DoubleSide }),
  );
  const outer = new THREE.Mesh(
    wallGeometry(0.2, 0, RINK.boardHeight, 1),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#9098b0'), side: THREE.DoubleSide }),
  );
  const glassTex = buildGlassTexture();
  // back faces, then front faces, as three would split it itself (see splitSides)
  const glass = splitSides(
    wallGeometry(0.1, RINK.boardHeight, RINK.glassHeight, 1 / 2),
    new THREE.MeshBasicMaterial({ map: glassTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  for (const m of glass.children) m.renderOrder = 2;
  // the glass's top edge: a thin rail that makes the (nearly invisible) glass
  // read as a structure and gives the goal lamps something to sit on
  const rail = new THREE.Mesh(
    bandGeometry(0.04, RINK.glassHeight, 0.16, RINK.glassHeight, 1),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#a8b4c8'), side: THREE.DoubleSide }),
  );
  g.add(inner, cap, outer, glass, rail);
  return g;
}
