// Skating model, skater collisions (each other, boards, nets) and puck
// physics (carry, slide, flight, boards/glass, posts, crossbar, net mesh,
// goal-line crossing, goalie save planes, body deflections, pickups).

import { GOAL, PHYS, RINK } from '../config';
import type { GameState, Skater, TeamId } from '../types';
import { goalieSavePlane } from './goalie';
import { givePuck, loosePuck, touchPuck } from './puckops';
import { canAct, carryPoint, onIce, stickPoint } from './query';
import { attackDir, attackGoalZ, boardsInfo, defenderOfGoal, depthPastLine, netBox } from './rink';
import { angleDiff, clamp, emit, gs, headingOf, rand, randRange, sk } from './util';

const PR = PHYS.puckRadius;
const HW = GOAL.halfWidth;
/** how hard a windup slows a skater down to the windup speed (m/s^2) */
const WINDUP_BRAKE = 9;
/**
 * Kids turn their body (and stick) at most this fast, rad/s: about 0.2 s to turn
 * around. Without it a kid nearly at a standstill, or starting a lunge, faced his new
 * direction in one tick (135-degree sprite snaps). The dog spins on the spot.
 */
export const KID_TURN_RATE = 11;

/** Coast decel (m/s^2) with no direction held: ice friction, stronger as the skater slows so he settles. */
function coastFriction(s: Skater, speed: number): number {
  if (s.state === 'fallen') return 4.5; // fallen skaters slide to a stop faster
  if (s.state === 'windup') return PHYS.windupGlide;
  const k = clamp(1 - speed / PHYS.coastStopSpeed, 0, 1);
  return PHYS.iceFriction + (PHYS.coastStopFriction - PHYS.iceFriction) * k;
}

/** Turn `s` toward heading `want`: instantly for the dog (and goalies), rate-limited for kids. */
function turnToward(s: Skater, want: number, dt: number): void {
  if (s.kind !== 'kid') {
    s.facing = want;
    return;
  }
  const step = KID_TURN_RATE * dt;
  const diff = angleDiff(want, s.facing);
  s.facing = Math.abs(diff) <= step ? want : angleDiff(s.facing + Math.sign(diff) * step, 0);
}

// ---------------------------------------------------------------- skating ----

/**
 * One tick of skating for a non-goalie skater, driven by `s.intent.move`.
 * The velocity change is split into the part along the current velocity
 * (speeding up = accel, slowing down = hard stop decel scaled by `turn`) and
 * the part across it (turning grip, much stronger for agile skaters). That
 * split is what makes it feel like skates: you can carve tight arcs at speed
 * but you can't reverse instantly.
 */
