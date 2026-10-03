// Assertion-based scenario tests for the sim: build a state, place entities,
// step, assert.   npx tsx tools/sim-tests.ts [filter]
//
// Tests run with the AI disabled (createGame({ ai: false })) so every intent
// is set by hand, and with a seeded RNG so they are deterministic.

import { GOAL, PHYS, RINK, RULES, SHOT, SIM_DT } from '../src/config';
import { emptyPad } from '../src/core/input';
import {
  BARK_FUMBLE_BASE,
  BARK_RADIUS,
  BARK_TAP_TIME,
  BARK_TRIGGER_RADIUS,
  POKE_REPEAT_MALUS,
  POKE_REPEAT_WINDOW,
  SAUCER_PEAK,
  applyHit,
  hitForce,
  pokeChance,
  shotSpeed,
} from '../src/sim/actions';
import { FACEOFF_TIMEOUT, setupFaceoff } from '../src/sim/faceoff';
import {
  AFTER_INTERMISSION_START_GUARD,
  createGame,
  emptyIntent,
  GAMEOVER_START_GUARD,
  INTERMISSION_START_GUARD,
  STUCK_PUCK_TIME,
  stepGame,
} from '../src/sim/game';
import { goalieHitbox } from '../src/sim/goalie';
import { KID_TURN_RATE } from '../src/sim/physics';
import {
  DELAYED_OFFENDER_TANGLE,
  DELAYED_PENALTY_MAX,
  MAX_BOXED,
  basePenaltyChance,
  boxSlotPos,
  callPenalties,
  delayPenalty,
  infractionFor,
  penaltyChance,
  rollPenalty,
  type HitContext,
} from '../src/sim/penalties';
import { touchPuck } from '../src/sim/puckops';
import { carryPoint, skatersOnIce, stickPoint } from '../src/sim/query';
import { attackDir, boardsInfo, defensiveDot, depthPastLine, ownGoalZ, screenToWorld } from '../src/sim/rink';
import { gs, mulberry32, setRandom, sk } from '../src/sim/util';
import type { GameEvent, GameState, PadState, Penalty, Skater, TeamId } from '../src/types';

// ------------------------------------------------------------- helpers ----
/** whistle one penalty right now (the sim only ever calls them in batches) */
const callPenalty = (state: GameState, pen: Penalty): void => callPenalties(state, [pen]);

/** manpower: `ppTeam` is the team on the power play (null at even strength) */
function strength(state: GameState): { home: number; away: number; ppTeam: TeamId | null } {
  const home = skatersOnIce(state, 0);
  const away = skatersOnIce(state, 1);
  return { home, away, ppTeam: home > away ? 0 : away > home ? 1 : null };
}

// ------------------------------------------------------------- harness ----
const filter = process.argv[2] ?? '';
let passed = 0;
const failed: string[] = [];
function test(name: string, fn: () => void): void {
  if (filter && !name.includes(filter)) return;
  setRandom(mulberry32(12345));
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  } finally {
    setRandom(null);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
/** read through a function: the sim mutates these between asserts, so TS narrowing must not stick */
const phase = (st: GameState): string => st.phase;
const stateOf = (s: Skater): string => s.state;
const num = (n: number): number => n;

/** Live-play state with the AI off, every skater parked out of the way, the puck dead center. */
function freshPlay(opts: { human?: boolean } = {}): GameState {
  const st = createGame({ autoplay: !opts.human, ai: false });
  st.phase = 'play';
  st.phaseTime = 0;
  st.tick = 100; // past the intro event
  st.referee.state = 'skate';
  let h = 0;
  let a = 0;
  for (const s of st.skaters) {
    if (s.kind === 'goalie') continue;
    // parked along the side boards in the neutral/defensive areas, standing still
    if (s.team === 0) place(s, -11, -16 + 3 * h++, 0);
    else place(s, 11, 16 - 3 * a++, Math.PI);
  }
  st.puck.pos = { x: 0, z: 0 };
  st.puck.y = 0;
  st.puck.vel = { x: 0, z: 0 };
  st.puck.vy = 0;
  return st;
}
function place(s: Skater, x: number, z: number, facing = 0): void {
  s.pos = { x, z };
  s.vel = { x: 0, z: 0 };
  s.facing = facing;
}
function give(st: GameState, s: Skater): void {
  st.puck.owner = s.id;
  st.puck.y = 0;
  st.puck.pos = carryPoint(s, st.time);
  touchPuck(st, s.id);
}
function loose(st: GameState, x: number, z: number, vx: number, vz: number, y = 0, vy = 0): void {
  const p = st.puck;
  p.owner = null;
  p.pos = { x, z };
  p.vel = { x: vx, z: vz };
  p.y = y;
  p.vy = vy;
}
/** Step n ticks. `each(st, i)` runs before each step (set intents there); button edges are cleared after. */
function run(st: GameState, n: number, each?: (st: GameState, i: number) => void, pad?: (i: number) => PadState): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    each?.(st, i);
    stepGame(st, pad ? pad(i) : emptyPad());
    all.push(...st.events);
    for (const s of st.skaters) {
      for (const b of [s.intent.shoot, s.intent.pass, s.intent.turbo]) {
        b.pressed = false;
        b.released = false;
      }
    }
  }
  return all;
}
/** Step until `pred` or n ticks; returns the events. */
function runUntil(st: GameState, n: number, pred: (st: GameState, ev: GameEvent[]) => boolean): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    stepGame(st, emptyPad());
    all.push(...st.events);
    if (pred(st, st.events)) break;
  }
  return all;
}
const ofType = <T extends GameEvent['type']>(ev: GameEvent[], t: T) => ev.filter((e) => e.type === t) as Extract<GameEvent, { type: T }>[];
const press = (b: { held: boolean; pressed: boolean; released: boolean }) => {
  b.held = true;
  b.pressed = true;
  b.released = false;
};
const release = (b: { held: boolean; pressed: boolean; released: boolean }) => {
  b.held = false;
  b.pressed = false;
  b.released = true;
};
const startPad = (): PadState => {
  const p = emptyPad();
  p.start = { held: true, pressed: true, released: false };
  return p;
};
/** move the defending goalie of the +z goal (away in P1) out of the way */
function pullAwayGoalie(st: GameState): void {
  place(st.skaters[9], -4.0, 25.0, Math.PI);
}
function mkPenalty(st: GameState, id: number, major = false): Penalty {
  const s = st.skaters[id];
  const d = major ? RULES.majorLength : RULES.minorLength;
  return { skaterId: id, team: s.team, infraction: 'ROUGHING', duration: d, remaining: d, major };
}

console.log('AIR FRIEND HOCKEY sim tests');

// ------------------------------------------------------------ geometry ----
test('rink: boards distance and screen mapping', () => {
  assert(near(boardsInfo(12, 0).dist, 1, 1e-9), 'side boards at x=13');
  assert(near(boardsInfo(0, 29.5).dist, 1, 1e-9), 'end boards at z=30.5');
  assert(boardsInfo(12.5, 29.5).dist < 0, 'corner is rounded');
  const up = { ...emptyPad(), up: true };
  assert(screenToWorld(up, 1).z === 1 && screenToWorld(up, 2).z === -1, 'up = attack in P1 and P2');
  const right = { ...emptyPad(), right: true };
  assert(screenToWorld(right, 1).x === -1 && screenToWorld(right, 2).x === 1, 'screen right mirrors with the camera');
});

// --------------------------------------------------------------- goals ----
test('goal: puck entering from the front counts', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  touchPuck(st, 1);
  loose(st, 0, 23, 0, 15);
  const ev = runUntil(st, 90, (s) => s.phase === 'goal');
  const g = ofType(ev, 'goal');
  assert(g.length === 1, `expected 1 goal event, got ${g.length}`);
  assert(g[0].info.team === 0 && g[0].info.scorer === 1, `scorer ${JSON.stringify(g[0].info)}`);
  assert(st.score[0] === 1 && phase(st) === 'goal', 'score/phase');
  assert(st.shots[0] === 1, 'a goal is always a shot on goal');
  assert(ofType(ev, 'whistle').some((w) => w.reason === 'goal'), 'goal whistle');
  run(st, 60);
  assert(st.puck.pos.z > RINK.goalLineZ && st.puck.pos.z < RINK.goalLineZ + GOAL.depth, `puck stays in the net (${st.puck.pos.z})`);
});

test('goal: side entry does not count (net mesh)', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  loose(st, 2.5, 27.0, -12, 0);
  const ev = run(st, 60);
  assert(ofType(ev, 'goal').length === 0, 'no goal');
  assert(ofType(ev, 'netHit').length >= 1, 'netHit emitted');
  assert(st.puck.pos.x > GOAL.halfWidth, `puck stayed outside (${st.puck.pos.x})`);
});

test('goal: back entry does not count', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  loose(st, 0.2, 29.5, 0, -12);
  const ev = run(st, 60);
  assert(ofType(ev, 'goal').length === 0, 'no goal');
  assert(ofType(ev, 'netHit').length >= 1, 'netHit emitted');
  assert(st.puck.pos.z > RINK.goalLineZ + GOAL.depth, 'puck stayed behind the net');
});

test('goal: dropping onto the net from above is a dead puck, not a goal', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  loose(st, 0, 27.0, 0, 0, 2.0, 0);
  const ev = run(st, 60);
  assert(ofType(ev, 'goal').length === 0, 'no goal');
  assert(ofType(ev, 'whistle').length === 1 && phase(st) === 'stoppage', `whistle + stoppage (phase ${st.phase})`);
});

test('post: puck rings off the post and stays out', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  loose(st, GOAL.halfWidth + 0.02, 22, 0, 18);
  const ev = run(st, 40);
  assert(ofType(ev, 'post').length === 1, 'post event');
  assert(ofType(ev, 'goal').length === 0, 'no goal');
  assert(st.puck.vel.z < 0 || Math.abs(st.puck.vel.x) > 3, 'puck bounced away');
});

test('crossbar: a puck at bar height clangs out', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  // aim so it reaches the line right at crossbar height
  const t = 3.5 / 20;
  const vy = (GOAL.height + 0.5 * PHYS.gravity * t * t) / t;
  loose(st, 0.3, 23, 0, 20, 0.0, vy);
  const ev = run(st, 40);
  assert(ofType(ev, 'post').length === 1, 'crossbar = post event');
  assert(ofType(ev, 'goal').length === 0, 'no goal');
});

test('boards: puck bounces with restitution and emits boards', () => {
  const st = freshPlay();
  loose(st, 0, 0, 15, 0);
  const ev = run(st, 60);
  const b = ofType(ev, 'boards');
  assert(b.length === 1 && b[0].speed > 12, `boards event ${JSON.stringify(b)}`);
  assert(st.puck.vel.x < -8 && st.puck.vel.x > -12, `rebound vx ${st.puck.vel.x.toFixed(2)}`);
});

test('boards: skaters cannot leave the rink or skate through nets', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  place(dog, 10, 0, Math.PI / 2);
  dog.intent.move = { x: 1, z: 0 };
  run(st, 120);
  assert(dog.pos.x <= RINK.halfWidth - dog.attrs.radius + 1e-6, `dog x ${dog.pos.x}`);
  place(dog, 0, 29.5, Math.PI);
  dog.intent.move = { x: 0, z: -1 };
  run(st, 60);
  assert(dog.pos.z > RINK.goalLineZ + GOAL.depth, `dog went through the net (z ${dog.pos.z.toFixed(2)})`);
});

// --------------------------------------------------------------- skating ----
test('skating: dog accelerates fast, turbo is faster and drains stamina, lockout at 0', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  place(dog, 0, -20, 0);
  dog.intent.move = { x: 0, z: 1 };
  run(st, 45);
  const v1 = Math.hypot(dog.vel.x, dog.vel.z);
  assert(v1 > dog.attrs.maxSpeed * 0.95, `dog reaches top speed in 0.75 s (${v1.toFixed(2)})`);
  dog.intent.turbo.held = true;
  const ev = run(st, 30);
  const v2 = Math.hypot(dog.vel.x, dog.vel.z);
  assert(v2 > v1 + 1.5, `turbo is faster (${v2.toFixed(2)})`);
  assert(ofType(ev, 'turboStart').length === 1, 'turboStart once');
  assert(dog.stamina < 0.85, 'stamina drained');
  dog.stamina = 0.01;
  run(st, 3);
  assert(!dog.turboActive && sk(dog).turboLock, 'locked out at 0');
  dog.stamina = 0.2;
  run(st, 1);
  assert(!dog.turboActive, 'still locked below 0.25');
  dog.stamina = 0.3;
  run(st, 1);
  assert(dog.turboActive, 'turbo back above 0.25');
});

test('skating: tight turns + hardStop when reversing at speed', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  place(dog, 0, -10, 0);
  dog.vel = { x: 0, z: 9 };
  dog.intent.move = { x: 1, z: 0 };
  run(st, 20);
  assert(dog.vel.x > 6, `dog carves to the side within 1/3 s (vx ${dog.vel.x.toFixed(2)})`);
  place(dog, 0, -10, 0);
  dog.vel = { x: 0, z: 8 };
  dog.intent.move = { x: 0, z: -1 };
  const ev = run(st, 40);
  assert(ofType(ev, 'hardStop').length === 1, 'hardStop once');
  assert(dog.vel.z < 0, 'reversed within 2/3 s');
});

