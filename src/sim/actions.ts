// Turns a skater's Intent into actions. Human pads and the AI both write
// Intents, and this file interprets them identically: turbo, BARK, windup and
// shot, pass, poke check, body check (+ the hit force model), and the
// call-for-pass / call-for-shot when a teammate is carrying.

import { GOAL, PHYS, SHOT } from '../config';
import type { GameState, Skater, Vec2 } from '../types';
import { delayPenalty, rollPenalty } from './penalties';
import { loosePuck, touchPuck } from './puckops';
import { attackVec, canAct, isGoalie, laneRisk, onIce, stickPoint } from './query';
import { attackGoalZ, boardsInfo } from './rink';
import { angleDiff, clamp, dirOf, emit, gauss, gs, headingOf, lerp, norm, rand, randRange, segDist, sk } from './util';

/** follow-through / animation lengths (seconds) */
export const ACTION_TIME = { shoot: 0.25, pass: 0.2, poke: 0.35, check: 0.3 } as const;
export const BARK_COOLDOWN = 2.5;
export const BARK_RADIUS = 3.0;
/**
 * TURBO is both the sprint and the bark, so a press only barks when that is what the
 * player is after (barkWanted): an opponent carrier within BARK_TRIGGER_RADIUS (a step
 * outside BARK_RADIUS: he's closing), or, while PAL carries, a defender squaring up in
 * front of him inside BARK_RADIUS (within BARK_FRONT_COS of his heading). Otherwise the
 * press just sprints and keeps the bark ready - racing a Blizzard kid to a loose puck or
 * backchecking past one no longer burns it - unless the button comes back up within
 * BARK_TAP_TIME: a deliberate tap always barks.
 */
export const BARK_TRIGGER_RADIUS = BARK_RADIUS + 1.5;
const BARK_FRONT_COS = 0.5;
export const BARK_TAP_TIME = 0.18;
export const BARK_FUMBLE_RADIUS = 2.5;
/** Fumble chance of an average-handling (0.55) carrier barked at inside BARK_FUMBLE_RADIUS. */
export const BARK_FUMBLE_BASE = 0.2;
/** A carrier poked at again within this long of the last poke is guarding it: POKE_REPEAT_MALUS off the chance. */
export const POKE_REPEAT_WINDOW = 0.75;
export const POKE_REPEAT_MALUS = 0.15;
/**
 * A puck the carrier keeps on the far side of his body from the poker (his back turned to
 * him, the puck tucked in: AI puck protection, or a player skating away) is reached around
 * him: the chance is multiplied by this.
 */
const POKE_SHIELD_MUL = 0.5;
/** a call for pass/shot stays valid this long */
export const CALL_FOR_TIME = 1.2;
/** below this force a lunge contact doesn't count as a hit */
const MIN_HIT_FORCE = 1.0;

/**
 * How much of his skating a pass leads the receiver by: an AI receiver eases into his
 * spot; a human holds the direction (and keeps accelerating along it).
 */
const PASS_LEAD = 0.9;
const PASS_LEAD_HUMAN = 1.0;

/** Lead factor for a pass to `target` (see PASS_LEAD). */
export const passLead = (state: GameState, target: Skater): number =>
  target.id === state.controlledId && !state.autoplay ? PASS_LEAD_HUMAN : PASS_LEAD;

