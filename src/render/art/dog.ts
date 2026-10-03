// PAL the bichon frise. Every frame is composed from hand-pixelled parts per
// direction (body with the tiny jersey, head normal/barking, tail plume,
// paws with skates) plus the stick held in the mouth, drawn as a two-tone
// shaft with a taped blade. A per-direction "rig" says where the parts sit
// and in which order they layer; poses nudge the parts (bob, lean, head
// bounce, leg cycle) so the same art animates in all five directions.

import type { AnimDef, ArtFrame, Dir5, KindArt } from './frames';
import { DIR5 } from './frames';
import { stampDecal, type Decal } from './glyphs';
import { defaultOutline, flipped, grid, line, outline, parse, put, stamp, type Grid } from './grid';

const CELL = 32;
const GROUND = 28; // row of the skate blades = the anchor row
const AY = CELL - 1 - GROUND; // anchor y from the bottom

// Fur ramp: W highlight, w base, c cream, C deep. Jersey: K light, J, j dark,
// t trim (stripe, K9). k = black (eyes/nose), R/r = mouth/tongue.
// The 1 px outline is added automatically: soft blue-gray on top, dark navy
// on the sides and underside so the fur keeps a crisp edge on the ice.

// ------------------------------------------------------------- E (profile)
const BODY_E = parse([
  '....KKKKKKK.....',
  '..wKKKKKKKKKJw..',
  '.wJKKKKKKKKJJjw.',
  'wWJJJJJJJJJJJjww',
  'wWttttttttttttcw',
  'wcjjjjjjjjjjjjcw',
  'wccjjjjjjjjjjjcc',
  '.cccccCcccccCcc.',
  '..cCc.cCc..cCc..',
  '...C...C....C...',
]);
const HEAD_E = parse([
  '...wwWWww....',
  '..wWWWWWWww..',
  '.wWWWWWWWwwc.',
  'wWWWWWWWwwwwc',
  'wWWwwCwWwwkwc',
  'wWwWwcCwwwkWwc',
  'wwwwwcCwwwwwwkk',
  '.wwwccCwwwwwckk',
  '.wcccCwwwwcRr..',
  '..wcCwwcwcr....',
  '...ccCcC.......',
]);
const HEAD_E_BARK = parse([
  '...wwWWww....',
  '..wWWWWWWww..',
  '.wWWWWWWWwwc.',
  'wWWWWWWWwwwwc',
  'wWWwwCwWwwkwcc',
  'wWwWwcCwwwkWwkk',
  'wwwwwcCwwwwcRkk',
  '.wwwccCwwwcRRR.',
  '.wcccCwwwcRrrR.',
  '..wcCwwcwRrr...',
  '...ccCcC.......',
]);
const TAIL_E = parse([
  '...wWWw...',
  '..wWWWWww.',
  '.wWWccwWwc',
  'wWWc..ccwc',
  'wWc....cc.',
]);
const PAW_E = parse(['wc.', 'cC.', 'bbb', 'eee']);
const PAW_E_FAR = parse(['cC.', 'CC.', 'bbb', 'EEE']);

// ---------------------------------------------------------- S (front view)
const BODY_S = parse([
  '..wwwwwwwwwwww..',
  '.wWWwwwwwwwwwwc.',
  'wWKKKwwwwwwKKKcw',
  'wJKKJwwwwwwJJjjw',
  'wJJJJwwwwwwJJjcw',
  'wJJJJJJJJJJJJjcw',
  'wttttttttttttttw',
  'wJJJJJJJJJJJJjjw',
  'cjjjjjjjjjjjjjjc',
  '.cjjjjjjjjjjjjc.',
  '..cCcc....cCcc..',
]);
const HEAD_S = parse([
  '...wwWWww...',
  '.wwWWWWWWww.',
  'wWWWWWWWWWwc',
  'wWWWWWWWWwwc',
  'cWWkkWwkkwwc',
  'CwWkkwwkkwwC',
  'CcwwwkkwwwcC',
  'CcwwwRRwwwcC',
  '.Ccwwrrwwcc.',
  '..cccwwccC..',
  '...CccccC...',
]);
const HEAD_S_BARK = parse([
  '...wwWWww...',
  '.wwWWWWWWww.',
  'wWWWWWWWWWwc',
  'wWWWWWWWWwwc',
  'cWWkkWwkkwwc',
  'CwWkkwwkkwwC',
  'CcwwwkkwwwcC',
  'CcwwRRRRwwcC',
  '.CcwRrrRwcc.',
  '..ccRrrRcC..',
  '...CcRRcC...',
]);
const TAIL_S = parse(['..wWw.', '.wWWWw', 'wWWccw', 'wWc..c']);
const LEG_S = parse(['wc', 'wc', 'cC', 'bb', 'eE']);
const LEG_FAR = parse(['cC', 'CC', 'bb', 'EE']);

