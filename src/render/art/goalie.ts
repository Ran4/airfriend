// Goalies: cage mask, bulky jersey, white leg pads with team stripes, a
// blocker, a catching glove and the wide-paddle goalie stick. Goalies square
// up to the play, so three views are drawn (N = back, E = profile, S = front)
// and the diagonals reuse N/S. Poses are explicit screen layouts per view
// (few frames, each one hand-placed), composed from the parts below.

import { hockeyStick, limb } from './body';
import type { AnimDef, ArtFrame, Dir5, KindArt } from './frames';
import { clone, flipped, grid, outline, parse, put, recolor, rotCCW, rotCW, stamp, type Grid } from './grid';
import { stampDecal } from './glyphs';
import { CELL, GROUND } from './kid';

const AY = CELL - 1 - GROUND;

// ------------------------------------------------------------------ parts --
const MASK_S = parse([
  '..hhhhhh..',
  '.hiiihhhH.',
  'hiihhhhhhH',
  'hhmmmmmmHH',
  'hmkmkkmkmH',
  'hmmmmmmmmH',
  'hmkmkkmkmH',
  '.hmmmmmmH.',
  '..hhhhhH..',
]);
const MASK_N = parse([
  '..hhhhhh..',
  '.hiiihhhH.',
  'hiihhhhhhH',
  'hiihhhhhHH',
  'hhhhhhhhHH',
  'HhhhhhhhHH',
  'HHhhhhhHHH',
  '.HHHHHHHH.',
  '..HHHHHH..',
]);
const MASK_E = parse([
  '..hhhhh...',
  '.hiihhhh..',
  'hiihhhhhH.',
  'hhhhhhHmmm',
  'HhhhhHmkmm',
  'HhhhhHmmmm',
  '.HhhhHmkmm',
  '..HHHHmmm.',
  '.....mmm..',
]);
const TORSO_S = parse([
  '..KKKttJJJJj..',
  '.KKKKKJJJJJjj.',
  'KKKKJJJJJJJJjj',
  'KKJJJJJJJJJJjj',
  'KJJJJttJJJJJjj',
  'JJJJJttJJJJjjj',
  'JJJJJJJJJJJjjj',
  'ttttttttttttTT',
  'jJJJJJJJJJJjjj',
]);
// back of the jersey, number stamped per goalie (glyphs.ts, same 3x5 font)
const TORSO_N_BLANK = parse([
  '..JJJJJJJJJJ..',
  '.KKKKJJJJJJJj.',
  'KKKKJJJJJJJJjj',
  'KKJJJJJJJJJJjj',
  'KJJJJJJJJJJjjj',
  'JJJJJJJJJJJjjj',
  'JJJJJJJJJJJjjj',
  'jJJJJJJJJJJjjj',
  'ttttttttttttTT',
]);
function torsoBack(num: string): Grid {
  const g = clone(TORSO_N_BLANK);
  const text = num.slice(0, 2);
  // two digits fill columns 4..10; one digit sits centered
  stampDecal(g, { text, x: text.length === 1 ? 6 : 4, y: 2 }, 0, 0);
  return g;
}
// rebound by buildGoalieArt() for each goalie's number
let TORSO_N = torsoBack('30');
const TORSO_E = parse([
  '..KKKJJJ...',
  '.KKKJJJJj..',
  'KKKJJJJJjj.',
  'KKJJJJJJjjj',
  'KJJJJJJJjjj',
  'JJJJJJJJjjj',
  'JJJJJJJjjjj',
  'tttttttttTT',
  'jJJJJJJjjj.',
]);
const PANTS_S = parse(['PPPPpppppppQ', 'PPpppppppppQ', 'PpppppppppQQ', 'ppppQ..pppQQ']);
const PANTS_E = parse(['PPPppppQ.', 'PPpppppQQ', 'PppppppQQ', '.ppppppQ.']);
// leg pads: white leather, team-color rolls (front), straps (back)
const PAD_F = parse(['aaaaA', 'aJJJA', 'aaaaA', 'aaaAA', 'aJJJA', 'aaaAA', 'aaaAA', 'aJJJA', 'AAAAA']);
const PAD_B = parse(['aaaaA', 'abbbA', 'aaaaA', 'aaaAA', 'abbbA', 'aaaAA', 'aaaAA', 'abbbA', 'AAAAA']);
const PAD_E = parse(['aaaA.', 'aJJA.', 'aaaA.', 'aaAA.', 'aJJA.', 'aaAA.', 'aaAA.', 'aJJAA', 'aAAAA']);
const GLOVE = parse(['.aaa.', 'aaJJa', 'aJJJa', 'aaJaA', '.AAA.']);
const GLOVE_PUCK = parse(['.aaa.', 'aa77a', 'aJ77a', 'aaJaA', '.AAA.']);
const BLOCKER = parse(['aaaA', 'aJJA', 'aJJA', 'aaaA', 'aJJA', 'AAAA']);
const FAR = { a: 'A', J: 'j', K: 'J', h: 'H', i: 'h' };