/** Process one skater's intent for this tick (phase `play`, non-goalie, on ice). */
export function updateActions(state: GameState, s: Skater, dt: number): void {
  const it = s.intent;
  const d = sk(s);
  const p = state.puck;
  if (!canAct(s)) {
    s.turboActive = false;
    s.windup = 0;
    return;
  }
  const has = p.owner === s.id;

  // --- turbo (hold) with the stamina lockout
  if (s.stamina <= 0) d.turboLock = true;
  if (d.turboLock && s.stamina > 0.25) d.turboLock = false;
  const moving = Math.hypot(it.move.x, it.move.z) > 0.1;
  const turbo = it.turbo.held && moving && s.state !== 'windup' && !d.turboLock && s.stamina > 0;
  if (turbo && !s.turboActive) emit(state, { type: 'turboStart', skaterId: s.id });
  s.turboActive = turbo;
  s.stamina = clamp(s.stamina + (turbo ? -PHYS.staminaDrain : PHYS.staminaRegen) * dt, 0, 1);

  // --- BARK (dog only): a TURBO press near an opponent, or a quick tap
  if (s.kind === 'dog') updateBark(state, s);

  if (s.state === 'windup' && !has) {
    s.state = 'skate';
    s.windup = 0;
  }

  if (has) {
    // SHOOT was already down when the puck arrived (a one-timer, or a held button)
    if (s.state !== 'windup' && it.shoot.held && d.shootHeldTime > 0) {
      const held = d.shootHeldTime;
      d.shootHeldTime = 0;
      s.windup = clamp(0.3 + (held / PHYS.windupTime) * 0.7, 0, 1);
      if (held < SHOT.oneTimerMaxHold && distToAttackedNet(state, s) <= SHOT.oneTimerRange) {
        releaseShot(state, s);
        return;
      }
      // too far out for a one-timer, or the button was held too long to be
      // one: load the stick at that charge instead, and the release shoots
      s.state = 'windup';
      s.stateTime = 0;
    }
    d.shootHeldTime = 0;
    if (it.shoot.pressed && s.state !== 'windup') {
      s.state = 'windup';
      s.stateTime = 0;
      s.windup = 0;
    }
    if (s.state === 'windup') {
      if (it.shoot.held && !it.shoot.released) s.windup = Math.min(1, s.windup + dt / PHYS.windupTime);
      else releaseShot(state, s);
    } else if (it.pass.pressed) {
      doPass(state, s);
    }
  } else {
    d.shootHeldTime = it.shoot.held ? d.shootHeldTime + dt : 0;
    const mate = p.owner !== null ? state.skaters[p.owner] : null;
    const mateHas = !!mate && mate.team === s.team && mate.id !== s.id;
    // a teammate's pass on its way (to me or anyone) is still our puck: the
    // buttons keep their "teammate has it" meaning instead of flipping to a
    // poke / body check that would knock it away or carry me off the line.
    // SHOOT held now primes a one-timer (shootHeldTime above).
    const ours = mateHas || matePassInFlight(state, s);
    if (it.shoot.pressed) {
      if (mateHas) callFor(state, s, 'shot', mate!);
      else if (!ours && d.actionCd <= 0 && s.stun <= 0) startPoke(s);
    }
    if (it.pass.pressed) {
      if (mateHas) callFor(state, s, 'pass', mate!);
      else if (!ours && d.actionCd <= 0 && s.stun <= 0) startCheck(s);
    }
  }

  if (s.state === 'poke' && !d.pokeDone && s.stateTime >= 0.08) resolvePoke(state, s);
  if (s.state === 'check' && !d.hitDone && s.stateTime < ACTION_TIME.check) resolveCheck(state, s);
}

/** Distance (m) from `s` to the middle of the net his team attacks. */
function distToAttackedNet(state: GameState, s: Skater): number {
  return Math.hypot(s.pos.x, attackGoalZ(s.team, state.period) - s.pos.z);
}

/**
 * The loose puck is a teammate's pass coming to `s`: aimed at him (and not too
 * old to arrive), or simply sliding right at him.
 */
function passIncoming(state: GameState, s: Skater): boolean {
  const p = state.puck;
  const pass = gs(state).pass;
  if (!pass || !passStillTravels(state, s, pass)) return false;
  if (state.time - pass.time > SHOT.passIncomingTime) return false;
  if (pass.to === s.id) return true;
  const dx = s.pos.x - p.pos.x;
  const dz = s.pos.z - p.pos.z;
  const dd = Math.hypot(dx, dz);
  const sp = Math.hypot(p.vel.x, p.vel.z);
  return dd < 12 && sp > 3 && (dx * p.vel.x + dz * p.vel.z) / (dd * sp) > 0.97;
}