// ----------------------------------------------------------- N (back view)
const BODY_N = parse([
  '...KKKKKKKK...',
  '..KKKKKKKKKKj.',
  '.wJKKKKKKKKJjw',
  'wWJJJJJJJJJJjw',
  'wWJJJJJJJJJJjw',
  'wwJJJJJJJJJJjc',
  'wcJJJJJJJJJJjc',
  'wcjjjjjjjjjjjc',
  'wcttttttttttcc',
  'wccccccccccccC',
  '.cCccccccccCC.',
  '..CC.cccc.CC..',
]);
const HEAD_N = parse([
  '...wwWWww...',
  '.wwWWWWWWww.',
  'wWWWWWWWWwwc',
  'wWWWWWWWwwwc',
  'wWWWWwwwwwwc',
  'cwWwwwwwwwcc',
  '.cwwwwwwwcc.',
  '..ccwwwwcc..',
  '....cccc....',
]);
const TAIL_N = parse([
  '..WWw..',
  '.WWWWw.',
  'wWWWwwc',
  'cwWwwcC',
  '.Ccwcc.',
  '..CCC..',
]);
const LEG_N = parse(['wc', 'cC', 'bb', 'eE']);
// drop ears hanging beside the head (back views)
const EAR_L = parse(['.wc', 'wwc', 'wcC', 'wcC', 'ccC', '.C.']);
const EAR_R = parse(['cw.', 'cww', 'Ccw', 'Ccw', 'Ccc', '.C.']);

// ------------------------------------------------- SE (front 3/4, right)
const BODY_SE = parse([
  '...wwKKKKKw....',
  '..wKKKKKKKKKw..',
  '.wJKKKKKKKKJJw.',
  'wWJJJJJJJJJJJjw',
  'wWtttttttttttcw',
  'wcJJJJJJJJJjjcw',
  'wcjjjjjjjjjjjcc',
  '.ccjjjjjjjjjjc.',
  '.cCcCjjjjjjCc..',
  '..cCccccCcCc...',
  '...C..C..C.....',
]);
const HEAD_SE = parse([
  '...wwWWww....',
  '.wwWWWWWWww..',
  'wWWWWWWWWWwc.',
  'wWWWWWWWWwwwc',
  'wWWcWkkWwkkwc',
  'wWcCwkkwwkkwc',
  'wwcCwwwwwwwkk',
  '.wcCwwwwwRRkk',
  '.wwcCwwwwrrc.',
  '..wccwwwcccC.',
  '...CcccccCC..',
]);
const HEAD_SE_BARK = parse([
  '...wwWWww....',
  '.wwWWWWWWww..',
  'wWWWWWWWWWwc.',
  'wWWWWWWWWwwwc',
  'wWWcWkkWwkkwc',
  'wWcCwkkwwkkwc',
  'wwcCwwwwwwwkk',
  '.wcCwwwwRRRkk',
  '.wwcCwwwRrrR.',
  '..wccwwwRrrC.',
  '...CcccccRC..',
]);

