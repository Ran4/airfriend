// Small text/number helpers shared by the HUD screens.

import { periodLength } from '../sim/query';
import type { GameState, Skater } from '../types';

export function periodName(p: number): string {
  return p === 1 ? '1ST' : p === 2 ? '2ND' : p === 3 ? '3RD' : p === 4 ? 'OT' : `${p}TH`;
}

export function periodTitle(p: number): string {
  return p >= 4 ? 'OVERTIME' : `${periodName(p)} PERIOD`;
}

/** m:ss, rounding up so the display only reads 0:00 when time is really out */
export function clockStr(sec: number): string {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** true while the clock still reads the full period (i.e. its opening faceoff) */
export function atPeriodStart(state: GameState): boolean {
  return state.clock >= periodLength(state.period) - 0.01;
}

export const jersey = (s: Skater): string => `#${s.number}`;

export function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

// ------------------------------------------------------------ easing ----
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t: number): number => 1 - (1 - clamp01(t)) ** 3;

/** integer slide from a to b over `dur` seconds starting at t = 0 */
export function slide(t: number, dur: number, a: number, b: number): number {
  return Math.round(a + (b - a) * easeOut(t / dur));
}

/** square-wave blink: true for the first half of each period */
export const blink = (t: number, hz: number): boolean => (t * hz) % 1 < 0.5;