test('skating: a released pad settles (9 m/s coasts to a stop within 15 m); the windup glide is unchanged', () => {
  const coast = (id: number, v: number) => {
    const st = freshPlay();
    const s = st.skaters[id];
    place(s, 0, -22, 0);
    s.vel = { x: 0, z: v };
    s.intent.move = { x: 0, z: 0 };
    let n = 0;
    while (Math.hypot(s.vel.x, s.vel.z) > 0.01 && n < 900) {
      run(st, 1);
      n++;
    }
    return { dist: s.pos.z + 22, time: n * SIM_DT };
  };
  const dog = coast(0, 9);
  // (it used to glide 34 m / 7.5 s: the next play started before PAL stopped)
  assert(dog.dist <= 15 && dog.dist >= 10, `PAL from 9 m/s: ${dog.dist.toFixed(1)} m (want 10-15: settles, still ice)`);
  assert(dog.time < 4, `PAL stopped in ${dog.time.toFixed(2)} s`);
  const kid = coast(1, 8);
  assert(kid.dist <= 15, `JOSH from 8 m/s: ${kid.dist.toFixed(1)} m`);
  // loading a shot with no direction held still glides at the old ice friction (rush shots unchanged)
  const st = freshPlay();
  const d = st.skaters[0];
  place(d, 0, -10, 0);
  give(st, d);
  d.vel = { x: 0, z: 4 };
  d.intent.move = { x: 0, z: 0 };
  run(st, 1, () => press(d.intent.shoot));
  const v0 = d.vel.z;
  run(st, 30);
  assert(d.state === 'windup', `still loading (${d.state})`);
  assert(near(v0 - d.vel.z, PHYS.windupGlide * 30 * SIM_DT, 0.02), `windup glide ${(v0 - d.vel.z).toFixed(3)} m/s lost over 0.5 s`);
});

test('facing: kids turn at most KID_TURN_RATE (no 135-degree snaps); the dog turns on the spot', () => {
  const st = freshPlay();
  const josh = st.skaters[1];
  const dog = st.skaters[0];
  place(josh, -4, 0, 0);
  place(dog, 4, 0, 0);
  josh.intent.move = { x: 0, z: -1 };
  dog.intent.move = { x: 0, z: -1 };
  run(st, 1);
  const turned = Math.abs(josh.facing);
  assert(turned <= KID_TURN_RATE * SIM_DT + 1e-9 && turned > 0, `kid turned ${turned.toFixed(3)} rad in one tick`);
  assert(near(Math.abs(dog.facing), Math.PI, 1e-6), `dog faces about at once (${dog.facing.toFixed(3)})`);
  run(st, Math.ceil(Math.PI / (KID_TURN_RATE * SIM_DT)) + 2);
  assert(near(Math.abs(josh.facing), Math.PI, 0.25), `kid turned around in ~0.3 s (${josh.facing.toFixed(3)})`);
  // a body check straight behind him: the lunge goes that way at once, the body squares up over it
  place(josh, -4, 0, 0);
  josh.intent.move = { x: 0, z: -1 };
  let maxStep = 0;
  let prev = josh.facing;
  run(st, 12, (s, i) => {
    if (i === 0) press(josh.intent.pass);
    if (i > 0) {
      maxStep = Math.max(maxStep, Math.abs(Math.atan2(Math.sin(josh.facing - prev), Math.cos(josh.facing - prev))));
      prev = josh.facing;
    }
  });
  assert(josh.state === 'check' || josh.stateTime > 0, 'lunged');
  assert(maxStep <= KID_TURN_RATE * SIM_DT + 1e-9, `largest per-tick turn in the lunge ${maxStep.toFixed(3)} rad`);
  assert(josh.vel.z < -1, `lunge drives backward (vz ${josh.vel.z.toFixed(2)})`);
});

test('bark: a TURBO press only barks near a carrier (or someone in front of PAL with the puck); a quick tap always does', () => {
  // A) nobody near: the press sprints and keeps the bark ready
  let st = freshPlay();
  let dog = st.skaters[0];
  place(dog, 0, 0, 0);
  dog.intent.move = { x: 0, z: 1 };
  let ev = run(st, 30, (s, i) => {
    if (i === 0) press(dog.intent.turbo);
  });
  assert(ofType(ev, 'bark').length === 0 && dog.barkCooldown === 0, 'a sprint with nobody near is not a bark');
  assert(ofType(ev, 'turboStart').length === 1 && dog.turboActive, 'it sprints');
  // ... let go after 0.1 s: a tap, it barks (on the release)
  ev = run(st, 12, (s, i) => {
    if (i === 0) release(dog.intent.turbo);
    if (i === 3) press(dog.intent.turbo);
    if (i === 9) release(dog.intent.turbo);
  });
  assert(ofType(ev, 'bark').length === 1 && dog.barkCooldown > 2, `a ${(6 * SIM_DT).toFixed(2)} s tap barks`);
  // ... held past BARK_TAP_TIME is a sprint after all
  st = freshPlay();
  dog = st.skaters[0];
  place(dog, 0, 0, 0);
  dog.intent.move = { x: 0, z: 1 };
  const holdTicks = Math.ceil(BARK_TAP_TIME / SIM_DT) + 2;
  ev = run(st, holdTicks + 3, (s, i) => {
    if (i === 0) press(dog.intent.turbo);
    if (i === holdTicks) release(dog.intent.turbo);
  });
  assert(ofType(ev, 'bark').length === 0, `a ${(holdTicks * SIM_DT).toFixed(2)} s press is no tap`);

  // B) a Blizzard carrier closing within BARK_TRIGGER_RADIUS: the press barks at once
  st = freshPlay();
  dog = st.skaters[0];
  const brick = st.skaters[5];
  place(dog, 0, 0, 0);
  place(brick, 0, BARK_TRIGGER_RADIUS - 0.3, Math.PI);
  give(st, brick);
  ev = run(st, 1, () => press(dog.intent.turbo));
  assert(ofType(ev, 'bark').length === 1, 'press near a carrier barks');

  // C) racing a kid to a loose puck (he's 2 m away, nobody carries): sprint, no bark
  st = freshPlay();
  dog = st.skaters[0];
  place(dog, 0, 0, 0);
  place(st.skaters[6], 1.5, 1.2, 0);
  loose(st, 0, 12, 0, 0);
  dog.intent.move = { x: 0, z: 1 };
  ev = run(st, 20, (s, i) => {
    if (i === 0) press(dog.intent.turbo);
  });
  assert(ofType(ev, 'bark').length === 0 && dog.barkCooldown === 0, 'loose-puck race: no bark');

  // D) PAL carrying, a defender squaring up in front inside BARK_RADIUS: bark; behind him: no bark
  st = freshPlay();
  dog = st.skaters[0];
  place(dog, 0, 0, 0);
  give(st, dog);
  place(st.skaters[7], 0.3, BARK_RADIUS - 0.8, Math.PI);
  ev = run(st, 1, () => press(dog.intent.turbo));
  const b = ofType(ev, 'bark')[0];
  assert(b && b.startled.includes(7), 'carrying: a defender in front gets barked at');
  st = freshPlay();
  dog = st.skaters[0];
  place(dog, 0, 0, 0);
  give(st, dog);
  place(st.skaters[7], 0.3, -(BARK_RADIUS - 0.8), 0);
  dog.intent.move = { x: 0, z: 1 };
  ev = run(st, 5, (s, i) => {
    if (i === 0) press(dog.intent.turbo);
  });
  assert(ofType(ev, 'bark').length === 0, 'carrying: a chaser behind is outrun, not barked at');
});

// ------------------------------------------------------- passing/pickup ----
test('pass: auto target, pickup and passReceived', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  const josh = st.skaters[1];
  place(dog, 0, -5, 0);
  place(josh, 0, 5, Math.PI);
  give(st, dog);
  const ev = run(st, 90, (s, i) => {
    if (i === 0) press(dog.intent.pass);
  });
  const ps = ofType(ev, 'pass');
  assert(ps.length === 1 && ps[0].from === 0 && ps[0].to === 1, `pass ${JSON.stringify(ps)}`);
  assert(ps[0].speed >= 9 && ps[0].speed <= PHYS.passSpeed * 1.2, `pass speed ${ps[0].speed}`);
  const rec = ofType(ev, 'passReceived');
  assert(rec.length === 1 && rec[0].from === 0 && rec[0].to === 1, 'passReceived');
  assert(st.puck.owner === 1, 'receiver owns the puck');
  assert(ofType(ev, 'pickup').some((p) => p.skaterId === 1), 'pickup event');
});

test('pass: intent.passTarget is honored; a fast puck may tick off a stick', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  const tom = st.skaters[3];
  place(dog, 0, -5, 0);
  place(tom, 6, -5, -Math.PI / 2);
  place(st.skaters[1], 0, 5, Math.PI);
  give(st, dog);
  dog.intent.passTarget = 3;
  const ev = run(st, 60, (s, i) => {
    if (i === 0) press(dog.intent.pass);
  });
  assert(ofType(ev, 'pass')[0]?.to === 3, 'passed to the requested target');
  assert(st.puck.owner === 3, 'target received it');
});

test('pass: aimed at the receiver\'s blade, led by his skating', () => {
  // the pass goes where the blade will be (~0.55 m in front of him), not at his skates
  const st = freshPlay();
  const josh = st.skaters[1];
  const tom = st.skaters[3];
  place(josh, 0, -6, 0);
  place(tom, 0, 4, -Math.PI / 2); // facing -x: his blade is 0.55 m to the -x side of him
  give(st, josh);
  josh.intent.passTarget = 3;
  run(st, 1, (s, i) => {
    if (i === 0) press(josh.intent.pass);
  });
  const p = st.puck;
  const blade = stickPoint(tom);
  // the puck's line passes through the blade (within a pass's aim error)
  const dx = blade.x - p.pos.x;
  const dz = blade.z - p.pos.z;
  const sp = Math.hypot(p.vel.x, p.vel.z);
  const miss = Math.abs(dx * p.vel.z - dz * p.vel.x) / sp;
  assert(miss < 0.25, `the pass misses the blade by ${miss.toFixed(2)} m`);
  assert(blade.x < -0.4, 'his blade is off to the side');
});

test('pass: a saucer floats over a stick in the middle of the lane; the receiver takes it', () => {
  const st = freshPlay();
  const josh = st.skaters[1];
  const tom = st.skaters[3];
  const brick = st.skaters[5];
  place(josh, 0, -5, 0);
  place(tom, 0, 5, Math.PI);
  place(brick, -0.9, 0, Math.PI / 2); // blade right on the line, halfway
  give(st, josh);
  josh.intent.passTarget = 3;
  let peak = 0;
  let brickTouched = false;
  const ev = run(st, 90, (s, i) => {
    if (i === 0) press(josh.intent.pass);
    peak = Math.max(peak, st.puck.y);
    if (st.puck.owner === 5) brickTouched = true;
    brick.vel = { x: 0, z: 0 };
  });
  const ps = ofType(ev, 'pass');
  assert(ps.length === 1, 'one pass');
  assert(peak > 0.5 && peak < SAUCER_PEAK + 0.1, `saucer peak ${peak.toFixed(2)} m`);
  assert(!brickTouched && st.puck.owner === 3, `the receiver gets it (owner ${st.puck.owner})`);
  // ... and with nobody in the lane the same pass stays flat
  const st2 = freshPlay();
  place(st2.skaters[1], 0, -5, 0);
  place(st2.skaters[3], 0, 5, Math.PI);
  give(st2, st2.skaters[1]);
  st2.skaters[1].intent.passTarget = 3;
  let peak2 = 0;
  run(st2, 30, (s, i) => {
    if (i === 0) press(st2.skaters[1].intent.pass);
    peak2 = Math.max(peak2, st2.puck.y);
  });
  assert(peak2 < 0.05, `a clean lane is a flat pass (peak ${peak2.toFixed(2)})`);
});

test('pickup: the passer cannot re-grab their own pass instantly', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  place(dog, 0, 0, 0);
  place(st.skaters[1], 0, 12, Math.PI);
  give(st, dog);
  run(st, 3, (s, i) => {
    if (i === 0) press(dog.intent.pass);
  });
  assert(st.puck.owner === null, 'puck released, not re-collected');
});

test('one-timer: SHOOT held while the pass arrives fires immediately', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  const josh = st.skaters[1];
  place(josh, -4, 6, Math.PI / 2);
  place(dog, 2, 14, -Math.PI / 2);
  give(st, josh);
  josh.intent.passTarget = 0;
  const ev = run(st, 90, (s, i) => {
    if (i === 0) press(josh.intent.pass);
    if (i === 2) press(dog.intent.shoot); // the pass is on its way: primes the one-timer, keep holding
  });
  const shots = ofType(ev, 'shot');
  assert(shots.length === 1 && shots[0].shooter === 0, `one-timer shot ${JSON.stringify(shots)}`);
  assert(st.puck.owner !== 0, 'did not hold onto it');
});

test('one-timer: SHOOT pressed just before the pass arrives primes it (no poke swats the pass)', () => {
  // qa-feel-dbg4: SHOOT 0.1-0.25 s early used to poke the incoming pass away (56%)
  for (let k = 0; k < 12; k++) {
    setRandom(mulberry32(100 + k));
    const st = freshPlay();
    const dog = st.skaters[0];
    const josh = st.skaters[1];
    place(josh, -7, 23, Math.PI / 2);
    place(dog, 1.5, 19.5, Math.atan2(-8.5, 3.5)); // blade turned to the passer
    give(st, josh);
    josh.intent.passTarget = 0;
    const pressAt = 1.6 + k * 0.15; // m from the dog: ~0.03-0.2 s before the blade meets it
    let held = false;
    const ev = run(st, 120, (s, i) => {
      if (i === 0) press(josh.intent.pass);
      const d = Math.hypot(s.puck.pos.x - dog.pos.x, s.puck.pos.z - dog.pos.z);
      if (!held && i > 1 && s.puck.owner === null && d < pressAt) {
        press(dog.intent.shoot);
        held = true;
      }
    });
    assert(!ofType(ev, 'poke').some((e) => e.skaterId === 0), `k=${k}: no poke while the pass comes in`);
    assert(ofType(ev, 'pickup').some((e) => e.skaterId === 0), `k=${k}: the dog received the pass`);
    const shots = ofType(ev, 'shot');
    assert(shots.length === 1 && shots[0].shooter === 0, `k=${k}: one-timer fired ${JSON.stringify(shots)}`);
  }
});