// -------------------------------------------------- NE (back 3/4, right)
const BODY_NE = parse([
  '.....KKKKKKK...',
  '...wKKKKKKKKKw.',
  '..wJKKKKKKKKJjw',
  '.wJJJJJJJJJJJjw',
  'wWJJJJJJJJJJjcw',
  'wWJJJJJJJJJJjcw',
  'wcJJJJJJJJJjjcw',
  'wcjjjjjjjjjjjcw',
  'wcttttttttttcw.',
  'cccccccccccccc.',
  '.cCcccccccccC..',
  '..CcC.cc.CcC...',
]);
const HEAD_NE = parse([
  '...wwWWw....',
  '.wwWWWWWWw..',
  'wWWWWWWWWwc.',
  'wWWWWWWWWwwc',
  'wWWWWWwwwwkc',
  'cwWwwwwwwwwk',
  'cwwwwwwwwwck',
  '.cwwwwwwwcc.',
  '..ccwwwwcc..',
  '....cccc....',
]);

// ------------------------------------------------------------------- rigs --

type StickPose = 'carry' | 'faceoff' | 'windup' | 'shoot' | 'pass' | 'poke' | 'none';

/** Blade heel: x relative to the mouth, y absolute (so the blade stays on the ice); d = blade direction. */
interface StickSpec {
  dx: number;
  y: number;
  d: 1 | -1;
  len?: number;
}

interface Leg {
  part: Grid;
  x: number;
  y: number; // top row of the part
  far: boolean; // drawn behind the body
}

interface Rig {
  fwd: [number, number]; // screen-space facing, for leans/lunges
  body: Grid;
  bodyAt: [number, number];
  head: Grid;
  headBark: Grid;
  headAt: [number, number];
  headBehind: boolean; // back views: the head is further away than the body
  tail: Grid;
  tailAt: [number, number];
  tailBehind: boolean; // front views: the plume peeks from behind
  legs: Leg[];
  /** skate cycle: per frame, per leg [dx, dy] */
  cycle: [number, number][][];
  mouth: [number, number]; // relative to the head's top-left
  sticks: Record<Exclude<StickPose, 'none'>, StickSpec>;
  stickBehind: boolean; // shaft hidden behind head/body (back view)
  butt: number; // px of shaft sticking out past the mouth
  decal?: Decal; // K9 on the back of the jersey
  ears?: [Grid, number, number][]; // extra ear lobes relative to the head
}

