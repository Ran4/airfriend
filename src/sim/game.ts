// Game rules + flow. Public API:
//   createGame(opts) -> GameState
//   stepGame(state, pad)   advance exactly one SIM_DT tick
// Free of DOM / three.js imports (it runs under node in tools/simulate.ts).
//
// Phase flow: intro -> faceoff -> play <-> (goal | stoppage | penalty) -> faceoff ...
// clock 0 -> periodEnd -> intermission -> faceoff (next period) ... -> gameOver.

import { PHYS, RULES, SIM_DT, TEAMS } from '../config';
import type {
  ButtonState,
  GameSimData,
  GameState,
  Intent,
  PadState,
  Skater,
  SkaterSimData,
  TeamId,
  Vec2,
} from '../types';
import { updateAI } from '../ai';
import { ACTION_TIME, CALL_FOR_TIME, updateActions } from './actions';
import { faceoffFormation, setupFaceoff, updateFaceoff } from './faceoff';
import { updateGoalie } from './goalie';
import {
  callPendingPenalties,
  delayedPenaltyExpired,
  offenderHasPuck,
  pendingPenalties,
  powerPlayGoal,
  resolvePendingOnGoal,
  updatePenalties,
} from './penalties';
import { collideSkaters, collideSkaterWorld, skateStep, updatePuck } from './physics';
import { isGoalie, onIce, periodLength, skatersOnIce } from './query';
import { refWhistle, updateReferee } from './referee';
import { CENTER_DOT, defensiveDot, nearestDot, screenToWorld } from './rink';
import { emit, gs, sk } from './util';

interface GameOptions {
  autoplay?: boolean;
  /** false: the AI never writes intents (unit tests drive every skater by hand). Default true. */
  ai?: boolean;
  /** override the intro length (rematch uses 1.5 s) */
  introTime?: number;
}

/** stuck-puck safety: whistle if nobody has touched a loose puck for this long */
export const STUCK_PUCK_TIME = 12;
/** control-switch hysteresis while the dog is boxed */
const SWITCH_MARGIN = 2.0;
const SWITCH_MIN_INTERVAL = 0.4;
/** PAL back from the box: a pass to the controlled kid this fresh still counts as "on its way" */
const PASS_KEEP_TIME = 1.5;
/** a whistle with less than this left on the clock ends the period instead of a faceoff */
export const PERIOD_END_GRACE = 0.5;
/** after a whistle everybody eases to a stop at this decel (m/s^2; independent of the live-play coast) */
const DEAD_PUCK_FRICTION = 3.0;

const button = (): ButtonState => ({ held: false, pressed: false, released: false });

export function emptyIntent(): Intent {
  return { move: { x: 0, z: 0 }, shoot: button(), pass: button(), turbo: button() };
}

function newSkaterSim(): SkaterSimData {
  return {
    actionCd: 0,
    lunge: { x: 0, z: 1 },
    hitDone: true,
    checkTurbo: false,
    pokeDone: true,
    stopCd: 0,
    turboLock: false,
    recvCd: 0,
    lastOwnTime: -10,
    shootHeldTime: 0,
    boardsCd: 0,
    hitTime: -10,
    pokedAt: -10,
    turboTapAt: -1,
    react: -1,
    shotSeq: -1,
    saveX: 0,
    saveY: 0,
    lateral: 0,
    carryTime: 0,
    diveDir: 1,
  };
}

function newGameSim(opts: GameOptions): GameSimData {
  return {
    aiEnabled: opts.ai !== false,
    introLen: opts.introTime ?? RULES.introTime,
    goalPending: null,
    outOfPlay: false,
    frozenBy: null,
    holdTime: 0,
    nextSpot: null,
    lastWarnSec: 99,
    pass: null,
    lastShot: null,
    shotSeq: 0,
    touchChain: [],
    lastTouchByTeam: [null, null],
    noTouchTime: 0,
    takers: [0, 5],
    react: [0.3, 0.3],
    aiFalseStart: [-1, -1],
    faceoffDone: true,
    lastSwitchTime: -10,
    startGuardUntil: -10,
    pendingPenalties: [],
    delayedTouch: false,
    boardsCd: 0,
    postCd: 0,
    netCd: 0,
  };
}

