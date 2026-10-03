// Read-only queries about the game state. Used by the sim and meant to be
// imported by the AI (src/ai) too. Nothing here mutates state.

import { PHYS, RULES } from '../config';
import type { GameState, Skater, TeamId, Vec2 } from '../types';
import { attackDir } from './rink';
import { dirOf, rightOf, segDist } from './util';

/** On the ice (not serving a penalty). Fallen skaters are still on the ice. */
export const onIce = (s: Skater): boolean => s.state !== 'box';

/** Can skate and use the buttons right now (not fallen/boxed/locked in a faceoff/celebrating). */
export const canAct = (s: Skater): boolean =>
  s.state !== 'box' && s.state !== 'fallen' && s.state !== 'faceoff' && s.state !== 'celebrate';

export const isGoalie = (s: Skater): boolean => s.kind === 'goalie';

/** The skater carrying the puck, or null. (A goalie in gHold counts as the carrier.) */
export function carrier(state: GameState): Skater | null {
  return state.puck.owner === null ? null : state.skaters[state.puck.owner];
}

/** Skaters of `team` on the ice, goalie included unless `skatersOnly`. */
function teamOnIce(state: GameState, team: TeamId, skatersOnly = false): Skater[] {
  return state.skaters.filter((s) => s.team === team && onIce(s) && !(skatersOnly && isGoalie(s)));
}

/** Number of non-goalie skaters `team` has on the ice (4 at even strength). */
export function skatersOnIce(state: GameState, team: TeamId): number {
  return teamOnIce(state, team, true).length;
}

/** World position of a skater's stick blade (pickup point, where a carried puck sits). */
export function stickPoint(s: Skater): Vec2 {
  const f = dirOf(s.facing);
  const reach = s.kind === 'goalie' ? 0.6 : PHYS.puckCarryDist;
  return { x: s.pos.x + f.x * reach, z: s.pos.z + f.z * reach };
}

/** A fully shielded puck (Intent.shield) rides this far ahead of the skater and this far to the side. */
const SHIELD_FWD = 0.32;
const SHIELD_SIDE = 0.42;

/** Where a carried puck sits: in front, a touch to the forehand (kids are right-handed; the dog's stick is in its mouth). */
export function carryPoint(s: Skater, time: number): Vec2 {
  const f = dirOf(s.facing);
  const r = rightOf(s.facing);
  let fwd = s.kind === 'goalie' ? 0.6 : PHYS.puckCarryDist;
  let side = s.kind === 'kid' ? 0.16 : 0;
  if (s.state === 'windup') {
    // puck drawn back to the forehand while loading up
    fwd = 0.3;
    side = s.kind === 'kid' ? 0.42 : 0.12;
  } else if (s.intent.shield && s.kind !== 'goalie') {
    // protecting it: tucked in beside the skates, on the side away from a reaching stick
    const k = Math.min(1, Math.abs(s.intent.shield));
    fwd += (SHIELD_FWD - fwd) * k;
    side += (Math.sign(s.intent.shield) * SHIELD_SIDE - side) * k;
  }
  // a little dribble wobble, faster when skating
  const sp = Math.hypot(s.vel.x, s.vel.z);
  const w = Math.sin(time * (9 + sp * 0.8) + s.id) * (0.04 + sp * 0.006);
  return { x: s.pos.x + f.x * fwd + r.x * (side + w), z: s.pos.z + f.z * fwd + r.z * (side + w) };
}

/**
 * How dangerous the lane from `a` to `b` is for a pass by `team`: sum over
 * opponents of how deep they stand inside a 1.5 m tube around the segment
 * (0 = clear, ~1 = an opponent right on the line).
 */
export function laneRisk(state: GameState, a: Vec2, b: Vec2, team: TeamId, tube = 1.5): number {
  let risk = 0;
  for (const o of state.skaters) {
    if (o.team === team || !onIce(o) || o.state === 'fallen') continue;
    const { d, t } = segDist(o.pos, a, b);
    if (t <= 0.02 || t >= 0.98) continue; // standing behind the passer / the receiver
    if (d < tube) risk += (tube - d) / tube;
  }
  return risk;
}

/** Unit world vector of `team`'s attack direction this period. */
export const attackVec = (state: GameState, team: TeamId): Vec2 => ({ x: 0, z: attackDir(team, state.period) });

/**
 * Where a loose puck will be after `t` seconds if nothing touches it
 * (ice friction only, ignores boards). Handy for intercept targets.
 */
export function predictPuck(state: GameState, t: number): Vec2 {
  const p = state.puck;
  const sp = Math.hypot(p.vel.x, p.vel.z);
  if (sp < 1e-6) return { ...p.pos };
  const tStop = sp / PHYS.puckFriction;
  const tt = Math.min(t, tStop);
  const d = sp * tt - 0.5 * PHYS.puckFriction * tt * tt;
  return { x: p.pos.x + (p.vel.x / sp) * d, z: p.pos.z + (p.vel.z / sp) * d };
}

/** Period length for a period number (OT is shorter/longer per config). */
export const periodLength = (period: number): number => (period > RULES.periods ? RULES.overtimeLength : RULES.periodLength);