test('one-timer: SHOOT held >= 1.2 s, or beyond 18 m, loads a windup and the release shoots', () => {
  // (a) held for ~2 s while a loose puck slides to the dog in the slot
  const st = freshPlay();
  const dog = st.skaters[0];
  place(dog, 0, 19, Math.PI); // facing the puck coming up the slot
  loose(st, 0, 10, 0, 6);
  let got = -1;
  let shotAt = -1;
  let ev = run(st, 200, (s, i) => {
    if (i === 0) press(dog.intent.shoot);
    if (got < 0 && s.puck.owner === 0) got = i;
    if (got >= 0 && i === got + 15) release(dog.intent.shoot);
    if (shotAt < 0 && s.events.some((e) => e.type === 'shot' && e.shooter === 0)) shotAt = i;
  });
  assert(got > 72, `the puck took > 1.2 s to arrive (${got} ticks)`);
  let shots = ofType(ev, 'shot');
  // (got / shotAt are seen one tick late, in the next `each`)
  assert(shots.length === 1 && shotAt === got + 16, `held button: one shot, on the release (got ${got}, shot ${shotAt})`);
  const st1 = freshPlay();
  const d1 = st1.skaters[0];
  place(d1, 0, 19, Math.PI);
  loose(st1, 0, 10, 0, 6);
  got = -1;
  ev = run(st1, 200, (s, i) => {
    if (i === 0) press(d1.intent.shoot);
    if (got < 0 && s.puck.owner === 0) got = i;
  });
  assert(ofType(ev, 'shot').length === 0 && stateOf(d1) === 'windup' && d1.windup > 0.95, `still loading (state ${d1.state}, windup ${d1.windup.toFixed(2)})`);

  // (b) a one-timer try from the neutral zone (22 m out): windup, then the release
  const st2 = freshPlay();
  const d2 = st2.skaters[0];
  const josh = st2.skaters[1];
  place(josh, -5, 0, Math.PI / 2);
  place(d2, 2, 4.5, -Math.PI / 2);
  give(st2, josh);
  josh.intent.passTarget = 0;
  got = -1;
  shotAt = -1;
  ev = run(st2, 120, (s, i) => {
    if (i === 0) press(josh.intent.pass);
    if (i === 3) press(d2.intent.shoot);
    if (got < 0 && s.puck.owner === 0) got = i;
    if (got >= 0 && i === got + 10) release(d2.intent.shoot);
    if (shotAt < 0 && s.events.some((e) => e.type === 'shot' && e.shooter === 0)) shotAt = i;
  });
  assert(got >= 0, 'received');
  shots = ofType(ev, 'shot');
  assert(shots.length === 1 && shotAt === got + 11, `no automatic one-timer at 22 m; shot on release (got ${got}, shot ${shotAt})`);
});

test('buttons: while a teammate pass is in flight, PASS never body-checks and SHOOT never pokes', () => {
  for (const to of [0, 2]) {
    const st = freshPlay();
    const dog = st.skaters[0];
    const josh = st.skaters[1];
    place(josh, -7, 10, Math.PI / 2);
    place(dog, 2, 14, -Math.PI / 2);
    place(st.skaters[2], 3, 4, 0);
    place(st.skaters[5], 3.5, 15, 0); // a checkable opponent right beside the dog
    give(st, josh);
    josh.intent.passTarget = to;
    const states = new Set<string>();
    run(st, 60, (s, i) => {
      if (i === 0) press(josh.intent.pass);
      // mash both buttons while the pass is out (it ends when anyone touches
      // it) and fresh: one to someone else stops counting after SHOT.matePassTime
      const out = s.puck.owner === null && gs(s).pass !== null && s.time - gs(s).pass!.time < SHOT.matePassTime;
      if (i >= 2 && out && i % 6 === 2) press(dog.intent.pass);
      if (i >= 2 && out && i % 6 === 5) press(dog.intent.shoot);
      if (i % 6 === 4) release(dog.intent.pass);
      if (i % 6 === 1) release(dog.intent.shoot);
      states.add(dog.state);
    });
    assert(!states.has('check') && !states.has('poke'), `pass to ${to}: dog states ${[...states].join(',')}`);
  }
  // control: with the puck plainly loose (nobody's pass), PASS is a check again
  const st = freshPlay();
  const dog = st.skaters[0];
  place(dog, 2, 14, 0);
  loose(st, -8, 0, 0, 0);
  run(st, 2, (s, i) => {
    if (i === 0) press(dog.intent.pass);
  });
  assert(stateOf(dog) === 'check', 'loose puck: PASS checks');
});