const RIGS: Record<Dir5, Rig> = {
  E: {
    fwd: [1, 0],
    body: BODY_E,
    bodyAt: [3, 15],
    head: HEAD_E,
    headBark: HEAD_E_BARK,
    headAt: [13, 7],
    headBehind: false,
    tail: TAIL_E,
    tailAt: [2, 11],
    tailBehind: false,
    legs: [
      { part: PAW_E, x: 15, y: GROUND - 3, far: false },
      { part: PAW_E_FAR, x: 17, y: GROUND - 3, far: true },
      { part: PAW_E, x: 5, y: GROUND - 3, far: false },
      { part: PAW_E_FAR, x: 7, y: GROUND - 3, far: true },
    ],
    cycle: [
      [[2, -1], [0, 0], [-2, 0], [0, 0]],
      [[0, 0], [1, 0], [0, 0], [-1, -1]],
      [[-1, 0], [2, -1], [1, 0], [-2, 0]],
      [[1, 0], [0, 0], [-1, -1], [1, 0]],
    ],
    mouth: [11, 8],
    sticks: {
      carry: { dx: 4, y: 27, d: 1 },
      faceoff: { dx: 3, y: 27, d: 1 },
      windup: { dx: -9, y: 24, d: -1 },
      shoot: { dx: 4, y: 21, d: 1, len: 3 },
      pass: { dx: 3, y: 26, d: 1 },
      poke: { dx: 4, y: 27, d: 1 },
    },
    stickBehind: false,
    butt: 0,
  },
  S: {
    fwd: [0, 1],
    body: BODY_S,
    bodyAt: [8, 14],
    head: HEAD_S,
    headBark: HEAD_S_BARK,
    headAt: [10, 9],
    headBehind: false,
    tail: TAIL_S,
    tailAt: [8, 7],
    tailBehind: true,
    legs: [
      { part: LEG_FAR, x: 9, y: 23, far: true },
      { part: LEG_FAR, x: 21, y: 23, far: true },
      { part: LEG_S, x: 12, y: GROUND - 3, far: false },
      { part: LEG_S, x: 18, y: GROUND - 3, far: false },
    ],
    cycle: [
      [[0, 0], [0, 0], [-1, -1], [0, 0]],
      [[0, -1], [0, 0], [0, 0], [0, 0]],
      [[0, 0], [0, 0], [0, 0], [1, -1]],
      [[0, 0], [0, -1], [0, 0], [0, 0]],
    ],
    mouth: [7, 8], // the corner of the mouth, so the face stays clear
    sticks: {
      carry: { dx: 5, y: 28, d: 1 },
      faceoff: { dx: 2, y: 28, d: 1 },
      windup: { dx: 7, y: 22, d: 1, len: 3 },
      shoot: { dx: -9, y: 25, d: -1, len: 3 },
      pass: { dx: -7, y: 28, d: -1 },
      poke: { dx: 2, y: 30, d: 1 },
    },
    stickBehind: false,
    butt: 0,
  },
  N: {
    fwd: [0, -1],
    body: BODY_N,
    decal: { text: 'K9', x: 3, y: 3, small: true },
    ears: [
      [EAR_L, -2, 3],
      [EAR_R, 11, 3],
    ],
    bodyAt: [9, 13],
    head: HEAD_N,
    headBark: HEAD_N,
    headAt: [10, 6],
    headBehind: false,
    tail: TAIL_N,
    tailAt: [13, 21],
    tailBehind: false,
    legs: [
      { part: LEG_FAR, x: 10, y: 21, far: true },
      { part: LEG_FAR, x: 20, y: 21, far: true },
      { part: LEG_N, x: 11, y: GROUND - 3, far: false },
      { part: LEG_N, x: 19, y: GROUND - 3, far: false },
    ],
    cycle: [
      [[0, 0], [0, 0], [-1, -1], [0, 0]],
      [[0, -1], [0, 0], [0, 0], [0, 0]],
      [[0, 0], [0, 0], [0, 0], [1, -1]],
      [[0, 0], [0, -1], [0, 0], [0, 0]],
    ],
    mouth: [9, 5],
    sticks: {
      carry: { dx: 6, y: 21, d: 1 },
      faceoff: { dx: 4, y: 20, d: 1 },
      windup: { dx: 9, y: 25, d: 1, len: 3 },
      shoot: { dx: 4, y: 15, d: 1, len: 3 },
      pass: { dx: 8, y: 21, d: 1 },
      poke: { dx: 4, y: 17, d: 1 },
    },
    stickBehind: true,
    butt: 3,
  },
  SE: {
    fwd: [1, 1],
    body: BODY_SE,
    bodyAt: [6, 13],
    head: HEAD_SE,
    headBark: HEAD_SE_BARK,
    headAt: [13, 10],
    headBehind: false,
    tail: TAIL_E,
    tailAt: [4, 9],
    tailBehind: false,
    legs: [
      { part: PAW_E_FAR, x: 8, y: GROUND - 5, far: true },
      { part: PAW_E_FAR, x: 12, y: GROUND - 5, far: true },
      { part: PAW_E, x: 15, y: GROUND - 2, far: false },
      { part: PAW_E, x: 19, y: GROUND - 3, far: false },
    ],
    cycle: [
      [[0, 0], [-1, 0], [1, -1], [0, 0]],
      [[0, -1], [0, 0], [0, 0], [0, 0]],
      [[-1, 0], [0, 0], [0, 0], [1, -1]],
      [[0, 0], [0, -1], [0, 0], [0, 0]],
    ],
    mouth: [10, 8],
    sticks: {
      carry: { dx: 4, y: 28, d: 1 },
      faceoff: { dx: 2, y: 28, d: 1 },
      windup: { dx: -9, y: 24, d: -1 },
      shoot: { dx: 5, y: 23, d: 1, len: 3 },
      pass: { dx: 3, y: 28, d: 1 },
      poke: { dx: 5, y: 30, d: 1 },
    },
    stickBehind: false,
    butt: 0,
  },
  NE: {
    fwd: [1, -1],
    body: BODY_NE,
    decal: { text: 'K9', x: 4, y: 4, small: true },
    ears: [[EAR_L, -2, 3]],
    bodyAt: [6, 13],
    head: HEAD_NE,
    headBark: HEAD_NE,
    headAt: [14, 5],
    headBehind: false,
    tail: TAIL_N,
    tailAt: [8, 20],
    tailBehind: false,
    legs: [
      { part: PAW_E_FAR, x: 17, y: GROUND - 4, far: true },
      { part: PAW_E_FAR, x: 20, y: GROUND - 5, far: true },
      { part: PAW_E, x: 8, y: GROUND - 3, far: false },
      { part: PAW_E, x: 12, y: GROUND - 3, far: false },
    ],
    cycle: [
      [[1, -1], [0, 0], [-1, 0], [0, 0]],
      [[0, 0], [0, 0], [0, 0], [0, -1]],
      [[0, 0], [1, -1], [0, 0], [-1, 0]],
      [[0, 0], [0, 0], [0, -1], [0, 0]],
    ],
    mouth: [9, 8],
    sticks: {
      carry: { dx: 3, y: 22, d: 1, len: 3 },
      faceoff: { dx: 2, y: 21, d: 1, len: 3 },
      windup: { dx: -12, y: 26, d: -1 },
      shoot: { dx: 3, y: 16, d: 1, len: 3 },
      pass: { dx: 4, y: 22, d: 1, len: 3 },
      poke: { dx: 4, y: 18, d: 1, len: 3 },
    },
    stickBehind: false,
    butt: 0,
  },
};

