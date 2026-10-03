import { GOAL, PHYS, RINK } from '../config';
import type { ButtonState, GameState, Skater, TeamId, Vec2 } from '../types';
import { canAct, isGoalie, laneRisk, onIce, predictPuck, stickPoint } from '../sim/query';
import { SAUCER_LAND, passLead, saucerFor } from '../sim/actions';
import { attackDir, attackGoalZ, clampToRink, ownGoalZ } from '../sim/rink';
import { clamp, gauss, segDist } from '../sim/util';

/*
 * Small geometry and judgement helpers shared by the AI modules.
 *
 * Most tactical code thinks in a TEAM FRAME: `x` is world x (unchanged) and
 * `a` ("along") is how far up ice a point is for that team, so the attacking
 * goal line is always at a = +26.5 and the own goal line at a = -26.5. That
 * keeps every formation table free of period/end bookkeeping.
 */

/** Drive a button toward `held` with correct pressed/released edges. */
export function setBtn(b: ButtonState, held: boolean): void {
  b.pressed = held && !b.held;
  b.released = !held && b.held;
  b.held = held;
}

export const ZERO: Vec2 = { x: 0, z: 0 };

/** +1/-1: world z sign of `team`'s attack direction this period. */
export const dirOfTeam = (state: GameState, team: TeamId): number => attackDir(team, state.period);

/** Team-frame "along" coordinate of world z. */
export const alongOf = (state: GameState, team: TeamId, z: number): number => z * dirOfTeam(state, team);

/** Team frame (x, along) -> world point. */
export const W = (state: GameState, team: TeamId, x: number, a: number): Vec2 => ({ x, z: a * dirOfTeam(state, team) });

export const ownGoal = (state: GameState, team: TeamId): Vec2 => ({ x: 0, z: ownGoalZ(team, state.period) });
export const oppGoal = (state: GameState, team: TeamId): Vec2 => ({ x: 0, z: attackGoalZ(team, state.period) });

export const d2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

export function unit(x: number, z: number): Vec2 {
  const l = Math.hypot(x, z);
  return l > 1e-9 ? { x: x / l, z: z / l } : { x: 0, z: 0 };
}

/** Keep an AI target point on the ice and out of the nets. */
export function safeTarget(p: Vec2, margin = 1.2): Vec2 {
  const q = clampToRink({ x: p.x, z: p.z }, margin);
  // skating "into" the net frame just grinds against it; aim beside it instead
  for (const sign of [1, -1]) {
    const gz = sign * RINK.goalLineZ;
    const past = (q.z - gz) * sign;
    if (past > -0.9 && past < GOAL.depth + 0.9 && Math.abs(q.x) < GOAL.halfWidth + 0.9) {
      q.x = (Math.sign(q.x) || 1) * (GOAL.halfWidth + 0.9);
    }
  }
  return q;
}

/**
 * Steering toward `t` with arrival: the desired speed falls off so the skater
 * coasts into the spot instead of overshooting and reversing (which looks
 * robotic and sprays ice every second). `brake` is the deceleration (m/s^2)
 * the approach is planned for; `urgency` scales the top speed (0..1).
 */
export function arrive(s: Skater, t: Vec2, brake = 3.2, urgency = 1, stopR = 0.35): Vec2 {
  const dx = t.x - s.pos.x;
  const dz = t.z - s.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < stopR) return { x: 0, z: 0 };
  const want = Math.min(s.attrs.maxSpeed * urgency, Math.sqrt(2 * brake * Math.max(0, d - stopR * 0.5)));
  const k = clamp(want / s.attrs.maxSpeed, 0, 1) / d;
  return { x: dx * k, z: dz * k };
}

/** Full-speed heading toward a point (pursuit, no slowing). */
export function rush(s: Skater, t: Vec2): Vec2 {
  return unit(t.x - s.pos.x, t.z - s.pos.z);
}

