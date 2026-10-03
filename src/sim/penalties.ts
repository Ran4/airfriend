// Penalties: the probabilistic call on body checks, infraction naming,
// minor/major, the box, power-play accounting (early minor expiry on a PP
// goal) and the max-2-in-the-box queue.

import { RINK, RULES } from '../config';
import type { GameState, Penalty, Skater, TeamId, Vec2 } from '../types';
import { loosePuck } from './puckops';
import { skatersOnIce } from './query';
import { defensiveDot } from './rink';
import { clamp, emit, gs, rand, sk } from './util';

export interface HitContext {
  hitter: Skater;
  victim: Skater;
  force: number;
  victimHadPuck: boolean;
  fromBehind: boolean;
  nearBoards: boolean;
  /** lots of travel or turbo into the hit */
  charging: boolean;
}

/** Max penalties served at once per team (4 skaters -> never fewer than 2 skaters + goalie). */
export const MAX_BOXED = 2;

/** The force curve alone: clamp((f - min)/(max - min), 0, 1)^curve * maxChance. */
export function basePenaltyChance(force: number): number {
  const t = clamp((force - RULES.penaltyForceMin) / (RULES.penaltyForceMax - RULES.penaltyForceMin), 0, 1);
  return Math.pow(t, RULES.penaltyCurve) * RULES.penaltyMaxChance;
}

/** Full call probability for a hit, with the situational multipliers. */
export function penaltyChance(h: HitContext): number {
  let p = basePenaltyChance(h.force);
  if (!h.victimHadPuck) p *= 1.6; // interference
  if (h.fromBehind) p *= 1.5;
  if (h.nearBoards) p *= 1.2;
  if (h.victim.kind === 'goalie') p *= 3; // goalie interference
  return Math.min(p, 0.95);
}

/** What the ref calls it, by situation and force. `r` is a random number for flavor. */
export function infractionFor(h: HitContext, r: number = rand()): string {
  if (h.victim.kind === 'goalie') return 'GOALIE INTERFERENCE';
  if (!h.victimHadPuck) return 'INTERFERENCE';
  if (h.fromBehind) return 'CHECKING FROM BEHIND';
  if (h.nearBoards) return 'BOARDING';
  if (h.force >= 9 && h.charging) return 'CHARGING';
  if (h.force >= 6.5 && r < 0.4) return 'ELBOWING';
  return 'ROUGHING';
}

/** Roll the dice for a hit. Returns the Penalty to call, or null. */
export function rollPenalty(state: GameState, h: HitContext): Penalty | null {
  if (state.phase !== 'play') return null;
  if (rand() >= penaltyChance(h)) return null;
  const major = h.force >= RULES.majorForce;
  const duration = major ? RULES.majorLength : RULES.minorLength;
  return {
    skaterId: h.hitter.id,
    team: h.hitter.team,
    infraction: infractionFor(h),
    duration,
    remaining: duration,
    major,
  };
}

/** Where boxed skater number `slot` (0/1) of `team` sits. */
export function boxSlotPos(team: TeamId, slot: number): Vec2 {
  return { x: RINK.penaltyBoxX, z: RINK.penaltyBoxZ[team] + (slot === 0 ? -0.6 : 0.6) };
}

/** Seat `pen`'s skater on the free bench spot (never on top of a teammate still serving). */
function sendToBox(state: GameState, s: Skater, pen: Penalty): void {
  if (state.puck.owner === s.id) loosePuck(state, 0, 0);
  const taken = state.penalties.filter((q) => q !== pen && q.team === s.team && q.skaterId !== s.id).map((q) => q.seat ?? 0);
  pen.seat = taken.includes(0) ? 1 : 0;
  const at = boxSlotPos(s.team, pen.seat);
  s.state = 'box';
  s.stateTime = 0;
  s.pos.x = at.x;
  s.pos.z = at.z;
  s.vel.x = s.vel.z = 0;
  s.facing = -Math.PI / 2; // looking at the ice
  s.windup = 0;
  s.turboActive = false;
  s.stun = 0;
  s.invuln = 0;
}