// ----------------------------------------------------------------- layout --

type P2 = [number, number];
interface Placed {
  g: Grid;
  at: P2; // top-left
}
interface GLayout {
  mask: Placed;
  torso: Placed;
  pants?: Placed;
  pads: (Placed & { far?: boolean })[];
  blades?: P2[]; // skate blade centers (row = GROUND unless given)
  armGlove: [P2, P2]; // shoulder -> hand
  armBlocker: [P2, P2];
  glove: Placed;
  blocker: Placed;
  gloveFar?: boolean; // glove arm behind the torso (profile view)
  stick?: { from: P2; heel: P2; toe: P2; len?: number; behind?: boolean };
}

const pl = (g: Grid, x: number, y: number): Placed => ({ g, at: [x, y] });

function compose(L: GLayout): Grid {
  const g = grid(CELL, CELL);
  const arm = ([s, h]: [P2, P2]) =>
    limb(g, s[0], s[1], h[0], h[1], 3, (_t, k) => (k === 0 ? 'K' : k === 1 ? 'J' : 'j'));
  const stick = () => {
    const s = L.stick!;
    hockeyStick(g, s.from[0], s.from[1], s.heel[0], s.heel[1], s.toe, s.len ?? 6);
    // goalie paddle: the lower part of the shaft is twice as wide
    const n = 4;
    for (let i = 1; i <= n; i++) {
      const t = 1 - i / (n + 2);
      const x = Math.round(s.from[0] + (s.heel[0] - s.from[0]) * t);
      const y = Math.round(s.from[1] + (s.heel[1] - s.from[1]) * t);
      put(g, x - 1, y, 'y');
    }
  };
  if (L.stick?.behind) stick();
  if (L.gloveFar) {
    arm(L.armGlove);
  }
  for (const b of L.blades ?? []) {
    put(g, b[0] - 1, b[1], 'e');
    put(g, b[0], b[1], 'e');
    put(g, b[0] + 1, b[1], 'E');
  }
  if (L.pants) stamp(g, L.pants.g, L.pants.at[0], L.pants.at[1]);
  for (const p of L.pads.filter((p) => p.far)) stamp(g, p.g, p.at[0], p.at[1], { map: FAR });
  for (const p of L.pads.filter((p) => !p.far)) stamp(g, p.g, p.at[0], p.at[1]);
  stamp(g, L.torso.g, L.torso.at[0], L.torso.at[1]);
  stamp(g, L.mask.g, L.mask.at[0], L.mask.at[1]);
  if (!L.gloveFar) arm(L.armGlove);
  arm(L.armBlocker);
  stamp(g, L.glove.g, L.glove.at[0], L.glove.at[1]);
  if (L.stick && !L.stick.behind) stick();
  stamp(g, L.blocker.g, L.blocker.at[0], L.blocker.at[1]);
  return g;
}

// ------------------------------------------------------------ front (S) ---
// Goalie faces the camera: glove on screen-right, blocker + stick on screen-left.

function frontReady(bob = 0, spread = 0): GLayout {
  const c = 3 + bob; // crouch
  return {
    mask: pl(MASK_S, 11, 2 + c),
    torso: pl(TORSO_S, 9, 10 + c),
    pants: pl(PANTS_S, 10, 18),
    pads: [pl(PAD_F, 9 - spread, 19), pl(PAD_F, 18 + spread, 19)],
    blades: [[11 - spread, GROUND], [20 + spread, GROUND]],
    armGlove: [[21, 13 + c], [25, 14 + c]],
    armBlocker: [[10, 13 + c], [6, 15 + c]],
    glove: pl(GLOVE, 23, 11 + c),
    blocker: pl(BLOCKER, 4, 12 + c),
    stick: { from: [6, 17 + c], heel: [11 - spread, GROUND], toe: [1, 0], len: 6 },
  };
}