export function createGame(opts: GameOptions = {}): GameState {
  const skaters: Skater[] = [];
  for (const team of [0, 1] as TeamId[]) {
    TEAMS[team].roster.forEach((r, i) => {
      skaters.push({
        id: team * 5 + i,
        team,
        kind: r.kind,
        position: r.position,
        name: r.name,
        number: r.number,
        attrs: r.attrs,
        pos: { x: 0, z: 0 },
        vel: { x: 0, z: 0 },
        facing: 0,
        intent: emptyIntent(),
        state: r.kind === 'goalie' ? 'gReady' : 'skate',
        stateTime: 0,
        windup: 0,
        stamina: 1,
        turboActive: false,
        barkCooldown: 0,
        stun: 0,
        invuln: 0,
        stats: { goals: 0, assists: 0, shots: 0, hits: 0, pim: 0 },
        sim: newSkaterSim(),
      });
    });
  }
  const state: GameState = {
    phase: 'intro',
    phaseTime: 0,
    period: 1,
    clock: RULES.periodLength,
    score: [0, 0],
    shots: [0, 0],
    hits: [0, 0],
    periodGoals: [[0, 0]],
    skaters,
    puck: {
      pos: { x: 0, z: 0 },
      y: 1.1,
      vel: { x: 0, z: 0 },
      vy: 0,
      owner: null,
      lastTouch: null,
      prevTouch: null,
      pickupBlock: 0,
      blockId: null,
      spin: 0,
    },
    referee: { pos: { x: 0.6, z: 0 }, vel: { x: 0, z: 0 }, facing: -Math.PI / 2, state: 'drop', stateTime: 0 },
    penalties: [],
    faceoff: null,
    goals: [],
    lastPenaltyCall: null,
    controlledId: 0,
    dogReturnPending: false,
    delayedPenalty: null,
    winner: null,
    events: [],
    tick: 0,
    time: 0,
    paused: false,
    autoplay: !!opts.autoplay,
    callFor: null,
    penaltyQueue: [],
    sim: newGameSim(opts),
  };
  // the intro shows the opening lineup
  for (const [id, f] of faceoffFormation(state, CENTER_DOT)) {
    const s = skaters[id];
    s.pos = { ...f.pos };
    s.facing = f.facing;
  }
  return state;
}

// ------------------------------------------------------------------ step ----

export function stepGame(state: GameState, pad: PadState): void {
  state.events = [];
  if (pad.start.pressed && handleStart(state)) return;
  if (state.paused) return;
  const dt = SIM_DT;
  state.tick++;
  state.time += dt;
  state.phaseTime += dt;
  tickTimers(state, dt);
  if (state.tick === 1 && state.phase === 'intro') emit(state, { type: 'introStart' });

  switch (state.phase) {
    case 'intro':
      if (state.phaseTime >= gs(state).introLen) {
        emit(state, { type: 'periodStart', period: state.period });
        startFaceoff(state, CENTER_DOT, true);
      }
      break;
    case 'faceoff':
      updateControl(state);
      if (gs(state).aiEnabled) updateAI(state, dt);
      applyHumanPad(state, pad);
      updateFaceoff(state);
      if (state.puck.owner === null && state.faceoff?.dropped) updatePuck(state, dt);
      break;
    case 'play':
      stepPlay(state, pad, dt);
      break;
    case 'goal':
      stepDeadPuck(state, dt);
      if (state.phaseTime >= RULES.goalCelebrateTime) {
        if (state.period > RULES.periods) endGame(state);
        else resumeOrEndPeriod(state, CENTER_DOT);
      }
      break;
    case 'stoppage':
    case 'penalty':
      updateControl(state);
      stepDeadPuck(state, dt);
      if (state.phaseTime >= (state.phase === 'stoppage' ? RULES.stoppageTime : RULES.penaltyBannerTime)) {
        resumeOrEndPeriod(state, gs(state).nextSpot ?? CENTER_DOT);
      }
      break;
    case 'periodEnd':
      stepDeadPuck(state, dt);
      if (state.phaseTime >= RULES.periodEndTime) {
        const tied = state.score[0] === state.score[1];
        if (state.period > RULES.periods || (state.period === RULES.periods && !tied)) endGame(state);
        else {
          state.phase = 'intermission';
          state.phaseTime = 0;
          emit(state, { type: 'intermissionStart', nextPeriod: state.period + 1 });
        }
      }
      break;
    case 'intermission':
      if (state.phaseTime >= RULES.intermissionTime) nextPeriod(state);
      break;
    case 'gameOver':
      stepDeadPuck(state, dt);
      break;
  }
  updateReferee(state, dt);
}

