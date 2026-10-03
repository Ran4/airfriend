import type { GameState, Vec2 } from '../types';
import { rand } from '../sim/util';

/*
 * AI memory lives outside GameState (the sim owns the state shape), keyed by
 * the state object. Rematch resets the state IN PLACE, so a tick counter that
 * goes backwards is the signal to forget everything.
 */

export type Mode = 'attack' | 'defend' | 'loose';

export type Role =
  | 'carrier' // has the puck
  | 'chase' // goes for a loose puck
  | 'pressure' // forechecks / pressures the opposing carrier
  | 'mark' // covers an opponent goal-side
  | 'box' // shorthanded box spot
  | 'support' // attack formation spot
  | 'idle';

export interface Assignment {
  role: Role;
  /** stable identity of the spot (for hysteresis), e.g. 'slot', 'pointS', 'mark:7' */
  key: string;
  /** world target (support/mark/box) */
  pos: Vec2;
  /** opponent id for marks / the carrier for pressure */
  target?: number;
}

export interface Brain {
  /** next time this skater re-evaluates its discrete choices */
  thinkAt: number;
  /** temperament 0..1, fixed per game: bolder skaters shoot and check more */
  bold: number;
  /** smoothed movement target (null = snap to the next one) */
  target: Vec2 | null;
  lastKey: string;
  // --- carrier
  plan: 'carry' | 'windup' | 'pass';
  /** windup: release at this time. pass: press at this time */
  planAt: number;
  passTo: number;
  /** when the current pass plan was made (a feed that waits for its lane gives up after a while) */
  passSince: number;
  aimX: number;
  dangleSide: number;
  dangleUntil: number;
  laneX: number;
  laneUntil: number;
  gotPuckAt: number;
  hadPuck: boolean;
  /** when this carrier reacts to a dog closing in (-1 = no dog around) */
  dogSeenAt: number;
  /** when this carrier reacts to an opponent's blade reaching for his puck (-1 = none) */
  pokeSeenAt: number;
  /** puck protection, eased: -1 tucked to the backhand .. +1 to the forehand (Intent.shield) */
  shield: number;
  /** state.callFor.time already answered */
  callSeen: number;
  /** offensive zone: protecting the puck from `protectFrom` (back to him, along the boards) until then */
  protectUntil: number;
  protectFrom: number;
  // --- defense
  pokeReady: number; // time when the next poke is allowed
  checkReady: number; // time when the next check is allowed
  engageAt: number; // reaction: time the pressure role may start poking
  // --- off-puck offense
  oneTimerUntil: number;
  offset: Vec2;
  offsetUntil: number;
  // --- skating
  turboOn: boolean;
  turboOffAt: number;
  /** no new sprint before this (each start is a turboStart event, a bark for the dog) */
  turboRestAt: number;
  /** bark sequencing: 0 idle, 1 release turbo this tick, 2 press it */
  bark: number;
  // --- goalie
  seen: Vec2; // the goalie's (slightly late) read of the puck
  clearAt: number;
}

export interface TeamMem {
  mode: Mode;
  /** mode the team is about to switch to, and when (reaction lag) */
  pending: Mode;
  pendingAt: number;
  assign: Map<number, Assignment>;
  chaser: number | null;
  presser: number | null;
  /** strong side of the attack formation (sticky so the shape doesn't mirror back and forth) */
  side: number;
  /** since when the team has had the puck in its offensive zone (-1 = it hasn't) */
  ozSince: number;
}

export interface AiMem {
  lastTick: number;
  brains: Brain[];
  teams: [TeamMem, TeamMem];
}

function newBrain(): Brain {
  return {
    thinkAt: 0,
    bold: rand(),
    target: null,
    lastKey: '',
    plan: 'carry',
    planAt: 0,
    passTo: -1,
    passSince: -10,
    aimX: 0,
    dangleSide: 0,
    dangleUntil: -1,
    laneX: 0,
    laneUntil: -1,
    gotPuckAt: -10,
    hadPuck: false,
    dogSeenAt: -1,
    pokeSeenAt: -1,
    shield: 0,
    callSeen: -1,
    protectUntil: -1,
    protectFrom: -1,
    pokeReady: 0,
    checkReady: 0,
    engageAt: 0,
    oneTimerUntil: -1,
    offset: { x: 0, z: 0 },
    offsetUntil: -1,
    turboOn: false,
    turboOffAt: 0,
    turboRestAt: 0,
    bark: 0,
    seen: { x: 0, z: 0 },
    clearAt: -1,
  };
}

const newTeam = (): TeamMem => ({ mode: 'loose', pending: 'loose', pendingAt: 0, assign: new Map(), chaser: null, presser: null, side: 1, ozSince: -1 });

const mems = new WeakMap<GameState, AiMem>();

export function aiMem(state: GameState): AiMem {
  let m = mems.get(state);
  if (!m || state.tick < m.lastTick) {
    m = { lastTick: state.tick, brains: state.skaters.map(newBrain), teams: [newTeam(), newTeam()] };
    mems.set(state, m);
  }
  m.lastTick = state.tick;
  return m;
}