export function skateStep(state: GameState, s: Skater, dt: number): void {
  const a = s.attrs;
  const d = sk(s);
  let mx = s.intent.move.x;
  let mz = s.intent.move.z;
  let ml = Math.hypot(mx, mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
    ml = 1;
  }
  let vmax = a.maxSpeed;
  let acc = a.accel;
  if (s.state === 'windup') vmax *= 0.6;
  if (s.turboActive) {
    // turbo is a burst, not just a higher cap
    vmax *= PHYS.turboMul;
    acc *= 1.25;
  }
  if (s.stun > 0) {
    vmax *= 0.55;
    acc *= 0.6;
  }
  if (s.state === 'check') {
    // the lunge drives along its own direction, slightly faster than top speed
    mx = d.lunge.x;
    mz = d.lunge.z;
    ml = 1;
    vmax += PHYS.checkLungeSpeed;
    acc *= 2.2;
  }
  const control = canAct(s);
  const speed = Math.hypot(s.vel.x, s.vel.z);

  if (!control || ml < 0.05) {
    // coast
    const fr = coastFriction(s, speed);
    if (speed > 1e-6) {
      let ns = Math.max(0, speed - fr * dt);
      // loading a shot digs the edges in with or without a direction held, so
      // a windup glides in at the same speed either way (UP never changes a shot)
      if (s.state === 'windup' && ns > vmax) ns = Math.max(vmax, speed - WINDUP_BRAKE * dt);
      s.vel.x *= ns / speed;
      s.vel.z *= ns / speed;
    }
  } else {
    const dvx = mx * vmax * ml - s.vel.x;
    const dvz = mz * vmax * ml - s.vel.z;
    if (speed < 0.4) {
      // from a standstill: quick first strides
      const lim = acc * 1.4 * dt;
      const l = Math.hypot(dvx, dvz);
      const k = l > lim ? lim / l : 1;
      s.vel.x += dvx * k;
      s.vel.z += dvz * k;
    } else {
      const hx = s.vel.x / speed;
      const hz = s.vel.z / speed;
      let par = dvx * hx + dvz * hz;
      let px = dvx - par * hx;
      let pz = dvz - par * hz;
      const cosA = (mx * hx + mz * hz) / ml;
      // slowing down while still heading the same way (turbo ran out) is gentle;
      // slowing down because you want to go elsewhere is a hard stop
      // (loading a shot digs the edges in: slows to the windup speed quickly)
      const brake = cosA > 0.7 ? (s.state === 'windup' ? WINDUP_BRAKE : 3.0) : PHYS.stopDecel * (0.35 + 0.65 * a.turn);
      par = par < 0 ? Math.max(par, -brake * dt) : Math.min(par, acc * dt);
      const grip = acc * (0.9 + 1.6 * a.turn) * dt;
      const pl = Math.hypot(px, pz);
      if (pl > grip) {
        px *= grip / pl;
        pz *= grip / pl;
      }
      s.vel.x += par * hx + px;
      s.vel.z += par * hz + pz;
      if (cosA < -0.5 && speed > 5.5 && d.stopCd <= 0) {
        emit(state, { type: 'hardStop', skaterId: s.id, speed });
        d.stopCd = 1.0;
      }
    }
  }
  s.pos.x += s.vel.x * dt;
  s.pos.z += s.vel.z * dt;

  // facing: the lunge, else velocity, else the stick turns on the spot
  const ns = Math.hypot(s.vel.x, s.vel.z);
  if (s.state === 'check') turnToward(s, headingOf(d.lunge.x, d.lunge.z), dt);
  else if (s.state === 'windup') {
    // square up to the net while loading the shot
    const tx = s.intent.aimAt ? s.intent.aimAt.x : 0;
    const tz = s.intent.aimAt ? s.intent.aimAt.z : attackGoalZ(s.team, state.period);
    const want = headingOf(tx - s.pos.x, tz - s.pos.z);
    s.facing += clamp(angleDiff(want, s.facing), -7 * dt, 7 * dt);
  } else if (control && ns > 1.0) turnToward(s, headingOf(s.vel.x, s.vel.z), dt);
  else if (control && ml > 0.1) turnToward(s, headingOf(mx, mz), dt);
}

// ------------------------------------------------------------- collisions ----

/** Circle-vs-circle pushes between all skaters on the ice (mass weighted, a little bounce). */
export function collideSkaters(state: GameState): void {
  const ks = state.skaters;
  for (let i = 0; i < ks.length; i++) {
    const a = ks[i];
    if (!onIce(a)) continue;
    for (let j = i + 1; j < ks.length; j++) {
      const b = ks[j];
      if (!onIce(b)) continue;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const min = a.attrs.radius + b.attrs.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const nx = d2 > 0 ? dx / d : 1;
      const nz = d2 > 0 ? dz / d : 0;
      const ma = a.attrs.weight;
      const mb = b.attrs.weight;
      const over = min - d;
      a.pos.x -= nx * over * (mb / (ma + mb));
      a.pos.z -= nz * over * (mb / (ma + mb));
      b.pos.x += nx * over * (ma / (ma + mb));
      b.pos.z += nz * over * (ma / (ma + mb));
      const vn = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
      if (vn < 0) {
        const j = (-(1 + 0.2) * vn) / (1 / ma + 1 / mb);
        a.vel.x -= (j / ma) * nx;
        a.vel.z -= (j / ma) * nz;
        b.vel.x += (j / mb) * nx;
        b.vel.z += (j / mb) * nz;
      }
    }
  }
}

