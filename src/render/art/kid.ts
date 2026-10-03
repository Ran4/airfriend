// The kids (and, recolored, the referee): helmet + cage, jersey with
// stripes and a number on the back, breezers, striped socks, skates and a
// stick. Heads, torsos and pants are hand-pixelled for the five authored
// directions; arms, legs and the stick come from body-space poses (body.ts)
// so every animation is defined once and stays consistent in all directions.
// Team colors are palette slots (J j K t T p P Q h H i s S g G).

import { basis, hockeyStick, limb, project, stampAt, v, type V3 } from './body';
import type { AnimDef, ArtFrame, Dir5, KindArt } from './frames';
import { DIR5 } from './frames';
import { flipped, grid, outline, parse, stamp, type Grid } from './grid';
import { stampDecal, type Decal } from './glyphs';

export const CELL = 32;
export const GROUND = 28;
const CX = 15.5;
const AY = CELL - 1 - GROUND;

// ------------------------------------------------------------------ heads --
const HEAD: Record<Dir5, Grid> = {
  S: parse([
    '..hhhhhh..',
    '.hiiihhhH.',
    'hiihhhhhhH',
    'hhhhhhhhHH',
    'HMmmmmmmMH',
    'HmfkffkfmH',
    'HmfffFFfmH',
    '.MmfffFmM.',
    '..MmmmmM..',
  ]),
  SE: parse([
    '..hhhhhh..',
    '.hiiihhhH.',
    'hiihhhhhhH',
    'hhhhhhhhHH',
    'HhhMmmmmmM',
    'HhHmfkffkm',
    'HhHmffFffm',
    '.HHMfffffm',
    '...MmmmmM.',
  ]),
  E: parse([
    '..hhhhh...',
    '.hiihhhh..',
    'hiihhhhhH.',
    'hhhhhhhhHM',
    'HhhhhHMmmm',
    'HhhhHMfkfm',
    '.HhhHMfFfm',
    '..HHHMfffm',
    '.....MmmM.',
  ]),
  NE: parse([
    '..hhhhhh..',
    '.hiiihhhH.',
    'hiihhhhhhH',
    'hiihhhhhHM',
    'hhhhhhhHHm',
    'HhhhhhhHfm',
    'HHhhhhHHfm',
    '.HHHHHHHm.',
    '..fffF....',
  ]),
  N: parse([
    '..hhhhhh..',
    '.hiiihhhH.',
    'hiihhhhhhH',
    'hiihhhhhHH',
    'hhhhhhhhHH',
    'HhhhhhhhHH',
    'HHhhhhhHHH',
    '.HHHHHHHH.',
    '...fffF...',
  ]),
};

// ---------------------------------------------------------------- torsos --
// Front: crest + hem stripe. Back: plain - the number is a decal (glyphs.ts)
// so mirrored frames can re-stamp it reading the right way round.
const TORSO: Record<Dir5, Grid> = {
  S: parse([
    '...KKttJJ...',
    '.KKKKKJJJJj.',
    'KKKKJJJJJJjj',
    'KKJJJJJJJJjj',
    'KJJJttJJJJjj',
    'JJJJttJJJjjj',
    'JJJJJJJJJjjj',
    'tttttttttTTT',
    'jJJJJJJJjjjj',
  ]),
  SE: parse([
    '...KKttJ...',
    '.KKKKKJJJj.',
    'KKKKJJJJJjj',
    'KKJJJJJJJjj',
    'KJJJJJttJjj',
    'JJJJJJttjjj',
    'JJJJJJJJjjj',
    'ttttttttTTT',
    'jJJJJJJjjjj',
  ]),
  E: parse([
    '..KKJJ...',
    '.KKKJJJj.',
    'KKKJJJJjj',
    'KKJJJJJjj',
    'KJJJJJJjj',
    'JJJJJJjjj',
    'JJJJJJjjj',
    'tttttttTT',
    'jJJJJJjj.',
  ]),
  NE: parse([
    '...JJJJJ...',
    '.KKKKJJJJj.',
    'KKJJJJJJJjj',
    'KJJJJJJJjjj',
    'JJJJJJJJjjj',
    'JJJJJJJjjjj',
    'JJJJJJJjjjj',
    'jJJJJJJjjjj',
    'ttttttttTTT',
  ]),
  N: parse([
    '...JJJJJJ...',
    '.KKKKJJJJJj.',
    'KKJJJJJJJJjj',
    'KJJJJJJJJjjj',
    'JJJJJJJJJjjj',
    'JJJJJJJJJjjj',
    'JJJJJJJJJjjj',
    'jJJJJJJJjjjj',
    'tttttttttTTT',
  ]),
};