test('shot: LEFT/RIGHT aims inside that post, height from the charge; UP/DOWN never change a shot', () => {
  /** one shot from the slot; returns where the puck crosses the goal line (no goalie) */
  // the direction is held on the release tick only, so the skating is identical
  const shoot = (seed: number, move: { x: number; z: number }, hold: number) => {
    setRandom(mulberry32(seed));
    const st = freshPlay();
    const dog = st.skaters[0];
    place(st.skaters[9], -12, 20, 0); // goalie out of the way
    place(dog, 0, 20.5, 0);
    give(st, dog);
    run(st, hold + 2, (s, i) => {
      dog.intent.move = i === hold + 1 ? move : { x: 0, z: 0 };
      if (i === 0) press(dog.intent.shoot);
      if (i === hold + 1) release(dog.intent.shoot);
    });
    const p = st.puck;
    const t = (26.5 - p.pos.z) / p.vel.z;
    return { x: p.pos.x + p.vel.x * t, y: p.y + p.vy * t - 0.5 * PHYS.gravity * t * t, vx: p.vel.x, vz: p.vel.z, vy: p.vy };
  };
  for (const hold of [0, 27, 54]) {
    for (let k = 0; k < 6; k++) {
      const a = shoot(50 + k, { x: 0, z: 0 }, hold);
      for (const m of [
        { x: 0, z: 1 },
        { x: 0, z: -1 },
      ]) {
        const b = shoot(50 + k, m, hold);
        assert(near(a.vx, b.vx, 1e-9) && near(a.vz, b.vz, 1e-9) && near(a.vy, b.vy, 1e-9), `hold ${hold}: UP/DOWN changed the shot`);
      }
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const left = Array.from({ length: 40 }, (_, k) => shoot(200 + k, { x: 1, z: 0 }, 0));
  const right = Array.from({ length: 40 }, (_, k) => shoot(200 + k, { x: -0.7, z: 0.7 }, 0)); // side + UP: still the corner
  const full = Array.from({ length: 40 }, (_, k) => shoot(300 + k, { x: 1, z: 0 }, 55));
  assert(near(mean(left.map((r) => r.x)), 0.68, 0.06), `tap +x side lands near 0.68 (${mean(left.map((r) => r.x)).toFixed(2)})`);
  assert(near(mean(right.map((r) => r.x)), -0.68, 0.06), `tap -x side (with UP) lands near -0.68 (${mean(right.map((r) => r.x)).toFixed(2)})`);
  const ty = mean(left.map((r) => r.y));
  const fy = mean(full.map((r) => r.y));
  assert(ty > 0.1 && ty < 0.35 && fy > 0.8 && fy < 1.1, `tap low (${ty.toFixed(2)}), slapper high (${fy.toFixed(2)})`);
});

// ------------------------------------------------------------- shooting ----
test('shot: tap vs full windup speed range, lift and on-target stat', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  place(dog, 0, 5, 0);
  give(st, dog);
  let ev = run(st, 2, (s, i) => {
    if (i === 0) {
      dog.intent.shoot = { held: true, pressed: true, released: true }; // sub-tick tap
    }
  });
  let sh = ofType(ev, 'shot');
  assert(sh.length === 1 && !sh[0].lifted, `tap shot ${JSON.stringify(sh)}`);
  let sp = Math.hypot(st.puck.vel.x, st.puck.vel.z);
  assert(near(sp, shotSpeed(dog, 0), 0.6), `tap speed ${sp.toFixed(1)} vs ${shotSpeed(dog, 0).toFixed(1)}`);
  assert(sp >= PHYS.shotSpeedMin * 0.8 && sp <= PHYS.shotSpeedMin * 1.05, 'tap in range');

  const st2 = freshPlay();
  const d2 = st2.skaters[0];
  place(d2, 0, 5, 0);
  give(st2, d2);
  ev = run(st2, 62, (s, i) => {
    if (i === 0) press(d2.intent.shoot);
    if (i === 60) release(d2.intent.shoot);
  });
  sh = ofType(ev, 'shot');
  assert(sh.length === 1 && sh[0].lifted && sh[0].power > 0.85, `full shot ${JSON.stringify(sh)}`);
  sp = Math.hypot(st2.puck.vel.x, st2.puck.vel.z);
  assert(sp >= PHYS.shotSpeedMax * 0.85 && sp <= PHYS.shotSpeedMax * 1.05, `full speed ${sp.toFixed(1)}`);
  assert(d2.state === 'shoot', 'follow-through state');
});

test('shot: windup slows the skater; wide shots are not counted as shots on goal', () => {
  const st = freshPlay();
  const dog = st.skaters[0];
  place(dog, 0, 0, 0);
  dog.vel = { x: 0, z: 9 };
  dog.intent.move = { x: 0, z: 1 };
  give(st, dog);
  run(st, 30, (s, i) => {
    if (i === 0) press(dog.intent.shoot);
  });
  assert(stateOf(dog) === 'windup' && Math.hypot(dog.vel.x, dog.vel.z) < dog.attrs.maxSpeed * 0.65, 'slowed during windup');
  dog.intent.aimAt = { x: 6, z: 26.5 };
  const ev = run(st, 2, (s, i) => {
    if (i === 0) release(dog.intent.shoot);
  });
  assert(ofType(ev, 'shot').length === 1, 'shot emitted');
  assert(st.shots[0] === 0 && dog.stats.shots === 0, 'wide shot not counted');
});

// ----------------------------------------------------------------- poke ----
test('poke: success rate follows handling; steal on success; cooldown', () => {
  let ok = 0;
  const N = 400;
  let expected = 0;
  for (let i = 0; i < N; i++) {
    const st = freshPlay();
    const brick = st.skaters[5];
    const andrea = st.skaters[2];
    place(brick, 0, 0, Math.PI);
    place(andrea, 0, -1.25, 0);
    give(st, brick);
    expected = pokeChance(andrea, brick, 0);
    const ev = run(st, 12, (s, k) => {
      if (k === 0) press(andrea.intent.shoot);
    });
    const pk = ofType(ev, 'poke');
    assert(pk.length === 1, 'one poke event');
    if (pk[0].success) {
      ok++;
      assert(ofType(ev, 'steal')[0]?.fromId === 5, 'steal event');
    }
    if (i === 0) {
      const again = run(st, 2, (s, k) => {
        if (k === 0) press(andrea.intent.shoot);
      });
      assert(ofType(again, 'poke').length === 0 && sk(andrea).actionCd > 0, 'cooldown blocks a second poke');
    }
  }
  const rate = ok / N;
  assert(near(rate, expected, 0.07), `poke rate ${rate.toFixed(2)} vs expected ${expected.toFixed(2)}`);
  // the dog is much harder to strip than a kid
  const st = freshPlay();
  assert(pokeChance(st.skaters[5], st.skaters[0], 0) < pokeChance(st.skaters[0], st.skaters[5], 0) - 0.2, 'dog handling matters');
});

test('poke: a carrier poked at again within POKE_REPEAT_WINDOW is harder to strip', () => {
  // a second stab right after the first finds him guarding it
  const N = 600;
  const rate = (since: number): { rate: number; expected: number } => {
    let ok = 0;
    let expected = 0;
    for (let i = 0; i < N; i++) {
      const st = freshPlay();
      const brick = st.skaters[5];
      const andrea = st.skaters[2];
      place(brick, 0, 0, Math.PI);
      place(andrea, 0, -1.25, 0);
      give(st, brick);
      const t0 = st.time;
      sk(brick).pokedAt = t0 - since;
      expected = pokeChance(andrea, brick, 0, since < POKE_REPEAT_WINDOW);
      const ev = run(st, 12, (s, k) => {
        if (k === 0) press(andrea.intent.shoot);
      });
      if (ofType(ev, 'poke')[0]?.success) ok++;
      assert((sk(brick).pokedAt ?? -10) > t0, 'the poke is remembered on the carrier');
    }
    return { rate: ok / N, expected };
  };
  const fresh = rate(5);
  const again = rate(POKE_REPEAT_WINDOW * 0.6);
  assert(near(again.expected, fresh.expected - POKE_REPEAT_MALUS, 1e-9), 'the malus comes off the chance');
  assert(near(fresh.rate, fresh.expected, 0.06), `fresh poke ${fresh.rate.toFixed(2)} vs ${fresh.expected.toFixed(2)}`);
  assert(near(again.rate, again.expected, 0.06), `repeat poke ${again.rate.toFixed(2)} vs ${again.expected.toFixed(2)}`);
});

// ---------------------------------------------------------------- checks ----
test('check: force model and knockdown, fallen then invulnerable', () => {
  setRandom(() => 0.999); // never a penalty
  const st = freshPlay();
  const tom = st.skaters[3];
  const brick = st.skaters[5];
  // the formula itself
  const f = hitForce(tom, brick, { x: 0, z: 1 }, false);
  assert(f === 0, 'no closing speed = no force');
  tom.vel = { x: 0, z: 8 };
  const f2 = hitForce(tom, brick, { x: 0, z: 1 }, false);
  const want = 8 * Math.sqrt(tom.attrs.weight / brick.attrs.weight) * (0.6 + 0.8 * tom.attrs.check);
  assert(near(f2, want, 1e-9), `force ${f2} vs ${want}`);
  assert(near(hitForce(tom, brick, { x: 0, z: 1 }, true), want * 1.2, 1e-9), 'turbo x1.2');

  place(tom, 0, -2.5, 0);
  tom.vel = { x: 0, z: 8 };
  place(brick, 0, 0, Math.PI);
  give(st, brick);
  const ev = run(st, 30, (s, i) => {
    if (i === 0) {
      tom.intent.move = { x: 0, z: 1 };
      press(tom.intent.pass);
    }
  });
  const c = ofType(ev, 'check');
  assert(c.length === 1 && c[0].hitter === 3 && c[0].victim === 5, `check ${JSON.stringify(c)}`);
  assert(c[0].force > PHYS.knockdownForce && c[0].knockedDown, `knockdown at force ${c[0].force.toFixed(1)}`);
  assert(stateOf(brick) === 'fallen' && st.puck.owner !== 5, 'victim down and lost the puck');
  assert(tom.stats.hits === 1 && st.hits[0] === 1, 'hit stats');
  run(st, Math.ceil(PHYS.fallTime * 60));
  assert(stateOf(brick) === 'skate' && brick.invuln > 0, 'got up with invulnerability');
});

test('check: light hit stumbles; the dog barely moves a kid; boards add force', () => {
  setRandom(() => 0.999);
  const st = freshPlay();
  const dog = st.skaters[0];
  const butch = st.skaters[7];
  place(dog, 0, -1.5, 0);
  dog.vel = { x: 0, z: 6 };
  place(butch, 0, 0, Math.PI);
  give(st, butch);
  const ev = run(st, 10, (s, i) => {
    if (i === 0) {
      dog.intent.move = { x: 0, z: 1 };
      press(dog.intent.pass);
    }
  });
  const c = ofType(ev, 'check')[0];
  assert(c && !c.knockedDown && c.force < PHYS.knockdownForce, `dog check is light (${c?.force.toFixed(2)})`);
  assert(stateOf(butch) !== 'fallen' && butch.stun > 0, 'stumble');

  const st2 = freshPlay();
  const tom = st2.skaters[3];
  const kyle = st2.skaters[8];
  place(kyle, 11.9, 0, Math.PI / 2);
  place(tom, 10.0, 0, Math.PI / 2);
  tom.vel = { x: 6, z: 0 };
  give(st2, kyle);
  const ev2 = run(st2, 10, (s, i) => {
    if (i === 0) {
      tom.intent.move = { x: 1, z: 0 };
      press(tom.intent.pass);
    }
  });
  const c2 = ofType(ev2, 'check')[0];
  assert(!!c2 && ofType(ev2, 'bodyBoards').some((b) => b.skaterId === 8), 'bodyBoards on a boards pin');
});

// ------------------------------------------------------------- penalties ----
test('penalty roll: light hits rarely called, heavy hits often (Monte Carlo)', () => {
  const st = freshPlay();
  const h = (force: number, o: Partial<HitContext> = {}): HitContext => ({
    hitter: st.skaters[7],
    victim: st.skaters[1],
    force,
    victimHadPuck: true,
    fromBehind: false,
    nearBoards: false,
    charging: false,
    ...o,
  });
  const rate = (ctx: HitContext, n = 20000) => {
    let k = 0;
    for (let i = 0; i < n; i++) if (rollPenalty(st, ctx)) k++;
    return k / n;
  };
  const rates = [3, 4.5, 6, 9, 12, 15].map((f) => rate(h(f)));
  assert(rates[0] === 0, 'below penaltyForceMin is never called');
  assert(rates[1] < 0.02, `light hit (4.5) rate ${rates[1]}`);
  for (let i = 1; i < rates.length; i++) assert(rates[i] >= rates[i - 1], `monotonic ${rates.join(',')}`);
  assert(near(rates[5], RULES.penaltyMaxChance, 0.02), `max-force hit rate ${rates[5]}`);
  assert(near(rates[3], basePenaltyChance(9), 0.02), 'matches the formula');
  // situational multipliers
  assert(near(penaltyChance(h(9, { victimHadPuck: false })), basePenaltyChance(9) * 1.6, 1e-9), 'interference x1.6');
  assert(near(penaltyChance(h(9, { fromBehind: true })), basePenaltyChance(9) * 1.5, 1e-9), 'from behind x1.5');
  assert(near(penaltyChance(h(9, { nearBoards: true })), basePenaltyChance(9) * 1.2, 1e-9), 'boards x1.2');
  assert(near(penaltyChance(h(6, { victim: st.skaters[9] })), basePenaltyChance(6) * 3, 1e-9), 'goalie x3');
  // names and severity
  assert(infractionFor(h(6, { victim: st.skaters[9] })) === 'GOALIE INTERFERENCE', 'goalie interference');
  assert(infractionFor(h(6, { victimHadPuck: false })) === 'INTERFERENCE', 'interference');
  assert(infractionFor(h(6, { fromBehind: true })) === 'CHECKING FROM BEHIND', 'from behind');
  assert(infractionFor(h(6, { nearBoards: true })) === 'BOARDING', 'boarding');
  assert(infractionFor(h(10, { charging: true })) === 'CHARGING', 'charging');
  assert(infractionFor(h(7), 0.1) === 'ELBOWING' && infractionFor(h(7), 0.9) === 'ROUGHING', 'elbowing flavor');
  assert(infractionFor(h(5)) === 'ROUGHING', 'roughing');
  setRandom(() => 0);
  const maj = rollPenalty(st, h(RULES.majorForce + 0.1))!;
  const min = rollPenalty(st, h(RULES.majorForce - 0.1))!;
  assert(maj.major && maj.duration === RULES.majorLength && !min.major && min.duration === RULES.minorLength, 'major/minor');
});

test('penalty: box, PP/SH strength, banner, faceoff in the offender zone, expiry', () => {
  const st = freshPlay();
  st.puck.pos = { x: 3, z: 0 };
  callPenalty(st, mkPenalty(st, 6));
  const t = st.skaters[6];
  assert(phase(st) === 'penalty' && stateOf(t) === 'box', 'phase + box');
  const at = boxSlotPos(1, 0);
  assert(t.pos.x === at.x && t.pos.z === at.z, 'sits in the away box');
  const str = strength(st);
  assert(str.home === 4 && str.away === 3 && str.ppTeam === 0, `strength ${JSON.stringify(str)}`);
  assert(st.lastPenaltyCall?.skaterId === 6 && t.stats.pim === RULES.minorLength, 'call + pim');
  const ev = run(st, Math.ceil(RULES.penaltyBannerTime * 60) + 1);
  assert(phase(st) === 'faceoff', `faceoff after the banner (${phase(st)})`);
  const want = defensiveDot(1, 1, 3);
  assert(st.faceoff!.spot.x === want.x && st.faceoff!.spot.z === want.z && want.z > 0, `spot ${JSON.stringify(st.faceoff!.spot)}`);
  assert(ofType(ev, 'faceoffSetup').length === 1, 'faceoffSetup');
  // penalty clock only runs in play
  const before = st.penalties[0].remaining;
  assert(before === RULES.minorLength, 'clock did not run during the banner');
  st.phase = 'play';
  st.penalties[0].remaining = 0.2;
  const ev2 = run(st, 20);
  assert(ofType(ev2, 'penaltyExpired')[0]?.skaterId === 6, 'expired');
  assert(stateOf(t) === 'skate' && t.pos.x < RINK.halfWidth, 'back on the ice next to the box');
});

test('penalty: PP goal ends a minor early; majors are served in full; SH goal flagged', () => {
  for (const major of [false, true]) {
    const st = freshPlay();
    callPenalty(st, mkPenalty(st, 6, major));
    st.phase = 'play';
    pullAwayGoalie(st);
    touchPuck(st, 0);
    loose(st, 0, 23, 0, 15);
    const ev = runUntil(st, 90, (s) => s.phase === 'goal');
    const g = ofType(ev, 'goal')[0];
    assert(g && g.info.powerPlay && !g.info.shortHanded, 'powerPlay flag');
    if (major) assert(stateOf(st.skaters[6]) === 'box' && ofType(ev, 'penaltyExpired').length === 0, 'major keeps serving');
    else assert(stateOf(st.skaters[6]) !== 'box' && ofType(ev, 'penaltyExpired')[0]?.skaterId === 6, 'minor ends early');
  }
  const st = freshPlay();
  callPenalty(st, mkPenalty(st, 6));
  st.phase = 'play';
  pullAwayGoalie(st);
  touchPuck(st, 5);
  // away scores into the +z goal (an own-goal by direction doesn't matter: test SH flag via the -z goal)
  place(st.skaters[4], 4.0, -25.0, 0);
  loose(st, 0, -23, 0, -15);
  const ev = runUntil(st, 90, (s) => s.phase === 'goal');
  const g = ofType(ev, 'goal')[0];
  assert(g && g.info.team === 1 && g.info.shortHanded && !g.info.powerPlay, `SH goal ${JSON.stringify(g?.info)}`);
  assert(stateOf(st.skaters[6]) === 'box', 'SH goal does not free the offender');
});

test('penalty: at most 2 boxed per team, extras queue and serve later', () => {
  const st = freshPlay();
  for (const id of [5, 6, 7]) {
    callPenalty(st, mkPenalty(st, id));
    st.phase = 'play';
  }
  assert(st.penalties.filter((p) => p.team === 1).length === MAX_BOXED, 'two active');
  assert(st.penaltyQueue!.length === 1 && stateOf(st.skaters[7]) !== 'box', 'third queued, still on the ice');
  assert(skatersOnIce(st, 1) === 2, 'never below 2 skaters + goalie');
  st.penalties[0].remaining = 0.05;
  const ev = run(st, 5);
  assert(ofType(ev, 'penaltyExpired')[0]?.skaterId === 5, 'first one out');
  assert(stateOf(st.skaters[7]) === 'box' && num(st.penaltyQueue!.length) === 0, 'queued one goes in');
  assert(skatersOnIce(st, 1) === 2, 'still 2 skaters');
});

test('penalty: dog in the box switches control, and back on return', () => {
  const st = freshPlay({ human: true });
  st.puck.pos = { x: -10, z: -12 };
  callPenalty(st, mkPenalty(st, 0));
  let ev = run(st, 1);
  const sw = ofType(ev, 'controlSwitch');
  assert(sw.length === 1 && st.controlledId !== 0, `switched to ${st.controlledId}`);
  const near1 = st.skaters.filter((s) => s.team === 0 && s.kind === 'kid').sort(
    (a, b) => Math.hypot(a.pos.x + 10, a.pos.z + 12) - Math.hypot(b.pos.x + 10, b.pos.z + 12),
  )[0];
  assert(st.controlledId === near1.id, 'nearest home skater to the puck');
  // the human now drives the kid with the pad (screen-relative)
  run(st, Math.ceil(RULES.penaltyBannerTime * 60) + 80); // banner + faceoff
  assert(gs(st).takers[0] === st.controlledId, 'controlled kid takes the faceoff');
  st.phase = 'play';
  st.penalties[0].remaining = 0.05;
  ev = run(st, 5);
  assert(st.controlledId === 0 && ofType(ev, 'controlSwitch').some((e) => e.skaterId === 0), 'control back to PAL');
});

/** Dog boxed, kid 1 carrying in the offensive zone under human control, PAL's penalty about to expire. */
function dogBoxedKidRush(): GameState {
  const st = freshPlay({ human: true });
  callPenalty(st, mkPenalty(st, 0));
  run(st, 1); // control leaves the boxed dog
  st.phase = 'play';
  const kid = st.skaters[1];
  place(kid, 0, 17 * attackDir(0, 1), 0);
  give(st, kid);
  run(st, 1);
  assert(num(st.controlledId) === 1 && !st.dogReturnPending, 'the carrier is controlled while PAL sits');
  st.penalties[0].remaining = 0.05;
  return st;
}
const passPad = (): PadState => {
  const p = emptyPad();
  p.pass = { held: true, pressed: true, released: false };
  return p;
};
const shootPad = (held: boolean, pressed = false, released = false): PadState => {
  const p = emptyPad();
  p.shoot = { held, pressed, released };
  return p;
};

test('control: PAL back from the box waits while the kid carries; switches when he passes', () => {
  const st = dogBoxedKidRush();
  let ev = run(st, 40);
  assert(ofType(ev, 'penaltyExpired')[0]?.skaterId === 0 && stateOf(st.skaters[0]) !== 'box', 'PAL is back on the ice');
  assert(num(st.controlledId) === 1 && st.dogReturnPending === true, `kid keeps the rush (${st.controlledId}, ${st.dogReturnPending})`);
  assert(ofType(ev, 'controlSwitch').length === 0, 'no switch at the box door');
  ev = run(st, 1, undefined, () => passPad());
  assert(ofType(ev, 'pass')[0]?.from === 1, 'the kid passes');
  ev.push(...run(st, 2));
  assert(num(st.controlledId) === 0 && !st.dogReturnPending, `control to PAL after the pass (${st.controlledId})`);
  assert(ofType(ev, 'controlSwitch').length === 1 && ofType(ev, 'controlSwitch')[0].skaterId === 0, 'one controlSwitch to PAL');
});

test('control: PAL back from the box takes over when the kid loses the puck or play stops', () => {
  // the kid is stripped: the away team has it
  let st = dogBoxedKidRush();
  run(st, 10);
  assert(num(st.controlledId) === 1 && st.dogReturnPending === true, 'kid keeps it');
  give(st, st.skaters[6]);
  let ev = run(st, 1);
  assert(num(st.controlledId) === 0 && !st.dogReturnPending && ofType(ev, 'controlSwitch')[0]?.skaterId === 0, 'turnover -> PAL');
  // a whistle
  st = dogBoxedKidRush();
  run(st, 10);
  callPenalty(st, mkPenalty(st, 7));
  ev = run(st, 1);
  assert(num(st.controlledId) === 0 && ofType(ev, 'controlSwitch')[0]?.skaterId === 0, 'stoppage -> PAL');
  // a teammate's pass on its way to the controlled kid keeps him; a pass that never arrives does not
  st = dogBoxedKidRush();
  run(st, 10);
  const G = gs(st);
  loose(st, -6, 0, 0, 0);
  G.pass = { from: 2, to: 1, time: st.time };
  run(st, 30);
  assert(num(st.controlledId) === 1 && st.dogReturnPending === true, 'pass in flight to the kid: kid keeps control');
  run(st, 90);
  assert(num(st.controlledId) === 0 && !st.dogReturnPending, 'a pass that never arrived stops counting');
});

test('control: a windup is never fired by a control change (only by the human releasing SHOOT)', () => {
  // PAL's penalty expires while the kid loads a slapshot: he keeps loading, no shot
  const st = dogBoxedKidRush();
  let ev = run(st, 1, undefined, () => shootPad(true, true));
  ev.push(...run(st, 50, undefined, () => shootPad(true)));
  assert(ofType(ev, 'penaltyExpired').length === 1, 'PAL came back mid-windup');
  assert(ofType(ev, 'shot').length === 0, `no shot without a release (${ofType(ev, 'shot').length})`);
  assert(stateOf(st.skaters[1]) === 'windup' && st.skaters[1].windup > 0.5 && num(st.controlledId) === 1, 'still loading, still the kid');
  ev = run(st, 1, undefined, () => shootPad(false, false, true));
  assert(ofType(ev, 'shot').length === 1 && ofType(ev, 'shot')[0].shooter === 1, 'released: one shot by the kid');
  run(st, 2);
  assert(num(st.controlledId) === 0, 'then PAL');

  // control lands on a skater the AI left winding up (PAL, here): it is dropped, not fired
  const st2 = dogBoxedKidRush();
  run(st2, 10);
  const dog = st2.skaters[0];
  place(dog, 2, 15 * attackDir(0, 1), 0);
  give(st2, dog);
  // the dog (AI-driven while the kid had control) is mid-windup when control comes back to him
  dog.state = 'windup';
  dog.stateTime = 0;
  dog.windup = 0.4;
  dog.intent.shoot = { held: true, pressed: false, released: false };
  ev = run(st2, 30);
  assert(num(st2.controlledId) === 0, 'PAL controlled');
  assert(ofType(ev, 'shot').length === 0 && stateOf(dog) !== 'windup' && dog.windup === 0, `windup dropped on the switch (${ofType(ev, 'shot').length} shots)`);
});

test('START: pauses in intro, goal, stoppage, penalty and periodEnd; a second START resumes', () => {
  const check = (st: GameState, label: string) => {
    const want = phase(st);
    run(st, 1, undefined, () => startPad());
    assert(st.paused, `${label}: paused`);
    const t = st.tick;
    const pt = st.phaseTime;
    run(st, 60);
    assert(st.tick === t && st.phaseTime === pt && phase(st) === want, `${label}: frozen`);
    run(st, 1, undefined, () => startPad());
    assert(!st.paused, `${label}: unpaused`);
    run(st, 2);
    assert(st.tick === t + 2, `${label}: running again`);
  };
  const intro = createGame({ ai: false });
  run(intro, 5);
  check(intro, 'intro');
  for (const ph of ['goal', 'stoppage'] as const) {
    const st = freshPlay({ human: true });
    st.phase = ph;
    check(st, ph);
  }
  const pen = freshPlay({ human: true });
  callPenalty(pen, mkPenalty(pen, 6));
  check(pen, 'penalty');
  const pe = freshPlay({ human: true });
  pe.clock = 0.02;
  run(pe, 3);
  assert(phase(pe) === 'periodEnd', 'periodEnd');
  check(pe, 'periodEnd');
});

test('START: a double tap at the intermission skips it without pausing the faceoff', () => {
  const st = freshPlay({ human: true });
  st.clock = 0.02;
  run(st, Math.ceil(RULES.periodEndTime * 60) + 3);
  assert(phase(st) === 'intermission', 'intermission');
  run(st, Math.ceil(INTERMISSION_START_GUARD * 60));
  run(st, 1, undefined, () => startPad());
  assert(phase(st) === 'faceoff' && num(st.period) === 2, 'skipped to period 2');
  run(st, 2);
  run(st, 1, undefined, () => startPad());
  assert(!st.paused && phase(st) === 'faceoff', 'the mashed second START is ignored');
  run(st, Math.ceil(AFTER_INTERMISSION_START_GUARD * 60));
  run(st, 1, undefined, () => startPad());
  assert(st.paused, 'a deliberate START later still pauses');
});

// -------------------------------------------------------------- faceoffs ----
test('faceoff: false start loses, first press after the drop wins, timeout coin flip', () => {
  // A: human jumps the drop
  let st = freshPlay({ human: true });
  setupFaceoff(st, { x: 0, z: 0 });
  // the drop time is random now: run until just past it
  let ev = run(st, Math.ceil(st.faceoff!.dropTime * 60) + 10, undefined, (i) => {
    const p = emptyPad();
    if (i === 20) p.shoot = { held: true, pressed: true, released: false };
    return p;
  });
  assert(ofType(ev, 'falseStart')[0]?.team === 0, 'falseStart event');
  assert(ofType(ev, 'faceoffWin')[0]?.team === 1, 'other team wins');
  assert(ofType(ev, 'faceoffDrop').length === 1 && phase(st) === 'play', 'dropped, play on');

  // B: human presses 0.05 s after the drop (faster than any AI reaction)
  st = freshPlay({ human: true });
  setupFaceoff(st, { x: 0, z: 0 });
  const dropTick = Math.ceil(st.faceoff!.dropTime * 60);
  let drawVz = 0;
  ev = [];
  for (let i = 0; i < dropTick + 30; i++) {
    const p = emptyPad();
    if (i === dropTick + 3) p.pass = { held: true, pressed: true, released: false };
    stepGame(st, p);
    ev.push(...st.events);
    if (st.events.some((e) => e.type === 'faceoffWin')) drawVz = st.puck.vel.z;
  }
  const w = ofType(ev, 'faceoffWin')[0];
  assert(w?.team === 0 && w.skaterId === 0, `human wins ${JSON.stringify(w)}`);
  assert(ofType(ev, 'falseStart').length === 0, 'no false start');
  assert(drawVz * attackDir(0, 1) < 0, 'drawn back toward own end');

  // C: human idles -> AI center wins inside its reaction window
  st = freshPlay({ human: true });
  setupFaceoff(st, { x: 0, z: 0 });
  let winAt = -1;
  for (let i = 0; i < 200 && winAt < 0; i++) {
    stepGame(st, emptyPad());
    if (st.events.some((e) => e.type === 'faceoffWin')) winAt = st.phaseTime;
  }
  void winAt;
  assert(phase(st) === 'play' && ofType(st.events, 'faceoffWin')[0]?.team === 1, 'AI wins when the human idles');

  // D: lineup: centers 1.2 m off the dot, shorthanded side has 3
  st = freshPlay();
  callPenalty(st, mkPenalty(st, 6));
  setupFaceoff(st, defensiveDot(1, 1, 1));
  const dot = st.faceoff!.spot;
  const homeC = st.skaters[gs(st).takers[0]];
  const awayC = st.skaters[gs(st).takers[1]];
  assert(near(homeC.pos.z, dot.z - 1.2, 1e-6) && near(awayC.pos.z, dot.z + 1.2, 1e-6), 'centers 1.2 m back');
  assert(stateOf(homeC) === 'faceoff' && stateOf(awayC) === 'faceoff', 'faceoff stance');
  for (const s of st.skaters) if (s.state !== 'box') assert(boardsInfo(s.pos.x, s.pos.z).dist > 0.5, `${s.name} inside the rink`);
});

test('faceoff: the drop time is random (0.8-1.6 s), period openers wait 1.9-2.5 s', () => {
  // normal faceoffs: spread over the whole window, so counting from the lineup doesn't work
  const st = freshPlay();
  const bins = [0, 0, 0, 0];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 200; i++) {
    setupFaceoff(st, i % 2 ? { x: 0, z: 0 } : defensiveDot(i % 4 < 2 ? 0 : 1, 1, i % 3 - 1));
    const t = st.faceoff!.dropTime;
    assert(t >= RULES.faceoffDropMin && t <= RULES.faceoffDropMax, `normal drop ${t} in 0.8-1.6`);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
    bins[Math.min(3, Math.floor(((t - 0.8) / 0.8) * 4))]++;
  }
  assert(lo < 0.9 && hi > 1.5 && bins.every((b) => b >= 25), `spread: ${lo.toFixed(2)}..${hi.toFixed(2)} bins ${bins}`);
  for (let i = 0; i < 200; i++) {
    setupFaceoff(st, { x: 0, z: 0 }, true);
    const t = st.faceoff!.dropTime;
    assert(t >= 1.9 && t <= 2.5, `opener drop ${t} in 1.9-2.5`);
  }
  // every real opener path: intro -> P1, intermission -> P2, -> OT
  const g = createGame({ autoplay: true, ai: false });
  runUntil(g, 400, (x) => x.phase === 'faceoff');
  assert(g.faceoff, `P1 faceoff (${g.phase})`);
  assert(g.period === 1 && g.faceoff!.dropTime >= 1.9, `P1 opener ${g.faceoff?.dropTime}`);
  for (const [period, score] of [
    [1, [0, 0]],
    [3, [1, 1]],
  ] as [number, [number, number]][]) {
    const p = freshPlay();
    p.period = period;
    while (p.periodGoals.length < period) p.periodGoals.push([0, 0]);
    p.score = score;
    p.clock = 0.02;
    runUntil(p, 2000, (x) => x.phase === 'faceoff');
    assert(p.faceoff, `P${period + 1} faceoff (${p.phase})`);
    assert(p.period === period + 1, `period ${period + 1}`);
    const t = p.faceoff!.dropTime;
    assert(t >= 1.9 && t <= 2.5, `period ${period + 1} opener drop ${t}`);
    // and the drop really waits that long
    const ev = runUntil(p, 400, (_x, e) => e.some((k) => k.type === 'faceoffDrop'));
    assert(ofType(ev, 'faceoffDrop').length === 1 && near(p.phaseTime, t, SIM_DT + 1e-9), `dropped at ${p.phaseTime} (${t})`);
  }
  // a faceoff after a whistle (here a penalty call) is a normal one
  const w = freshPlay();
  callPenalty(w, mkPenalty(w, 6));
  runUntil(w, 600, (x) => x.phase === 'faceoff');
  assert(w.faceoff, `whistle faceoff (${w.phase})`);
  assert(w.faceoff!.dropTime <= RULES.faceoffDropMax, `post-whistle drop ${w.faceoff?.dropTime}`);
});

