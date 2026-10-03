import { RINK } from '../config';
import type { GameState, Skater, Vec2 } from '../types';
import { isGoalie, onIce } from '../sim/query';
import { boardsInfo } from '../sim/rink';
import { clamp, segDist } from '../sim/util';
import { W, alongOf, d2, dirOfTeam, oppGoal, openness, safeTarget, unit } from './util';

/*
 * The offensive-zone game (both teams' AI). A carrier who gets into the zone with
 * a checker on him doesn't throw a hopeful shot or skate into the stick: he
 *   - PROTECTS it: back to the checker, skating away along the boards (deeper,
 *     around behind the net if that's where the ice is), the puck tucked on the
 *     far side of his skates (skater.ts uses Intent.shield for that);
 *   - CYCLES it: the support forward hangs on the half-wall above him and the
 *     other one at the net front, and the first clean lane to either, or back
 *     to a defenseman at the point, gets it (bestPass adds cycleBonus);
 *   - at the POINT a defenseman walks the line, shoots when the lane is clear
 *     (more with a screen in front), or slides it across to his partner;
 *   - when a shot goes, the forwards crash the net (team.ts crash slots).
 * Defensemen also pinch down the wall to keep a puck in when somebody is back
 * (team.ts pickPresser / pinchOk).
 */

export const isD = (s: Skater): boolean => s.position === 'LD' || s.position === 'RD';

/** Is world point `p` in `team`'s offensive zone (with a margin past the line, m)? */
export const inOZ = (state: GameState, team: number, p: Vec2, margin = 0.5): boolean =>
  alongOf(state, team as 0 | 1, p.z) > RINK.blueLineZ + margin;

/** A pressured carrier protects the puck this long (s), re-decided at every think ... */
export const PROTECT_TIME: readonly [number, number] = [0.6, 1.1];
/** ... when a checker is within this (m) and coming, or right on him */
export const PROTECT_R = 2.9;
/** Protect target: this far along the boards ahead, and this far off them (m) */
const PROTECT_AHEAD = 4.5;
const PROTECT_OFF = 1.7;

/** ... or within this (m) when he came in alone: curl off and wait for help instead of skating into him */
export const PROTECT_R_ALONE = 4.6;
/** "alone": no teammate within this (m) who is in the zone or about to be */
const SUPPORT_R = 9;

/** No teammate close enough to work it with (see SUPPORT_R). */
export function unsupported(state: GameState, s: Skater): boolean {
  for (const t of state.skaters) {
    if (t.team !== s.team || t.id === s.id || !onIce(t) || isGoalie(t) || t.state === 'fallen') continue;
    if (d2(t.pos, s.pos) < SUPPORT_R && inOZ(state, s.team, t.pos, -3)) return false;
  }
  return true;
}

/** A defender coming at `s` (or already on him) that a carrier should protect the puck from, else null. */
export function protectThreat(state: GameState, s: Skater, r = PROTECT_R): Skater | null {
  let best: Skater | null = null;
  let bd = r;
  for (const o of state.skaters) {
    if (o.team === s.team || !onIce(o) || isGoalie(o) || o.state === 'fallen') continue;
    const d = d2(o.pos, s.pos);
    if (d >= bd) continue;
    const u = unit(s.pos.x - o.pos.x, s.pos.z - o.pos.z);
    const closing = (o.vel.x - s.vel.x) * u.x + (o.vel.z - s.vel.z) * u.z;
    if (closing < 0.3 && d > 1.7 && r <= PROTECT_R) continue;
    best = o;
    bd = d;
  }
  return best;
}

/**
 * Where a carrier protecting the puck from `from` skates: away from him along the
 * boards, preferring to go deeper (down the wall, around behind the net), never back
 * out over the blue line. Out in open ice: away from him, toward the near boards.
 */
export function protectTarget(state: GameState, s: Skater, from: Skater): Vec2 {
  const team = s.team;
  const away = unit(s.pos.x - from.pos.x, s.pos.z - from.pos.z);
  const deep = { x: 0, z: dirOfTeam(state, team) };
  const along = alongOf(state, team, s.pos.z);
  const bi = boardsInfo(s.pos.x, s.pos.z);
  const vl = Math.hypot(s.vel.x, s.vel.z);
  const vel = vl > 1 ? { x: s.vel.x / vl, z: s.vel.z / vl } : { x: 0, z: 0 };
  let t: Vec2;
  if (bi.dist > 5) {
    const d = unit(away.x + bi.nx * 0.6 + deep.x * 0.4, away.z + bi.nz * 0.6 + deep.z * 0.4);
    t = { x: s.pos.x + d.x * PROTECT_AHEAD, z: s.pos.z + d.z * PROTECT_AHEAD };
  } else {
    // the two directions along the wall; take the one away from him, keep going the way
    // I'm going, and go low unless I'm already behind the net
    const tan = [
      { x: bi.nz, z: -bi.nx },
      { x: -bi.nz, z: bi.nx },
    ];
    const score = (u: Vec2) =>
      u.x * away.x + u.z * away.z + (u.x * vel.x + u.z * vel.z) * 0.4 + (along < 24 ? (u.x * deep.x + u.z * deep.z) * 0.5 : 0);
    const u = score(tan[0]) >= score(tan[1]) ? tan[0] : tan[1];
    const wall = { x: s.pos.x + bi.nx * bi.dist, z: s.pos.z + bi.nz * bi.dist };
    t = { x: wall.x - bi.nx * PROTECT_OFF + u.x * PROTECT_AHEAD, z: wall.z - bi.nz * PROTECT_OFF + u.z * PROTECT_AHEAD };
  }
  // keep it in the zone: up at the line, turn along it toward the middle instead
  const ta = alongOf(state, team, t.z);
  if (along > RINK.blueLineZ && ta < RINK.blueLineZ + 1.8) t = W(state, team, s.pos.x * 0.55, RINK.blueLineZ + 1.8);
  return safeTarget(t, 1.3);
}