/** Keep a skater inside the boards and out of the nets. Emits `bodyBoards` on hard slams. */
export function collideSkaterWorld(state: GameState, s: Skater): void {
  const r = s.attrs.radius;
  const b = boardsInfo(s.pos.x, s.pos.z);
  if (b.dist < r) {
    s.pos.x -= b.nx * (r - b.dist);
    s.pos.z -= b.nz * (r - b.dist);
    const vn = s.vel.x * b.nx + s.vel.z * b.nz;
    if (vn > 0) {
      s.vel.x -= (1 + PHYS.skaterRestitution) * vn * b.nx;
      s.vel.z -= (1 + PHYS.skaterRestitution) * vn * b.nz;
      const d = sk(s);
      const recentlyHit = state.time - d.hitTime < 0.6;
      if (d.boardsCd <= 0 && (vn > 5.5 || (recentlyHit && vn > 2.5))) {
        emit(state, { type: 'bodyBoards', skaterId: s.id, speed: vn });
        d.boardsCd = 0.5;
      }
    }
  }
  for (const sign of [1, -1]) {
    const n = netBox(sign);
    const qx = clamp(s.pos.x, n.x0, n.x1);
    const qz = clamp(s.pos.z, n.z0, n.z1);
    let dx = s.pos.x - qx;
    let dz = s.pos.z - qz;
    let d = Math.hypot(dx, dz);
    if (d >= r) continue;
    if (d < 1e-6) {
      // center inside the frame: leave through the nearest face
      const opts = [
        { d: s.pos.x - n.x0, x: -1, z: 0 },
        { d: n.x1 - s.pos.x, x: 1, z: 0 },
        { d: s.pos.z - n.z0, x: 0, z: -1 },
        { d: n.z1 - s.pos.z, x: 0, z: 1 },
      ].sort((p, q) => p.d - q.d)[0];
      dx = opts.x;
      dz = opts.z;
      d = 0;
      s.pos.x += dx * (opts.d + r);
      s.pos.z += dz * (opts.d + r);
    } else {
      dx /= d;
      dz /= d;
      s.pos.x += dx * (r - d);
      s.pos.z += dz * (r - d);
    }
    const vn = s.vel.x * dx + s.vel.z * dz;
    if (vn < 0) {
      s.vel.x -= 1.2 * vn * dx;
      s.vel.z -= 1.2 * vn * dz;
    }
  }
}

// ------------------------------------------------------------------- puck ----

/** One tick of puck physics. Sets gs(state).goalPending / outOfPlay for game.ts to act on. */
export function updatePuck(state: GameState, dt: number): void {
  const p = state.puck;
  const G = gs(state);
  if (p.pickupBlock > 0) {
    p.pickupBlock -= dt;
    if (p.pickupBlock <= 0) {
      p.pickupBlock = 0;
      p.blockId = null;
    }
  }
  G.boardsCd -= dt;
  G.postCd -= dt;
  G.netCd -= dt;
  // the stuck-puck clock only runs while nobody has the puck
  if (p.owner !== null) {
    G.noTouchTime = 0;
    carryPuck(state);
  } else {
    G.noTouchTime += dt;
    loosePuckStep(state, dt);
  }
  p.spin += Math.hypot(p.vel.x, p.vel.z) * dt * 2.5;
}