// ------------------------------------------------------------------ poses --

interface Pose {
  bob?: number; // whole dog up/down (negative = up)
  lean?: number; // px along the facing direction
  headDx?: number;
  headDy?: number;
  tailDy?: number;
  bark?: boolean;
  step?: number; // skate-cycle frame (undefined = standing)
  stick?: StickPose;
  legsDy?: number; // extra leg offset (hop: legs tuck up)
}

/** Stick in the mouth: two-tone shaft from the mouth to the blade heel, taped blade on the ice. */
function drawStick(g: Grid, mx: number, my: number, hx: number, hy: number, d: 1 | -1, len: number, butt: number, under: boolean): void {
  let x0 = mx;
  let y0 = my;
  if (butt) {
    const L = Math.hypot(hx - mx, hy - my) || 1;
    x0 = mx - Math.round(((hx - mx) / L) * butt);
    y0 = my - Math.round(((hy - my) / L) * butt);
  }
  const steep = Math.abs(hy - y0) > Math.abs(hx - x0);
  // dark side toward the bottom-right (light is top-left)
  line(g, x0 + (steep ? 1 : 0), y0 + (steep ? 0 : 1), hx + (steep ? 1 : 0), hy + (steep ? 0 : 1), 'Y', under);
  line(g, x0, y0, hx, hy, 'y', under);
  for (let i = 0; i < len; i++) {
    const bx = hx + d * i;
    if (!under || g.d[(hy + 1) * g.w + bx] === '.') put(g, bx, hy + 1, i === 0 ? 'Y' : 'x');
  }
}