/**
 * Book a called penalty: the 'penalty' event, PIM, and the offender to the box
 * (or the queue). No whistle and no phase change: callPenalties does those,
 * and a major still owed after a goal is served this way during the goal.
 */
function servePenalty(state: GameState, pen: Penalty): void {
  emit(state, { type: 'penalty', penalty: pen });
  state.lastPenaltyCall = pen;
  const s = state.skaters[pen.skaterId];
  s.stats.pim += pen.duration;
  const queue = (state.penaltyQueue ??= []);
  const active = state.penalties.filter((q) => q.team === pen.team).length;
  const alreadyIn = state.penalties.some((q) => q.skaterId === pen.skaterId);
  if (active >= MAX_BOXED || alreadyIn) queue.push(pen);
  else {
    state.penalties.push(pen);
    sendToBox(state, s, pen);
  }
}

/**
 * Whistle one or more penalties together: banner phase, offenders to the box
 * (or the queue), faceoff in the zone of the last offender next.
 */
export function callPenalties(state: GameState, pens: Penalty[]): void {
  if (!pens.length) return;
  const G = gs(state);
  emit(state, { type: 'whistle', reason: 'penalty' });
  for (const pen of pens) servePenalty(state, pen);
  const puck = state.puck;
  G.nextSpot = defensiveDot(pens[pens.length - 1].team, state.period, puck.pos.x);
  if (puck.owner !== null && state.skaters[puck.owner].state !== 'box') {
    puck.owner = null;
  }
  puck.vel.x = puck.vel.z = 0;
  G.frozenBy = null;
  G.outOfPlay = false;
  clearDelayed(state);
  state.callFor = null;
  state.phase = 'penalty';
  state.phaseTime = 0;
  state.referee.state = 'point';
  state.referee.stateTime = 0;
}

// ------------------------------------------------------- delayed penalty ----
// A rolled foul is not whistled at once: the fouled team plays on (it usually
// has the puck, often on a rush) until the offending team touches the puck,
// the puck goes dead, or DELAYED_PENALTY_MAX passes. The ref points meanwhile.

/** longest a delayed call waits for its whistle (s of play) */
export const DELAYED_PENALTY_MAX = 10;
/**
 * The offender is tangled up with the man he fouled: he can't play the puck
 * for this long. Without it the hitter collects the puck he just knocked off
 * the carrier on the very same tick (his blade is right there), and the
 * "delayed" call is whistled at once, rush and all.
 */
export const DELAYED_OFFENDER_TANGLE = 0.6;

/** Fouls waiting for the whistle (empty when there is no delayed penalty). */
export function pendingPenalties(state: GameState): Penalty[] {
  return (gs(state).pendingPenalties ??= []);
}

/** Does a team with a pending foul hold the puck, or has one of its skaters touched it since the delay began? */
export function offenderHasPuck(state: GameState): boolean {
  const pend = pendingPenalties(state);
  if (!pend.length) return false;
  if (gs(state).delayedTouch) return true;
  const o = state.puck.owner;
  return o !== null && pend.some((q) => q.team === state.skaters[o].team);
}

/**
 * A foul has been rolled in live play. If the offending team has the puck it
 * is whistled at once; otherwise the call is delayed (a second foul while one
 * is pending joins it, and both are called together).
 */
export function delayPenalty(state: GameState, pen: Penalty): void {
  const G = gs(state);
  const pend = pendingPenalties(state);
  if (!pend.length) G.delayedTouch = false; // touches before the foul don't count
  pend.push(pen);
  if (offenderHasPuck(state)) {
    callPendingPenalties(state);
    return;
  }
  const off = sk(state.skaters[pen.skaterId]);
  off.recvCd = Math.max(off.recvCd, DELAYED_OFFENDER_TANGLE);
  if (!state.delayedPenalty) state.delayedPenalty = { team: pen.team, skaterId: pen.skaterId, t: state.time };
  emit(state, { type: 'delayedPenalty', team: pen.team, skaterId: pen.skaterId });
  state.referee.state = 'point';
  state.referee.stateTime = 0;
}