function carryPuck(state: GameState): void {
  const p = state.puck;
  const o = state.skaters[p.owner!];
  if (o.state === 'box' || o.state === 'fallen') {
    loosePuck(state, o.vel.x * 0.6, o.vel.z * 0.6);
    return;
  }
  sk(o).lastOwnTime = state.time;
  if (o.state === 'gHold') {
    // in the glove
    p.pos.x = o.pos.x + Math.sin(o.facing) * 0.3;
    p.pos.z = o.pos.z + Math.cos(o.facing) * 0.3;
    // a goalie facing into his own net still holds it on the right side of the
    // line (knocked loose from there it would otherwise count as a goal)
    const sign = -attackDir(o.team, state.period);
    if (depthPastLine(p.pos.z, sign) > -PR && Math.abs(p.pos.x) < HW + PR) p.pos.z = sign * (RINK.goalLineZ - PR);
    p.y = 0.45;
    p.vel.x = p.vel.z = p.vy = 0;
    return;
  }
  const t = carryPoint(o, state.time);
  // keep the blade inside the boards
  const b = boardsInfo(t.x, t.z);
  if (b.dist < PR + 0.02) {
    t.x -= b.nx * (PR + 0.02 - b.dist);
    t.z -= b.nz * (PR + 0.02 - b.dist);
  }
  // nets: jamming it over the line from the front scores (unless the goalie
  // smothers it); the blade can't go through the mesh from the side/back
  for (const sign of [1, -1]) {
    const d0 = depthPastLine(p.pos.z, sign);
    const d1 = depthPastLine(t.z, sign);
    if (d1 <= PR || d1 > GOAL.depth + 0.15 || Math.abs(t.x) > HW + 0.06) continue;
    if (d0 <= PR && Math.abs(p.pos.x) < HW - PR && state.phase === 'play') {
      const defTeam = defenderOfGoal(sign, state.period);
      const g = state.skaters[defTeam === 0 ? 4 : 9];
      const gDist = Math.hypot(g.pos.x - t.x, g.pos.z - t.z);
      if (onIce(g) && canAct(g) && gDist < 1.1 && rand() < 0.6 + 0.35 * g.attrs.handling) {
        smother(state, g);
        return;
      }
      p.pos.x = t.x;
      p.pos.z = t.z;
      loosePuck(state, o.vel.x * 0.5, o.vel.z * 0.5);
      if (G(state).goalPending === null) G(state).goalPending = (1 - defTeam) as TeamId;
      return;
    }
    // blocked by the frame: the puck stays put; if the skater drags too far it's lost
    t.x = p.pos.x;
    t.z = p.pos.z;
  }
  const lag = Math.hypot(t.x - o.pos.x, t.z - o.pos.z);
  if (lag > 1.2) {
    loosePuck(state, 0, 0);
    return;
  }
  // a carried puck moves with its carrier (a finite difference would be dribble noise)
  p.vel.x = o.vel.x;
  p.vel.z = o.vel.z;
  p.pos.x = t.x;
  p.pos.z = t.z;
  p.y = 0;
  p.vy = 0;
}

const G = (state: GameState) => gs(state);

/** Goalie covers a carried/jammed puck. */
function smother(state: GameState, g: Skater): void {
  const p = state.puck;
  p.owner = g.id;
  p.vel.x = p.vel.z = p.vy = 0;
  touchPuck(state, g.id);
  g.state = 'gHold';
  g.stateTime = 0;
  G(state).frozenBy = g.id;
  G(state).holdTime = 0;
  emit(state, { type: 'save', goalie: g.id, caught: true });
}