/** A teammate's pass left his stick moments ago (or is on its way to `s`): the puck is still "ours". */
function matePassInFlight(state: GameState, s: Skater): boolean {
  const pass = gs(state).pass;
  if (!pass || !passStillTravels(state, s, pass)) return false;
  return state.time - pass.time < SHOT.matePassTime || passIncoming(state, s);
}

/** a teammate's pass, loose and untouched since it left his stick */
function passStillTravels(state: GameState, s: Skater, pass: { from: number }): boolean {
  const p = state.puck;
  return p.owner === null && pass.from !== s.id && p.lastTouch === pass.from && state.skaters[pass.from].team === s.team;
}

function callFor(state: GameState, s: Skater, kind: 'pass' | 'shot', mate: Skater): void {
  state.callFor = { kind, from: s.id, carrier: mate.id, time: state.time };
  emit(state, { type: 'callFor', kind, skaterId: s.id, carrier: mate.id });
}

// ------------------------------------------------------------------ BARK ----

/**
 * A TURBO press by `s` right now would be a bark on purpose (the same two cases the AI
 * dog barks in): an opponent carrier within BARK_TRIGGER_RADIUS (startle him into a
 * fumble), or `s` carrying with an opponent skater inside BARK_RADIUS ahead of him (in
 * his way). Goalies don't count: a press driving the net sprints at him, a tap barks.
 */
export function barkWanted(state: GameState, s: Skater): boolean {
  const f = dirOf(s.facing);
  const carrying = state.puck.owner === s.id;
  for (const o of state.skaters) {
    if (o.team === s.team || !onIce(o) || isGoalie(o) || o.state === 'fallen') continue;
    const dx = o.pos.x - s.pos.x;
    const dz = o.pos.z - s.pos.z;
    const dd = Math.hypot(dx, dz);
    if (state.puck.owner === o.id && dd < BARK_TRIGGER_RADIUS) return true;
    if (carrying && dd < BARK_RADIUS && dx * f.x + dz * f.z > BARK_FRONT_COS * dd) return true;
  }
  return false;
}

/**
 * TURBO press -> bark, when it's off cooldown and barkWanted. Otherwise the press only
 * sprints; it barks after all if the button is let go again within BARK_TAP_TIME (a
 * tap is a bark on purpose, not the start of a sprint).
 */
function updateBark(state: GameState, s: Skater): void {
  const it = s.intent;
  const d = sk(s);
  if (it.turbo.pressed && s.barkCooldown <= 0) {
    if (barkWanted(state, s)) {
      d.turboTapAt = -1;
      bark(state, s);
      return;
    }
    d.turboTapAt = state.time;
  }
  const tapAt = d.turboTapAt ?? -1;
  if (tapAt < 0) return;
  const held = state.time - tapAt;
  if (!it.turbo.held) {
    d.turboTapAt = -1;
    if (held <= BARK_TAP_TIME && s.barkCooldown <= 0) bark(state, s);
  } else if (held > BARK_TAP_TIME) d.turboTapAt = -1;
}

