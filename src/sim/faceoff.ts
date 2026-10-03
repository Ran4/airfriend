// Faceoffs: lineup formations (incl. shorthanded), the drop, first-press
// wins, false starts, the AI center's reaction window, and the draw back to
// a teammate.

import { RULES } from '../config';
import type { GameState, Skater, TeamId, Vec2 } from '../types';
import { choosePassTarget } from './actions';
import { touchPuck } from './puckops';
import { isGoalie, onIce } from './query';
import { attackDir, clampToRink, ownGoalZ } from './rink';
import { emit, gs, rand, randRange, sk } from './util';

/** AI centers react to the drop within this window (s). */
const AI_REACT_MIN = 0.18;
const AI_REACT_MAX = 0.45;
/** nobody pressed within this long after the drop: coin flip */
export const FACEOFF_TIMEOUT = 1.2;
/** chance an AI center jumps the drop (FALSE START!) */
const AI_FALSE_START_CHANCE = 0.05;
/** an AI jump comes within this long before the drop (never before 0.3 s) */
const AI_FALSE_START_LEAD = 0.8;
/** the human's held direction picks the draw target above this stick deflection */
const DRAW_AIM_MIN = 0.35;

/** Is the human pressing for `team` in this faceoff? */
const humanTakes = (state: GameState, team: TeamId): boolean =>
  team === 0 && !state.autoplay && gs(state).takers[0] === state.controlledId;

/** The skater taking the draw: the controlled skater for HOME, else the center (or a stand-in if boxed). */
function faceoffTaker(state: GameState, team: TeamId): Skater {
  const on = state.skaters.filter((s) => s.team === team && onIce(s) && !isGoalie(s));
  if (team === 0) {
    const c = state.skaters[state.controlledId];
    if (onIce(c) && c.team === 0 && !isGoalie(c)) return c;
  }
  const order = ['C', 'W', 'RD', 'LD'];
  on.sort((a, b) => order.indexOf(a.position) - order.indexOf(b.position));
  return on[0];
}

/**
 * Lineup positions for every skater on the ice around `spot`. Offsets are
 * expressed along each team's attack direction so both sides mirror; the
 * shorthanded side drops the winger and pulls the D in.
 */
export function faceoffFormation(state: GameState, spot: Vec2): Map<number, { pos: Vec2; facing: number }> {
  const out = new Map<number, { pos: Vec2; facing: number }>();
  const wingX = spot.x === 0 ? 3.5 : -Math.sign(spot.x) * 3.5; // wingers line up toward the middle
  for (const team of [0, 1] as TeamId[]) {
    const d = attackDir(team, state.period);
    const facing = d === 1 ? 0 : Math.PI;
    const taker = faceoffTaker(state, team);
    const rest = state.skaters.filter((s) => s.team === team && onIce(s) && !isGoalie(s) && s.id !== taker.id);
    // slot templates: [lateral x (world), along offset]
    const slots: { role: string; x: number; a: number }[] =
      rest.length >= 3
        ? [
            { role: 'W', x: wingX, a: -1.5 },
            { role: 'LD', x: 3.0 * d, a: -5.5 },
            { role: 'RD', x: -3.0 * d, a: -5.5 },
          ]
        : rest.length === 2
          ? [
              { role: 'LD', x: 2.5 * d, a: -4.5 },
              { role: 'RD', x: -2.5 * d, a: -4.5 },
            ]
          : [{ role: 'D', x: 0, a: -4.5 }];
    // matching positions first, then whoever is left
    const free = [...rest];
    const assign = new Map<string, Skater>();
    for (const sl of slots) {
      const i = free.findIndex((s) => s.position === sl.role);
      if (i >= 0) assign.set(sl.role, free.splice(i, 1)[0]);
    }
    for (const sl of slots) if (!assign.has(sl.role) && free.length) assign.set(sl.role, free.shift()!);
    const place = (s: Skater, x: number, a: number) => {
      const p = clampToRink({ x: spot.x + x, z: spot.z + a * d }, s.attrs.radius + 0.6);
      // never behind your own goal line
      const gz = ownGoalZ(team, state.period);
      if ((p.z - gz) * d < 0.8) p.z = gz + d * 0.8;
      if (Math.abs(p.z - gz) < 1.5 && Math.abs(p.x) < 1.6) p.x = Math.sign(p.x || 1) * 1.6;
      out.set(s.id, { pos: p, facing });
    };
    place(taker, 0, -1.2);
    for (const sl of slots) {
      const s = assign.get(sl.role);
      if (s) place(s, sl.x, sl.a);
    }
    const g = state.skaters[team === 0 ? 4 : 9];
    if (onIce(g)) out.set(g.id, { pos: { x: 0, z: ownGoalZ(team, state.period) + d * 0.9 }, facing });
  }
  return out;
}