function drawDog(dir: Dir5, p: Pose, mirrorSrc = false): Grid {
  const r = RIGS[dir];
  const g = grid(CELL, CELL);
  const bob = p.bob ?? 0;
  const lean = p.lean ?? 0;
  const lx = Math.round(r.fwd[0] * lean);
  const ly = Math.round(r.fwd[1] * lean * 0.5); // vertical screen motion is foreshortened
  const ox = lx;
  const oy = bob + ly;
  const cyc = p.step === undefined ? null : r.cycle[p.step % r.cycle.length];

  const hx = r.headAt[0] + ox + (p.headDx ?? 0);
  const hy = r.headAt[1] + oy + (p.headDy ?? 0);
  const mx = hx + r.mouth[0];
  const my = hy + r.mouth[1];
  const pose = p.stick ?? 'carry';
  const st = pose === 'none' ? null : r.sticks[pose];
  const stickNow = (under: boolean) => {
    if (!st) return;
    drawStick(g, mx, my, mx + st.dx, st.y + Math.min(0, bob), st.d, st.len ?? 4, r.butt, under);
  };

  const legs = (far: boolean) =>
    r.legs.forEach((L, i) => {
      if (L.far !== far) return;
      const c = cyc ? cyc[i] : [0, 0];
      stamp(g, L.part, L.x + c[0] + lx, L.y + c[1] + (p.legsDy ?? 0) + Math.min(0, bob));
    });

  const tail = () => stamp(g, r.tail, r.tailAt[0] + ox, r.tailAt[1] + oy + (p.tailDy ?? 0));
  const head = () => {
    for (const [e, ex, ey] of r.ears ?? []) stamp(g, e, hx + ex, hy + ey + (p.step !== undefined && p.step % 2 ? 1 : 0));
    stamp(g, p.bark ? r.headBark : r.head, hx, hy);
  };

  if (r.stickBehind) stickNow(false);
  legs(true);
  if (r.tailBehind) tail();
  if (r.headBehind) head();
  stamp(g, r.body, r.bodyAt[0] + ox, r.bodyAt[1] + oy);
  if (r.decal) stampDecal(g, r.decal, r.bodyAt[0] + ox, r.bodyAt[1] + oy, mirrorSrc);
  legs(false);
  if (!r.tailBehind) tail();
  if (!r.headBehind) head();
  if (!r.stickBehind) stickNow(false);
  return g;
}

// ---------------------------------------------------------------- fallen --
// On its back, paws (and skates) in the air, dizzy, stick dropped beside it.

const FALLEN_BODY = parse([
  '...wwWWwwwwWWww...',
  '.wwWWWWWWWWWWWwww.',
  'wWWWWWwwwwwwwwwwwc',
  'wWWwwwwwwwwwwwwwcc',
  'wcccccccccccccccC.',
  '.JJJJJJJJJJJJJjj..',
  '..jjjjjjjjjjjjj...',
]);
// legs splayed in the air, skates up (rear pair leans back, front pair forward)
const LEG_UP_L = parse(['ee...', 'bbb..', '.wc..', '.Wwc.', '..wwc']);
const LEG_UP_R = parse(['...ee', '..bbb', '..wc.', '.wwc.', 'wwc..']);
const FALLEN_HEAD = parse([
  '...wwWWww...',
  '.wwWWWWWWww.',
  'wWWWWWWWWWwc',
  'wWkWkWWkWkwc',
  'cWWkWWWWkWwc',
  'CwkWkwwkWkwC',
  'Ccwwwkkwwwcc',
  'CcwwwRRwwwcC',
  '.Ccwwrrwwcc.',
  '..cccrrccC..',
  '...CccccC...',
]);

function drawFallen(tumble: boolean): Grid {
  const g = grid(CELL, CELL);
  if (tumble) {
    // mid-fall: tipped onto its side, legs flailing
    const base = drawDog('E', { stick: 'none', bob: 1, headDy: 1 });
    // tilt by shearing rows: top rows shift right
    for (let y = 0; y < CELL; y++) {
      const sh = Math.round((GROUND - y) / 6);
      for (let x = 0; x < CELL; x++) {
        const sx = x - sh;
        if (sx >= 0 && sx < CELL) g.d[y * CELL + x] = base.d[y * CELL + sx];
      }
    }
    line(g, 6, GROUND, 14, GROUND, 'y');
    put(g, 14, GROUND, 'x');
    put(g, 15, GROUND, 'x');
    return g;
  }
  // stick lying on the ice behind the dog
  line(g, 4, GROUND - 1, 18, GROUND - 3, 'y');
  line(g, 4, GROUND, 18, GROUND - 2, 'Y');
  put(g, 3, GROUND, 'x');
  put(g, 2, GROUND, 'x');
  stamp(g, LEG_UP_L, 4, GROUND - 13, { map: { w: 'c', c: 'C', e: 'E' } });
  stamp(g, LEG_UP_L, 7, GROUND - 14);
  stamp(g, LEG_UP_R, 13, GROUND - 14, { map: { w: 'c', c: 'C', e: 'E' } });
  stamp(g, LEG_UP_R, 16, GROUND - 13);
  stamp(g, TAIL_S, 2, GROUND - 7);
  stamp(g, FALLEN_BODY, 4, GROUND - 9);
  stamp(g, FALLEN_HEAD, 18, GROUND - 11);
  return g;
}