function bark(state: GameState, s: Skater): void {
  s.barkCooldown = BARK_COOLDOWN;
  const startled: number[] = [];
  const fumblers: Skater[] = [];
  for (const o of state.skaters) {
    if (o.team === s.team || !onIce(o)) continue;
    const dd = Math.hypot(o.pos.x - s.pos.x, o.pos.z - s.pos.z);
    if (dd > BARK_RADIUS) continue;
    o.stun = Math.max(o.stun, 0.4);
    startled.push(o.id);
    if (state.puck.owner === o.id && dd < BARK_FUMBLE_RADIUS && o.state !== 'gHold') {
      const chance = clamp((BARK_FUMBLE_BASE * (1.2 - o.attrs.handling)) / 0.65, 0.05, 0.6);
      if (rand() < chance) fumblers.push(o);
    }
  }
  emit(state, { type: 'bark', skaterId: s.id, startled });
  for (const o of fumblers) {
    const a = randRange(0, Math.PI * 2);
    loosePuck(state, o.vel.x * 0.5 + Math.sin(a) * 2.5, o.vel.z * 0.5 + Math.cos(a) * 2.5, 0, 0.5);
    emit(state, { type: 'fumble', skaterId: o.id });
  }
}

// ------------------------------------------------------------------ shot ----

/** Shot speed for a given charge and shooter (m/s). */
export function shotSpeed(s: Skater, charge: number): number {
  return lerp(PHYS.shotSpeedMin, PHYS.shotSpeedMax, charge) * (0.8 + 0.2 * s.attrs.shot);
}

/** Release the shot with the current `s.windup` charge. */
function releaseShot(state: GameState, s: Skater): void {
  const p = state.puck;
  const G = gs(state);
  const it = s.intent;
  const c = clamp(s.windup, 0, 1);
  const goalZ = attackGoalZ(s.team, state.period);
  const sign = Math.sign(goalZ);

  // where to aim: AI aimAt, else LEFT/RIGHT held picks that corner (height
  // from the charge: tap low, slapper high), else auto-aim at the side of
  // the net the goalie is leaving open. UP/DOWN (skating at the net, or
  // away) never changes the shot.
  let aimX: number;
  let aimY: number;
  const autoY = c > 0.6 ? 0.55 : 0.12 + 0.25 * c;
  const corner = !it.aimAt && Math.abs(it.move.x) > 0.35;
  if (it.aimAt) {
    aimX = clamp(it.aimAt.x, -3, 3);
    aimY = autoY;
  } else if (corner) {
    aimX = Math.sign(it.move.x) * lerp(SHOT.cornerX, SHOT.cornerXFull, c);
    aimY = lerp(SHOT.cornerYLow, SHOT.cornerYHigh, Math.pow(c, SHOT.cornerYCurve));
  } else {
    const g = state.skaters[s.team === 0 ? 9 : 4];
    const gx = onIce(g) ? g.pos.x : 0;
    aimX = (Math.abs(gx) > 0.08 ? -Math.sign(gx) : Math.sign(-s.pos.x) || (rand() < 0.5 ? 1 : -1)) * SHOT.autoX;
    aimY = autoY;
  }
  const skill = 1.45 - s.attrs.shot;
  // (the AI keeps the original linear spread; it aims through aimAt)
  const spread = it.aimAt ? 0.016 + 0.042 * c : SHOT.tapErr + SHOT.chargeErr * Math.sqrt(Math.min(1, c / SHOT.chargeErrFull));
  const angErr = gauss() * spread * skill;
  const yErr = gauss() * (0.05 + 0.2 * c) * skill;

  const dx = aimX - p.pos.x;
  const dz = goalZ - p.pos.z;
  const a = headingOf(dx, dz) + angErr;
  const dir = dirOf(a);
  let speed = shotSpeed(s, c);
  speed += Math.max(0, s.vel.x * dir.x + s.vel.z * dir.z) * 0.3;
  const distance = Math.hypot(dx, dz);
  const t = distance / speed;
  const ty = clamp(aimY + yErr, 0, 1.6);
  let vy = (ty + 0.5 * PHYS.gravity * t * t) / t;
  // a low auto-aimed tap stays on the ice; a corner tap may lift to its spot
  vy = clamp(vy, 0, (corner ? 3 : 0.5) + 3.5 * c);
  if (!corner && ty < 0.25 && c < 0.35) vy = Math.min(vy, 0.6);

  loosePuck(state, dir.x * speed, dir.z * speed, vy, 0.3);
  p.y = Math.max(p.y, 0.02);
  touchPuck(state, s.id);
  G.pass = null;
  state.callFor = null;

  // on target? (straight-line projection to the goal line, gravity on the height)
  let onTarget = false;
  const ahead = (goalZ - p.pos.z) * sign;
  const vAlong = dir.z * sign * speed;
  if (ahead > 0 && vAlong > 0.5) {
    const tl = ahead / vAlong;
    const xl = p.pos.x + dir.x * speed * tl;
    const yl = Math.max(0, p.y + vy * tl - 0.5 * PHYS.gravity * tl * tl);
    onTarget = Math.abs(xl) < GOAL.halfWidth - PHYS.puckRadius && yl < GOAL.height - PHYS.puckRadius;
  }
  if (onTarget) {
    s.stats.shots++;
    state.shots[s.team]++;
  }
  G.lastShot = { shooter: s.id, team: s.team, time: state.time, counted: onTarget };
  const power = clamp((speed - PHYS.shotSpeedMin) / (PHYS.shotSpeedMax - PHYS.shotSpeedMin), 0, 1);
  emit(state, { type: 'shot', shooter: s.id, power, lifted: vy > 0.8 });
  s.state = 'shoot';
  s.stateTime = 0;
  s.windup = 0;
}