function loosePuckStep(state: GameState, dt: number): void {
  const p = state.puck;
  const speed3 = Math.hypot(p.vel.x, p.vel.z, p.vy);
  const n = clamp(Math.ceil((speed3 * dt) / 0.04), 1, 24);
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const px = p.pos.x;
    const pz = p.pos.z;
    const py = p.y;
    // --- integrate
    if (p.y > 0 || p.vy > 0) {
      p.vy -= PHYS.gravity * h;
      p.y += p.vy * h;
      const drag = 1 - PHYS.puckAirDrag * h;
      p.vel.x *= drag;
      p.vel.z *= drag;
      if (p.y <= 0) {
        p.y = 0;
        if (p.vy < -2) {
          p.vy = -p.vy * 0.28;
          p.vel.x *= 0.9;
          p.vel.z *= 0.9;
        } else p.vy = 0;
      }
    } else {
      const sp = Math.hypot(p.vel.x, p.vel.z);
      if (sp > 1e-6) {
        const k = Math.max(0, sp - PHYS.puckFriction * h) / sp;
        p.vel.x *= k;
        p.vel.z *= k;
      }
    }
    p.pos.x += p.vel.x * h;
    p.pos.z += p.vel.z * h;

    if (state.phase === 'play') {
      // --- goalies (geometric save at the goalie's plane)
      for (const gid of [4, 9]) {
        const g = state.skaters[gid];
        if (goalieSavePlane(state, g, px, pz, py)) break;
      }
      if (p.owner !== null) return;
    }
    // --- nets
    puckNets(state, px, pz, py);
    if (G(state).outOfPlay) return;
    // --- boards and glass
    const b = boardsInfo(p.pos.x, p.pos.z);
    if (b.dist < PR) {
      if (p.y > RINK.glassHeight) {
        G(state).outOfPlay = true;
        p.vel.x = p.vel.z = 0;
        return;
      }
      p.pos.x -= b.nx * (PR - b.dist);
      p.pos.z -= b.nz * (PR - b.dist);
      const vn = p.vel.x * b.nx + p.vel.z * b.nz;
      if (vn > 0) {
        // reflect the normal part, scrub a little of the tangential part
        const tx = p.vel.x - vn * b.nx;
        const tz = p.vel.z - vn * b.nz;
        p.vel.x = tx * 0.92 - vn * PHYS.puckRestitution * b.nx;
        p.vel.z = tz * 0.92 - vn * PHYS.puckRestitution * b.nz;
        if (vn > 1.5 && G(state).boardsCd <= 0) {
          emit(state, { type: 'boards', pos: { x: p.pos.x, z: p.pos.z }, speed: vn });
          G(state).boardsCd = 0.12;
        }
        G(state).shotSeq++;
      }
    }
    if (state.phase !== 'play') continue;
    // --- bodies (shot blocks, skate deflections)
    deflectOffBodies(state);
    // --- pickups
    if (tryPickups(state)) return;
  }
}

