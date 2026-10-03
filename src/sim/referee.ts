// The referee: decoration that behaves. Hangs 2-4 m from the puck on the
// boards side, out of the passing lanes, sidesteps skaters, stands at the dot
// for drops, whistles and points at penalties (an arm up through a delayed call).

import type { GameState } from '../types';
import { onIce } from './query';
import { boardsInfo, clampToRink } from './rink';
import { angleDiff, clamp, headingOf } from './util';

const REF_SPEED = 7.5;
const REF_ACCEL = 9;

export function updateReferee(state: GameState, dt: number): void {
  const r = state.referee;
  const p = state.puck;
  r.stateTime += dt;
  if ((r.state === 'whistle' && r.stateTime > 1.0) || (r.state === 'point' && state.phase !== 'penalty' && !state.delayedPenalty)) {
    r.state = 'skate';
    r.stateTime = 0;
  }

  let tx: number;
  let tz: number;
  if (state.phase === 'faceoff' && state.faceoff && !state.faceoff.dropped) {
    // standing at the dot with the puck
    tx = state.faceoff.spot.x + 0.6;
    tz = state.faceoff.spot.z;
  } else {
    // off the puck toward the nearer side boards, a bit behind the play
    const side = p.pos.x >= 0 ? 1 : -1;
    const behind = Math.sign(p.vel.z) || 1;
    tx = p.pos.x + side * 3.2;
    tz = p.pos.z - behind * 1.2;
    const t = clampToRink({ x: tx, z: tz }, 1.0);
    tx = t.x;
    tz = t.z;
    // too close to the boards on that side: swing to the other side of the puck
    if (Math.hypot(tx - p.pos.x, tz - p.pos.z) < 2.0) {
      tx = p.pos.x - side * 3.2;
    }
  }
  // sidestep skaters
  for (const s of state.skaters) {
    if (!onIce(s)) continue;
    const dx = r.pos.x - s.pos.x;
    const dz = r.pos.z - s.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.6 && d > 1e-4) {
      tx += (dx / d) * (1.6 - d) * 2;
      tz += (dz / d) * (1.6 - d) * 2;
    }
  }
  const dvx = clamp((tx - r.pos.x) * 2.5, -REF_SPEED, REF_SPEED) - r.vel.x;
  const dvz = clamp((tz - r.pos.z) * 2.5, -REF_SPEED, REF_SPEED) - r.vel.z;
  const l = Math.hypot(dvx, dvz);
  const k = l > REF_ACCEL * dt ? (REF_ACCEL * dt) / l : 1;
  r.vel.x += dvx * k;
  r.vel.z += dvz * k;
  r.pos.x += r.vel.x * dt;
  r.pos.z += r.vel.z * dt;
  const b = boardsInfo(r.pos.x, r.pos.z);
  if (b.dist < 0.5) {
    r.pos.x -= b.nx * (0.5 - b.dist);
    r.pos.z -= b.nz * (0.5 - b.dist);
  }
  // face the puck
  const want = headingOf(p.pos.x - r.pos.x, p.pos.z - r.pos.z);
  r.facing += clamp(angleDiff(want, r.facing), -6 * dt, 6 * dt);
}

/** Blow the whistle (visual state; the event is emitted by the caller). */
export function refWhistle(state: GameState): void {
  // pointing at a called penalty beats the whistle pose (a delayed call's arm comes down for it)
  if (state.referee.state === 'point' && state.phase === 'penalty') return;
  state.referee.state = 'whistle';
  state.referee.stateTime = 0;
}
