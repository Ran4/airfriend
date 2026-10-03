import { RINK } from '../config';
import type { GameState, Skater, TeamId, Vec2 } from '../types';
import { canAct, carrier, isGoalie, onIce, skatersOnIce } from '../sim/query';
import { clamp, gs, lerp, randRange } from '../sim/util';
import type { AiMem, Assignment, Mode, Role, TeamMem } from './memory';
import { W, alongOf, d2, interceptPoint, ownGoal, safeTarget, unit } from './util';
import { POINT_ALONG, isD } from './ozone';

/*
 * Team tactics: who does what. Every tick each team
 *   1. perceives possession (with a short human-like lag, so a bobbled puck
 *      doesn't flip the whole team's shape),
 *   2. picks the one skater who goes for the puck (chaser / presser), with
 *      hysteresis so two kids don't take turns,
 *   3. lays out formation spots for everybody else (attack lanes and points,
 *      or goal-side marks / a shorthanded box) relative to the puck, and
 *   4. matches skaters to spots, minimizing skating distance with a bonus for
 *      keeping last tick's spot.
 */

type Kind = 'F' | 'D';
interface Slot {
  key: string;
  role: Role;
  pos: Vec2;
  kind: Kind | 'any';
  target?: number;
  /** priority: subtracted from the matching cost (meters) so key spots get filled first */
  bonus?: number;
  /** matching cost (m) of the wrong kind of skater on this spot (default 5, 9 for the dog) */
  mis?: number;
}

/** keeping your spot is worth this many meters of skating */
const KEEP_BONUS = 3.0;
/** a new chaser must be this many seconds faster to take over */
const CHASE_SWITCH = 0.3;
/** a new presser must be this many meters closer to take over */
const PRESS_SWITCH = 2.2;
/** the human holds a formation spot only while he is within this many meters of it */
const HUMAN_SLOT_R = 2.5;
/** the lane defender holds the net front once the carrier is this close (m), the gap beyond the OUT distance */
const LANE_FRONT_IN = 12;
const LANE_FRONT_OUT = 15;
/** forwards crash the net for this long (s) after a teammate's shot */
const CRASH_TIME = 1.5;
/**
 * A defenseman pinches (takes the presser role on a carrier) down the wall in the
 * offensive zone, up to this far (m) past the blue line, from at most PINCH_R away,
 * and only with a teammate back behind the puck.
 */
const PINCH_DEPTH = 9;
const PINCH_R = 6;
/** offensive zone: matching cost (m) of a forward on a point / a D in a forward spot */
const OZ_MISMATCH = 14;

const kindOf = (s: Skater): Kind => (s.position === 'LD' || s.position === 'RD' ? 'D' : 'F');

/** The skater the human drives (the AI must not count on it doing anything). */
export const isHuman = (state: GameState, s: Skater): boolean => !state.autoplay && s.id === state.controlledId;

/** What the team would believe right now with perfect, instant perception. */
function rawMode(state: GameState, team: TeamId): Mode {
  const c = carrier(state);
  if (c) return c.team === team ? 'attack' : 'defend';
  const pass = gs(state).pass;
  if (pass && state.time - pass.time < 1.6) return state.skaters[pass.from].team === team ? 'attack' : 'defend';
  return 'loose';
}