// ------------------------------------------------------------------ pass ----

/**
 * Best teammate to pass to, given a direction hint (held direction, else
 * facing). Scores alignment, distance (~11 m is ideal), lane danger and up-ice
 * progress; the goalie only as a last resort. Returns null if nobody is there.
 */
export function choosePassTarget(state: GameState, s: Skater, hint: Vec2 | null): Skater | null {
  const h = hint && Math.hypot(hint.x, hint.z) > 0.2 ? norm(hint.x, hint.z) : dirOf(s.facing);
  const att = attackVec(state, s.team);
  let best: Skater | null = null;
  let bs = -Infinity;
  for (const t of state.skaters) {
    if (t.team !== s.team || t.id === s.id || !canAct(t)) continue;
    const vx = t.pos.x - s.pos.x;
    const vz = t.pos.z - s.pos.z;
    const d = Math.hypot(vx, vz);
    if (d < 1.5) continue;
    const ux = vx / d;
    const uz = vz / d;
    let score = (ux * h.x + uz * h.z) * 2.0;
    score -= Math.abs(d - 11) * 0.05;
    score -= laneRisk(state, s.pos, t.pos, s.team) * 1.4;
    score += (ux * att.x + uz * att.z) * 0.3;
    if (isGoalie(t)) score -= 4;
    if (score > bs) {
      bs = score;
      best = t;
    }
  }
  return best;
}

