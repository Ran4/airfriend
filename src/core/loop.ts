// Fixed-step clock + render interpolation for the main loop (src/main.ts).
//
// The sim runs at exactly SIM_HZ; the display runs at whatever the monitor
// does (59.94, 60.05, 120, 144 Hz ...). Two things keep motion smooth:
//
//  1. FixedClock snaps a frame time within VSYNC_SNAP of one sim step to
//     exactly one step. Without it a ~60 Hz panel slowly drifts the
//     accumulator across the tick boundary (every ~17 s on a 59.94 Hz panel)
//     and then alternates 0- and 2-step frames for a few hundred ms; a loop
//     that happens to start right at the boundary stutters like that all the
//     time, on timestamp jitter alone.
//  2. RenderInterp draws actors between the last two sim states. At 144 Hz
//     over half the frames run no sim step at all, so raw positions advance in
//     an irregular 2-3-2-3 frame pattern while the camera spring moves every
//     frame: sprites wobble against the scrolling rink. Instead, the render
//     and HUD see each actor at lerp(prev, cur, alpha), alpha = leftover
//     accumulator / SIM_DT, written into the state just for the draw and put
//     back bit-for-bit right after, so the sim never sees a lerped value.

import { SIM_DT } from '../config';
import type { GameState, Vec2 } from '../types';

/** frame times this close to one sim step count as exactly one step (seconds) */
const VSYNC_SNAP = 0.001;
/** longest frame credited to the sim; a longer hitch (tab switch, GC) is dropped */
const MAX_FRAME = 0.1;
/** an actor that moved further than this in one tick teleported: draw it, don't slide it (m) */
export const TELEPORT = 3;

export class FixedClock {
  /** game seconds owed to the sim, always in [0, SIM_DT) between frames */
  acc = 0;

  /** wall-clock seconds since the last frame -> frame seconds (clamped, vsync-snapped) */
  static frameSeconds(raw: number): number {
    const dt = Math.min(MAX_FRAME, Math.max(0, raw));
    return Math.abs(dt - SIM_DT) < VSYNC_SNAP ? SIM_DT : dt;
  }

  /**
   * Credit one rendered frame of `dt` seconds (already from frameSeconds) at
   * `speed`x and run every whole sim step it pays for. `tick` returns false
   * when the sim threw: stepping stops for this frame and the backlog is
   * dropped, so a throwing sim gets one attempt per frame instead of 8*speed.
   * Returns the number of steps that ran.
   */
  advance(dt: number, speed: number, tick: () => boolean): number {
    this.acc += dt * speed;
    const max = 8 * speed;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < max) {
      if (!tick()) {
        this.acc = 0;
        break;
      }
      this.acc -= SIM_DT;
      steps++;
    }
    // hopelessly behind (slow machine at a high ?speed): don't spiral
    if (steps >= max) this.acc = 0;
    return steps;
  }

  /** how far the display is between the last sim step and the next, 0..1 */
  get alpha(): number {
    return Math.min(1, Math.max(0, this.acc / SIM_DT));
  }
}

/**
 * Prev-tick snapshot of every drawn position (skaters x/z, puck x/z/y,
 * referee x/z) and the swap that shows lerped positions to one draw.
 * Layout of both buffers: [s0.x, s0.z, s1.x, ... , puck.x, puck.z, puck.y, ref.x, ref.z].
 */
export class RenderInterp {
  private prev: Float64Array = new Float64Array(0);
  private saved: Float64Array = new Float64Array(0);
  /** the state `prev` was taken from; null = no usable snapshot (draw raw) */
  private owner: GameState | null = null;
  /** the state currently holding lerped positions, until restore() */
  private swapped: GameState | null = null;

  /** call right before each frame-loop sim step */
  snapshot(s: GameState): void {
    this.prev = read(s, this.prev);
    this.owner = s;
  }

  /** forget the snapshot: the next draws show raw sim positions until the next snapshot */
  invalidate(): void {
    this.owner = null;
  }

  /**
   * Overwrite the drawn positions in `s` with lerp(prev, cur, alpha). Returns
   * true when it changed the state; the caller must then call restore() in a
   * finally. Objects that moved more than TELEPORT in the tick are left at cur.
   */
  apply(s: GameState, alpha: number): boolean {
    if (this.swapped || this.owner !== s || alpha >= 1) return false;
    const prev = this.prev;
    this.saved = read(s, this.saved);
    const cur = this.saved;
    if (cur.length !== prev.length) return false;
    const n = s.skaters.length;
    this.swapped = s;
    for (let k = 0; k < n; k++) lerpXZ(s.skaters[k].pos, prev, cur, 2 * k, alpha);
    const j = 2 * n;
    const pk = s.puck;
    const dx = cur[j] - prev[j];
    const dz = cur[j + 1] - prev[j + 1];
    const dy = cur[j + 2] - prev[j + 2];
    if (dx * dx + dz * dz + dy * dy <= TELEPORT * TELEPORT) {
      pk.pos.x = prev[j] + dx * alpha;
      pk.pos.z = prev[j + 1] + dz * alpha;
      pk.y = prev[j + 2] + dy * alpha;
    }
    lerpXZ(s.referee.pos, prev, cur, j + 3, alpha);
    return true;
  }

  /** put the true sim positions back, bit-for-bit (no-op when nothing is swapped) */
  restore(): void {
    const s = this.swapped;
    if (!s) return;
    this.swapped = null;
    write(s, this.saved);
  }
}

/** p = lerp(prev, cur, alpha) at buffer index i (x) / i+1 (z); left at cur after a teleport */
function lerpXZ(p: Vec2, prev: Float64Array, cur: Float64Array, i: number, alpha: number): void {
  const dx = cur[i] - prev[i];
  const dz = cur[i + 1] - prev[i + 1];
  if (dx * dx + dz * dz > TELEPORT * TELEPORT) return;
  p.x = prev[i] + dx * alpha;
  p.z = prev[i + 1] + dz * alpha;
}

function read(s: GameState, out: Float64Array): Float64Array {
  const n = s.skaters.length;
  const len = 2 * n + 5;
  if (out.length !== len) out = new Float64Array(len);
  for (let k = 0; k < n; k++) {
    out[2 * k] = s.skaters[k].pos.x;
    out[2 * k + 1] = s.skaters[k].pos.z;
  }
  const j = 2 * n;
  out[j] = s.puck.pos.x;
  out[j + 1] = s.puck.pos.z;
  out[j + 2] = s.puck.y;
  out[j + 3] = s.referee.pos.x;
  out[j + 4] = s.referee.pos.z;
  return out;
}

function write(s: GameState, src: Float64Array): void {
  const n = s.skaters.length;
  for (let k = 0; k < n; k++) {
    s.skaters[k].pos.x = src[2 * k];
    s.skaters[k].pos.z = src[2 * k + 1];
  }
  const j = 2 * n;
  s.puck.pos.x = src[j];
  s.puck.pos.z = src[j + 1];
  s.puck.y = src[j + 2];
  s.referee.pos.x = src[j + 3];
  s.referee.pos.z = src[j + 4];
}