/**
 * START button: pause / unpause in every phase but the two screens where it
 * means something else (intermission: skip it, gameOver: rematch). Returns
 * true if the step should end here.
 */
function handleStart(state: GameState): boolean {
  if (state.paused) {
    state.paused = false;
    return true;
  }
  switch (state.phase) {
    case 'intermission':
      // the stats screen gets a moment before a START can skip it
      if (state.phaseTime < INTERMISSION_START_GUARD) return false;
      nextPeriod(state);
      return false;
    case 'gameOver':
      // a START hit just as the horn sounds must not skip the final screen
      if (state.phaseTime < GAMEOVER_START_GUARD) return false;
      rematch(state);
      return true;
    default:
      // a START mashed to skip the intermission must not pause the faceoff it skipped to
      if (state.time < gs(state).startGuardUntil) return false;
      state.paused = true;
      return true;
  }
}

/** seconds the final screen ignores START (it shows the result and three stars first) */
export const GAMEOVER_START_GUARD = 1.5;
/** seconds the intermission stats screen ignores START */
export const INTERMISSION_START_GUARD = 1.0;
/** seconds START is ignored once the intermission is over (so a double tap doesn't pause) */
export const AFTER_INTERMISSION_START_GUARD = 0.4;

function rematch(state: GameState): void {
  const G = gs(state);
  const fresh = createGame({ autoplay: state.autoplay, ai: G.aiEnabled, introTime: 1.5 });
  Object.assign(state, fresh);
  // the fresh game announces introStart itself on its first tick
  state.events = [{ type: 'rematch' }];
}

function nextPeriod(state: GameState): void {
  state.period++;
  state.clock = periodLength(state.period);
  state.periodGoals.push([0, 0]);
  const G = gs(state);
  G.lastWarnSec = 99;
  G.startGuardUntil = state.time + AFTER_INTERMISSION_START_GUARD;
  for (const s of state.skaters) {
    s.stamina = 1;
    s.stun = 0;
    if (s.state === 'fallen' || s.state === 'celebrate') s.state = isGoalie(s) ? 'gReady' : 'skate';
  }
  emit(state, { type: 'periodStart', period: state.period });
  startFaceoff(state, CENTER_DOT, true);
}

/** `opener`: the first faceoff of a period (a longer lineup, see setupFaceoff). */
function startFaceoff(state: GameState, spot: Vec2, opener = false): void {
  updateControl(state);
  for (const s of state.skaters) if (s.state === 'celebrate' || s.state === 'fallen') s.state = isGoalie(s) ? 'gReady' : 'skate';
  setupFaceoff(state, spot, opener);
}

/**
 * A dead puck is over: faceoff, unless the whistle (goal, stoppage, penalty)
 * came with the period all but over. Nobody wants a full faceoff for 0:00.3,
 * and the horn would sound the instant the puck dropped.
 */
function resumeOrEndPeriod(state: GameState, spot: Vec2): void {
  if (state.clock < PERIOD_END_GRACE) {
    state.clock = 0;
    endPeriod(state);
  } else startFaceoff(state, spot);
}

/** The horn: clock at 0, into the periodEnd phase. */
function endPeriod(state: GameState): void {
  state.phase = 'periodEnd';
  state.phaseTime = 0;
  state.callFor = null;
  gs(state).frozenBy = null;
  for (const s of state.skaters) if (s.state === 'windup') s.state = 'skate';
  emit(state, { type: 'periodEnd', period: state.period });
}

function endGame(state: GameState): void {
  const w: TeamId | 'tie' = state.score[0] > state.score[1] ? 0 : state.score[1] > state.score[0] ? 1 : 'tie';
  state.winner = w;
  state.phase = 'gameOver';
  state.phaseTime = 0;
  state.callFor = null;
  for (const s of state.skaters) {
    if (!onIce(s) || isGoalie(s)) continue;
    s.state = w !== 'tie' && s.team === w ? 'celebrate' : 'skate';
    s.stateTime = 0;
  }
  emit(state, { type: 'gameOver', winner: w });
}