export function updateTeam(state: GameState, team: TeamId, mem: AiMem): void {
  const T = mem.teams[team];
  const raw = rawMode(state, team);
  if (raw !== T.mode) {
    if (T.pending !== raw) {
      T.pending = raw;
      // a loose puck is usually a shot, a bounce or a bobble: wait a beat before re-shaping
      T.pendingAt = state.time + (raw === 'loose' ? randRange(0.3, 0.5) : randRange(0.1, 0.24));
    }
    if (state.time >= T.pendingAt) T.mode = raw;
  } else T.pending = raw;

  const mates = state.skaters.filter((s) => s.team === team && onIce(s) && !isGoalie(s));
  const assign = new Map<number, Assignment>();
  const c = carrier(state);
  let rest = mates;

  if (c && c.team === team && !isGoalie(c)) {
    assign.set(c.id, { role: 'carrier', key: 'carrier', pos: { ...c.pos } });
    rest = mates.filter((s) => s.id !== c.id);
  }

  const mode = T.mode;
  if (mode === 'attack' || (mode === 'loose' && keepShape(state, team) && !(c && c.team !== team))) {
    if (mode === 'loose') rest = pickChaser(state, T, rest, assign);
    else T.chaser = null;
    T.presser = null;
    const anchor = c && c.team === team ? c.pos : passAnchor(state);
    if (Math.abs(anchor.x) > 1.5) T.side = anchor.x > 0 ? 1 : -1;
    fill(state, T, rest, attackSlots(state, team, anchor, rest, T.side), assign);
  } else {
    let focus: Skater | null = null;
    if (mode === 'defend') {
      focus = c && c.team !== team ? c : passReceiver(state, team);
    }
    if (focus) {
      rest = pickPresser(state, T, rest, focus, assign);
      T.chaser = null;
    } else {
      rest = pickChaser(state, T, rest, assign);
      T.presser = null;
    }
    fill(state, T, rest, defendSlots(state, team, focus, rest.length), assign);
  }
  T.assign = assign;
  // the offensive-zone clock: runs while we have it (or it's ours to chase) in their zone
  const inZone = alongOf(state, team, state.puck.pos.z) > OFF_ZONE;
  const ours = c ? c.team === team : mode === 'attack' || (mode === 'loose' && keepShape(state, team));
  if (inZone && ours) {
    if (T.ozSince < 0) T.ozSince = state.time;
  } else T.ozSince = -1;
}

/**
 * A loose puck keeps the attack shape (with one man chasing it) after our own touch, and
 * in the offensive zone off the other goalie (a rebound: crash it, don't turn and run).
 */
function keepShape(state: GameState, team: TeamId): boolean {
  const lt = state.puck.lastTouch;
  if (lt === null) return false;
  const t = state.skaters[lt];
  if (t.team === team) return true;
  return isGoalie(t) && alongOf(state, team, state.puck.pos.z) > OFF_ZONE + 1;
}

/** Where the attack shape centers while a pass is in flight: the receiver, else the puck. */
function passAnchor(state: GameState): Vec2 {
  const pass = gs(state).pass;
  if (pass) return state.skaters[pass.to].pos;
  return state.puck.pos;
}

/** Defending against a pass in flight: the intended receiver is the man to pressure. */
function passReceiver(state: GameState, team: TeamId): Skater | null {
  const pass = gs(state).pass;
  if (!pass) return null;
  const r = state.skaters[pass.to];
  return r.team !== team && onIce(r) ? r : null;
}

/** One skater goes for the loose puck: earliest intercept, sticky. Humans are never relied on. */
function pickChaser(state: GameState, T: TeamMem, pool: Skater[], assign: Map<number, Assignment>): Skater[] {
  const cands = pool.filter((s) => canAct(s) && !isHuman(state, s));
  if (!cands.length) return pool;
  let best: Skater | null = null;
  let bt = Infinity;
  let cur: { s: Skater; t: number } | null = null;
  for (const s of cands) {
    const { t } = interceptPoint(state, s, 0.1);
    if (t < bt) {
      bt = t;
      best = s;
    }
    if (s.id === T.chaser) cur = { s, t };
  }
  if (cur && cur.t < bt + CHASE_SWITCH) best = cur.s;
  T.chaser = best!.id;
  const ip = interceptPoint(state, best!, 0.1).p;
  assign.set(best!.id, { role: 'chase', key: 'chase', pos: ip });
  return pool.filter((s) => s.id !== best!.id);
}

/** One skater pressures the opposing carrier: nearest, preferring someone already goal-side. */
function pickPresser(state: GameState, T: TeamMem, pool: Skater[], focus: Skater, assign: Map<number, Assignment>): Skater[] {
  const cands = pool.filter((s) => canAct(s) && !isHuman(state, s));
  if (!cands.length) return pool;
  const team = cands[0].team;
  const goal = ownGoal(state, team);
  const deep = alongOf(state, team, focus.pos.z); // > 0: the carrier is in OUR attacking half
  const cost = (s: Skater) => {
    let c = d2(s.pos, focus.pos);
    if (d2(s.pos, goal) < d2(focus.pos, goal) - 0.5) c -= 1.5; // already goal-side
    // D don't chase deep into the other zone, except a pinch down the wall to keep it in
    if (kindOf(s) === 'D' && deep > 4) c += pinchOk(state, s, focus, deep) ? -1.5 : 7;
    if (s.id === T.presser) c -= PRESS_SWITCH;
    return c;
  };
  let best = cands[0];
  for (const s of cands) if (cost(s) < cost(best)) best = s;
  T.presser = best.id;
  assign.set(best.id, { role: 'pressure', key: 'pressure', pos: { ...focus.pos }, target: focus.id });
  return pool.filter((s) => s.id !== best.id);
}