// ----------------------------------------------------------------- pants --
const PANTS_WIDE = parse(['PPPPpppppppQ', 'PPpppppppppQ', 'PpppppppppQQ', 'ppppQ..pppQQ']);
const PANTS_MID = parse(['PPPPppppppQ', 'PPppppppppQ', 'PppppppppQQ', 'pppQ..pppQQ']);
const PANTS_E = parse(['PPPppppQ.', 'PPpppppQQ', 'PppppppQQ', '.ppppppQ.']);
const PANTS: Record<Dir5, Grid> = { S: PANTS_WIDE, N: PANTS_WIDE, SE: PANTS_MID, NE: PANTS_MID, E: PANTS_E };

// top-left placement of the hand-drawn parts (before pose offsets)
const AT: Record<Dir5, { head: [number, number]; torso: [number, number]; pants: [number, number] }> = {
  S: { head: [11, 2], torso: [10, 10], pants: [10, 18] },
  N: { head: [11, 2], torso: [10, 10], pants: [10, 18] },
  SE: { head: [11, 2], torso: [10, 10], pants: [10, 18] },
  NE: { head: [11, 2], torso: [10, 10], pants: [10, 18] },
  E: { head: [11, 2], torso: [11, 10], pants: [11, 18] },
};

// ---------------------------------------------------------------- skates --
// anchor = ankle pixel (top of the boot)
const SKATE_F = parse(['Bbb', 'bbb', '.e.']);
const SKATE_E = parse(['Bb...', 'bbbbB', 'eeeee']);
const SKATE_D = parse(['Bb..', 'bbbB', '.eee']);
const SKATE: Record<Dir5, [Grid, [number, number]]> = {
  S: [SKATE_F, [1, 0]],
  N: [SKATE_F, [1, 0]],
  E: [SKATE_E, [1, 0]],
  SE: [SKATE_D, [1, 0]],
  NE: [SKATE_D, [1, 0]],
};
const GLOVE = parse(['gg', 'gG']);
const FAR = { s: 'S', t: 'T', J: 'j', K: 'J', B: 'b', e: 'E' };

// ----------------------------------------------------------------- poses --

interface StickPose {
  grip: V3; // top hand (right glove)
  heel: V3; // where the blade starts
  toe: V3; // blade direction
  t?: number; // where the bottom hand sits along the shaft (0 = grip)
}

export interface KidPose {
  lean?: number; // upper body forward, px
  bob?: number; // upper body down, px
  crouch?: number; // hips lower, px (upper body follows)
  ankleL?: V3;
  ankleR?: V3;
  stick?: StickPose | null;
  /** explicit hands when there is no stick (referee) */
  handL?: V3;
  handR?: V3;
  headDy?: number;
}

export interface Look {
  head: Record<Dir5, Grid>;
  torso: Record<Dir5, Grid>;
  /** extra height for legs (the referee is a grown-up) */
  legLen: number;
  /** recolor hook for arm pixels (armbands) */
  armCol?: (t: number, k: number) => string | null;
  /** post-process the torso part (ref stripes) */
  torsoFx?: (g: Grid) => Grid;
  /** jersey numbers, relative to the torso part */
  decals?: Partial<Record<Dir5, Decal>>;
}

export const KID_LOOK: Look = {
  head: HEAD,
  torso: TORSO,
  legLen: 0,
  decals: { N: { text: '24', x: 2, y: 2 }, NE: { text: '24', x: 1, y: 2 } },
};

const HIP_L = 3.5;
const SHOULDER_L = 5.5;
const SHOULDER_H = 16;

/** Upper-body points use a flatter depth so shoulders don't splay vertically in profile. */
function projectFlat(dir: Dir5, p: V3, ox: number, oy: number): { x: number; y: number; depth: number } {
  const b = basis(dir);
  const q = project(b, { f: p.f, l: p.l * 0.5, h: p.h }, CX, GROUND);
  return { x: q.x + ox, y: q.y + oy, depth: project(b, p, CX, GROUND).depth };
}