/** Pass the puck: to intent.passTarget if valid, else the auto-chosen teammate. */
export function doPass(state: GameState, s: Skater): boolean {
  const p = state.puck;
  const it = s.intent;
  let target: Skater | null = null;
  if (it.passTarget !== undefined) {
    const t = state.skaters[it.passTarget];
    if (t && t.team === s.team && t.id !== s.id && canAct(t)) target = t;
  }
  if (!target) target = choosePassTarget(state, s, it.move);
  if (!target) return false;

  // lead the receiver: iterate the intercept time twice
  const skill = s.attrs.pass;
  const leadK = passLead(state, target);
  // (at his blade, which rides ~0.5 m in front of him, not at his skates)
  const blade = stickPoint(target);
  let aim = { x: blade.x, z: blade.z };
  let speed: number = PHYS.passSpeed;
  for (let i = 0; i < 2; i++) {
    const dd = Math.hypot(aim.x - p.pos.x, aim.z - p.pos.z);
    speed = clamp(7 + dd * 0.75, 9, PHYS.passSpeed * (0.85 + 0.3 * skill));
    const t = dd / speed;
    aim = { x: blade.x + target.vel.x * t * leadK, z: blade.z + target.vel.z * t * leadK };
  }
  // a stick in the middle of the lane: float it over (a slower pass, so lead him for its flight)
  let vy = 0;
  const sc = saucerFor(state, p.pos, aim, s.team);
  if (sc) {
    aim = { x: blade.x + target.vel.x * sc.time * leadK, z: blade.z + target.vel.z * sc.time * leadK };
    speed = (Math.hypot(aim.x - p.pos.x, aim.z - p.pos.z) * SAUCER_LAND) / sc.time;
    vy = sc.vy;
  }
  const bInfo = boardsInfo(aim.x, aim.z);
  if (bInfo.dist < 0.8) {
    aim.x -= bInfo.nx * (0.8 - bInfo.dist);
    aim.z -= bInfo.nz * (0.8 - bInfo.dist);
  }
  const a = headingOf(aim.x - p.pos.x, aim.z - p.pos.z) + gauss() * (1 - skill) * 0.06;
  loosePuck(state, Math.sin(a) * speed, Math.cos(a) * speed, vy, 0.25);
  if (vy > 0) p.y = 0.02;
  touchPuck(state, s.id);
  gs(state).pass = { from: s.id, to: target.id, time: state.time };
  gs(state).lastShot = null;
  state.callFor = null;
  emit(state, { type: 'pass', from: s.id, to: target.id, speed });
  s.state = 'pass';
  s.stateTime = 0;
  return true;
}

/**
 * Saucer passes float over a stick in the middle of the lane: the puck peaks at SAUCER_PEAK
 * (out of reach above 0.5 m for the middle ~half of its flight) and comes down at SAUCER_LAND
 * of the way to the receiver, sliding the rest. Only over SAUCER_MIN..SAUCER_MAX: shorter
 * can't get up and down in time, and a long one is better hard and flat.
 */
export const SAUCER_PEAK = 0.65;
export const SAUCER_LAND = 0.92;
const SAUCER_MIN = 5;
const SAUCER_MAX = 16;
/** an opponent's blade this close to the lane is "in" it */
const SAUCER_STICK = 1.0;

/**
 * The saucer for a pass from `a` to `aim` by `team`, if one helps: an opponent's blade near
 * the middle of the lane and none near either end (a saucer is as catchable as a flat pass
 * there). Returns its flight time and vertical speed, or null for a flat pass.
 */
export function saucerFor(state: GameState, a: Vec2, aim: Vec2, team: number): { time: number; vy: number } | null {
  const dd = Math.hypot(aim.x - a.x, aim.z - a.z);
  if (dd < SAUCER_MIN || dd > SAUCER_MAX) return null;
  let mid = false;
  for (const o of state.skaters) {
    if (o.team === team || !onIce(o) || o.state === 'fallen' || isGoalie(o)) continue;
    const { d, t } = segDist(stickPoint(o), a, aim);
    if (d > SAUCER_STICK) continue;
    if (t < 0.3 || t > 0.7) return null;
    mid = true;
  }
  if (!mid) return null;
  const vy = Math.sqrt(2 * PHYS.gravity * SAUCER_PEAK);
  return { time: (2 * vy) / PHYS.gravity, vy };
}

// ------------------------------------------------------------------ poke ----

function startPoke(s: Skater): void {
  s.state = 'poke';
  s.stateTime = 0;
  sk(s).pokeDone = false;
  sk(s).actionCd = 0.6;
}

/**
 * Chance that a poke by `s` strips `c` (before the roll). `repeat`: he was just poked at and
 * is guarding it. `puck`: where it is (a puck behind the carrier's body is harder to reach).
 */