/** Lineup -> drop (s): random, so the drop can't be timed by counting; longer on period openers. */
function rollDropTime(opener: boolean): number {
  return opener
    ? randRange(RULES.faceoffOpenerDropMin, RULES.faceoffOpenerDropMax)
    : randRange(RULES.faceoffDropMin, RULES.faceoffDropMax);
}

/**
 * Line everyone up at `spot` and enter phase `faceoff`. `opener` marks the
 * first faceoff of a period (longer wait, so the period card can be read).
 */
export function setupFaceoff(state: GameState, spot: Vec2, opener = false): void {
  const G = gs(state);
  state.phase = 'faceoff';
  state.phaseTime = 0;
  const dropTime = rollDropTime(opener);
  state.faceoff = { spot: { ...spot }, dropped: false, dropTime, earlyPress: [false, false] };
  G.faceoffDone = false;
  G.takers = [faceoffTaker(state, 0).id, faceoffTaker(state, 1).id];
  G.react = [randRange(AI_REACT_MIN, AI_REACT_MAX), randRange(AI_REACT_MIN, AI_REACT_MAX)];
  G.aiFalseStart = [0, 1].map((t) =>
    // never on the game's opening draw: a newcomer's first FALSE START! should be their own
    !humanTakes(state, t as TeamId) && rand() < AI_FALSE_START_CHANCE && !(opener && state.period === 1)
      ? randRange(Math.max(0.3, dropTime - AI_FALSE_START_LEAD), dropTime - 0.1)
      : -1,
  ) as [number, number];
  G.nextSpot = null;
  G.frozenBy = null;
  G.pass = null;
  G.lastShot = null;
  G.touchChain = [];
  G.noTouchTime = 0;
  G.goalPending = null;
  G.outOfPlay = false;
  state.callFor = null;

  const form = faceoffFormation(state, spot);
  for (const s of state.skaters) {
    const f = form.get(s.id);
    if (!f) continue;
    s.pos.x = f.pos.x;
    s.pos.z = f.pos.z;
    s.vel.x = s.vel.z = 0;
    s.facing = f.facing;
    s.state = isGoalie(s) ? 'gReady' : G.takers.includes(s.id) ? 'faceoff' : 'skate';
    s.stateTime = 0;
    s.windup = 0;
    s.turboActive = false;
    s.stun = 0;
    s.intent.move = { x: 0, z: 0 };
  }
  const p = state.puck;
  p.owner = null;
  p.pos.x = spot.x;
  p.pos.z = spot.z;
  p.y = 1.1; // in the ref's hand
  p.vel.x = p.vel.z = p.vy = 0;
  p.pickupBlock = 0;
  p.blockId = null;
  p.lastTouch = null;
  p.prevTouch = null;
  const r = state.referee;
  r.pos.x = spot.x + 0.6;
  r.pos.z = spot.z;
  r.vel.x = r.vel.z = 0;
  r.state = 'drop';
  r.stateTime = 0;
  emit(state, { type: 'faceoffSetup', spot: { ...spot } });
}

