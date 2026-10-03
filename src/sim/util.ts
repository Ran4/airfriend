// Small math + RNG helpers shared by the sim (and importable by the AI).
// No DOM, no three.js.

import type { GameEvent, GameSimData, GameState, Skater, SkaterSimData, Vec2 } from '../types';

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** heading angle of a world direction (0 = +z, +PI/2 = +x) */
export const headingOf = (x: number, z: number): number => Math.atan2(x, z);
/** unit world direction of a heading angle */
export const dirOf = (h: number): Vec2 => ({ x: Math.sin(h), z: Math.cos(h) });
/** a skater's right-hand side for heading h (facing +z, right is -x) */
export const rightOf = (h: number): Vec2 => ({ x: -Math.cos(h), z: Math.sin(h) });

export function norm(x: number, z: number): Vec2 {
  const l = Math.hypot(x, z);
  return l > 1e-9 ? { x: x / l, z: z / l } : { x: 0, z: 0 };
}

/** wrap an angle difference into [-PI, PI] */
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** distance from point p to segment ab, plus the segment parameter t (0..1) */
export function segDist(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number } {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  const t = l2 > 1e-9 ? clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / l2, 0, 1) : 0;
  return { d: Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t)), t };
}

// ------------------------------------------------------------------ RNG ----
// Everything random in the sim goes through rand() so tests can seed it.
let rng: () => number = Math.random;
export const rand = (): number => rng();
export const randRange = (a: number, b: number): number => a + (b - a) * rng();
/** approx. standard normal (sum of 3 uniforms) */
export const gauss = (): number => (rng() + rng() + rng() - 1.5) * 2;
/** replace the RNG (null restores Math.random) */
export function setRandom(fn: (() => number) | null): void {
  rng = fn ?? Math.random;
}
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- accessors ----
export const emit = (state: GameState, e: GameEvent): void => {
  state.events.push(e);
};
/** sim-internal per-skater data (createGame always sets it) */
export const sk = (s: Skater): SkaterSimData => s.sim!;
/** sim-internal game data (createGame always sets it) */
export const gs = (state: GameState): GameSimData => state.sim!;