function frontButterfly(): GLayout {
  const flat = rotCW(PAD_F);
  return {
    mask: pl(MASK_S, 11, 9),
    torso: pl(TORSO_S, 9, 16),
    pads: [pl(flipped(flat), 1, 24), pl(flat, 22, 24)],
    armGlove: [[21, 18], [26, 18]],
    armBlocker: [[10, 18], [5, 20]],
    glove: pl(GLOVE, 24, 15),
    blocker: pl(BLOCKER, 3, 17),
    stick: { from: [5, 23], heel: [11, GROUND], toe: [1, 0], len: 8 },
  };
}

function frontHold(): GLayout {
  return {
    mask: pl(MASK_S, 11, 3),
    torso: pl(TORSO_S, 9, 11),
    pants: pl(PANTS_S, 10, 18),
    pads: [pl(PAD_F, 9, 19), pl(PAD_F, 18, 19)],
    blades: [[11, GROUND], [20, GROUND]],
    armGlove: [[21, 13], [24, 6]],
    armBlocker: [[10, 14], [6, 17]],
    glove: pl(GLOVE_PUCK, 22, 2),
    blocker: pl(BLOCKER, 4, 14),
    stick: { from: [6, 19], heel: [10, GROUND], toe: [1, 0], len: 6 },
  };
}

function frontCheer(up: number): GLayout {
  return {
    mask: pl(MASK_S, 11, 3),
    torso: pl(TORSO_S, 9, 11),
    pants: pl(PANTS_S, 10, 18),
    pads: [pl(PAD_F, 9, 19), pl(PAD_F, 18, 19)],
    blades: [[11, GROUND], [20, GROUND]],
    armGlove: [[21, 13], [25, 5 - up]],
    armBlocker: [[10, 13], [6, 5 - up]],
    glove: pl(GLOVE, 23, 2 - up),
    blocker: pl(BLOCKER, 4, 2 - up),
  };
}

// Dive toward screen-left (gDiveR is the mirror). Two frames: launch, stretched.
function frontDive(stretched: boolean, back = false): Grid {
  const MASK = back ? MASK_N : MASK_S;
  const TORSO = back ? TORSO_N : TORSO_S;
  if (!stretched) {
    return compose({
      mask: pl(MASK, 6, 8),
      torso: pl(TORSO, 5, 15),
      pads: [pl(back ? PAD_B : PAD_F, 6, 19), pl(rotCW(back ? PAD_B : PAD_F), 18, 23)],
      blades: [[8, GROUND]],
      armGlove: [[6, 17], [2, 10]],
      armBlocker: [[17, 17], [21, 15]],
      glove: pl(GLOVE, 0, 6),
      blocker: pl(BLOCKER, 19, 12),
      stick: { from: [21, 18], heel: [24, GROUND], toe: [1, 0], len: 5 },
    });
  }
  // lying on the side, fully stretched: everything rotated a quarter turn
  const g = grid(CELL, CELL);
  const torso = rotCCW(TORSO); // 9 wide x 14 tall: shoulders become top/bottom
  const flat = rotCW(back ? PAD_B : PAD_F);
  hockeyStick(g, 24, 16, 28, GROUND - 1, [1, 0], 4);
  stamp(g, flat, 20, 19);
  stamp(g, flat, 18, 24);
  stamp(g, PANTS_E, 15, 20, { map: {} });
  stamp(g, torso, 8, 15);
  stamp(g, rotCCW(MASK), 1, 18);
  limb(g, 9, 17, 4, 15, 3, (_t, k) => (k === 0 ? 'K' : k === 1 ? 'J' : 'j'));
  stamp(g, GLOVE, 0, 12);
  // blocker lying flat over the shoulder, not standing up like a post
  stamp(g, rotCW(BLOCKER), 12, 13);
  return g;
}

// ------------------------------------------------------------- back (N) ---
// Seen from behind: glove on screen-left, blocker on screen-right, stick out front (hidden).