// -------------------------------------------------------------- live play ----

function stepPlay(state: GameState, pad: PadState, dt: number): void {
  const G = gs(state);
  updateControl(state);
  if (G.aiEnabled) updateAI(state, dt);
  applyHumanPad(state, pad);
  const cf = state.callFor;
  if (cf && (state.time - cf.time > CALL_FOR_TIME || state.puck.owner !== cf.carrier)) state.callFor = null;

  for (const s of state.skaters) {
    if (!onIce(s) || isGoalie(s)) continue;
    updateActions(state, s, dt);
    if (state.phase !== 'play') {
      // a penalty was called at once (the offending team had the puck); this tick still ran off the clock
      runClock(state, dt);
      return;
    }
  }
  for (const s of state.skaters) {
    if (!onIce(s)) continue;
    if (isGoalie(s)) updateGoalie(state, s, dt);
    else skateStep(state, s, dt);
  }
  collideSkaters(state);
  for (const s of state.skaters) if (onIce(s)) collideSkaterWorld(state, s);

  updatePuck(state, dt);
  // Every tick of live play runs the clock, including the one that ends in a
  // whistle: a goal on the last tick of a period is scored at 0:00, not with
  // one tick left over (which used to buy a whole faceoff before the horn).
  // The penalty clocks only run on uninterrupted ticks (one tick, unnoticed).
  //
  // A delayed penalty is whistled when the offending team touches the puck,
  // after DELAYED_PENALTY_MAX, or instead of any other whistle (puck dead):
  // the penalty phase then replaces the stoppage, and at the horn it shows
  // its banner before resumeOrEndPeriod ends the period.
  const delayed = pendingPenalties(state).length > 0;
  if (G.goalPending !== null) {
    runClock(state, dt);
    const team = G.goalPending;
    scoreGoal(state, team);
    if (delayed) resolvePendingOnGoal(state, team);
    return;
  }
  if (delayed && (offenderHasPuck(state) || delayedPenaltyExpired(state))) {
    runClock(state, dt);
    callPendingPenalties(state);
    return;
  }
  if (G.outOfPlay) {
    runClock(state, dt);
    if (delayed) callPendingPenalties(state);
    else stoppage(state, 'offIce', nearestDot(state.puck.pos));
    return;
  }
  // goalie freeze
  if (G.frozenBy !== null) {
    const g = state.skaters[G.frozenBy];
    if (state.puck.owner !== g.id || g.state !== 'gHold') G.frozenBy = null;
    else {
      G.holdTime += dt;
      if (G.holdTime >= RULES.goalieHoldTime) {
        runClock(state, dt);
        if (delayed) callPendingPenalties(state);
        else stoppage(state, 'freeze', defensiveDot(g.team, state.period, state.puck.pos.x));
        return;
      }
    }
  }
  if (state.puck.owner === null && G.noTouchTime > STUCK_PUCK_TIME) {
    runClock(state, dt);
    if (delayed) callPendingPenalties(state);
    else stoppage(state, 'freeze', nearestDot(state.puck.pos));
    return;
  }

  // clock (the penalty clocks only run with it)
  runClock(state, dt);
  updatePenalties(state, dt);
  if (state.clock <= 0) {
    if (delayed) callPendingPenalties(state);
    else endPeriod(state);
  }
}

/** Run the game clock for one tick of play, with one beep as it passes each of 10, 9, ... 1. */
function runClock(state: GameState, dt: number): void {
  const G = gs(state);
  const prev = state.clock;
  state.clock = Math.max(0, prev - dt);
  const sec = Math.floor(prev);
  if (sec >= 1 && sec <= 10 && Math.floor(state.clock) < sec) {
    if (sec !== G.lastWarnSec) {
      G.lastWarnSec = sec;
      emit(state, { type: 'clockWarning' });
    }
  }
}

/** Human pad -> Intent of the controlled skater (screen-relative via screenToWorld). */
function applyHumanPad(state: GameState, pad: PadState): void {
  if (state.autoplay) return;
  const s = state.skaters[state.controlledId];
  s.intent.move = screenToWorld(pad, state.period);
  s.intent.shoot = { ...pad.shoot };
  s.intent.pass = { ...pad.pass };
  s.intent.turbo = { ...pad.turbo };
  s.intent.passTarget = undefined;
  s.intent.aimAt = undefined;
  s.intent.shield = undefined;
}