/** A safe pinch for defenseman `s` on `focus` (see PINCH_DEPTH): on the wall near our blue line, somebody back. */
function pinchOk(state: GameState, s: Skater, focus: Skater, deep: number): boolean {
  if (deep > OFF_ZONE + PINCH_DEPTH || Math.abs(focus.pos.x) < 4.5 || d2(s.pos, focus.pos) > PINCH_R) return false;
  if (skatersOnIce(state, s.team) < skatersOnIce(state, (1 - s.team) as TeamId)) return false;
  return state.skaters.some(
    (t) => t.team === s.team && t.id !== s.id && onIce(t) && !isGoalie(t) && t.state !== 'fallen' && alongOf(state, s.team, t.pos.z) < deep - 3,
  );
}

/** Match `pool` to `slots` (same length or more slots) minimizing distance + kind mismatch - continuity. */
function fill(state: GameState, T: TeamMem, pool: Skater[], slots: Slot[], assign: Map<number, Assignment>): void {
  if (!pool.length) return;
  const prev = T.assign;
  const cost = (s: Skater, sl: Slot): number => {
    let c = d2(s.pos, sl.pos) - (sl.bonus ?? 0);
    const k = kindOf(s);
    if (sl.kind !== 'any' && sl.kind !== k) c += sl.mis ?? (s.kind === 'dog' ? 9 : 5);
    if (prev.get(s.id)?.key === sl.key) c -= KEEP_BONUS;
    if (s.state === 'fallen') c *= 0.5; // he's going nowhere fast; don't let him steal a far spot
    return c;
  };
  // the human goes wherever the human goes: he holds a spot only while he is actually
  // standing on it. A spot "held" by a human 10 m away (the lane in front of our net)
  // is a spot nobody holds, so otherwise the AI fills every spot around him.
  const human = pool.find((s) => isHuman(state, s));
  let ai = pool;
  let free = slots;
  if (human) {
    let bi = 0;
    for (let i = 1; i < free.length; i++) if (d2(human.pos, free[i].pos) < d2(human.pos, free[bi].pos)) bi = i;
    const sl = free[bi];
    ai = pool.filter((s) => s !== human);
    if (sl && d2(human.pos, sl.pos) < HUMAN_SLOT_R + (prev.get(human.id)?.key === sl.key ? 1 : 0)) {
      assign.set(human.id, { role: sl.role, key: sl.key, pos: sl.pos, target: sl.target });
      free = free.filter((_, i) => i !== bi);
    } else assign.set(human.id, { role: 'idle', key: 'human', pos: { ...human.pos } });
  }
  if (!ai.length) return;
  // brute force: at most 4 skaters x 5 slots
  let best: number[] = [];
  let bc = Infinity;
  const used = new Array(free.length).fill(false);
  const pick: number[] = [];
  const rec = (i: number, acc: number) => {
    if (acc >= bc) return;
    if (i === ai.length) {
      bc = acc;
      best = [...pick];
      return;
    }
    for (let j = 0; j < free.length; j++) {
      if (used[j]) continue;
      used[j] = true;
      pick.push(j);
      rec(i + 1, acc + cost(ai[i], free[j]));
      pick.pop();
      used[j] = false;
    }
  };
  rec(0, 0);
  ai.forEach((s, i) => {
    const sl = free[best[i]];
    if (sl) assign.set(s.id, { role: sl.role, key: sl.key, pos: sl.pos, target: sl.target });
    else assign.set(s.id, { role: 'idle', key: 'idle', pos: { ...s.pos } });
  });
}

// ---------------------------------------------------------------------------
// Formations (team frame: x = world x, a = along the attack direction)