/** Push away from teammates that are too close, so nobody swarms the same ice. */
export function separation(state: GameState, s: Skater, radius = 3.2, ignore = -1): Vec2 {
  let x = 0;
  let z = 0;
  for (const o of state.skaters) {
    if (o.id === s.id || o.team !== s.team || o.id === ignore || !onIce(o) || isGoalie(o)) continue;
    const dx = s.pos.x - o.pos.x;
    const dz = s.pos.z - o.pos.z;
    const d = Math.hypot(dx, dz);
    if (d >= radius || d < 1e-4) continue;
    const w = (radius - d) / radius;
    x += (dx / d) * w;
    z += (dz / d) * w;
  }
  return { x, z };
}

/** Add vectors and clamp the result to length 1 (a valid intent.move). */
export function blend(...vs: [Vec2, number][]): Vec2 {
  let x = 0;
  let z = 0;
  for (const [v, w] of vs) {
    x += v.x * w;
    z += v.z * w;
  }
  const l = Math.hypot(x, z);
  return l > 1 ? { x: x / l, z: z / l } : { x, z };
}

/** Distance from `p` to the nearest skating opponent of `team` (goalies excluded) that is upright. */
export function openness(state: GameState, p: Vec2, team: TeamId): number {
  let d = 99;
  for (const o of state.skaters) {
    if (o.team === team || !onIce(o) || isGoalie(o) || o.state === 'fallen') continue;
    d = Math.min(d, Math.hypot(o.pos.x - p.x, o.pos.z - p.z));
  }
  return d;
}

/**
 * How good a shot from `p` would be for `team`, roughly 0..1: the part of the
 * goal mouth the goalie doesn't cover (as an angle), shrunk with distance
 * (long shots give the goalie time) and by bodies in the lane.
 */
export function shotQuality(state: GameState, p: Vec2, team: TeamId, ignoreBlockers = false): number {
  const gz = attackGoalZ(team, state.period);
  const sign = Math.sign(gz);
  const out = (gz - p.z) * sign; // distance in front of the goal line
  if (out < 0.4) return 0; // behind or on the line: wraparounds only
  const g = state.skaters[team === 0 ? 9 : 4];
  const angTo = (x: number) => Math.atan2(x - p.x, out);
  const a0 = angTo(-GOAL.halfWidth + 0.08);
  const a1 = angTo(GOAL.halfWidth - 0.08);
  let open = a1 - a0;
  if (onIce(g) && g.state !== 'fallen') {
    // the goalie's body seen from the shooter, projected onto the goal line
    const gOut = Math.max(0.15, (gz - g.pos.z) * sign);
    const half = g.state === 'gButterfly' ? 0.7 : 0.48;
    const scale = out / Math.max(0.3, out - gOut);
    const c = p.x + (g.pos.x - p.x) * scale;
    const s0 = angTo(c - half * scale);
    const s1 = angTo(c + half * scale);
    open -= Math.max(0, Math.min(a1, s1) - Math.max(a0, s0));
  }
  const dist = Math.hypot(p.x, out);
  // with a square goalie only ~0.05-0.09 rad of net shows from anywhere in the slot;
  // ~0.1 rad open is a great look. Distance costs less than you'd think: a loaded
  // slapper from 10 m beats a set goalie about as often as one from 6 m.
  let q = Math.max(0, open) / 0.1;
  q *= clamp(1.15 - dist / 22, 0.2, 1);
  if (!ignoreBlockers) {
    const goal = { x: 0, z: gz };
    for (const o of state.skaters) {
      if (o.team === team || !onIce(o) || isGoalie(o) || o.state === 'fallen') continue;
      const { d, t } = segDist(o.pos, p, goal);
      if (t > 0.05 && t < 0.92 && d < 0.9) q *= 0.35 + 0.65 * (d / 0.9);
    }
  }
  return clamp(q, 0, 1.2);
}