function mirrorX(L: GLayout, back: boolean): GLayout {
  const mx = (p: P2): P2 => [CELL - 1 - p[0], p[1]];
  const mp = (p: Placed): Placed => ({ g: flipped(p.g), at: [CELL - p.at[0] - p.g.w, p.at[1]] });
  return {
    mask: back ? { g: MASK_N, at: L.mask.at } : mp(L.mask),
    torso: back ? { g: TORSO_N, at: L.torso.at } : mp(L.torso),
    pants: L.pants && mp(L.pants),
    pads: L.pads.map((p) => {
      const q = mp(p);
      return back && p.g === PAD_F ? { ...q, g: PAD_B } : q;
    }),
    blades: L.blades?.map(mx),
    armGlove: [mx(L.armGlove[0]), mx(L.armGlove[1])],
    armBlocker: [mx(L.armBlocker[0]), mx(L.armBlocker[1])],
    glove: mp(L.glove),
    blocker: mp(L.blocker),
    stick: L.stick && {
      ...L.stick,
      from: mx(L.stick.from),
      heel: [CELL - 1 - L.stick.heel[0], L.stick.heel[1] - (back ? 3 : 0)],
      toe: [-L.stick.toe[0], L.stick.toe[1]],
      behind: back,
    },
  };
}

// ----------------------------------------------------------- profile (E) ---

function sideReady(bob = 0, step = 0): GLayout {
  const c = 3 + bob;
  return {
    mask: pl(MASK_E, 12, 2 + c),
    torso: pl(TORSO_E, 10, 10 + c),
    pants: pl(PANTS_E, 11, 18),
    pads: [{ ...pl(PAD_E, 13 - step, 19), far: true }, pl(PAD_E, 16 + step, 19)],
    blades: [[15 - step, GROUND], [18 + step, GROUND]],
    gloveFar: true,
    armGlove: [[14, 12 + c], [22, 12 + c]],
    armBlocker: [[16, 13 + c], [20, 16 + c]],
    glove: pl(GLOVE, 20, 9 + c),
    blocker: pl(BLOCKER, 19, 13 + c),
    stick: { from: [21, 18 + c], heel: [23, GROUND], toe: [1, 0], len: 5 },
  };
}

function sideHold(): GLayout {
  const L = sideReady(-2);
  return { ...L, armGlove: [[14, 11], [22, 5]], glove: pl(GLOVE_PUCK, 20, 1) };
}

// -------------------------------------------------------------- assembly ---

function frame(g: Grid): ArtFrame {
  outline(g);
  return { g, ax: CELL / 2, ay: AY };
}

/** front + back + profile layouts -> five directions (diagonals reuse N/S) */
function anim(fps: number, loop: boolean, front: GLayout[], side?: GLayout[]): AnimDef {
  const S = front.map((L) => frame(compose(L)));
  const N = front.map((L) => frame(compose(mirrorX(L, true))));
  const E = side ? side.map((L) => frame(compose(L))) : S;
  // NW reuses the back view unmirrored (the number must read correctly)
  return { fps, loop, dirs: { N, NE: N, NW: N, E, SE: S, S } };
}

function dive(right: boolean): AnimDef {
  const make = (back: boolean) => [frontDive(false, back), frontDive(true, back)].map((g) => frame(right ? flipped(g) : g));
  const front = make(false);
  const back = make(true);
  // screen-space: the dive always goes to its own side, whatever the facing
  return { fps: 10, loop: false, dirs: { N: back, NE: back, NW: back, E: front, SE: front, S: front }, screenSpace: true };
}

export function buildGoalieArt(number = '30'): KindArt {
  TORSO_N = torsoBack(number);
  const stretched = frontDive(true);
  return {
    w: CELL,
    h: CELL,
    defaultAnim: 'gReady',
    fallback: {
      idle: 'gReady',
      skate: 'gSkate',
      windup: 'gReady',
      shoot: 'gReady',
      pass: 'gReady',
      poke: 'gReady',
      check: 'gReady',
      faceoff: 'gReady',
      bark: 'gReady',
      refSkate: 'gSkate',
      refWhistle: 'gReady',
      refPoint: 'gReady',
    },
    anims: {
      gReady: anim(2, true, [frontReady(0), frontReady(1)], [sideReady(0), sideReady(1)]),
      gSkate: anim(6, true, [frontReady(0, 2), frontReady(1, 0)], [sideReady(0, 2), sideReady(1, -1)]),
      gButterfly: anim(1, false, [frontButterfly()]),
      gDiveL: dive(false),
      gDiveR: dive(true),
      gHold: anim(1, false, [frontHold()], [sideHold()]),
      celebrate: anim(4, true, [frontCheer(0), frontCheer(1)]),
      fallen: { ...dive(false), dirs: Object.fromEntries((['N', 'NE', 'E', 'SE', 'S'] as Dir5[]).map((d) => [d, [frame(recolor(stretched, {}))]])) },
    },
  };
}