const OFF_ZONE = RINK.blueLineZ;

function attackSlots(state: GameState, team: TeamId, anchor: Vec2, pool: Skater[], ss: number): Slot[] {
  const cx = anchor.x;
  const ca = alongOf(state, team, anchor.z);
  // ss: strong side = the puck's side (sticky, see updateTeam)
  const pp = skatersOnIce(state, team) > skatersOnIce(state, (1 - team) as TeamId);
  let F: [string, number, number][];
  let D: [string, number, number][];
  if (ca > OFF_ZONE) {
    // set up in the zone (ai/ozone.ts): D on the points, forwards by where the puck is
    const pt = pp ? 11.5 : POINT_ALONG - 0.4;
    const c = carrier(state);
    const own = c && c.team === team ? c : null;
    const G = gs(state);
    const shooting =
      (own !== null && own.state === 'windup') || (G.lastShot !== null && G.lastShot.team === team && state.time - G.lastShot.time < CRASH_TIME);
    if (shooting || (own && isD(own) && ca < 16)) {
      // a shot from the point (or one on its way): crash the net, one man screening the goalie
      F = [
        ['screen', -ss * 0.6, 24.3],
        ['rebW', -ss * 2.1, 23.5],
        ['rebS', ss * 2.3, 22.9],
        ['high', -ss * 1.0, 17.5],
      ];
    } else if (ca > 19.5) {
      // the carrier is down low: one man on the half-wall above him to cycle it back up to,
      // one at the net front, then the back door
      F = [
        ['cycle', ss * 8.6, clamp(ca - 5.5, 14.5, 19)],
        ['netfront', -ss * 1.0, 23.2],
        ['backdoor', -ss * 3.6, 23.4],
        ['slot', ss * 0.5, 19.5],
      ];
    } else {
      // higher up: the slot, a man low in the corner for the cycle, then the back door
      F = [
        ['slot', -ss * 1.5, 20.2],
        ['low', ss * 7.8, 24.2],
        ['backdoor', -ss * 3.8, 23.2],
        ['high', -ss * 1.0, 15.5],
      ];
    }
    D = [
      ['pointS', ss * 6.2, pt],
      ['pointW', -ss * 5.0, pt - 0.3],
      ['highD', 0, 13.5],
      ['safety', -ss * 2, 3],
    ];
  } else if (ca > -OFF_ZONE) {
    // through the neutral zone: forwards in wide lanes ahead, D trailing
    const central = Math.abs(cx) < 3;
    F = [
      ['laneW', -ss * 7.4, ca + 6.5],
      central ? ['laneS', ss * 7.2, ca + 6.0] : ['middle', -ss * 1.8, ca + 8.5],
      ['laneS2', ss * 7.0, ca + 4.5],
      ['deep', 0, ca + 11],
    ];
    D = [
      ['trailS', ss * 3.8, ca - 6.0],
      ['trailW', -ss * 4.2, ca - 7.5],
      ['trailC', 0, ca - 9],
      ['safety', 0, ca - 12],
    ];
  } else {
    // breakout: winger on the strong half-wall, center swings low, stretch on the weak side
    F = [
      ['wallS', ss * 9.6, -10.5],
      ['swing', -ss * 2.5, ca + 7.0],
      ['stretch', -ss * 7.0, -1.5],
      ['wallW', -ss * 9.0, -11],
    ];
    D = [
      ['partner', -ss * 4.8, Math.max(-23.5, ca - 1.0)],
      ['netD', ss * 1.6, -20],
      ['highD', 0, -12],
      ['safety', 0, -18],
    ];
  }
  const nF = pool.filter((s) => kindOf(s) === 'F').length;
  const nD = pool.length - nF;
  const near = (x: number, a: number) => Math.hypot(x - cx, a - ca) < 3.5;
  const mk = (list: [string, number, number][], kind: Kind, n: number): Slot[] =>
    list
      .filter(([, x, a]) => !near(x, a))
      .slice(0, Math.max(0, n))
      .map(([key, x, a]) => ({
        key,
        role: 'support' as Role,
        kind,
        pos: safeTarget(W(state, team, x, clamp(a, -24.5, kind === 'D' ? 13 : 24.5)), 1.4),
        // in the zone the forwards work low and the D hold the points, even if a forward
        // trailing the play is closer to a point (he skates on in, the D come up to it)
        mis: ca > OFF_ZONE ? OZ_MISMATCH : undefined,
      }));
  // one spare slot per kind keeps the matcher flexible when kinds don't line up
  return [...mk(F, 'F', nF + 1), ...mk(D, 'D', nD + 1)];
}

