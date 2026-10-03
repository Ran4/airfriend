// Goalies. The AI only supplies positioning through intent.move (and may
// press PASS to clear a puck the goalie is playing). Everything else is
// automatic here: facing the puck, staying near the crease, reacting to
// incoming shots after a reaction delay (butterfly / dive / stance), the
// geometric save at the goalie's plane, catch vs rebound, and auto-clearing
// a loose puck the goalie picked up.

import { GOAL, PHYS } from '../config';
import type { GameState, Skater } from '../types';
import { doPass } from './actions';
import { loosePuck, touchPuck } from './puckops';
import { attackVec, onIce } from './query';
import { depthPastLine, ownGoalZ, screenRightX } from './rink';
import { angleDiff, clamp, emit, gs, headingOf, lerp, rand, randRange, sk } from './util';

const PR = PHYS.puckRadius;
/** how far out of the crease the sim lets a goalie roam (m from the goal center) */
export const GOALIE_MAX_RANGE = 4.4;
const GOALIE_MIN_OUT = 0.15;
const POSE_TIME = { gButterfly: 0.75, gDiveL: 0.95, gDiveR: 0.95 } as const;
/** a goalie playing a loose puck clears it after this long if the AI hasn't */
const GOALIE_AUTO_CLEAR = 1.0;

/** sign (+1/-1) of the z of the goal this goalie defends */
const goalSign = (state: GameState, g: Skater): number => Math.sign(ownGoalZ(g.team, state.period));

/** Reaction delay for a new incoming shot (s): reflexes, lateral puck movement, being startled. */
function reactionDelay(g: Skater): number {
  return 0.1 + (1 - g.attrs.handling) * 0.32 + Math.min(0.2, sk(g).lateral * 0.018) + (g.stun > 0 ? 0.2 : 0) + rand() * 0.06;
}

/** Per-tick goalie update in phase `play`: shot tracking, reactions, movement, constraints. */
export function updateGoalie(state: GameState, g: Skater, dt: number): void {
  if (!onIce(g)) return;
  const d = sk(g);
  const p = state.puck;
  const sign = goalSign(state, g);

  // lost the covered puck (knocked loose by a hit): back on its feet
  if (g.state === 'gHold' && p.owner !== g.id) {
    g.state = 'gReady';
    g.stateTime = 0;
  }
  // pose timers
  if ((g.state === 'gButterfly' || g.state === 'gDiveL' || g.state === 'gDiveR') && g.stateTime > POSE_TIME[g.state]) {
    g.state = 'gReady';
    g.stateTime = 0;
  }
  if (g.state === 'fallen') {
    if (g.stateTime > PHYS.fallTime) {
      g.state = 'gReady';
      g.stateTime = 0;
      g.invuln = 0.6;
    }
    slide(g, 0, 0, 4.5, dt);
    return;
  }

  // smoothed lateral puck speed: cross-ice passes leave the goalie behind
  d.lateral += (Math.abs(p.vel.x) - d.lateral) * Math.min(1, dt * 4);

  trackShot(state, g, sign, dt);

  // facing: always square to the puck
  const want = headingOf(p.pos.x - g.pos.x, p.pos.z - g.pos.z);
  g.facing += clamp(angleDiff(want, g.facing), -10 * dt, 10 * dt);

  // movement
  const m = g.intent.move;
  const ml = Math.min(1, Math.hypot(m.x, m.z));
  const vmax = g.attrs.maxSpeed * (g.stun > 0 ? 0.6 : 1);
  let tvx = ml > 0.02 ? (m.x / Math.hypot(m.x, m.z)) * ml * vmax : 0;
  let tvz = ml > 0.02 ? (m.z / Math.hypot(m.x, m.z)) * ml * vmax : 0;
  if (d.react === -2 && g.state === 'gReady') {
    // reacted to a shot in the stance: push across toward it
    const dx = d.saveX - g.pos.x;
    tvx = clamp(dx * 12, -5, 5);
  }
  switch (g.state) {
    case 'gHold':
      tvx = tvz = 0;
      break;
    case 'gButterfly':
      tvx = clamp((d.saveX - g.pos.x) * 6, -2.5, 2.5);
      tvz = 0;
      break;
    case 'gDiveL':
    case 'gDiveR': {
      // explosive push early in the dive, then sliding on the ice
      const push = g.stateTime < 0.25 ? 5.5 : 0;
      tvx = d.diveDir * push;
      tvz = 0;
      if (push === 0) {
        slide(g, 0, 0, 6, dt);
        constrain(g, sign);
        return;
      }
      break;
    }
  }
  slide(g, tvx, tvz, g.attrs.accel * (g.state === 'gReady' ? 1 : 2), dt);
  constrain(g, sign);

  // playing a loose puck: AI may press PASS, else it's cleared automatically
  if (p.owner === g.id && g.state !== 'gHold') {
    d.carryTime += dt;
    if (g.intent.pass.pressed || d.carryTime > GOALIE_AUTO_CLEAR) clearPuck(state, g);
  }
}