/**
 * Corner to aim at (world x on the goal line), away from where the goalie
 * leans. Aimed like a human's held-direction shot (+-0.58 m), with a spread
 * that shrinks with shooting skill: the AI must not out-snipe the player, so
 * close-range goals have to come from beating the goalie's position (passes,
 * rebounds, dekes) rather than from pixel-perfect corners.
 */
export function pickCorner(state: GameState, s: Skater, rnd: number): number {
  const team = s.team;
  const g = state.skaters[team === 0 ? 9 : 4];
  const gx = onIce(g) ? g.pos.x : 0;
  const lean = gx - s.pos.x * 0.12; // where he is relative to the center of the angle
  let side = Math.abs(lean) > 0.12 ? -Math.sign(lean) : rnd < 0.5 ? -1 : 1;
  // sometimes go short side anyway: the goalie can't cheat on everything
  if (rnd > 0.85) side = -side;
  return side * (0.58 + gauss() * 0.11 * (1.3 - s.attrs.shot));
}

/**
 * How carefully a passer reads the lane (passRisk): `blade` = a defender's blade within this
 * many meters of the puck's path takes it with no reaction at all (0 = only the open-ice
 * race counts); `shadow` = a defender standing between the receiver and the passer, close
 * to the receiver, owns the pass.
 */
export interface LaneRead {
  blade: number;
  shadow: boolean;
  /**
   * How hard defenders are expected to skate to cut the pass off (x their open-ice speed,
   * default 1). Below 1: a read of defenders who hold their spots (the cycle reads the zone
   * that way: they're marking, not jumping lanes; only sticks near the lane count much).
   */
  chase?: number;
}
/** everything: what a pass has to get through (pickup radius plus a little) */
export const SHARP_READ: LaneRead = { blade: PHYS.pickupRadius + 0.15, shadow: true };
/** the open-ice race only */
export const OPEN_READ: LaneRead = { blade: 0, shadow: false };

/**
 * Interception risk of a pass from `a` to the receiver `r`, roughly the
 * number of opponents that could get a stick on it (0 = safe, >= 1 = likely
 * picked off). Walks the puck's path (aimed where the sim's pass will go: at
 * the receiver's blade, led by his skating) and asks, for each opponent,
 * whether he can skate to that point before the puck gets there. With a
 * sharper `read` (LaneRead), a blade already on the path takes it with no
 * reaction, and a defender shadowing the receiver as good as owns it.
 */