test('faceoff: the beaten center never scoops the draw (100 forced wins each way)', () => {
  for (const winner of [0, 1] as TeamId[]) {
    for (let i = 0; i < 100; i++) {
      setRandom(mulberry32(900 + i + winner * 1000));
      const st = createGame({ autoplay: true }); // full AI: everyone skates to the puck
      st.tick = 100;
      st.period = 1 + (i % 2);
      const spots = [{ x: 0, z: 0 }, defensiveDot(0, st.period, 1), defensiveDot(1, st.period, -1), { x: 7, z: -6.5 }];
      setupFaceoff(st, spots[i % spots.length]);
      const G = gs(st);
      const loser = G.takers[winner === 0 ? 1 : 0];
      G.aiFalseStart = [-1, -1];
      G.react[winner] = 0.05;
      G.react[winner === 0 ? 1 : 0] = 0.9;
      const ev = runUntil(st, 300, (_x, e) => e.some((k) => k.type === 'faceoffWin'));
      assert(ofType(ev, 'faceoffWin')[0]?.team === winner, `team ${winner} wins`);
      for (let k = 0; k < Math.ceil(0.25 / SIM_DT); k++) {
        run(st, 1);
        assert(st.puck.owner !== loser, `seed ${i}: losing center ${loser} owns the puck ${k + 1} ticks after a team ${winner} win`);
      }
    }
  }
});

