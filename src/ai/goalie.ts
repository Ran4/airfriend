import { GOAL } from '../config';
import type { GameState, Skater, Vec2 } from '../types';
import { canAct, isGoalie, onIce } from '../sim/query';
import { GOALIE_MAX_RANGE } from '../sim/goalie';
import { clamp, randRange } from '../sim/util';
import type { Brain } from './memory';
import { d2, lane, openness, ownGoal } from './util';

/*
 * Goalie positioning. Saves themselves are resolved by the sim (reaction
 * delay, poses, geometric hitbox); what the AI controls is WHERE the goalie
 * stands when the shot comes: on the line from the goal center to the puck,
 * further out (cutting the angle) the further away the puck is, hugging the
 * post when the puck is below the goal line.
 *
 * The goalie works from a slightly late read of the puck (`b.seen`), so a
 * quick cross-crease pass leaves him a step behind: beatable, but only by a
 * good play.
 */

interface GoalieOut {
  move: Vec2;
  pass: boolean;
  passTarget?: number;
}

export function goalieAI(state: GameState, g: Skater, b: Brain, dt: number): GoalieOut {
  const out: GoalieOut = { move: { x: 0, z: 0 }, pass: false };
  const p = state.puck;
  const goal = ownGoal(state, g.team);
  const sign = Math.sign(goal.z);

  // late read of the puck: a better goalie tracks it more tightly
  const tau = 0.05 + (1 - g.attrs.handling) * 0.2;
  const k = 1 - Math.exp(-dt / tau);
  b.seen.x += (p.pos.x - b.seen.x) * k;
  b.seen.z += (p.pos.z - b.seen.z) * k;

  if (!canAct(g) || g.state === 'gHold') return out;

  // --- he has the puck (picked up, not covered): move it to an open teammate
  if (p.owner === g.id) {
    if (b.clearAt < 0) b.clearAt = state.time + randRange(0.3, 0.65);
    if (state.time >= b.clearAt) {
      const t = outlet(state, g);
      out.pass = true;
      if (t) out.passTarget = t.id;
      b.clearAt = -1;
    }
    return out;
  }
  b.clearAt = -1;

  // --- a slow loose puck near the crease that nobody else will reach first: go play it
  const pSpeed = Math.hypot(p.vel.x, p.vel.z);
  if (p.owner === null && pSpeed < 4 && p.y < 0.3 && d2(p.pos, goal) < 3.6) {
    const mine = d2(g.pos, p.pos);
    let threat = Infinity;
    for (const o of state.skaters) {
      if (o.team === g.team || !onIce(o) || isGoalie(o)) continue;
      threat = Math.min(threat, d2(o.pos, p.pos));
    }
    if (threat > mine + 1.2) {
      out.move = toward(g, p.pos, 3);
      return out;
    }
  }

  // --- angle cutting
  const px = b.seen.x;
  const pOut = (goal.z - b.seen.z) * sign; // how far in front of the goal line the puck is
  let tx: number;
  let tOut: number;
  if (pOut < 0.35) {
    // puck below the goal line: seal the near post
    tx = (Math.sign(px) || 1) * (GOAL.halfWidth - 0.2);
    tOut = 0.3;
  } else {
    const dist = Math.hypot(px, pOut);
    // out to the top of the crease against shooters, a touch deeper for long ones
    // (a long shot gives time to react; a close one has to hit the body)
    const depth = clamp(0.75 + dist * 0.045, 0.8, 1.45);
    // the puck carried right into the crease: back in to avoid being walked around
    // (any earlier and the near corners open up for a simple shot from the doorstep)
    const close = clamp((3.5 - dist) / 2.5, 0, 1);
    let r = depth * (1 - close * 0.45);
    // a man open on the back door: play deeper so the cross-crease pass isn't a tap-in
    if (backDoor(state, g, goal, sign, px)) r *= 0.7;
    tx = (px / dist) * r;
    tOut = (pOut / dist) * r;
    // sharp angle: stay on the post rather than drifting outside it
    tx = clamp(tx, -(GOAL.halfWidth - 0.15), GOAL.halfWidth - 0.15);
    tOut = Math.max(tOut, 0.3);
  }
  const target = { x: tx, z: goal.z - sign * tOut };
  // (the sim also clamps the range; keep the plan inside it)
  if (d2(target, goal) > GOALIE_MAX_RANGE - 0.3) return out;
  out.move = toward(g, target, 2.4);
  return out;
}

/** An attacker (not the puck carrier) loitering low on the far side of the net. */
function backDoor(state: GameState, g: Skater, goal: Vec2, sign: number, px: number): boolean {
  const owner = state.puck.owner;
  for (const o of state.skaters) {
    if (o.team === g.team || !onIce(o) || isGoalie(o) || o.id === owner) continue;
    const out = (goal.z - o.pos.z) * sign;
    if (out > 0.3 && out < 6 && Math.abs(o.pos.x) < 5 && Math.abs(o.pos.x - px) > 2.5) return true;
  }
  return false;
}

/** P-controller on position: intent length = distance x gain (capped at full speed). */
function toward(g: Skater, t: Vec2, gain: number): Vec2 {
  const dx = t.x - g.pos.x;
  const dz = t.z - g.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.04) return { x: 0, z: 0 };
  const m = Math.min(1, d * gain);
  return { x: (dx / d) * m, z: (dz / d) * m };
}

/** Best teammate for a goalie outlet: open, a clean lane, preferably a D close by. */
function outlet(state: GameState, g: Skater): Skater | null {
  let best: Skater | null = null;
  let bs = -Infinity;
  for (const t of state.skaters) {
    if (t.team !== g.team || t.id === g.id || !canAct(t) || isGoalie(t)) continue;
    const d = d2(t.pos, g.pos);
    if (d < 3 || d > 26) continue;
    const sc = Math.min(openness(state, t.pos, g.team), 6) * 0.5 - lane(state, g.pos, t.pos, g.team) * 2 - Math.abs(d - 9) * 0.06;
    if (sc > bs) {
      bs = sc;
      best = t;
    }
  }
  return bs > 0.8 ? best : null;
}
