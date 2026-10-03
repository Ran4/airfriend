// Rink geometry + the orientation helpers every module must agree on.

import { GOAL, RINK } from '../config';
import type { PadState, TeamId, Vec2 } from '../types';

/**
 * +1 if `team` attacks toward +z in `period`, else -1.
 * HOME attacks +z in odd periods (1, 3) and in overtime; teams switch ends
 * every period.
 */
export function attackDir(team: TeamId, period: number): 1 | -1 {
  const homeDir: 1 | -1 = period % 2 === 1 || period > 3 ? 1 : -1;
  return team === 0 ? homeDir : homeDir === 1 ? -1 : 1;
}

/** z of the goal line `team` DEFENDS in `period`. */
export function ownGoalZ(team: TeamId, period: number): number {
  return -attackDir(team, period) * RINK.goalLineZ;
}

/** z of the goal line `team` ATTACKS in `period`. */
export function attackGoalZ(team: TeamId, period: number): number {
  return attackDir(team, period) * RINK.goalLineZ;
}

/** Which team defends the goal whose line is at z = sign * goalLineZ. */
export function defenderOfGoal(sign: number, period: number): TeamId {
  return Math.sign(ownGoalZ(0, period)) === Math.sign(sign) ? 0 : 1;
}

/**
 * The camera always sits behind HOME's defending end looking toward HOME's
 * attack direction, so "up" on screen always means "attack" for the human.
 *   screen up    -> world (0, +d)        where d = attackDir(0, period)
 *   screen right -> world (-d, 0)
 * (A camera looking along +z has world -x on its right.)
 */
export function screenToWorld(pad: PadState, period: number): Vec2 {
  const d = attackDir(0, period);
  const sx = (pad.right ? 1 : 0) - (pad.left ? 1 : 0);
  const sy = (pad.up ? 1 : 0) - (pad.down ? 1 : 0);
  let x = -d * sx;
  let z = d * sy;
  const len = Math.hypot(x, z);
  if (len > 0) {
    x /= len;
    z /= len;
  }
  return { x, z };
}

/** Camera yaw in world terms: the world-space heading (atan2(x,z)) the camera looks along. */
export function cameraHeading(period: number): number {
  return attackDir(0, period) === 1 ? 0 : Math.PI;
}

/** World x sign that appears as screen-RIGHT in `period` (screen right = world -d on x). */
export function screenRightX(period: number): 1 | -1 {
  return attackDir(0, period) === 1 ? -1 : 1;
}

// ---------------------------------------------------------------- boards ----
// The boards are a rounded rectangle = an inner rectangle grown by the corner
// radius, so the distance to the boards is just the distance to that inner
// rectangle. Cheap and exact.
const INNER_X = RINK.halfWidth - RINK.cornerRadius;
const INNER_Z = RINK.halfLength - RINK.cornerRadius;

interface BoardsInfo {
  /** distance from the point to the boards, positive inside the rink */
  dist: number;
  /** outward unit normal of the nearest board */
  nx: number;
  nz: number;
}

export function boardsInfo(x: number, z: number): BoardsInfo {
  const cx = Math.max(-INNER_X, Math.min(INNER_X, x));
  const cz = Math.max(-INNER_Z, Math.min(INNER_Z, z));
  const dx = x - cx;
  const dz = z - cz;
  const d = Math.hypot(dx, dz);
  if (d > 1e-6) return { dist: RINK.cornerRadius - d, nx: dx / d, nz: dz / d };
  // inside the inner rectangle: nearest straight wall
  const toSide = RINK.halfWidth - Math.abs(x);
  const toEnd = RINK.halfLength - Math.abs(z);
  return toSide < toEnd
    ? { dist: toSide, nx: Math.sign(x) || 1, nz: 0 }
    : { dist: toEnd, nx: 0, nz: Math.sign(z) || 1 };
}

/** Move p (in place) so it is at least `margin` inside the boards. Returns p. */
export function clampToRink(p: Vec2, margin: number): Vec2 {
  const b = boardsInfo(p.x, p.z);
  if (b.dist < margin) {
    p.x -= b.nx * (margin - b.dist);
    p.z -= b.nz * (margin - b.dist);
  }
  return p;
}

// ----------------------------------------------------------------- goals ----
/** Signed distance of z PAST the goal line at sign*goalLineZ (negative = in front of it). */
export const depthPastLine = (z: number, sign: number): number => (z - sign * RINK.goalLineZ) * sign;

/** Net footprint (posts included) as an axis-aligned box, for skater collisions. */
export function netBox(sign: number): { x0: number; x1: number; z0: number; z1: number } {
  const a = sign * RINK.goalLineZ;
  const b = sign * (RINK.goalLineZ + GOAL.depth);
  const hw = GOAL.halfWidth + GOAL.postRadius;
  return { x0: -hw, x1: hw, z0: Math.min(a, b), z1: Math.max(a, b) };
}

// -------------------------------------------------------------- faceoffs ----
export const CENTER_DOT: Vec2 = { x: 0, z: 0 };
const FACEOFF_DOTS: Vec2[] = [
  CENTER_DOT,
  ...[-1, 1].flatMap((sx) =>
    [-1, 1].flatMap((sz) => [
      { x: sx * RINK.neutralDot.x, z: sz * RINK.neutralDot.z },
      { x: sx * RINK.endDot.x, z: sz * RINK.endDot.z },
    ]),
  ),
];

export function nearestDot(p: Vec2): Vec2 {
  let best = FACEOFF_DOTS[0];
  let bd = Infinity;
  for (const d of FACEOFF_DOTS) {
    const dd = Math.hypot(d.x - p.x, d.z - p.z);
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return { ...best };
}

/** End-zone dot in `team`'s DEFENSIVE zone, on the side of world x `xHint`. */
export function defensiveDot(team: TeamId, period: number, xHint: number): Vec2 {
  return {
    x: (xHint >= 0 ? 1 : -1) * RINK.endDot.x,
    z: Math.sign(ownGoalZ(team, period)) * RINK.endDot.z,
  };
}