test('faceoff: a human win with LEFT/RIGHT held draws to that side', () => {
  for (const period of [1, 2]) {
    for (const side of ['left', 'right'] as const) {
      for (const spot of [{ x: 0, z: 0 }, defensiveDot(0, period, 1), defensiveDot(0, period, -1), defensiveDot(1, period, 1)]) {
        const st = freshPlay({ human: true });
        st.period = period;
        setupFaceoff(st, spot);
        const G = gs(st);
        G.aiFalseStart = [-1, -1];
        G.react[1] = 1.0;
        const dropTick = Math.ceil(st.faceoff!.dropTime * 60);
        const ev = run(st, dropTick + 5, undefined, (i) => {
          const p = emptyPad();
          p[side] = true;
          if (i === dropTick + 1) p.pass = { held: true, pressed: true, released: false };
          return p;
        });
        assert(ofType(ev, 'faceoffWin')[0]?.team === 0, 'human wins');
        const target = st.skaters[G.pass?.to ?? -1];
        assert(target && target.team === 0 && target.kind !== 'goalie', `drawn to a skater (${G.pass?.to})`);
        const dir = screenToWorld({ ...emptyPad(), [side]: true }, period);
        const taker = st.skaters[0];
        const lat = (target.pos.x - taker.pos.x) * dir.x + (target.pos.z - taker.pos.z) * dir.z;
        assert(lat > 1, `P${period} ${side} at ${JSON.stringify(spot)}: ${target.name} is ${lat.toFixed(2)} m to the ${side}`);
        assert(st.puck.vel.x * dir.x + st.puck.vel.z * dir.z > 0, 'the puck heads that way');
      }
    }
  }
  // nothing held: the old random draw back (mostly to a D) still applies
  let back = 0;
  for (let i = 0; i < 40; i++) {
    const st = freshPlay({ human: true });
    setupFaceoff(st, { x: 0, z: 0 });
    gs(st).react[1] = 1.0;
    gs(st).aiFalseStart = [-1, -1];
    const dropTick = Math.ceil(st.faceoff!.dropTime * 60);
    run(st, dropTick + 5, undefined, (k) => {
      const p = emptyPad();
      if (k === dropTick + 1) p.shoot = { held: true, pressed: true, released: false };
      return p;
    });
    const t = st.skaters[gs(st).pass?.to ?? -1];
    if (t && (t.pos.z - st.skaters[0].pos.z) * attackDir(0, 1) < -2) back++;
  }
  assert(back >= 20, `untouched draws still go back mostly (${back}/40)`);
});

// --------------------------------------------------------------- goalies ----
test('goalie: catch -> freeze -> whistle -> end-zone faceoff', () => {
  setRandom(() => 0.01);
  const st = freshPlay();
  const g = st.skaters[9];
  place(g, 0, 25.2, Math.PI);
  touchPuck(st, 0);
  loose(st, 0.1, 17, 0, 20, 0, 1.8);
  gs(st).lastShot = { shooter: 0, team: 0, time: st.time, counted: false };
  let ev = runUntil(st, 60, (s, e) => e.some((x) => x.type === 'save'));
  const sv = ofType(ev, 'save')[0];
  assert(sv && sv.goalie === 9 && sv.caught, `caught save ${JSON.stringify(sv)}`);
  assert(stateOf(g) === 'gHold' && st.puck.owner === 9, 'holding');
  assert(st.shots[0] === 1, 'a save counts as a shot on goal');
  ev = runUntil(st, 200, (s) => s.phase === 'stoppage');
  assert(ofType(ev, 'whistle')[0]?.reason === 'freeze', 'freeze whistle');
  ev = runUntil(st, 200, (s) => s.phase === 'faceoff');
  const spot = st.faceoff!.spot;
  assert(spot.z === RINK.endDot.z && Math.abs(spot.x) === RINK.endDot.x, `end-zone dot ${JSON.stringify(spot)}`);
});

test('goalie: reaction + geometric hitbox (butterfly vs high corner), rebounds', () => {
  const st = freshPlay();
  const g = st.skaters[9];
  // hitbox shapes
  g.state = 'gReady';
  assert(goalieHitbox(g)[0][1] === 0.45, 'stance 0.9 m wide');
  g.state = 'gButterfly';
  g.stateTime = 1;
  assert(goalieHitbox(g)[0][1] === 0.75 && goalieHitbox(g)[0][3] === 0.6, 'butterfly 1.5 m x 0.6 m');
  g.state = 'gReady';
  // a low shot at the far post from the slot is stopped by a reacting goalie
  let saves = 0;
  let goals = 0;
  for (let i = 0; i < 40; i++) {
    setRandom(mulberry32(100 + i));
    const s = freshPlay();
    place(s.skaters[9], 0, 25.3, Math.PI);
    touchPuck(s, 0);
    loose(s, 0, 15, 0.7 * (11.5 / 11.2) / (11.5 / 22), 22, 0, 0.2);
    const ev = runUntil(s, 60, (x, e) => e.some((k) => k.type === 'save' || k.type === 'goal'));
    if (ofType(ev, 'save').length) saves++;
    if (ofType(ev, 'goal').length) goals++;
  }
  assert(saves > 30, `low far-post shots from 11 m mostly saved (${saves}/40 saves, ${goals} goals)`);
  // a high corner snipe from close range beats the goalie more often than not
  let snipes = 0;
  for (let i = 0; i < 40; i++) {
    setRandom(mulberry32(300 + i));
    const s = freshPlay();
    place(s.skaters[9], 0, 25.3, Math.PI);
    touchPuck(s, 0);
    const T = 5.5 / 30;
    const vy = (1.0 + 0.5 * PHYS.gravity * T * T) / T;
    loose(s, 0.2, 21, (0.75 - 0.2) / T, 30, 0, vy);
    const ev = runUntil(s, 60, (x, e) => e.some((k) => k.type === 'save' || k.type === 'goal' || k.type === 'post'));
    if (ofType(ev, 'goal').length) snipes++;
  }
  assert(snipes >= 20, `high-corner snipes from 5.5 m mostly score (${snipes}/40)`);
});

// ------------------------------------------------------ periods and flow ----
test('flow: period end -> intermission -> period 2 with switched ends', () => {
  const st = freshPlay();
  st.clock = 0.05;
  let ev = run(st, 10);
  assert(ofType(ev, 'periodEnd')[0]?.period === 1 && phase(st) === 'periodEnd', 'periodEnd');
  ev = run(st, Math.ceil(RULES.periodEndTime * 60));
  assert(phase(st) === 'intermission' && ofType(ev, 'intermissionStart')[0]?.nextPeriod === 2, 'intermission');
  // the stats screen ignores START for its first second (a mashed START must not skip it unseen)
  run(st, 1, undefined, () => startPad());
  assert(phase(st) === 'intermission', 'START in the first instant of the intermission is ignored');
  run(st, Math.ceil(INTERMISSION_START_GUARD * 60));
  ev = run(st, 1, undefined, () => startPad());
  assert(num(st.period) === 2 && phase(st) === 'faceoff', 'START skips to period 2');
  assert(ofType(ev, 'periodStart')[0]?.period === 2, 'periodStart');
  assert(st.clock === RULES.periodLength && st.periodGoals.length === 2, 'clock reset');
  assert(attackDir(0, 2) === -1 && ownGoalZ(0, 2) > 0, 'home now defends +z');
  const dog = st.skaters[0];
  assert(near(dog.pos.z, 1.2, 1e-6) && near(dog.facing, Math.PI, 1e-9), 'dog lines up on the +z side facing -z');
  assert(st.skaters[4].pos.z > 20, 'home goalie at the +z net');
});

test('flow: intermission timer, penalties carry over', () => {
  const st = freshPlay();
  callPenalty(st, mkPenalty(st, 6));
  st.phase = 'play';
  st.clock = 0.02;
  run(st, Math.ceil(RULES.periodEndTime * 60) + Math.ceil(RULES.intermissionTime * 60) + 5);
  assert(num(st.period) === 2 && phase(st) === 'faceoff', `auto-advance (${phase(st)} p${st.period})`);
  assert(stateOf(st.skaters[6]) === 'box' && st.penalties.length === 1, 'still in the box');
});

test('flow: clockWarning once per second over the last 10 s', () => {
  const st = freshPlay();
  st.clock = 11.5;
  const ev = run(st, 12 * 60);
  assert(ofType(ev, 'clockWarning').length === 10, `warnings ${ofType(ev, 'clockWarning').length}`);
  assert(ofType(ev, 'periodEnd').length === 1, 'period ended');
});

test('flow: OT sudden death after a tied 3rd; OT goal ends it', () => {
  const st = freshPlay();
  st.period = 3;
  st.periodGoals = [
    [1, 0],
    [0, 1],
    [0, 0],
  ];
  st.score = [1, 1];
  st.clock = 0.02;
  run(st, Math.ceil(RULES.periodEndTime * 60) + 3);
  assert(phase(st) === 'intermission', 'tied -> intermission');
  run(st, Math.ceil(INTERMISSION_START_GUARD * 60)); // START guard on the stats screen
  run(st, 1, undefined, () => startPad());
  assert(st.period === 4 && st.clock === RULES.overtimeLength && attackDir(0, 4) === 1, 'OT period 4');
  st.phase = 'play';
  place(st.skaters[4], 4.0, -25.0, 0);
  touchPuck(st, 6);
  loose(st, 0, -23, 0, -15);
  const ev = runUntil(st, 90, (s) => s.phase === 'goal');
  assert(ofType(ev, 'goal').length === 1, 'OT goal');
  const ev2 = run(st, Math.ceil(RULES.goalCelebrateTime * 60) + 2);
  assert(phase(st) === 'gameOver' && st.winner === 1, `away wins in OT (${phase(st)}, ${st.winner})`);
  assert(ofType(ev2, 'gameOver')[0]?.winner === 1, 'gameOver event');
});

test('flow: still tied after OT is a tie; a 3rd-period lead ends regulation', () => {
  const st = freshPlay();
  st.period = 4;
  st.periodGoals = [[0, 0], [0, 0], [0, 0], [0, 0]];
  st.clock = 0.02;
  run(st, Math.ceil(RULES.periodEndTime * 60) + 3);
  assert(phase(st) === 'gameOver' && st.winner === 'tie', `tie (${phase(st)} ${st.winner})`);
  const st2 = freshPlay();
  st2.period = 3;
  st2.periodGoals = [[1, 0], [0, 0], [0, 0]];
  st2.score = [1, 0];
  st2.clock = 0.02;
  run(st2, Math.ceil(RULES.periodEndTime * 60) + 3);
  assert(phase(st2) === 'gameOver' && st2.winner === 0, 'home wins in regulation');
});

test('flow: rematch resets everything with a short intro', () => {
  const st = freshPlay();
  st.period = 4;
  st.score = [3, 1];
  st.clock = 0.02;
  run(st, Math.ceil(RULES.periodEndTime * 60) + 3);
  assert(phase(st) === 'gameOver', 'game over');
  run(st, 1, undefined, () => startPad());
  assert(phase(st) === 'gameOver', 'START right at the horn is ignored (final screen guard)');
  run(st, Math.ceil(GAMEOVER_START_GUARD * 60));
  const ev = run(st, 1, undefined, () => startPad());
  assert(ev[0]?.type === 'rematch', 'rematch');
  assert(phase(st) === 'intro' && num(st.score[0]) === 0 && num(st.period) === 1 && st.goals.length === 0 && (st.winner as unknown) === null, 'reset');
  assert(gs(st).introLen === 1.5 && st.autoplay, 'short intro, options kept');
  // exactly one introStart per rematch: the fresh game's first tick announces it
  // (rematch() used to emit one too, so listeners saw two)
  const ev2 = [...ev, ...run(st, 95)];
  assert(ofType(ev2, 'introStart').length === 1, `one introStart (${ofType(ev2, 'introStart').length})`);
  assert(phase(st) === 'faceoff', 'faceoff after 1.5 s');
});

test('flow: intro -> opening faceoff -> play (full AI game start)', () => {
  const st = createGame({ autoplay: true });
  // the opening faceoff holds the lineup up to faceoffOpenerDropMax, then the AI reacts
  const ev = run(st, Math.ceil((RULES.introTime + RULES.faceoffOpenerDropMax + FACEOFF_TIMEOUT) * 60) + 10);
  assert(ev[0]?.type === 'introStart', 'introStart first');
  assert(ofType(ev, 'periodStart')[0]?.period === 1 && ofType(ev, 'faceoffWin').length === 1, 'opening faceoff');
  assert(phase(st) === 'play' && st.clock < RULES.periodLength, 'clock running');
});

test('flow: pause freezes everything; START resumes', () => {
  const st = freshPlay({ human: true });
  st.puck.vel = { x: 5, z: 0 };
  run(st, 1, undefined, () => startPad());
  assert(st.paused, 'paused');
  const t = st.tick;
  const c = st.clock;
  const x = st.puck.pos.x;
  run(st, 60);
  assert(st.tick === t && st.clock === c && st.puck.pos.x === x, 'frozen');
  run(st, 1, undefined, () => startPad());
  assert(!st.paused, 'unpaused');
  run(st, 5);
  assert(st.tick > t && st.clock < c, 'running again');
});