export function passRisk(state: GameState, a: Vec2, r: Skater, team: TeamId, read: LaneRead = SHARP_READ): number {
  // aimed like sim/actions doPass: at his blade, led by his skating
  const blade = stickPoint(r);
  const leadK = passLead(state, r);
  let aim = { x: blade.x, z: blade.z };
  let speed = 12;
  for (let i = 0; i < 2; i++) {
    const dd = Math.hypot(aim.x - a.x, aim.z - a.z);
    speed = clamp(7 + dd * 0.75, 9, 16);
    const t = dd / speed;
    aim = { x: blade.x + r.vel.x * t * leadK, z: blade.z + r.vel.z * t * leadK };
  }
  // a saucer (sim/actions saucerFor) is slower, and out of reach in the middle of its flight
  const sc = saucerFor(state, a, aim, team);
  if (sc) aim = { x: blade.x + r.vel.x * sc.time * leadK, z: blade.z + r.vel.z * sc.time * leadK };
  const len = Math.hypot(aim.x - a.x, aim.z - a.z);
  if (len < 0.5) return 0;
  if (sc) speed = (len * SAUCER_LAND) / sc.time;
  let risk = 0;
  for (const o of state.skaters) {
    if (o.team === team || !onIce(o) || o.state === 'fallen') continue;
    const goalie = isGoalie(o);
    const sp = stickPoint(o);
    let worst = 0;
    for (let f = 0; f <= 1.0001; f += 0.06) {
      const px = a.x + (aim.x - a.x) * f;
      const pz = a.z + (aim.z - a.z) * f;
      const tPuck = (len * f) / speed;
      if (sc && sc.vy * tPuck - 0.5 * PHYS.gravity * tPuck * tPuck > PUCK_REACH_Y) continue;
      // reach = pickup radius plus the blade sitting ~0.5 m in front of the body
      const gap = Math.hypot(o.pos.x - px, o.pos.z - pz) - (goalie ? 1.0 : 1.05);
      // his blade, carried along by his skating for the first beat
      const lead = Math.min(tPuck, 0.25);
      const onPath = Math.hypot(sp.x + o.vel.x * lead - px, sp.z + o.vel.z * lead - pz) <= read.blade;
      // a stick already in the lane takes it without having to react
      const tO = gap <= 0 || onPath ? -1 : gap / ((goalie ? 3.5 : o.attrs.maxSpeed * 0.85) * (read.chase ?? 1)) + (o.stun > 0 ? 0.35 : 0.18);
      // right at the receiver's spot he has to beat the receiver to it: a bit less likely
      const w = f > 0.94 ? 0.7 : 1;
      worst = Math.max(worst, clamp((tPuck - tO) / 0.25 + 0.5, 0, 1) * w);
    }
    if (read.shadow && !goalie && worst < 1) {
      // shadowing: on the passer's side of the receiver and close to him
      const { d, t } = segDist(o.pos, a, aim);
      const dr = Math.hypot(o.pos.x - aim.x, o.pos.z - aim.z);
      if (dr < SHADOW_R && t > 0.45 && t < 0.999 && d < SHADOW_LAT) worst = 1;
    }
    risk += worst;
  }
  return risk;
}

/** a puck higher than this can't be picked up (sim/physics tryPickups) */
const PUCK_REACH_Y = 0.5;
/** A defender within this of the receiver, between him and the passer ... */
const SHADOW_R = 2.2;
/** ... and at most this far off the passing line, picks the pass off (LaneRead.shadow). */
const SHADOW_LAT = 1.3;

/** Lane danger for a pass from a to b (0 = clear). */
export const lane = (state: GameState, a: Vec2, b: Vec2, team: TeamId): number => laneRisk(state, a, b, team, 1.3);

/**
 * Earliest point where `s` can get to a loose puck: walks the puck's
 * predicted path and returns the first spot the skater can reach in time.
 */
export function interceptPoint(state: GameState, s: Skater, react = 0.15): { p: Vec2; t: number } {
  const sp = s.attrs.maxSpeed * 0.92;
  for (let t = 0; t <= 2.4; t += 0.1) {
    const p = predictPuck(state, t);
    const reach = Math.hypot(p.x - s.pos.x, p.z - s.pos.z) - 0.6;
    if (reach / sp + react <= t) return { p: clampToRink(p, 0.6), t };
  }
  const p = predictPuck(state, 2.4);
  return { p: clampToRink(p, 0.6), t: 2.4 + Math.hypot(p.x - s.pos.x, p.z - s.pos.z) / sp };
}

/** Teammates that can take a pass right now. */
export const receivers = (state: GameState, s: Skater): Skater[] =>
  state.skaters.filter((t) => t.team === s.team && t.id !== s.id && canAct(t) && !isGoalie(t));

/** Velocity component of `s` toward point `p` (closing speed). */
export function closing(s: Skater, p: Vec2): number {
  const u = unit(p.x - s.pos.x, p.z - s.pos.z);
  return s.vel.x * u.x + s.vel.z * u.z;
}

/** Is `o` roughly in front of `s` along direction `dir` (cosine threshold)? */
export function inFront(s: Skater, o: Vec2, dir: Vec2, cos = 0.5): boolean {
  const u = unit(o.x - s.pos.x, o.z - s.pos.z);
  return u.x * dir.x + u.z * dir.z > cos;
}