export function pokeChance(s: Skater, c: Skater, angle: number, repeat = false, puck?: Vec2): number {
  let chance = 0.5 + 0.6 * (s.attrs.handling - c.attrs.handling) - angle * 0.18;
  if (repeat) chance -= POKE_REPEAT_MALUS;
  const bx = s.pos.x - c.pos.x;
  const bz = s.pos.z - c.pos.z;
  const bl = Math.hypot(bx, bz) || 1;
  if ((Math.sin(c.facing) * bx + Math.cos(c.facing) * bz) / bl < -0.3) chance += 0.12; // from behind
  if (c.state === 'windup') chance += 0.15;
  if (puck && shieldedFrom(c, s, puck)) chance *= POKE_SHIELD_MUL;
  return clamp(chance, 0.08, 0.85);
}

/** Is the carrier `c`'s body between `s` and the puck? */
function shieldedFrom(c: Skater, s: Skater, puck: Vec2): boolean {
  const { d, t } = segDist(c.pos, s.pos, puck);
  return t > 0.15 && t < 0.95 && d < c.attrs.radius + 0.12;
}

function resolvePoke(state: GameState, s: Skater): void {
  sk(s).pokeDone = true;
  const p = state.puck;
  let success = false;
  const dx = p.pos.x - s.pos.x;
  const dz = p.pos.z - s.pos.z;
  const dd = Math.hypot(dx, dz);
  const angle = Math.abs(angleDiff(headingOf(dx, dz), s.facing));
  if (p.owner !== null) {
    const c = state.skaters[p.owner];
    if (c.team !== s.team && c.state !== 'gHold' && dd <= PHYS.pokeRange && angle < 1.2) {
      const cd = sk(c);
      const repeat = state.time - (cd.pokedAt ?? -10) < POKE_REPEAT_WINDOW;
      cd.pokedAt = state.time;
      if (rand() < pokeChance(s, c, angle, repeat, p.pos)) {
        const u = norm(dx, dz);
        const side = randRange(-2, 2);
        loosePuck(state, u.x * 4 + c.vel.x * 0.4 - u.z * side, u.z * 4 + c.vel.z * 0.4 + u.x * side, 0, 0.45);
        touchPuck(state, s.id);
        success = true;
        emit(state, { type: 'poke', skaterId: s.id, success });
        emit(state, { type: 'steal', skaterId: s.id, fromId: c.id });
        return;
      }
    }
  } else if (dd <= PHYS.pokeRange && angle < 1.2 && p.y < 0.5 && !matePassInFlight(state, s)) {
    // swat a loose puck ahead (never a teammate's pass: that one is received)
    const f = dirOf(s.facing);
    p.vel.x = f.x * 6 + p.vel.x * 0.3;
    p.vel.z = f.z * 6 + p.vel.z * 0.3;
    touchPuck(state, s.id);
    success = true;
  }
  emit(state, { type: 'poke', skaterId: s.id, success });
}

// ----------------------------------------------------------------- check ----

function startCheck(s: Skater): void {
  const d = sk(s);
  const m = s.intent.move;
  const dir = Math.hypot(m.x, m.z) > 0.2 ? norm(m.x, m.z) : dirOf(s.facing);
  d.lunge = dir;
  d.hitDone = false;
  d.checkTurbo = s.turboActive;
  d.actionCd = 0.9;
  s.state = 'check';
  s.stateTime = 0;
  // the dog throws itself at once; a kid squares up over the lunge (physics.ts turnToward)
  if (s.kind !== 'kid') s.facing = headingOf(dir.x, dir.z);
  s.vel.x += dir.x * PHYS.checkLungeSpeed * 0.6;
  s.vel.z += dir.z * PHYS.checkLungeSpeed * 0.6;
  const cap = s.attrs.maxSpeed * PHYS.turboMul + PHYS.checkLungeSpeed;
  const sp = Math.hypot(s.vel.x, s.vel.z);
  if (sp > cap) {
    s.vel.x *= cap / sp;
    s.vel.z *= cap / sp;
  }
}