function slide(g: Skater, tvx: number, tvz: number, acc: number, dt: number): void {
  const dvx = tvx - g.vel.x;
  const dvz = tvz - g.vel.z;
  const l = Math.hypot(dvx, dvz);
  const k = l > acc * dt ? (acc * dt) / l : 1;
  g.vel.x += dvx * k;
  g.vel.z += dvz * k;
  g.pos.x += g.vel.x * dt;
  g.pos.z += g.vel.z * dt;
}

/** Keep the goalie in front of the line and within range of the crease. */
function constrain(g: Skater, sign: number): void {
  const gz = sign * 26.5;
  const out = -depthPastLine(g.pos.z, sign);
  if (out < GOALIE_MIN_OUT) {
    g.pos.z = gz - sign * GOALIE_MIN_OUT;
    if (g.vel.z * sign > 0) g.vel.z = 0;
  }
  const rx = g.pos.x;
  const rz = g.pos.z - gz;
  const r = Math.hypot(rx, rz);
  if (r > GOALIE_MAX_RANGE) {
    g.pos.x = (rx / r) * GOALIE_MAX_RANGE;
    g.pos.z = gz + (rz / r) * GOALIE_MAX_RANGE;
    g.vel.x *= 0.5;
    g.vel.z *= 0.5;
  }
}

/** Detect an incoming shot, wait out the reaction delay, then commit to a save pose. */
function trackShot(state: GameState, g: Skater, sign: number, dt: number): void {
  const d = sk(g);
  const p = state.puck;
  const G = gs(state);
  if (p.owner !== null || g.state === 'gHold') {
    d.react = -1;
    return;
  }
  const vTow = p.vel.z * sign; // >0 = heading at this goal
  const outP = -depthPastLine(p.pos.z, sign);
  const outG = -depthPastLine(g.pos.z, sign);
  if (vTow > 4 && outP > outG && outP < 25) {
    const t = (outP - outG) / vTow;
    const px = p.pos.x + p.vel.x * t;
    const py = Math.max(0, p.y + p.vy * t - 0.5 * PHYS.gravity * t * t);
    if (Math.abs(px) < GOAL.halfWidth + 0.7) {
      if (d.shotSeq !== G.shotSeq) {
        d.shotSeq = G.shotSeq;
        d.react = reactionDelay(g);
      }
      d.saveX = px;
      d.saveY = py;
    }
  } else if (d.react >= 0) d.react = -1;
  if (d.react >= 0) {
    d.react -= dt;
    if (d.react < 0) {
      d.react = -2;
      choosePose(state, g);
    }
  }
}

function choosePose(state: GameState, g: Skater): void {
  if (g.state !== 'gReady') return;
  const d = sk(g);
  const dx = d.saveX - g.pos.x;
  const adx = Math.abs(dx);
  if (adx <= 0.4 && d.saveY > 0.3) return; // glove/blocker in the stance
  if (d.saveY < 0.55 && adx < 0.9) {
    g.state = 'gButterfly';
    g.stateTime = 0;
    return;
  }
  if (adx < 2.3) {
    d.diveDir = Math.sign(dx) || 1;
    g.state = d.diveDir === screenRightX(state.period) ? 'gDiveR' : 'gDiveL';
    g.stateTime = 0;
  }
}

/** seconds for the pads/dive to reach full coverage after committing */
const DEPLOY_TIME = { gButterfly: 0.16, gDive: 0.22 } as const;

/**
 * Save hitbox as [x0, x1, y0, y1] rects in (world x offset from the goalie,
 * height). Butterfly and dive coverage grow from the stance over DEPLOY_TIME,
 * so a goalie who reacts late is still mid-move when the puck arrives.
 */
export function goalieHitbox(g: Skater): [number, number, number, number][] {
  switch (g.state) {
    case 'gReady':
      return [[-0.45, 0.45, 0, 1.25]];
    case 'gButterfly': {
      const k = clamp(g.stateTime / DEPLOY_TIME.gButterfly, 0, 1);
      const w = lerp(0.45, 0.75, k);
      return [
        [-w, w, 0, lerp(1.25, 0.6, k)],
        [-0.32, 0.32, 0, 1.05],
      ];
    }
    case 'gDiveL':
    case 'gDiveR': {
      const k = clamp(g.stateTime / DEPLOY_TIME.gDive, 0, 1);
      const reach = lerp(0.45, 1.8, k);
      const s = sk(g).diveDir;
      return [[s > 0 ? -0.35 : -reach, s > 0 ? reach : 0.35, 0, lerp(1.1, 0.8, k)]];
    }
    default:
      return [];
  }
}