/** Per tick in phase `faceoff`: drop, presses, false starts, resolution. */
export function updateFaceoff(state: GameState): void {
  const F = state.faceoff;
  const G = gs(state);
  if (!F || G.faceoffDone) return;
  const t = state.phaseTime;

  if (!F.dropped && t >= F.dropTime) {
    F.dropped = true;
    state.puck.y = 0.6;
    state.puck.vy = -1;
    state.referee.state = 'skate';
    state.referee.stateTime = 0;
    emit(state, { type: 'faceoffDrop' });
    if (F.earlyPress[0] !== F.earlyPress[1]) return win(state, F.earlyPress[0] ? 1 : 0);
    if (F.earlyPress[0] && F.earlyPress[1]) return win(state, rand() < 0.5 ? 0 : 1);
  }

  const pressers: TeamId[] = [];
  for (const team of [0, 1] as TeamId[]) {
    let pressed: boolean;
    if (humanTakes(state, team)) {
      const it = state.skaters[G.takers[team]].intent;
      pressed = it.shoot.pressed || it.pass.pressed;
    } else if (!F.dropped) {
      pressed = G.aiFalseStart[team] >= 0 && t >= G.aiFalseStart[team];
      if (pressed) G.aiFalseStart[team] = -1;
    } else pressed = t >= F.dropTime + G.react[team];
    if (!pressed) continue;
    if (!F.dropped) {
      if (!F.earlyPress[team]) {
        F.earlyPress[team] = true;
        emit(state, { type: 'falseStart', team, skaterId: G.takers[team] });
      }
    } else if (!F.earlyPress[team]) pressers.push(team);
  }
  if (!F.dropped) return;
  if (pressers.length) return win(state, pressers[Math.floor(rand() * pressers.length)]);
  if (t >= F.dropTime + FACEOFF_TIMEOUT) win(state, rand() < 0.5 ? 0 : 1);
}

function win(state: GameState, team: TeamId): void {
  const G = gs(state);
  const F = state.faceoff!;
  G.faceoffDone = true;
  const taker = state.skaters[G.takers[team]];
  const d = attackDir(team, state.period);
  // the human draws it where the stick points (never to his own goalie)
  let target: Skater | null = null;
  const held = taker.intent.move;
  if (humanTakes(state, team) && Math.hypot(held.x, held.z) > DRAW_AIM_MIN) {
    target = choosePassTarget(state, taker, held);
    if (target && isGoalie(target)) target = null;
  }
  // else draw it back: usually to a defenseman, sometimes the winger
  if (!target) {
    const mates = state.skaters.filter((s) => s.team === team && onIce(s) && !isGoalie(s) && s.id !== taker.id);
    const ds = mates.filter((s) => (s.pos.z - F.spot.z) * d < -3);
    const pool = ds.length && rand() < 0.75 ? ds : mates;
    target = pool[Math.floor(rand() * pool.length)] ?? null;
  }
  const p = state.puck;
  p.pos.x = F.spot.x;
  p.pos.z = F.spot.z;
  p.y = 0;
  p.vy = 0;
  p.owner = null;
  const tx = target ? target.pos.x : F.spot.x;
  const tz = target ? target.pos.z : F.spot.z - d * 4;
  const dx = tx - p.pos.x;
  const dz = tz - p.pos.z;
  const dd = Math.hypot(dx, dz) || 1;
  const sp = Math.min(10, Math.max(6, dd * 1.1 + 3));
  p.vel.x = (dx / dd) * sp;
  p.vel.z = (dz / dd) * sp;
  touchPuck(state, taker.id);
  p.blockId = taker.id;
  p.pickupBlock = 0.3;
  // both blades sit inside pickup range of the dot: the beaten center is tied
  // up for a moment, or he'd scoop every draw he just lost
  const loser = sk(state.skaters[G.takers[team === 0 ? 1 : 0]]);
  loser.recvCd = Math.max(loser.recvCd, RULES.faceoffLoserRecvCd);
  G.pass = target ? { from: taker.id, to: target.id, time: state.time } : null;
  for (const id of G.takers) state.skaters[id].state = 'skate';
  emit(state, { type: 'faceoffWin', team, skaterId: taker.id });
  state.phase = 'play';
  state.phaseTime = 0;
  state.faceoff = null;
}