function puckNets(state: GameState, px: number, pz: number, py: number): void {
  const p = state.puck;
  const Gs = G(state);
  for (const sign of [1, -1]) {
    const zl = sign * RINK.goalLineZ;
    const d0 = depthPastLine(pz, sign);
    let d1 = depthPastLine(p.pos.z, sign);
    if (d1 < -1 || d1 > GOAL.depth + 0.6 || Math.abs(p.pos.x) > HW + 0.6) continue;
    const low = p.y < GOAL.height;
    // posts
    if (low) {
      for (const sx of [-HW, HW]) {
        const dx = p.pos.x - sx;
        const dz = p.pos.z - zl;
        const dd = Math.hypot(dx, dz);
        const min = GOAL.postRadius + PR;
        if (dd >= min) continue;
        const nx = dd > 1e-6 ? dx / dd : 0;
        const nz = dd > 1e-6 ? dz / dd : -sign;
        p.pos.x = sx + nx * min;
        p.pos.z = zl + nz * min;
        const vn = p.vel.x * nx + p.vel.z * nz;
        if (vn < 0) {
          p.vel.x -= (1 + PHYS.postRestitution) * vn * nx;
          p.vel.z -= (1 + PHYS.postRestitution) * vn * nz;
          if (-vn > 2 && Gs.postCd <= 0) {
            emit(state, { type: 'post', pos: { x: sx, z: zl } });
            Gs.postCd = 0.3;
          }
          Gs.shotSeq++;
        }
      }
      // the post moved the puck: a puck sliding along the line can be pushed
      // from partly over it to fully over it here, so the tests below must see
      // where it is now, not where it was before the collision
      d1 = depthPastLine(p.pos.z, sign);
    }
    // crossbar: crossing the goal plane at bar height
    if (d0 < 0 && d1 >= 0 && Math.abs(p.pos.x) < HW && Math.abs(p.y - GOAL.height) < PR + GOAL.postRadius + 0.02) {
      p.pos.z = zl - sign * (PR + 0.02);
      p.vel.z = -p.vel.z * 0.55;
      p.vy = p.y > GOAL.height ? Math.abs(p.vy) * 0.5 + 1.5 : -Math.abs(p.vy) * 0.5 - 0.5;
      if (Gs.postCd <= 0) {
        emit(state, { type: 'post', pos: { x: p.pos.x, z: zl } });
        Gs.postCd = 0.3;
      }
      Gs.shotSeq++;
      continue;
    }
    // goal: the whole puck past the line, between the posts, under the bar,
    // having come in through the mouth. "Through the mouth" = last substep it
    // was between the posts and short of the back mesh (in front of the line,
    // straddling it, or already inside), never beside or behind the frame. A
    // puck that is somehow inside without having been counted (pushed in by a
    // post, released there) is a goal the moment it moves, not a dead ghost.
    if (
      state.phase === 'play' &&
      Gs.goalPending === null &&
      d1 > PR &&
      d1 < GOAL.depth &&
      Math.abs(p.pos.x) < HW - PR &&
      p.y < GOAL.height - PR &&
      Math.abs(px) < HW &&
      d0 < GOAL.depth
    ) {
      Gs.goalPending = (1 - defenderOfGoal(sign, state.period)) as TeamId;
    }
    // landing on top of the net = dead puck
    if (py >= GOAL.height && p.y < GOAL.height && d1 > 0 && d1 < GOAL.depth && Math.abs(p.pos.x) < HW) {
      if (state.phase === 'play') Gs.outOfPlay = true;
      p.y = GOAL.height;
      p.vy = 0;
      p.vel.x = p.vel.z = 0;
      return;
    }
    if (!low) continue;
    // side mesh (x = +-HW, from the line to the back)
    if (d1 > 0 && d1 < GOAL.depth + PR) {
      for (const sx of [-HW, HW]) {
        if (Math.abs(p.pos.x - sx) >= PR + 0.02) continue;
        const inside = Math.abs(px) < HW;
        const out = Math.sign(sx);
        if (inside) {
          p.pos.x = sx - out * (PR + 0.021);
          p.vel.x = -p.vel.x * 0.2;
          p.vel.z *= 0.7;
        } else {
          p.pos.x = sx + out * (PR + 0.021);
          p.vel.x = -p.vel.x * 0.35;
          p.vel.z *= 0.8;
          netHit(state, p.pos.x, p.pos.z);
        }
      }
    }
    // back mesh
    if (Math.abs(p.pos.x) < HW + PR && Math.abs(d1 - GOAL.depth) < PR + 0.02) {
      const inside = d0 < GOAL.depth;
      if (inside) {
        p.pos.z = zl + sign * (GOAL.depth - PR - 0.021);
        p.vel.z = -p.vel.z * 0.15;
        p.vel.x *= 0.6;
      } else {
        p.pos.z = zl + sign * (GOAL.depth + PR + 0.021);
        p.vel.z = -p.vel.z * 0.35;
        p.vel.x *= 0.8;
        netHit(state, p.pos.x, p.pos.z);
      }
    }
  }
}

function netHit(state: GameState, x: number, z: number): void {
  const Gs = G(state);
  Gs.shotSeq++;
  if (Gs.netCd > 0) return;
  emit(state, { type: 'netHit', pos: { x, z } });
  Gs.netCd = 0.3;
}

function deflectOffBodies(state: GameState): void {
  const p = state.puck;
  if (p.y > 1.1) return;
  for (const s of state.skaters) {
    if (!onIce(s) || s.kind === 'goalie') continue;
    if (p.blockId === s.id && p.pickupBlock > 0) continue;
    const dx = p.pos.x - s.pos.x;
    const dz = p.pos.z - s.pos.z;
    const min = s.attrs.radius * 0.7 + PR;
    const d = Math.hypot(dx, dz);
    if (d >= min || d < 1e-6) continue;
    const nx = dx / d;
    const nz = dz / d;
    const rvx = p.vel.x - s.vel.x;
    const rvz = p.vel.z - s.vel.z;
    const vn = rvx * nx + rvz * nz;
    if (vn >= 0 || Math.hypot(rvx, rvz) < 4) continue;
    p.pos.x = s.pos.x + nx * min;
    p.pos.z = s.pos.z + nz * min;
    p.vel.x -= 1.3 * vn * nx;
    p.vel.z -= 1.3 * vn * nz;
    p.vel.x *= 0.7;
    p.vel.z *= 0.7;
    touchPuck(state, s.id);
    return;
  }
}