// -------------------------------------------------------------- assembly ---

function frame(g: Grid): ArtFrame {
  // white fur on white ice: only the top edge keeps the soft lit outline,
  // the sides, ears and underside get the dark one (like the kids' navy)
  outline(g, defaultOutline, false);
  return { g, ax: CELL / 2, ay: AY };
}

/** Same pose list rendered in all five directions. */
function anim(fps: number, loop: boolean, poses: Pose[]): AnimDef {
  const dirs: AnimDef['dirs'] = {};
  for (const d of DIR5) dirs[d] = poses.map((p) => frame(drawDog(d, p)));
  // explicit NW so K9 doesn't read backwards on the mirrored back view
  dirs.NW = poses.map((p) => frame(flipped(drawDog('NE', p, true))));
  return { fps, loop, dirs };
}

/** The same frames for every direction (spins, falls). */
function anyDir(fps: number, loop: boolean, grids: Grid[]): AnimDef {
  const frames = grids.map(frame);
  const dirs: AnimDef['dirs'] = {};
  for (const d of DIR5) dirs[d] = frames;
  return { fps, loop, dirs };
}

export function buildDogArt(): KindArt {
  return {
    w: CELL,
    h: CELL,
    defaultAnim: 'idle',
    fallback: {
      gReady: 'idle',
      gSkate: 'skate',
      gButterfly: 'faceoff',
      gDiveL: 'fallen',
      gDiveR: 'fallen',
      gHold: 'idle',
      refSkate: 'skate',
      refWhistle: 'bark',
      refPoint: 'idle',
    },
    anims: {
      // breathing + tail wag
      idle: anim(2.5, true, [{}, { tailDy: -1, headDy: 1, bob: 0 }]),
      // paws scampering, ears (head) bouncing
      skate: anim(10, true, [
        { step: 0 },
        { step: 1, bob: -1, headDy: 1 },
        { step: 2 },
        { step: 3, bob: -1, headDy: 1 },
      ]),
      windup: anim(8, false, [
        { stick: 'windup', lean: -1 },
        { stick: 'windup', lean: -1, headDy: 1, tailDy: -1 },
      ]),
      shoot: anim(12, false, [
        { stick: 'carry', lean: 1 },
        { stick: 'shoot', lean: 2, headDy: -1 },
      ]),
      pass: anim(12, false, [{ stick: 'carry' }, { stick: 'pass', lean: 1 }]),
      poke: anim(10, false, [
        { stick: 'carry', lean: 1 },
        { stick: 'poke', lean: 3, headDy: 1 },
      ]),
      // head-down lunge
      check: anim(10, false, [
        { lean: 1, headDy: 1, stick: 'faceoff' },
        { lean: 3, headDy: 2, tailDy: 1, stick: 'faceoff' },
      ]),
      faceoff: anim(1, false, [{ stick: 'faceoff', bob: 1, headDy: 1 }]),
      bark: anim(10, false, [
        { bark: true, headDy: -1, stick: 'carry' },
        { bark: true, headDy: -1, tailDy: -1, stick: 'carry' },
      ]),
      // hop + spin: S -> E -> N -> W while yapping
      celebrate: anyDir(8, true, [
        drawDog('S', { bark: true }),
        drawDog('E', { bark: true, bob: -3, legsDy: -1 }),
        drawDog('N', { bob: -5, legsDy: -1 }),
        flipped(drawDog('E', { bark: true, bob: -2 })),
      ]),
      fallen: anyDir(8, false, [drawFallen(true), drawFallen(false)]),
    },
  };
}