// ---------------------------------------------------------------- dog ----
test('bark: startles nearby opponents and can make the carrier fumble; cooldown', () => {
  setRandom(() => 0.01);
  const st = freshPlay();
  const dog = st.skaters[0];
  const brick = st.skaters[5];
  place(dog, 0, 0, 0);
  place(brick, 0, 2.0, Math.PI);
  give(st, brick);
  let ev = run(st, 2, (s, i) => {
    if (i === 0) press(dog.intent.turbo);
  });
  const b = ofType(ev, 'bark')[0];
  assert(b && b.skaterId === 0 && b.startled.includes(5), `bark ${JSON.stringify(b)}`);
  assert(ofType(ev, 'fumble')[0]?.skaterId === 5 && st.puck.owner !== 5, 'fumbled');
  assert(brick.stun > 0 && dog.barkCooldown > 2, 'stun + cooldown');
  ev = run(st, 2, (s, i) => {
    if (i === 0) press(dog.intent.turbo);
  });
  assert(ofType(ev, 'bark').length === 0, 'cooldown');
  // kids can't bark
  const josh = st.skaters[1];
  ev = run(st, 2, (s, i) => {
    if (i === 0) press(josh.intent.turbo);
  });
  assert(ofType(ev, 'bark').length === 0, 'only the dog barks');
});

test('bark: an average-handling carrier inside BARK_FUMBLE_RADIUS fumbles ~BARK_FUMBLE_BASE of the time', () => {
  const N = 1500;
  let fumbles = 0;
  for (let i = 0; i < N; i++) {
    const st = freshPlay();
    const dog = st.skaters[0];
    const brick = st.skaters[5];
    brick.attrs = { ...brick.attrs, handling: 0.55 };
    place(dog, 0, 0, 0);
    place(brick, 0, 2.0, Math.PI);
    give(st, brick);
    const ev = run(st, 1, () => press(dog.intent.turbo));
    if (ofType(ev, 'fumble').length) fumbles++;
  }
  const r = fumbles / N;
  assert(near(r, BARK_FUMBLE_BASE, 0.04), `fumble rate ${r.toFixed(3)} vs ${BARK_FUMBLE_BASE}`);
});

test('call for pass/shot: PASS/SHOOT without the puck while a teammate carries', () => {
  const st = freshPlay({ human: true });
  const josh = st.skaters[1];
  place(josh, 0, 0, 0);
  give(st, josh);
  let ev = run(st, 1, undefined, () => {
    const p = emptyPad();
    p.pass = { held: true, pressed: true, released: false };
    return p;
  });
  assert(st.callFor?.kind === 'pass' && st.callFor.from === 0 && st.callFor.carrier === 1, `callFor ${JSON.stringify(st.callFor)}`);
  assert(ofType(ev, 'callFor').length === 1 && ofType(ev, 'check').length === 0, 'event, no body check');
  assert(stateOf(st.skaters[0]) === 'skate', 'the dog did not lunge');
  ev = run(st, 80);
  assert(st.callFor === null, 'expires');
  run(st, 1, undefined, () => {
    const p = emptyPad();
    p.shoot = { held: true, pressed: true, released: false };
    return p;
  });
  assert((st.callFor as { kind: string } | null)?.kind === 'shot', 'call for shot');
  void ev;
});

test('human pad: screen-relative in periods 1 and 2', () => {
  for (const period of [1, 2]) {
    const st = freshPlay({ human: true });
    st.period = period;
    const dog = st.skaters[0];
    place(dog, 0, 0, 0);
    run(st, 30, undefined, () => ({ ...emptyPad(), up: true }));
    const d = attackDir(0, period);
    assert(dog.vel.z * d > 5, `P${period}: up = attack direction (vz ${dog.vel.z.toFixed(1)})`);
    place(dog, 0, 0, 0);
    run(st, 30, undefined, () => ({ ...emptyPad(), right: true }));
    assert(dog.vel.x * -d > 5, `P${period}: right = world -d on x (vx ${dog.vel.x.toFixed(1)})`);
  }
});

test('stuck puck: whistle after nobody touches it for a long time', () => {
  const st = freshPlay();
  st.puck.pos = { x: 0, z: 0 };
  const ev = run(st, 13 * 60);
  assert(ofType(ev, 'whistle').length === 1 && (phase(st) === 'stoppage' || phase(st) === 'faceoff'), 'safety whistle');
});

test('scoring credit: assists from the same-team touch chain', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  touchPuck(st, 2);
  touchPuck(st, 1);
  touchPuck(st, 0);
  loose(st, 0, 23, 0, 15);
  const ev = runUntil(st, 90, (s) => s.phase === 'goal');
  const g = ofType(ev, 'goal')[0].info;
  assert(g.scorer === 0 && g.assists[0] === 1 && g.assists[1] === 2, `credit ${JSON.stringify(g)}`);
  assert(st.skaters[1].stats.assists === 1 && st.skaters[0].stats.goals === 1, 'stats');
  const st2 = freshPlay();
  pullAwayGoalie(st2);
  touchPuck(st2, 1);
  touchPuck(st2, 6); // turnover breaks the chain
  touchPuck(st2, 0);
  loose(st2, 0, 23, 0, 15);
  const g2 = ofType(runUntil(st2, 90, (s) => s.phase === 'goal'), 'goal')[0].info;
  assert(g2.scorer === 0 && g2.assists.length === 0, 'no assist across a turnover');
});

test('off ice: a puck over the glass is whistled dead, faceoff at the nearest dot', () => {
  const st = freshPlay();
  loose(st, 9, 3, 12, 0, 2.6, 2.0);
  let ev = run(st, 30);
  assert(ofType(ev, 'whistle')[0]?.reason === 'offIce' && phase(st) === 'stoppage', 'offIce whistle');
  ev = run(st, Math.ceil(RULES.stoppageTime * 60) + 2);
  const spot = st.faceoff!.spot;
  assert(spot.x === RINK.neutralDot.x && spot.z === RINK.neutralDot.z, `nearest dot ${JSON.stringify(spot)}`);
});

test('goalie: plays a loose puck it picks up (auto-clear) and covers under pressure', () => {
  const st = freshPlay();
  const g = st.skaters[9];
  place(g, 0, 25.3, Math.PI);
  loose(st, 0.2, 24.0, 0, 1.0);
  let ev = run(st, 20);
  assert(st.puck.owner === 9 || ofType(ev, 'pickup').some((e) => e.skaterId === 9), 'goalie picked it up');
  ev = run(st, 90);
  assert(st.puck.owner !== 9 && (ofType(ev, 'pass').some((e) => e.from === 9) || st.puck.lastTouch === 9), 'cleared it');
  assert(stateOf(g).startsWith('g'), `goalie keeps a goalie state (${g.state})`);
  // with an opponent right there it covers instead -> freeze
  const st2 = freshPlay();
  place(st2.skaters[9], 0, 25.3, Math.PI);
  place(st2.skaters[1], 1.5, 23.5, 0);
  loose(st2, 0.2, 24.0, 0, 1.0);
  const ev2 = runUntil(st2, 200, (s) => phase(s) === 'stoppage');
  assert(ofType(ev2, 'whistle')[0]?.reason === 'freeze', 'covered and frozen');
});

test('goal: carrying the puck over the line into an empty net scores', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  const dog = st.skaters[0];
  place(dog, 0, 24, 0);
  give(st, dog);
  dog.intent.move = { x: 0, z: 1 };
  const ev = runUntil(st, 90, (s) => phase(s) === 'goal');
  const g = ofType(ev, 'goal')[0];
  assert(g && g.info.scorer === 0, 'jammed in');
});

test('goal: a puck sliding along the goal line, knocked in by the far post, scores', () => {
  // Partly over the line, sliding sideways: the far post shoves it fully over.
  // The goal test used to use the depth from before the post moved it, so the
  // crossing was never seen and the puck sat in the net in live play.
  const cases = [
    { x: 0.4, dz: 0.03, vx: -8, vz: 0 },
    { x: -0.4, dz: 0.03, vx: 10, vz: 0 },
    { x: -0.4, dz: -0.03, vx: 10, vz: 0.5 },
  ];
  for (const c of cases) {
    const st = freshPlay();
    place(st.skaters[9], 6, 22, Math.PI);
    touchPuck(st, 1);
    loose(st, c.x, RINK.goalLineZ + c.dz, c.vx, c.vz);
    const ev = runUntil(st, 100, (s) => phase(s) !== 'play');
    const d = depthPastLine(st.puck.pos.z, 1);
    assert(ofType(ev, 'goal').length === 1, `${JSON.stringify(c)}: goal (phase ${phase(st)}, puck x=${st.puck.pos.x.toFixed(2)} depth=${d.toFixed(2)})`);
  }
});

test('goal: a puck lying inside the net is a goal; nobody picks it up through the mesh', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  const kid = st.skaters[6];
  place(kid, 0, RINK.goalLineZ - 0.75, 0); // blade reaching over the line onto it
  touchPuck(st, 1);
  loose(st, 0.1, RINK.goalLineZ + 0.25, 0, 0.5);
  const ev = run(st, 1);
  assert(ofType(ev, 'pickup').length === 0 && st.puck.owner === null, `puck inside the net stays loose (owner ${st.puck.owner})`);
  assert(ofType(ev, 'goal').length === 1, 'and counts');
});

test('stuck puck: a long carry does not run the stuck-puck clock (check / fall after 13 s)', () => {
  for (const how of ['check', 'fall']) {
    const st = freshPlay();
    const dog = st.skaters[0];
    place(dog, 0, -5, 0);
    give(st, dog);
    run(st, Math.ceil((STUCK_PUCK_TIME + 1) / SIM_DT), (_s, i) => {
      const a = i / 120;
      dog.intent.move = { x: Math.cos(a) * 0.5, z: Math.sin(a) * 0.5 };
    });
    assert(st.puck.owner === 0 && phase(st) === 'play', `${how}: still carrying`);
    assert(gs(st).noTouchTime < 1, `${how}: clock idle during the carry (${gs(st).noTouchTime.toFixed(1)})`);
    dog.intent.move = { x: 0, z: 0 };
    if (how === 'check') {
      setRandom(() => 0.99); // no penalty call
      const h = st.skaters[6];
      place(h, dog.pos.x - 1, dog.pos.z, 0);
      h.vel = { x: 7, z: 0 };
      applyHit(st, h, dog, { x: 1, z: 0 });
      assert(st.puck.owner === null, 'check knocked it loose');
    } else {
      dog.state = 'fallen';
      dog.stateTime = 0;
    }
    const ev = run(st, 10);
    assert(!ofType(ev, 'whistle').length && phase(st) === 'play', `${how}: no whistle (${ofType(ev, 'whistle').map((w) => w.reason)})`);
    setRandom(mulberry32(12345));
  }
});

test('flow: a goal on the last tick of a period is at 0:00 and goes to the horn, not a faceoff', () => {
  const st = freshPlay();
  pullAwayGoalie(st);
  st.clock = SIM_DT;
  touchPuck(st, 1);
  loose(st, 0, RINK.goalLineZ - 0.2, 0, 20);
  const ev = run(st, 1);
  assert(ofType(ev, 'goal').length === 1 && phase(st) === 'goal', 'goal on the last tick');
  assert(st.clock === 0, `clock ran on the goal tick (${st.clock})`);
  const ev2 = runUntil(st, Math.ceil((RULES.goalCelebrateTime + 1) / SIM_DT), (s) => phase(s) !== 'goal');
  assert(phase(st) === 'periodEnd' && ofType(ev2, 'periodEnd').length === 1, `straight to periodEnd (${phase(st)})`);
  assert(ofType(ev2, 'faceoffSetup').length === 0, 'no faceoff for the last tick');
  // with real time left it is a normal faceoff
  const st2 = freshPlay();
  pullAwayGoalie(st2);
  st2.clock = 5;
  touchPuck(st2, 1);
  loose(st2, 0, RINK.goalLineZ - 0.2, 0, 20);
  run(st2, 1);
  runUntil(st2, Math.ceil((RULES.goalCelebrateTime + 1) / SIM_DT), (s) => phase(s) !== 'goal');
  assert(phase(st2) === 'faceoff' && near(st2.clock, 5 - SIM_DT, 1e-9), `faceoff with time left (${phase(st2)} ${st2.clock})`);
});

test('penalty: box seats never coincide (an offender takes the free seat)', () => {
  const st = freshPlay();
  const seats = () => {
    const boxed = st.skaters.filter((s) => s.state === 'box');
    for (const a of boxed)
      for (const b of boxed) {
        if (a.id < b.id && a.team === b.team) assert(a.pos.x !== b.pos.x || a.pos.z !== b.pos.z, `${a.id} and ${b.id} share a seat`);
      }
  };
  callPenalty(st, mkPenalty(st, 5));
  st.phase = 'play';
  callPenalty(st, mkPenalty(st, 6));
  st.phase = 'play';
  seats();
  // the first one out, a new one in: must not land on 6
  st.penalties.find((p) => p.skaterId === 5)!.remaining = 0.01;
  run(st, 2);
  assert(stateOf(st.skaters[5]) !== 'box', '5 is out');
  callPenalty(st, mkPenalty(st, 7));
  st.phase = 'play';
  seats();
  // a long random sequence of calls and expiries (both teams, queue included)
  const r = mulberry32(7);
  for (let k = 0; k < 300; k++) {
    if (r() < 0.5) {
      const id = [1, 2, 3, 5, 6, 7, 8][Math.floor(r() * 7)];
      callPenalty(st, mkPenalty(st, id, r() < 0.2));
      st.phase = 'play';
    } else if (st.penalties.length) {
      st.penalties[Math.floor(r() * st.penalties.length)].remaining = 0.01;
      run(st, 1);
      st.phase = 'play';
    }
    seats();
    for (const p of st.penalties) assert(p.seat === 0 || p.seat === 1, 'every served penalty has a seat');
  }
});

// ------------------------------------------------------- delayed penalty ----
/** A foul that is certain to be called: applyHit with every roll forced to 0. */
function foulHit(st: GameState, hitter: Skater, victim: Skater, n: { x: number; z: number }): void {
  setRandom(() => 0);
  try {
    applyHit(st, hitter, victim, n);
  } finally {
    setRandom(mulberry32(777));
  }
}
const pendingCount = (st: GameState): number => gs(st).pendingPenalties.length;