/** Loose puck reaches a stick: the nearest eligible blade gets it (fast pucks need a reception roll). */
function tryPickups(state: GameState): boolean {
  const p = state.puck;
  if (p.y > 0.5) return false;
  // nobody reaches through the mesh for a puck lying inside a net
  for (const sign of [1, -1]) {
    const d = depthPastLine(p.pos.z, sign);
    if (d > PR && d < GOAL.depth && Math.abs(p.pos.x) < HW) return false;
  }
  let best: Skater | null = null;
  let bd = Infinity;
  for (const s of state.skaters) {
    if (!canAct(s) || sk(s).recvCd > 0) continue;
    if (p.blockId === s.id && p.pickupBlock > 0) continue;
    if (s.state === 'gHold') continue;
    let d: number;
    if (s.kind === 'goalie') {
      // goalies smother slow pucks around their body; fast ones are saves
      const rel = Math.hypot(p.vel.x - s.vel.x, p.vel.z - s.vel.z);
      if (rel > 9 || p.y > 0.9) continue;
      const sp = stickPoint(s);
      d = Math.min(Math.hypot(p.pos.x - s.pos.x, p.pos.z - s.pos.z) - 0.1, Math.hypot(p.pos.x - sp.x, p.pos.z - sp.z));
    } else {
      const sp = stickPoint(s);
      d = Math.hypot(p.pos.x - sp.x, p.pos.z - sp.z);
      // reaching for a bullet is harder than collecting a pass
      const rel = Math.hypot(p.vel.x - s.vel.x, p.vel.z - s.vel.z);
      if (rel > 15 && d > PHYS.pickupRadius * 0.6) continue;
      if (rel > 15 && p.y > 0.25) continue;
    }
    if (d < PHYS.pickupRadius && d < bd) {
      bd = d;
      best = s;
    }
  }
  if (!best) return false;
  const rel = Math.hypot(p.vel.x - best.vel.x, p.vel.z - best.vel.z);
  if (rel > PHYS.maxPickupSpeed && best.kind !== 'goalie') {
    const chance = clamp(0.2 + 0.6 * best.attrs.handling - (rel - PHYS.maxPickupSpeed) * 0.04, 0.05, 0.85);
    if (rand() >= chance) {
      // it ticks off the blade (a tip: most of the speed survives)
      const a = headingOf(p.vel.x, p.vel.z) + randRange(-0.45, 0.45);
      const ns = Math.hypot(p.vel.x, p.vel.z) * randRange(0.5, 0.8);
      p.vel.x = Math.sin(a) * ns;
      p.vel.z = Math.cos(a) * ns;
      sk(best).recvCd = 0.3;
      touchPuck(state, best.id);
      return false;
    }
  }
  givePuck(state, best);
  if (best.kind === 'goalie') goalieGotPuck(state, best);
  return true;
}

/** A goalie picked up a loose puck: cover it if under pressure, else play it (auto-clear in goalie.ts). */
function goalieGotPuck(state: GameState, g: Skater): void {
  let pressure = false;
  for (const o of state.skaters) {
    if (o.team !== g.team && onIce(o) && Math.hypot(o.pos.x - g.pos.x, o.pos.z - g.pos.z) < 3.0) pressure = true;
  }
  sk(g).carryTime = 0;
  if (pressure) {
    g.state = 'gHold';
    g.stateTime = 0;
    G(state).frozenBy = g.id;
    G(state).holdTime = 0;
  }
}