function resolveCheck(state: GameState, s: Skater): void {
  const d = sk(s);
  for (const o of state.skaters) {
    if (o.team === s.team || !onIce(o) || o.state === 'fallen' || o.invuln > 0) continue;
    const dx = o.pos.x - s.pos.x;
    const dz = o.pos.z - s.pos.z;
    const dd = Math.hypot(dx, dz);
    if (dd > PHYS.checkRange || dd < 1e-3) continue;
    const nx = dx / dd;
    const nz = dz / dd;
    if (nx * d.lunge.x + nz * d.lunge.z < 0.3) continue;
    // a lunge that can't catch its man (no closing speed) isn't a hit yet
    if (hitForce(s, o, { x: nx, z: nz }, d.checkTurbo) < MIN_HIT_FORCE) continue;
    d.hitDone = true;
    applyHit(state, s, o, { x: nx, z: nz });
    return;
  }
}

/** Hit force: closing speed along the contact normal x sqrt(weight ratio) x check skill (x1.2 on turbo). */
export function hitForce(hitter: Skater, victim: Skater, n: Vec2, turbo: boolean): number {
  const closing = Math.max(0, (hitter.vel.x - victim.vel.x) * n.x + (hitter.vel.z - victim.vel.z) * n.z);
  return closing * Math.sqrt(hitter.attrs.weight / victim.attrs.weight) * (0.6 + 0.8 * hitter.attrs.check) * (turbo ? 1.2 : 1);
}

/** Resolve a connected body check (force, boards, knockdown, puck loss, penalty roll). */
export function applyHit(state: GameState, s: Skater, o: Skater, n: Vec2): void {
  const d = sk(s);
  const p = state.puck;
  const speed = Math.hypot(s.vel.x, s.vel.z);
  let force = hitForce(s, o, n, d.checkTurbo);
  // pinned against the boards: extra force and a glass rattle
  const b = boardsInfo(o.pos.x, o.pos.z);
  const nearBoards = b.dist < 1.6 + o.attrs.radius && n.x * b.nx + n.z * b.nz > 0.3;
  if (nearBoards) {
    force += 2.0 + 1.5 * clamp(1 - b.dist / 1.6, 0, 1);
    emit(state, { type: 'bodyBoards', skaterId: o.id, speed: Math.max(speed, 3) });
    sk(o).boardsCd = 0.6;
  }
  const hadPuck = p.owner === o.id || state.time - sk(o).lastOwnTime < 0.35;
  const fromBehind = Math.sin(o.facing) * n.x + Math.cos(o.facing) * n.z > 0.55;
  const knockedDown = force > PHYS.knockdownForce;

  if (p.owner === o.id && force > 1.5) {
    loosePuck(state, o.vel.x * 0.6 + n.x * 2 + randRange(-1.5, 1.5), o.vel.z * 0.6 + n.z * 2 + randRange(-1.5, 1.5), 0, 0.45);
  }
  const push = Math.min(force * 0.55, 7) * (knockedDown ? 1 : 0.6);
  o.vel.x += n.x * push;
  o.vel.z += n.z * push;
  s.vel.x *= 0.35;
  s.vel.z *= 0.35;
  sk(o).hitTime = state.time;
  if (knockedDown) {
    o.state = 'fallen';
    o.stateTime = 0;
    o.windup = 0;
    o.turboActive = false;
  } else {
    o.stun = Math.max(o.stun, 0.35);
  }
  s.stats.hits++;
  state.hits[s.team]++;
  emit(state, { type: 'check', hitter: s.id, victim: o.id, force, knockedDown });

  const pen = rollPenalty(state, {
    hitter: s,
    victim: o,
    force,
    victimHadPuck: hadPuck,
    fromBehind,
    nearBoards,
    charging: d.checkTurbo || speed > 9.5,
  });
  // the whistle waits until the offending team touches the puck (see delayPenalty)
  if (pen) delayPenalty(state, pen);
}