/**
 * The human controls the dog. While PAL is boxed, control goes to the home
 * skater nearest the puck (instantly to a home carrier), with hysteresis so
 * it doesn't flicker between two kids. When PAL comes back, a kid in the
 * middle of a rush keeps control until the play is done (dogReturnPending).
 */
function updateControl(state: GameState): void {
  const G = gs(state);
  const dog = state.skaters[0];
  let want = state.controlledId;
  let pending = false;
  if (onIce(dog)) {
    const cur = state.skaters[state.controlledId];
    if (cur.id !== 0 && kidKeepsControl(state, cur)) pending = true;
    else want = 0;
  } else {
    const cands = state.skaters.filter((s) => s.team === 0 && onIce(s) && !isGoalie(s));
    const p = state.puck.pos;
    const dist = (s: Skater) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z);
    const owner = state.puck.owner !== null ? state.skaters[state.puck.owner] : null;
    const cur = state.skaters[state.controlledId];
    const curOk = cands.includes(cur);
    if (owner && cands.includes(owner)) want = owner.id;
    else if (cands.length) {
      const near = cands.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
      if (!curOk) want = near.id;
      else if (near.id !== cur.id && dist(near) < dist(cur) - SWITCH_MARGIN && state.time - G.lastSwitchTime > SWITCH_MIN_INTERVAL)
        want = near.id;
    }
  }
  state.dogReturnPending = pending;
  if (want !== state.controlledId) {
    // the old skater's intent was the pad's; don't leave buttons stuck down
    const old = state.skaters[state.controlledId];
    old.intent = emptyIntent();
    if (!state.autoplay) {
      // A shot being loaded is the human's (or, on the new skater, the AI's):
      // whoever gets the skater did not press SHOOT, so it must not go off
      // on a release nobody made. Drop the windup instead.
      cancelWindup(old);
      cancelWindup(state.skaters[want]);
    }
    state.controlledId = want;
    G.lastSwitchTime = state.time;
    emit(state, { type: 'controlSwitch', skaterId: want });
  }
}

/**
 * PAL is back from the box: does the controlled kid keep control for now?
 * Only in live play, and only while he carries, loads a shot, or has a
 * teammate's pass on its way to him.
 */
function kidKeepsControl(state: GameState, s: Skater): boolean {
  if (state.phase !== 'play' || s.team !== 0 || !onIce(s) || isGoalie(s)) return false;
  const p = state.puck;
  if (p.owner === s.id || s.state === 'windup') return true;
  const pass = gs(state).pass;
  return (
    p.owner === null &&
    pass !== null &&
    pass.to === s.id &&
    pass.from !== s.id &&
    state.skaters[pass.from].team === s.team &&
    state.time - pass.time < PASS_KEEP_TIME
  );
}

function cancelWindup(s: Skater): void {
  if (s.state === 'windup') {
    s.state = 'skate';
    s.stateTime = 0;
    s.windup = 0;
  }
  sk(s).shootHeldTime = 0;
}

function scoreGoal(state: GameState, team: TeamId): void {
  const G = gs(state);
  const other = (1 - team) as TeamId;
  const powerPlay = skatersOnIce(state, team) > skatersOnIce(state, other);
  const shortHanded = skatersOnIce(state, team) < skatersOnIce(state, other);
  const p = state.puck;
  let scorer: number | null = p.lastTouch !== null && state.skaters[p.lastTouch].team === team ? p.lastTouch : G.lastTouchByTeam[team];
  if (scorer === null) scorer = state.skaters.find((s) => s.team === team && onIce(s) && !isGoalie(s))!.id;
  const chain = G.touchChain;
  const chainTeam = chain.length ? state.skaters[chain[chain.length - 1]].team : null;
  const assists: number[] = [];
  if (chainTeam === team) {
    for (let i = chain.length - 1; i >= 0 && assists.length < 2; i--) {
      if (chain[i] !== scorer && !assists.includes(chain[i])) assists.push(chain[i]);
    }
  }
  const info = { team, scorer, assists, period: state.period, clock: state.clock, powerPlay, shortHanded };
  state.score[team]++;
  state.periodGoals[state.period - 1][team]++;
  state.goals.push(info);
  state.skaters[scorer].stats.goals++;
  for (const a of assists) state.skaters[a].stats.assists++;
  // every goal is a shot on goal
  const ls = G.lastShot;
  if (!(ls && ls.team === team && ls.counted)) {
    state.shots[team]++;
    state.skaters[ls && ls.team === team ? ls.shooter : scorer].stats.shots++;
  }
  emit(state, { type: 'goal', info });
  emit(state, { type: 'whistle', reason: 'goal' });
  if (powerPlay) powerPlayGoal(state, team);
  state.phase = 'goal';
  state.phaseTime = 0;
  G.goalPending = null;
  G.frozenBy = null;
  G.lastShot = null;
  state.callFor = null;
  refWhistle(state);
  for (const s of state.skaters) {
    if (!onIce(s) || isGoalie(s)) continue;
    s.windup = 0;
    s.turboActive = false;
    s.state = s.team === team && s.state !== 'fallen' ? 'celebrate' : s.state === 'fallen' ? 'fallen' : 'skate';
    s.stateTime = 0;
  }
}