function drawHuman(dir: Dir5, p: KidPose, look: Look, mirrorSrc = false): Grid {
  const g = grid(CELL, CELL);
  const b = basis(dir);
  const crouch = p.crouch ?? 0;
  const lean = p.lean ?? 0;
  const lift = look.legLen;
  // upper-body offset: lean along the facing, bob/crouch down, grown-ups taller
  const ox = Math.round(b.F[0] * lean);
  const oy = Math.round(b.F[1] * lean * 0.5) + (p.bob ?? 0) + crouch - lift;
  const at = AT[dir];

  const legsAt: (() => void)[] = [];
  // ---- legs (far first), hips are under the pants
  const legs = (['L', 'R'] as const).map((side) => {
    const sl = side === 'L' ? HIP_L : -HIP_L;
    const ank = (side === 'L' ? p.ankleL : p.ankleR) ?? v(0, sl, 2);
    const hip = project(b, { f: 0, l: sl * 0.9, h: 7 + lift - crouch }, CX, GROUND);
    const an = project(b, ank, CX, GROUND);
    return { hip: { x: hip.x + ox, y: hip.y + (p.bob ?? 0) }, an, depth: an.depth };
  });
  legs.sort((a, c) => a.depth - c.depth);
  const [sk, skA] = SKATE[dir];
  legs.forEach((L, i) => legsAt.push(() => {
    const far = legs.length === 2 && i === 0 && Math.abs(legs[0].depth - legs[1].depth) > 1.5;
    limb(g, L.hip.x, L.hip.y, L.an.x, L.an.y - 1, 3, (t, k) => {
      const stripe = t > 0.3 && t < 0.55;
      const c = stripe ? (k === 2 ? 'T' : 't') : k === 2 ? 'S' : 's';
      return far ? ((FAR as Record<string, string>)[c] ?? c) : c;
    });
    stampAt(g, sk, skA, L.an.x, L.an.y, far ? FAR : undefined);
  }));

  // ---- hands + stick
  const sp = p.stick;
  const gripP = sp ? sp.grip : p.handR;
  const botP = sp ? lerp3(sp.grip, sp.heel, sp.t ?? 0.42) : p.handL;
  const shoulderR = projectFlat(dir, v(0, -SHOULDER_L, SHOULDER_H), ox, oy + lift);
  const shoulderL = projectFlat(dir, v(0, SHOULDER_L, SHOULDER_H), ox, oy + lift);
  const handR = gripP ? projectFlat(dir, gripP, ox, oy + lift) : null;
  const handL = botP ? projectFlat(dir, botP, ox, oy + lift) : null;
  // the stick and its hands are drawn in front unless it sits beyond the body
  let stickFront = true;
  let gripPt = null as null | { x: number; y: number };
  let heelPt = null as null | { x: number; y: number };
  let toeV: [number, number] = [1, 0];
  if (sp) {
    const gq = project(b, sp.grip, CX, GROUND);
    const hq = project(b, sp.heel, CX, GROUND);
    gripPt = { x: gq.x + ox, y: gq.y + oy };
    // blades on the ice in front of a S-facing kid would leave the cell: keep them inside
    heelPt = { x: hq.x, y: Math.min(hq.y, CELL - 2) };
    // raised sticks ride with the upper body; blades on the ice stay planted
    if (sp.heel.h > 1) heelPt = { x: hq.x + ox, y: hq.y + oy };
    const tq = project(b, { f: sp.heel.f + sp.toe.f, l: sp.heel.l + sp.toe.l, h: sp.heel.h + sp.toe.h }, CX, GROUND);
    toeV = [tq.x - hq.x || 0.01, tq.y - hq.y];
    stickFront = (gq.depth + hq.depth) / 2 > -1.5;
  }

  const arm = (sh: { x: number; y: number }, hand: { x: number; y: number } | null) => {
    if (!hand) return;
    limb(g, sh.x, sh.y, hand.x, hand.y, 2, (t, k) => {
      const c = look.armCol?.(t, k);
      if (c) return c;
      return k ? 'j' : 'J';
    });
  };
  const glove = (hand: { x: number; y: number } | null) => hand && stamp(g, GLOVE, hand.x - 1, hand.y - 1);
  const armsFront: (() => void)[] = [];
  const doArm = (sh: typeof shoulderR, hand: typeof handR) => {
    if (!hand) return;
    const front = hand.depth > -1;
    const draw = () => {
      arm(sh, hand);
      if (sp) glove(hand);
      else stamp(g, GLOVE, hand.x - 1, hand.y - 1);
    };
    if (front) armsFront.push(draw);
    else draw();
  };

  if (sp && !stickFront && gripPt && heelPt) hockeyStick(g, gripPt.x, gripPt.y, heelPt.x, heelPt.y, toeV);
  legsAt.forEach((f) => f());
  doArm(shoulderL, handL);
  doArm(shoulderR, handR);

  // ---- body parts
  stamp(g, PANTS[dir], at.pants[0] + ox, at.pants[1] + (p.bob ?? 0) + crouch - lift + Math.round(b.F[1] * lean * 0.5));
  const torso = look.torsoFx ? look.torsoFx(look.torso[dir]) : look.torso[dir];
  stamp(g, torso, at.torso[0] + ox, at.torso[1] + oy);
  const decal = look.decals?.[dir];
  if (decal) stampDecal(g, decal, at.torso[0] + ox, at.torso[1] + oy, mirrorSrc);
  stamp(g, look.head[dir], at.head[0] + ox, at.head[1] + oy + (p.headDy ?? 0));

  if (sp && stickFront && gripPt && heelPt) hockeyStick(g, gripPt.x, gripPt.y, heelPt.x, heelPt.y, toeV);
  armsFront.forEach((f) => f());
  return g;
}

