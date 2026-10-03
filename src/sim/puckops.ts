// Puck ownership changes. Every touch goes through touchPuck() so scoring
// credit (scorer/assists), goalie shot tracking and the stuck-puck timer stay
// consistent.

import type { GameState, Skater } from '../types';
import { emit, gs, sk } from './util';

/** Record that skater `id` touched the puck (pickup, shot, pass, deflection, save). */
export function touchPuck(state: GameState, id: number): void {
  const p = state.puck;
  const G = gs(state);
  const s = state.skaters[id];
  if (p.lastTouch !== id) {
    p.prevTouch = p.lastTouch;
    p.lastTouch = id;
  }
  // assists only count within one team's uninterrupted sequence
  const chain = G.touchChain;
  const head = chain.length ? state.skaters[chain[chain.length - 1]] : null;
  if (!head || head.team !== s.team) G.touchChain = [id];
  else if (head.id !== id) {
    chain.push(id);
    if (chain.length > 3) chain.shift();
  }
  G.lastTouchByTeam[s.team] = id;
  G.noTouchTime = 0;
  // a delayed penalty is whistled once the offending team touches the puck (game.ts acts on it at the end of the tick)
  if (G.pendingPenalties?.some((q) => q.team === s.team)) G.delayedTouch = true;
  G.shotSeq++;
}

/** Give the puck to `s` (pickup). Emits `pickup` and `passReceived` when it completes a pass. */
export function givePuck(state: GameState, s: Skater): void {
  const p = state.puck;
  const G = gs(state);
  p.owner = s.id;
  p.vel.x = s.vel.x;
  p.vel.z = s.vel.z;
  p.y = 0;
  p.vy = 0;
  touchPuck(state, s.id);
  sk(s).lastOwnTime = state.time;
  emit(state, { type: 'pickup', skaterId: s.id });
  const pass = G.pass;
  if (pass && pass.from !== s.id && state.skaters[pass.from].team === s.team) {
    emit(state, { type: 'passReceived', from: pass.from, to: s.id });
  }
  G.pass = null;
  G.lastShot = null;
}

/**
 * Knock the puck loose from its owner (hit, poke, fumble, falling down) with
 * the given velocity. The former owner can't re-grab it for `block` seconds.
 */
export function loosePuck(state: GameState, vx: number, vz: number, vy = 0, block = 0.35): void {
  const p = state.puck;
  const prev = p.owner;
  p.owner = null;
  p.vel.x = vx;
  p.vel.z = vz;
  p.vy = vy;
  if (prev !== null) {
    p.blockId = prev;
    p.pickupBlock = block;
    sk(state.skaters[prev]).lastOwnTime = state.time;
    // a puck that was just carried is not a stuck puck
    gs(state).noTouchTime = 0;
  }
  gs(state).shotSeq++;
}