/** How far (m) the puck at (dx, y) is outside the hitbox; 0 = inside. Infinity = no hitbox. */
function hitboxMiss(g: Skater, dx: number, y: number): number {
  let best = Infinity;
  for (const [x0, x1, y0, y1] of goalieHitbox(g)) {
    const ox = Math.max(x0 - PR - dx, 0, dx - x1 - PR);
    const oy = Math.max(y0 - y, 0, y - y1 - PR);
    best = Math.min(best, Math.hypot(ox, oy));
  }
  return best;
}

/**
 * Called from the puck substep loop: if the loose puck just crossed this
 * goalie's plane heading for the net, resolve the geometric save. Returns
 * true if the goalie touched it.
 */
export function goalieSavePlane(state: GameState, g: Skater, px: number, pz: number, py: number): boolean {
  if (!onIce(g) || g.state === 'fallen' || g.state === 'gHold') return false;
  const p = state.puck;
  const sign = goalSign(state, g);
  const vTow = p.vel.z * sign;
  if (vTow < 3) return false;
  const outG = -depthPastLine(g.pos.z, sign);
  const o0 = -depthPastLine(pz, sign);
  const o1 = -depthPastLine(p.pos.z, sign);
  if (!(o0 > outG && o1 <= outG)) return false;
  const t = (o0 - outG) / Math.max(1e-6, o0 - o1);
  const cx = px + (p.pos.x - px) * t;
  const cy = py + (p.y - py) * t;
  const dx = cx - g.pos.x;
  if (Math.abs(dx) > 2.5) return false;
  const miss = hitboxMiss(g, dx, cy);
  let saved = miss <= 0;
  if (!saved && miss < 0.12) saved = rand() < g.attrs.handling * 0.5 * (1 - miss / 0.12);
  if (!saved) return false;
  applySave(state, g, cx, cy, sign);
  return true;
}

function applySave(state: GameState, g: Skater, x: number, y: number, sign: number): void {
  const p = state.puck;
  const G = gs(state);
  const speed = Math.hypot(p.vel.x, p.vel.z);
  const ls = G.lastShot;
  if (ls && !ls.counted && ls.team !== g.team && state.time - ls.time < 2.5) {
    ls.counted = true;
    state.shots[ls.team]++;
    state.skaters[ls.shooter].stats.shots++;
  }
  let catchP = g.state === 'gReady' ? (y > 0.35 ? 0.6 : 0.3) : g.state === 'gButterfly' ? 0.35 : 0.12;
  catchP *= 0.55 + 0.6 * g.attrs.handling;
  catchP -= Math.max(0, speed - 22) * 0.02;
  catchP = clamp(catchP, 0.05, 0.8);
  p.pos.x = x;
  p.pos.z = g.pos.z - sign * 0.12;
  if (rand() < catchP) {
    p.owner = g.id;
    p.vel.x = p.vel.z = p.vy = 0;
    touchPuck(state, g.id);
    sk(g).lastOwnTime = state.time;
    g.state = 'gHold';
    g.stateTime = 0;
    G.frozenBy = g.id;
    G.holdTime = 0;
    G.pass = null;
    emit(state, { type: 'save', goalie: g.id, caught: true });
    return;
  }
  // rebound out in front (rarely deflected up over the glass)
  touchPuck(state, g.id);
  if (y > 0.7 && rand() < 0.05) {
    p.vel.x = randRange(-2, 2);
    p.vel.z = sign * 8;
    p.vy = 9;
    p.y = Math.max(p.y, 0.8);
  } else {
    const a = headingOf(0, -sign) + randRange(-1.0, 1.0);
    const rs = clamp(speed * randRange(0.15, 0.35), 2.5, 10);
    p.vel.x = Math.sin(a) * rs;
    p.vel.z = Math.cos(a) * rs;
    p.vy = y > 0.6 ? rand() * 2.5 : rand() * 0.8;
  }
  p.pickupBlock = 0.15;
  p.blockId = g.id;
  emit(state, { type: 'save', goalie: g.id, caught: false });
}

/** Goalie playing a loose puck moves it on: a pass up ice, or a rim around the boards. */
function clearPuck(state: GameState, g: Skater): void {
  g.intent.move = attackVec(state, g.team);
  if (doPass(state, g)) {
    g.state = 'gReady';
    return;
  }
  const sign = goalSign(state, g);
  const side = g.pos.x >= 0 ? 1 : -1;
  loosePuck(state, side * 9, -sign * 6, 0, 0.4);
  touchPuck(state, g.id);
}