function lerp3(a: V3, b: V3, t: number): V3 {
  return { f: a.f + (b.f - a.f) * t, l: a.l + (b.l - a.l) * t, h: a.h + (b.h - a.h) * t };
}

// ---------------------------------------------------------------- fallen --
// Face-down on the ice, head to the right, stick dropped. Shared by all dirs.
const FALLEN = parse([
  '....................hhhhh...',
  '...........KKKJJJj.hiihhhH..',
  '..Bb.sstPPPKKJtJtJjhihhhhHH.',
  '.bbbbsstPPpKJJtJtJjhhhhhHMm.',
  '.eeeesstPppJJJJJJjjjHHHMffm.',
  '...Bbsstppp jjjjjjjjgg.Mmm..',
  '..bbbbsQQ...........gg......',
  '..eeee......................',
]);

function drawFallenKid(tumble: boolean): Grid {
  if (tumble) {
    // pitched forward mid-fall: lean hard, stick flying out of the hands
    const base = drawHuman('E', {
      lean: 3,
      bob: 2,
      ankleL: v(-4, 3, 4),
      ankleR: v(-2, -3, 3),
      stick: { grip: v(4, 0, 12), heel: v(10, 2, 6), toe: v(1, 1, 0) },
    }, KID_LOOK);
    return base;
  }
  const g = grid(CELL, CELL);
  // stick on the ice in front of the body
  hockeyStick(g, 6, GROUND - 1, 22, GROUND, [1, 0]);
  stamp(g, FALLEN, 2, GROUND - 8);
  return g;
}

// -------------------------------------------------------------- anim sets --

const CARRY: StickPose = { grip: v(2, -2, 11), heel: v(9, 6, 0), toe: v(2, 2, 0) };