function stoppage(state: GameState, reason: 'freeze' | 'offIce', spot: Vec2): void {
  const G = gs(state);
  emit(state, { type: 'whistle', reason });
  state.phase = 'stoppage';
  state.phaseTime = 0;
  G.nextSpot = spot;
  G.outOfPlay = false;
  G.frozenBy = null;
  state.callFor = null;
  refWhistle(state);
  for (const s of state.skaters) {
    if (s.state === 'windup') s.state = 'skate';
    s.windup = 0;
    s.turboActive = false;
  }
}

/** Dead-puck phases: everyone glides to a stop, scorers' teammates mob the scorer. */
function stepDeadPuck(state: GameState, dt: number): void {
  const last = state.goals[state.goals.length - 1];
  const scorer = state.phase === 'goal' && last ? state.skaters[last.scorer] : null;
  for (const s of state.skaters) {
    if (!onIce(s)) continue;
    if (s.state === 'celebrate' && scorer && s.id !== scorer.id) {
      const dx = scorer.pos.x - s.pos.x;
      const dz = scorer.pos.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      const want = d > 1.4 ? 4 : 0;
      const tvx = d > 1e-3 ? (dx / d) * want : 0;
      const tvz = d > 1e-3 ? (dz / d) * want : 0;
      s.vel.x += (tvx - s.vel.x) * Math.min(1, dt * 3);
      s.vel.z += (tvz - s.vel.z) * Math.min(1, dt * 3);
      if (d > 0.5) s.facing = Math.atan2(dx, dz);
    } else {
      const sp = Math.hypot(s.vel.x, s.vel.z);
      if (sp > 1e-6) {
        const ns = Math.max(0, sp - DEAD_PUCK_FRICTION * dt);
        s.vel.x *= ns / sp;
        s.vel.z *= ns / sp;
      }
    }
    s.pos.x += s.vel.x * dt;
    s.pos.z += s.vel.z * dt;
  }
  collideSkaters(state);
  for (const s of state.skaters) if (onIce(s)) collideSkaterWorld(state, s);
  if (state.phase === 'goal') {
    state.puck.vel.x *= 0.96;
    state.puck.vel.z *= 0.96;
  }
  updatePuck(state, dt);
}

function tickTimers(state: GameState, dt: number): void {
  for (const s of state.skaters) {
    const d = sk(s);
    s.stateTime += dt;
    s.stun = Math.max(0, s.stun - dt);
    s.invuln = Math.max(0, s.invuln - dt);
    s.barkCooldown = Math.max(0, s.barkCooldown - dt);
    d.actionCd = Math.max(0, d.actionCd - dt);
    d.stopCd = Math.max(0, d.stopCd - dt);
    d.recvCd = Math.max(0, d.recvCd - dt);
    d.boardsCd = Math.max(0, d.boardsCd - dt);
    switch (s.state) {
      case 'shoot':
      case 'pass':
      case 'poke':
      case 'check':
        if (s.stateTime > ACTION_TIME[s.state]) {
          s.state = 'skate';
          s.stateTime = 0;
        }
        break;
      case 'fallen':
        if (s.stateTime > PHYS.fallTime) {
          s.state = isGoalie(s) ? 'gReady' : 'skate';
          s.stateTime = 0;
          s.invuln = 0.6;
        }
        break;
    }
  }
}