test('delayed penalty: play goes on while the fouled team keeps the puck; an offender touch whistles it', () => {
  const st = freshPlay();
  const kid = st.skaters[1];
  const mate = st.skaters[2];
  const mate3 = st.skaters[3];
  const butch = st.skaters[7];
  const kyle = st.skaters[8];
  // kid 1 carries in the offensive zone (home attacks +z in P1); Butch runs his teammate over away from the puck
  place(kid, 2, 15, 0);
  give(st, kid);
  place(mate, -5, 10, 0);
  place(butch, -5, 8.7, 0);
  butch.vel = { x: 0, z: 9 };
  foulHit(st, butch, mate, { x: 0, z: 1 });
  let ev: GameEvent[] = st.events;
  assert(ofType(ev, 'check').length === 1, 'the hit happened');
  const dp = ofType(ev, 'delayedPenalty');
  assert(dp.length === 1 && dp[0].team === 1 && dp[0].skaterId === 7, `delayedPenalty event ${JSON.stringify(dp)}`);
  assert(ofType(ev, 'penalty').length === 0 && ofType(ev, 'whistle').length === 0, 'no call yet');
  assert(phase(st) === 'play' && stateOf(butch) !== 'box', 'play goes on, Butch still on the ice');
  assert(st.delayedPenalty?.team === 1 && st.delayedPenalty.skaterId === 7 && st.delayedPenalty.t === st.time, `state ${JSON.stringify(st.delayedPenalty)}`);
  assert(st.referee.state === 'point', 'the ref points');
  // the fouled team keeps it: carries, and a teammate touches it
  ev = run(st, 60);
  place(mate3, 0, 13, 0);
  give(st, mate3);
  ev.push(...run(st, 60));
  assert(ofType(ev, 'whistle').length === 0 && ofType(ev, 'penalty').length === 0, 'no whistle while the fouled team has it');
  assert(phase(st) === 'play' && st.delayedPenalty?.skaterId === 7 && st.referee.state === 'point', 'still delayed, ref still pointing');
  // an offender (not the hitter) gets his stick on it
  place(kyle, 4, 11, Math.PI);
  const sp = stickPoint(kyle);
  loose(st, sp.x, sp.z, 0, 0);
  ev = runUntil(st, 10, (s) => s.phase !== 'play');
  assert(phase(st) === 'penalty', `whistled (${phase(st)})`);
  const pens = ofType(ev, 'penalty');
  assert(pens.length === 1 && pens[0].penalty.skaterId === 7 && pens[0].penalty.infraction === 'INTERFERENCE', `one call ${JSON.stringify(pens)}`);
  assert(ofType(ev, 'whistle').map((w) => w.reason).join() === 'penalty', 'one penalty whistle');
  assert(stateOf(butch) === 'box' && st.penalties.length === 1 && st.puck.owner === null, 'Butch in the box, puck dead');
  assert(st.delayedPenalty === null && pendingCount(st) === 0, 'delay cleared');
  const x = st.puck.pos.x;
  ev = run(st, Math.ceil(RULES.penaltyBannerTime * 60) + 1);
  const want = defensiveDot(1, 1, x);
  assert(phase(st) === 'faceoff' && st.faceoff!.spot.x === want.x && st.faceoff!.spot.z === want.z && want.z > 0, `offender-zone faceoff ${JSON.stringify(st.faceoff?.spot)}`);
});

test('delayed penalty: 10 s max, dead puck, the horn, offenders with the puck, tangled hitter, fouls called together', () => {
  // (1) the fouled team sits on it: whistled after DELAYED_PENALTY_MAX
  let st = freshPlay();
  place(st.skaters[1], 2, 0, 0);
  give(st, st.skaters[1]);
  delayPenalty(st, mkPenalty(st, 7));
  const t0 = st.time;
  let ev = runUntil(st, 700, (s) => {
    if (s.phase === 'play') assert(s.referee.state === 'point', 'ref points through the delay');
    return s.phase !== 'play';
  });
  assert(phase(st) === 'penalty' && near(st.time - t0, DELAYED_PENALTY_MAX, SIM_DT + 1e-9), `called after ${(st.time - t0).toFixed(3)} s`);
  // (2) puck over the glass during the delay: the penalty, not an offIce stoppage
  st = freshPlay();
  delayPenalty(st, mkPenalty(st, 7));
  loose(st, 9, 3, 12, 0, 2.6, 2.0);
  ev = run(st, 30);
  assert(ofType(ev, 'whistle').map((w) => w.reason).join() === 'penalty' && phase(st) === 'penalty', `whistles ${JSON.stringify(ofType(ev, 'whistle'))}`);
  assert(stateOf(st.skaters[7]) === 'box', 'served');
  run(st, Math.ceil(RULES.penaltyBannerTime * 60) + 1);
  assert(phase(st) === 'faceoff' && st.faceoff!.spot.z > 15, `offender-zone faceoff ${JSON.stringify(st.faceoff?.spot)}`);
  // (3) the clock runs out during the delay: penalty banner at 0:00, then the horn (no faceoff)
  st = freshPlay();
  st.clock = 0.5;
  place(st.skaters[1], 2, 0, 0);
  give(st, st.skaters[1]);
  delayPenalty(st, mkPenalty(st, 7));
  ev = runUntil(st, 60, (s) => s.phase !== 'play');
  assert(phase(st) === 'penalty' && st.clock === 0 && ofType(ev, 'periodEnd').length === 0, `called at the horn (${phase(st)} ${st.clock})`);
  ev = run(st, Math.ceil(RULES.penaltyBannerTime * 60) + 1);
  assert(phase(st) === 'periodEnd' && ofType(ev, 'faceoffSetup').length === 0 && stateOf(st.skaters[7]) === 'box', `then the horn (${phase(st)})`);
  // (4) the offending team has the puck at the foul: whistled at once, no delay
  st = freshPlay();
  give(st, st.skaters[6]);
  st.events = [];
  delayPenalty(st, mkPenalty(st, 7));
  assert(phase(st) === 'penalty' && ofType(st.events, 'delayedPenalty').length === 0 && ofType(st.events, 'penalty').length === 1, 'immediate call');
  assert(st.delayedPenalty === null && stateOf(st.skaters[7]) === 'box', 'no delay left over');
  // (5) the offender is tangled up: he can't collect the puck at his own stick at once
  st = freshPlay();
  const butch = st.skaters[7];
  place(butch, 0, 5, 0);
  delayPenalty(st, mkPenalty(st, 7));
  const bs = stickPoint(butch);
  loose(st, bs.x, bs.z, 0, 0);
  ev = run(st, Math.floor(DELAYED_OFFENDER_TANGLE * 60) - 2);
  assert(phase(st) === 'play' && ofType(ev, 'pickup').length === 0, 'no pickup while tangled');
  ev = runUntil(st, 20, (s) => s.phase !== 'play');
  assert(phase(st) === 'penalty' && ofType(ev, 'pickup')[0]?.skaterId === 7, 'his pickup afterwards ends the delay');
  // (6) a second foul joins the first; both are called together on the offender touch
  st = freshPlay();
  place(st.skaters[1], 2, 0, 0);
  give(st, st.skaters[1]);
  delayPenalty(st, mkPenalty(st, 7));
  const d0 = st.delayedPenalty!;
  run(st, 30);
  st.events = [];
  delayPenalty(st, mkPenalty(st, 6));
  assert(phase(st) === 'play' && pendingCount(st) === 2 && ofType(st.events, 'delayedPenalty')[0]?.skaterId === 6, 'second foul pending');
  assert(st.delayedPenalty!.skaterId === 7 && st.delayedPenalty!.t === d0.t, 'the delay keeps its first foul and start');
  place(st.skaters[8], 2, 3, Math.PI);
  give(st, st.skaters[8]);
  ev = run(st, 1);
  assert(phase(st) === 'penalty', 'called');
  assert(ofType(ev, 'penalty').map((e) => e.penalty.skaterId).join() === '7,6' && ofType(ev, 'whistle').length === 1, 'two calls, one whistle');
  assert(stateOf(st.skaters[7]) === 'box' && stateOf(st.skaters[6]) === 'box' && skatersOnIce(st, 1) === 2, 'both boxed');
  // (7) the fouled team fouls back while it has the puck: everything is called at once
  st = freshPlay();
  place(st.skaters[1], 2, 0, 0);
  give(st, st.skaters[1]);
  delayPenalty(st, mkPenalty(st, 7));
  st.events = [];
  delayPenalty(st, mkPenalty(st, 2));
  assert(phase(st) === 'penalty' && ofType(st.events, 'penalty').length === 2 && stateOf(st.skaters[2]) === 'box' && stateOf(st.skaters[7]) === 'box', 'coincidental calls');
});

test('delayed penalty: a goal by the fouled team wipes out the minor; majors are still served', () => {
  for (const kind of ['minor', 'major', 'both'] as const) {
    const st = freshPlay();
    pullAwayGoalie(st);
    if (kind !== 'major') delayPenalty(st, mkPenalty(st, 7));
    if (kind !== 'minor') delayPenalty(st, mkPenalty(st, 6, true));
    touchPuck(st, 1);
    loose(st, 0, 23, 0, 15);
    let ev = runUntil(st, 90, (s) => s.phase === 'goal');
    const g = ofType(ev, 'goal')[0];
    assert(g && g.info.team === 0 && !g.info.powerPlay, `${kind}: goal ${JSON.stringify(g?.info)}`);
    assert(st.delayedPenalty === null && pendingCount(st) === 0 && phase(st) === 'goal', `${kind}: delay over, goal phase`);
    const called = ofType(ev, 'penalty').map((e) => e.penalty.skaterId);
    assert(stateOf(st.skaters[7]) !== 'box' && st.skaters[7].stats.pim === 0 && !called.includes(7), `${kind}: the minor is gone`);
    if (kind === 'minor') assert(called.length === 0 && st.penalties.length === 0 && !st.penaltyQueue!.length, 'nothing served');
    else {
      assert(called.join() === '6' && stateOf(st.skaters[6]) === 'box', `${kind}: the major is served (${called})`);
      assert(st.penalties.length === 1 && st.penalties[0].major && st.penalties[0].remaining === RULES.majorLength, 'full major');
    }
    ev = run(st, Math.ceil(RULES.goalCelebrateTime * 60) + 1);
    assert(phase(st) === 'faceoff' && st.faceoff!.spot.x === 0 && st.faceoff!.spot.z === 0, `${kind}: center faceoff after the goal`);
    assert(skatersOnIce(st, 1) === (kind === 'minor' ? 4 : 3), `${kind}: away strength`);
  }
});

test('delayed penalty: never outlives live play (full AI games with lots of fouls)', () => {
  // nearly every real hit is called (a normal game has 1-2 penalties)
  const R = RULES as unknown as { penaltyMaxChance: number; penaltyForceMin: number; penaltyCurve: number };
  const saved = { ...R };
  R.penaltyMaxChance = 0.95;
  R.penaltyForceMin = 1.0;
  R.penaltyCurve = 0.3;
  const n = { delays: 0, calls: 0, goalsDuring: 0, phases: new Set<string>() };
  try {
    // at least 4 games, and on until a goal has gone in during a delay (it's a rare coincidence)
    for (let g = 0; g < 4 || (n.goalsDuring === 0 && g < 12); g++) {
      const st = createGame({ autoplay: true });
      for (let i = 0; i < 40 * 3600 && st.phase !== 'gameOver'; i++) {
        const before = pendingCount(st);
        stepGame(st, emptyPad());
        n.delays += ofType(st.events, 'delayedPenalty').length;
        n.calls += ofType(st.events, 'penalty').length;
        if (before && ofType(st.events, 'goal').length) n.goalsDuring++;
        const pend = pendingCount(st);
        if (st.phase !== 'play') {
          n.phases.add(st.phase);
          assert(st.delayedPenalty === null && pend === 0, `g${g} t=${st.time.toFixed(2)}: delayed penalty in phase ${st.phase}`);
        } else assert(!!st.delayedPenalty === pend > 0, `g${g} t=${st.time.toFixed(2)}: delayedPenalty and the pending list disagree`);
        if (st.delayedPenalty) assert(st.time - st.delayedPenalty.t <= DELAYED_PENALTY_MAX + SIM_DT * 1.5, 'delay over the max');
      }
      assert(st.phase === 'gameOver', `game ${g} finished`);
    }
  } finally {
    Object.assign(R, saved);
  }
  assert(n.delays >= 20 && n.calls >= 20 && n.goalsDuring >= 1, `enough fouls to mean something (${n.delays} delayed, ${n.calls} called, ${n.goalsDuring} goals during a delay)`);
  for (const ph of ['faceoff', 'goal', 'stoppage', 'penalty', 'periodEnd', 'intermission', 'gameOver'])
    assert(n.phases.has(ph), `visited ${ph}`);
});

test('intent edge cases: emptyIntent shape, no NaN with zero-length vectors', () => {
  const st = freshPlay();
  for (const s of st.skaters) s.intent = emptyIntent();
  st.skaters[0].intent.move = { x: 0, z: 0 };
  run(st, 30);
  assert(st.skaters.every((s) => Number.isFinite(s.pos.x) && Number.isFinite(s.facing)), 'finite');
  void SIM_DT;
  void (0 as unknown as TeamId);
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('FAILED:\n  ' + failed.join('\n  '));
  process.exitCode = 1;
}