export const KID_POSES = {
  idle: [
    { stick: { grip: v(1, -2, 11), heel: v(8, 6, 0), toe: v(2, 2, 0) } },
    { stick: { grip: v(1, -2, 11), heel: v(8, 6, 0), toe: v(2, 2, 0) }, bob: 1 },
  ] as KidPose[],
  skate: [
    { ankleL: v(-3, 7, 3), ankleR: v(1, -3, 2), bob: 1, lean: 1, stick: { ...CARRY, heel: v(9, 5, 0) } },
    { ankleL: v(-1, 4, 2), ankleR: v(0, -3.5, 2), lean: 1, stick: CARRY },
    { ankleL: v(1, 3, 2), ankleR: v(-3, -7, 3), bob: 1, lean: 1, stick: { ...CARRY, heel: v(9, 7, 0) } },
    { ankleL: v(0, 3.5, 2), ankleR: v(-1, -4, 2), lean: 1, stick: CARRY },
  ] as KidPose[],
  windup: [
    { lean: 0, stick: { grip: v(1, -2, 13), heel: v(-2, 6, 16), toe: v(-1, 2, 1) } },
    { lean: -1, bob: 1, stick: { grip: v(0, -1, 14), heel: v(-7, 6, 20), toe: v(-1, 2, 1) } },
  ] as KidPose[],
  shoot: [
    { lean: 1, stick: { grip: v(3, -1, 10), heel: v(8, 2, 0), toe: v(2, 2, 0) } },
    { lean: 2, stick: { grip: v(4, 0, 13), heel: v(11, -3, 10), toe: v(1, -2, 1) } },
  ] as KidPose[],
  pass: [
    { stick: { grip: v(2, -2, 11), heel: v(6, 6, 0), toe: v(2, 2, 0) } },
    { lean: 1, stick: { grip: v(3, -1, 11), heel: v(9, 1, 0), toe: v(2, 1, 0) } },
  ] as KidPose[],
  poke: [
    { lean: 1, stick: CARRY },
    { lean: 2, stick: { grip: v(6, -1, 10), heel: v(13, 2, 0), toe: v(2, 2, 0), t: 0.35 } },
  ] as KidPose[],
  // shoulder lunge, stick held low across the body
  check: [
    { lean: 2, stick: { grip: v(3, -4, 11), heel: v(4, 6, 6), toe: v(1, 1, 1), t: 0.6 }, ankleR: v(-2, -4, 2) },
    { lean: 3, bob: 1, stick: { grip: v(4, -4, 10), heel: v(5, 6, 5), toe: v(1, 1, 1), t: 0.6 }, ankleR: v(-4, -5, 3) },
  ] as KidPose[],
  faceoff: [
    {
      crouch: 3,
      lean: 2,
      ankleL: v(0, 5, 2),
      ankleR: v(0, -5, 2),
      stick: { grip: v(3, -2, 9), heel: v(6, 1, 0), toe: v(2, 2, 0), t: 0.5 },
    },
  ] as KidPose[],
  // stick pumped over the head
  celebrate: [
    { stick: { grip: v(1, 4, 18), heel: v(2, 9, 27), toe: v(1, 2, 0), t: 0.3 } },
    { bob: 1, stick: { grip: v(1, 4, 16), heel: v(2, 9, 24), toe: v(1, 2, 0), t: 0.3 } },
    { stick: { grip: v(1, 4, 18), heel: v(2, 9, 27), toe: v(1, 2, 0), t: 0.3 } },
    { bob: 1, stick: { grip: v(1, 4, 16), heel: v(2, 9, 24), toe: v(1, 2, 0), t: 0.3 } },
  ] as KidPose[],
};

function frame(g: Grid): ArtFrame {
  outline(g);
  return { g, ax: CELL / 2, ay: AY };
}

export function animFrom(look: Look, fps: number, loop: boolean, poses: KidPose[]): AnimDef {
  const dirs: AnimDef['dirs'] = {};
  for (const d of DIR5) dirs[d] = poses.map((p) => frame(drawHuman(d, p, look)));
  // explicit NW so the number on the back doesn't read mirrored
  if (look.decals?.NE) dirs.NW = poses.map((p) => frame(flipped(drawHuman('NE', p, look, true))));
  return { fps, loop, dirs };
}

function anyDir(fps: number, loop: boolean, grids: Grid[]): AnimDef {
  const frames = grids.map(frame);
  const dirs: AnimDef['dirs'] = {};
  for (const d of DIR5) dirs[d] = frames;
  return { fps, loop, dirs };
}

/** KID_LOOK wearing a given jersey number (1-2 digits, centered on the back) */
function lookWithNumber(num: string): Look {
  const text = num.slice(0, 2);
  const dx = text.length === 1 ? 2 : 0;
  return { ...KID_LOOK, decals: { N: { text, x: 2 + dx, y: 2 }, NE: { text, x: 1 + dx, y: 2 } } };
}

export function buildKidArt(number = '24'): KindArt {
  const L = lookWithNumber(number);
  const P = KID_POSES;
  return {
    w: CELL,
    h: CELL,
    defaultAnim: 'idle',
    fallback: {
      bark: 'idle',
      gReady: 'idle',
      gSkate: 'skate',
      gButterfly: 'faceoff',
      gDiveL: 'fallen',
      gDiveR: 'fallen',
      gHold: 'idle',
      refSkate: 'skate',
      refWhistle: 'idle',
      refPoint: 'idle',
    },
    anims: {
      idle: animFrom(L, 2, true, P.idle),
      skate: animFrom(L, 8, true, P.skate),
      windup: animFrom(L, 8, false, P.windup),
      shoot: animFrom(L, 12, false, P.shoot),
      pass: animFrom(L, 12, false, P.pass),
      poke: animFrom(L, 10, false, P.poke),
      check: animFrom(L, 10, false, P.check),
      faceoff: animFrom(L, 1, false, P.faceoff),
      celebrate: animFrom(L, 6, true, P.celebrate),
      fallen: anyDir(8, false, [drawFallenKid(true), drawFallenKid(false)]),
    },
  };
}

export { flipped };