/** How deep a defenseman holds the line at the point (team frame along). */
export const POINT_ALONG = 10.2;

/**
 * A defenseman carrying at the point walks the line toward the middle to open a shooting
 * lane, and steps down into the high slot only when there's open ice in front of him.
 */
export function pointCarryTarget(state: GameState, s: Skater): Vec2 {
  const team = s.team;
  const ca = alongOf(state, team, s.pos.z);
  const ahead = W(state, team, s.pos.x * 0.6, Math.min(ca + 5, 17));
  if (openness(state, ahead, team) > 5) return safeTarget(ahead, 1.3);
  const x = Math.abs(s.pos.x) > 3 ? s.pos.x * 0.45 : s.pos.x + (s.pos.x >= 0 ? 1.5 : -1.5);
  return safeTarget(W(state, team, x, POINT_ALONG + 0.3), 1.3);
}

/** At the point: a defenseman (or anybody) on the line, between the dots. */
export const atPoint = (state: GameState, s: Skater): boolean => {
  const a = alongOf(state, s.team, s.pos.z);
  return a > RINK.blueLineZ - 0.5 && a < 15.5 && Math.abs(s.pos.x) < 10;
};

/** A teammate parked at the net front (a screen / a rebound) for a point shot. */
export function screenUp(state: GameState, s: Skater): boolean {
  const g = oppGoal(state, s.team);
  for (const t of state.skaters) {
    if (t.team !== s.team || t.id === s.id || !onIce(t) || isGoalie(t)) continue;
    if (d2(t.pos, g) < 4.2 && alongOf(state, s.team, t.pos.z) < RINK.goalLineZ) return true;
  }
  return false;
}

/** extra score (bestPass) for the safe pass back to an open defenseman at the point, under pressure */
const POINT_FEED = 0.35;
/** ... for the D-to-D slide across with a clear shooting lane on the far side */
const D_TO_D = 0.25;
/** ... for the cycle pass to a support man down low / on the wall, under pressure */
const CYCLE_FEED = 0.2;

/**
 * Offensive-zone pass bonus for `s` passing to `r` (0 outside the zone). `pressure` is
 * 0..1 (a checker on him). Backward passes don't count against a pass in the zone: the
 * cycle is about keeping it, and the point is the outlet.
 */
export function cycleBonus(state: GameState, s: Skater, r: Skater, pressure: number): number {
  const team = s.team;
  if (!inOZ(state, team, s.pos) || !inOZ(state, team, r.pos, -0.3)) return 0;
  const ra = alongOf(state, team, r.pos.z);
  const sa = alongOf(state, team, s.pos.z);
  let bonus = 0;
  // the progress term (skater.ts) charges for going back; give most of that back in here
  bonus += clamp((sa - ra) / 12, 0, 0.5) * 0.45;
  const open = openness(state, r.pos, team);
  if (atPoint(state, r) && isD(r) && open > 2.5) {
    if (atPoint(state, s)) {
      // D to D: across the line, to a partner with a shooting lane
      if (Math.sign(r.pos.x) !== Math.sign(s.pos.x) && shotLaneClear(state, r)) bonus += D_TO_D;
    } else bonus += POINT_FEED * (0.4 + 0.6 * pressure);
  } else if (!atPoint(state, s) && open > 2.2 && (ra > 18 || Math.abs(r.pos.x) > 6.5)) {
    // low / half-wall support
    bonus += CYCLE_FEED * pressure;
  }
  return bonus;
}

/** No skating opponent (goalies don't count) in the lane from `s` to the net. */
function shotLaneClear(state: GameState, s: Skater): boolean {
  const goal = oppGoal(state, s.team);
  for (const o of state.skaters) {
    if (o.team === s.team || !onIce(o) || isGoalie(o) || o.state === 'fallen') continue;
    const { d, t } = segDist(o.pos, s.pos, goal);
    if (t > 0.02 && t < 0.97 && d < 1.1) return false;
  }
  return true;
}