/** Has the delayed call waited long enough? */
export function delayedPenaltyExpired(state: GameState): boolean {
  const d = state.delayedPenalty;
  return !!d && state.time - d.t >= DELAYED_PENALTY_MAX - 1e-9;
}

/** Whistle every pending foul now (the penalty phase, box and faceoff as for any call). */
export function callPendingPenalties(state: GameState): void {
  const pend = pendingPenalties(state).splice(0);
  callPenalties(state, pend);
}

/**
 * `scoringTeam` scored while fouls were pending: the scored-on team's minors
 * are wiped out (the fouled team got its goal), everything else is served now,
 * without a penalty phase (the goal phase and its center faceoff go on).
 */
export function resolvePendingOnGoal(state: GameState, scoringTeam: TeamId): void {
  const pend = pendingPenalties(state).splice(0);
  for (const pen of pend) {
    if (pen.team !== scoringTeam && !pen.major) continue;
    servePenalty(state, pen);
  }
  clearDelayed(state);
}

function clearDelayed(state: GameState): void {
  const G = gs(state);
  G.pendingPenalties = [];
  G.delayedTouch = false;
  state.delayedPenalty = null;
}

function returnFromBox(state: GameState, s: Skater): void {
  s.state = 'skate';
  s.stateTime = 0;
  s.pos.x = RINK.halfWidth - 1.0;
  s.pos.z = RINK.penaltyBoxZ[s.team];
  s.vel.x = -3;
  s.vel.z = 0;
  s.facing = -Math.PI / 2;
  s.invuln = 0.6;
  emit(state, { type: 'penaltyExpired', skaterId: s.id });
}

/** End penalty `pen` now: the skater returns (unless they owe more time) and the queue advances. */
function expirePenalty(state: GameState, pen: Penalty): void {
  const i = state.penalties.indexOf(pen);
  if (i < 0) return;
  state.penalties.splice(i, 1);
  const queue = (state.penaltyQueue ??= []);
  const s = state.skaters[pen.skaterId];
  // same skater owes more time: keep sitting
  const own = queue.findIndex((q) => q.skaterId === s.id);
  if (own >= 0) {
    const more = queue.splice(own, 1)[0];
    more.seat = pen.seat;
    state.penalties.push(more);
    return;
  }
  returnFromBox(state, s);
  const next = queue.findIndex((q) => q.team === pen.team && !state.penalties.some((a) => a.skaterId === q.skaterId));
  if (next >= 0) {
    const q = queue.splice(next, 1)[0];
    state.penalties.push(q);
    sendToBox(state, state.skaters[q.skaterId], q);
  }
}

/** Count penalty clocks down. Only call while the game clock runs. */
export function updatePenalties(state: GameState, dt: number): void {
  for (const pen of [...state.penalties]) {
    pen.remaining -= dt;
    if (pen.remaining <= 0) {
      pen.remaining = 0;
      expirePenalty(state, pen);
    }
  }
}

/**
 * A goal by `scoringTeam` while it had more skaters: the shorthanded team's
 * minor with the least time left ends early. Majors are served in full.
 */
export function powerPlayGoal(state: GameState, scoringTeam: TeamId): void {
  const other = (1 - scoringTeam) as TeamId;
  if (skatersOnIce(state, scoringTeam) <= skatersOnIce(state, other)) return;
  const minors = state.penalties.filter((q) => q.team === other && !q.major).sort((a, b) => a.remaining - b.remaining);
  if (minors.length) expirePenalty(state, minors[0]);
}