function threat(state: GameState, team: TeamId, o: Skater): number {
  const goal = ownGoal(state, team);
  let t = 30 - d2(o.pos, goal);
  if (Math.abs(o.pos.x) < 6) t += 4;
  if (o.kind === 'dog') t += 8; // everybody knows who the star is
  if (o.state === 'fallen') t -= 8;
  return t;
}

function defendSlots(state: GameState, team: TeamId, focus: Skater | null, n: number): Slot[] {
  if (n <= 0) return [];
  const opp = (1 - team) as TeamId;
  const goal = ownGoal(state, team);
  const fp = focus ? focus.pos : state.puck.pos;
  const fa = alongOf(state, team, fp.z);
  const sh = skatersOnIce(state, team) < skatersOnIce(state, opp);
  const slots: Slot[] = [];
  const box = (key: string, x: number, a: number) =>
    slots.push({ key, role: 'box', kind: 'any', pos: safeTarget(W(state, team, x, a), 1.4) });

  if (sh && fa < -OFF_ZONE + 2) {
    // shorthanded in our zone: collapse into a tight box around the slot
    // (the presser is already out on the puck; low spots first, then the weak-side high spot)
    const sx = clamp(fp.x * 0.3, -2.5, 2.5);
    const weak = fp.x >= 0 ? -1 : 1;
    if (n === 1) box('lowC', sx, -22);
    else {
      box('lowL', sx - 2.5, -22.3);
      box('lowR', sx + 2.5, -22.3);
    }
    if (n >= 3) box('highW', sx + weak * 3.2, -16.8);
    return slots;
  }
  // someone always stands in the carrier's lane to the net (the D facing the rush);
  // the presser attacks the puck, this one keeps the gap
  const dgF = d2(fp, goal);
  if (dgF > 3) {
    const u = unit(fp.x - goal.x, fp.z - goal.z);
    // gap control: meet a rush at the blue line, give ground as it comes in. Once he is
    // in close, stop backing up with him: hold the net front on his line to the goal,
    // where the tap-in would go (blended in over a few meters so the spot doesn't jump)
    const gap = Math.max(2.6, dgF - clamp(dgF * 0.35, 3, 8));
    const front = clamp(2.5 + (dgF - 4) * 0.125, 2.5, 3.5);
    const r = lerp(front, gap, clamp((dgF - LANE_FRONT_IN) / (LANE_FRONT_OUT - LANE_FRONT_IN), 0, 1));
    slots.push({ key: 'lane', role: 'mark', kind: 'D', pos: safeTarget({ x: goal.x + u.x * r, z: goal.z + u.z * r }, 1.2), bonus: 14 });
  }
  const opps = state.skaters
    .filter((o) => o.team === opp && onIce(o) && !isGoalie(o) && o.id !== focus?.id)
    .sort((a, b) => threat(state, team, b) - threat(state, team, a));
  for (const [i, o] of opps.slice(0, n).entries()) {
    const dg = d2(o.pos, goal);
    const u = unit(goal.x - o.pos.x, goal.z - o.pos.z);
    const off = clamp(dg * 0.22, 1.1, 2.6);
    // goal-side of the man, leaning a little into the passing lane from the puck
    const p = { x: o.pos.x + u.x * off, z: o.pos.z + u.z * off };
    p.x += (fp.x - p.x) * 0.15;
    p.z += (fp.z - p.z) * 0.15;
    slots.push({ key: `mark:${o.id}`, role: 'mark', kind: dg < 14 ? 'D' : 'any', pos: safeTarget(p, 1.2), target: o.id, bonus: i === 0 ? 5 : i === 1 ? 2 : 0 });
  }
  // spare men (we have more skaters): protect the slot, then sit high
  box('slotD', clamp(fp.x * 0.2, -2, 2), -20.5);
  box('highD', fp.x * 0.4, clamp(fa - 7, -18, 4));
  return slots;
}
