// Shot lab: PAL (human pad) against IGOR (AI goalie, set) with every other
// skater parked, many seeded trials per row. Measures the human shooting
// model: corner aim, charge-based height, UP-while-skating-in, one-timers
// (early SHOOT, long hold, range limit) and PASS/SHOOT while a pass is in
// flight. Prints the rate per row and PASS/FAIL against the tuning targets.
//
//   ./node_modules/.bin/tsx tools/sim-shotlab.ts [trials=300] [section]
//   sections: shots | approach | onetimer | buttons | all (default)

import { emptyPad } from '../src/core/input';
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, rand, setRandom } from '../src/sim/util';
import type { GameState, PadState } from '../src/types';

const N = Number(process.argv[2] ?? 300);
const which = process.argv[3] ?? 'all';
const on = (s: string) => which === 'all' || which === s;
const GL = 26.5; // period 1: HOME attacks +z; screen LEFT = world +x

type Dir = { up?: boolean; down?: boolean; left?: boolean; right?: boolean };
const B = (h: boolean, prev: boolean) => ({ held: h, pressed: h && !prev, released: !h && prev });
function P(d: Dir, shoot?: [boolean, boolean], pass?: [boolean, boolean]): PadState {
  const p = emptyPad();
  Object.assign(p, { up: !!d.up, down: !!d.down, left: !!d.left, right: !!d.right });
  if (shoot) p.shoot = B(shoot[0], shoot[1]);
  if (pass) p.pass = B(pass[0], pass[1]);
  return p;
}
function play(): GameState {
  const st = createGame({ autoplay: false, ai: true });
  st.phase = 'play';
  st.tick = 100;
  st.referee.state = 'skate';
  return st;
}
/** park everyone but PAL, the goalies and the listed helpers */
function freeze(st: GameState, keep: number[] = []) {
  for (const s of st.skaters) {
    if (s.kind === 'goalie' || s.id === 0 || keep.includes(s.id)) continue;
    s.pos = { x: s.team ? 12 : -12, z: -20 + s.id };
    s.vel = { x: 0, z: 0 };
  }
}
/** what the shot did: goal / catch / save, else post (rang iron, stayed out) or miss */
function outcome(st: GameState, n = 90): string {
  let post = false;
  for (let i = 0; i < n; i++) {
    freeze(st);
    stepGame(st, P({}));
    for (const e of st.events) {
      if (e.type === 'goal') return 'goal';
      if (e.type === 'save') return e.caught ? 'catch' : 'save';
      if (e.type === 'post') post = true;
    }
    if (st.phase !== 'play') return 'dead';
  }
  return post ? 'post' : 'miss';
}

interface Row {
  label: string;
  rate: number;
  tally: Record<string, number>;
}
function run(label: string, f: (seed: number) => string, n = N, key = 'goal'): Row {
  const tally: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const r = f(7000 + i);
    tally[r] = (tally[r] ?? 0) + 1;
  }
  const rate = (tally[key] ?? 0) / n;
  console.log(`${label.padEnd(58)} ${key} ${(rate * 100).toFixed(1).padStart(5)}%  ${JSON.stringify(tally)}`);
  return { label, rate, tally };
}
const results: string[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
}
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

// ---------------------------------------------------------- standing shots ----
/** PAL stands at (x, out m from the line) with the puck; the goalie sets for 0.7 s; then SHOOT is held `hold` ticks. */
function standShot(seed: number, x: number, out: number, hold: number, aim: Dir): string {
  setRandom(mulberry32(seed));
  const st = play();
  const d = st.skaters[0];
  for (let i = 0; i < 42; i++) {
    freeze(st);
    d.pos = { x, z: GL - out };
    d.vel = { x: 0, z: 0 };
    d.facing = Math.atan2(-x, out);
    st.puck.owner = 0;
    stepGame(st, P({}));
  }
  let prev = false;
  for (let i = 0; i <= hold + 1; i++) {
    const h = i <= hold;
    freeze(st);
    stepGame(st, P(aim, [h, prev]));
    prev = h;
    if (st.puck.owner !== 0 && h) break;
  }
  return outcome(st);
}
/** a slot spot 5-7 m out, |x| <= 1, picked from the seed */
function slot(seed: number): { x: number; out: number; side: Dir } {
  setRandom(mulberry32(seed * 7919 + 13));
  const x = (rand() * 2 - 1) * 1.0;
  const out = 5 + rand() * 2;
  // aim at the far side of the shooter's position half the time, the near side the other half
  const side: Dir = rand() < 0.5 ? { left: true } : { right: true };
  return { x, out, side };
}

if (on('shots')) {
  console.log(`== standing shots vs a set IGOR (${N} trials per row) ==`);
  const tapSide = run('slot 5-7 m, TAP, side held', (sd) => {
    const s = slot(sd);
    return standShot(sd, s.x, s.out, 0, s.side);
  });
  run('slot 5-7 m, TAP, no direction', (sd) => {
    const s = slot(sd);
    return standShot(sd, s.x, s.out, 0, {});
  });
  const halfSide = run('slot 5-7 m, HALF windup, side held', (sd) => {
    const s = slot(sd);
    return standShot(sd, s.x, s.out, 27, s.side);
  });
  run('slot 5-7 m, HALF windup, no direction', (sd) => {
    const s = slot(sd);
    return standShot(sd, s.x, s.out, 27, {});
  });
  run('slot 5-7 m, FULL windup, side held', (sd) => {
    const s = slot(sd);
    return standShot(sd, s.x, s.out, 54, s.side);
  });
  run('slot 5-7 m, FULL windup, no direction', (sd) => {
    const s = slot(sd);
    return standShot(sd, s.x, s.out, 54, {});
  });
  run('10 m, TAP, side held', (sd) => standShot(sd, 0, 10, 0, sd % 2 ? { left: true } : { right: true }));
  run('10 m, FULL windup, side held', (sd) => standShot(sd, 0, 10, 54, sd % 2 ? { left: true } : { right: true }));
  run('14 m, FULL windup, side held', (sd) => standShot(sd, 0, 14, 54, sd % 2 ? { left: true } : { right: true }));
  run('bad angle (x=6, 5 m), HALF, side held', (sd) => standShot(sd, 6, 5, 27, sd % 2 ? { left: true } : { right: true }));
  run('slot, TAP, UP held (standing)', (sd) => {
    const s = slot(sd);
    return standShot(sd, s.x, s.out, 0, { up: true });
  });
  check('corner-aimed tap from the slot 15-25%', tapSide.rate >= 0.15 && tapSide.rate <= 0.25, pct(tapSide.rate));
  check('half windup with a side held 30-45%', halfSide.rate >= 0.3 && halfSide.rate <= 0.45, pct(halfSide.rate));
}

// ------------------------------------------------------------ skating in ----
/** PAL skates in from 14 m at ~8 m/s holding UP, then shoots at `out` m holding `aim` (UP kept or released). */
function rushShot(seed: number, out: number, hold: number, aim: Dir): string {
  setRandom(mulberry32(seed));
  const st = play();
  const d = st.skaters[0];
  const x = ((seed % 5) - 2) * 0.4;
  for (let i = 0; i < 40; i++) {
    freeze(st);
    d.pos = { x, z: GL - 14 };
    d.vel = { x: 0, z: 0 };
    d.facing = 0;
    st.puck.owner = 0;
    stepGame(st, P({}));
  }
  d.vel = { x: 0, z: 8 };
  // the windup is released at `out`, so it starts earlier for longer holds
  const startZ = GL - out - hold * (1 / 60) * 7.5;
  for (let i = 0; i < 200 && d.pos.z < startZ; i++) {
    freeze(st);
    stepGame(st, P({ up: true }));
    if (st.puck.owner !== 0) return 'lost';
  }
  let prev = false;
  for (let i = 0; i <= hold + 1; i++) {
    const h = i <= hold;
    freeze(st);
    stepGame(st, P(aim, [h, prev]));
    prev = h;
    if (st.puck.owner !== 0 && h) break;
  }
  return outcome(st);
}

if (on('approach')) {
  console.log(`== skating in with UP, shooting with / without UP (${N} trials per row) ==`);
  for (const out of [6, 10]) {
    for (const [lbl, hold] of [
      ['TAP', 0],
      ['HALF', 27],
      ['FULL', 54],
    ] as const) {
      const a = run(`rush, shot at ${out} m, ${lbl}, keep UP held`, (sd) => rushShot(sd, out, hold, { up: true }));
      const b = run(`rush, shot at ${out} m, ${lbl}, no direction`, (sd) => rushShot(sd, out, hold, {}));
      // two binomial samples of N: allow ~3 sigma of noise
      const sig = Math.sqrt((Math.max(0.02, (a.rate + b.rate) / 2) * (1 - (a.rate + b.rate) / 2) * 2) / N);
      check(`UP vs none, ${lbl} at ${out} m`, Math.abs(a.rate - b.rate) <= Math.max(0.04, 3 * sig), `${pct(a.rate)} vs ${pct(b.rate)}`);
    }
  }
}

// ------------------------------------------------------------ one-timers ----
interface OtCfg {
  /** PAL's spot (period 1 world coords); the pass comes from JOSH at (-7, 23) unless `from` */
  pal: { x: number; z: number };
  from?: { x: number; z: number };
  /** SHOOT press tick relative to the reception tick measured on a dry run (negative = before) */
  pressAt: number;
  /** press SHOOT the tick after JOSH's pass leaves instead (long feeds: SHOOT held the whole way) */
  pressOnPass?: boolean;
  /** with pressOnPass: seconds SHOOT counts as already held when the pass leaves (a feed of
   *  <= DOG_FEED_MAX 18 m arrives in ~1 s, too soon to hold 1.2 s from the pass alone) */
  heldBefore?: number;
  /** release SHOOT this many ticks after reception (Infinity = keep holding to the end) */
  releaseAfter?: number;
  aim?: Dir;
  facePasser?: boolean;
  /** press SHOOT once the pass is this close to PAL (the reviewer's qa-feel-dbg4 repro) */
  pressNear?: number;
}
interface OtResult {
  received: boolean;
  swatted: boolean;
  shotTick: number | null; // tick of PAL's shot relative to reception
  goal: boolean;
  passed: boolean;
}
/** Dry run: when does PAL receive JOSH's called-for pass? */
function otRun(seed: number, c: OtCfg, dry: boolean, recvTick: number): OtResult & { recv: number; heldTicks: number } {
  setRandom(mulberry32(seed));
  const st = play();
  const d = st.skaters[0];
  const j = st.skaters[1];
  const from = c.from ?? { x: -7, z: 23 };
  const pin = () => {
    freeze(st, [1]);
    if (!passed) {
      j.pos = { ...from };
      j.vel = { x: 0, z: 0 };
      st.puck.owner = 1;
    }
    d.pos = { ...c.pal };
    d.vel = { x: 0, z: 0 };
  };
  let passed = false;
  let recv = -1;
  let swatted = false;
  let shotTick: number | null = null;
  let goal = false;
  // facing up ice (the reviewer's repro), or with the blade turned to the passer
  d.facing = c.facePasser ? Math.atan2(from.x - c.pal.x, from.z - c.pal.z) : 0;
  for (let i = 0; i < 3; i++) {
    pin();
    stepGame(st, P({}));
  }
  let prevS = false;
  let prevP = false;
  let passTick = -1;
  for (let i = 0; i < 200; i++) {
    pin();
    const call = i === 0;
    let shoot = false;
    if (!dry && recvTick >= 0) {
      const rAfter = c.releaseAfter ?? 0;
      const near = Math.hypot(st.puck.pos.x - d.pos.x, st.puck.pos.z - d.pos.z);
      const pressed: boolean = c.pressNear
        ? passTick >= 0 && (near < c.pressNear || prevS)
        : c.pressOnPass
          ? passTick >= 0 && i > passTick
          : i - recvTick >= c.pressAt;
      shoot = pressed && (recv < 0 || i - recv < rAfter);
      if (shoot && !prevS && c.pressOnPass && c.heldBefore) d.sim!.shootHeldTime = c.heldBefore;
    }
    stepGame(st, P(c.aim ?? {}, [shoot, prevS], [call, prevP]));
    prevS = shoot;
    prevP = call;
    for (const e of st.events) {
      if (e.type === 'pass' && e.from === 1 && !passed) {
        passed = true;
        passTick = i;
      }
      if (e.type === 'pickup' && e.skaterId === 0 && recv < 0) recv = i;
      if (e.type === 'poke' && e.skaterId === 0 && e.success && recv < 0) swatted = true;
      if (e.type === 'shot' && e.shooter === 0 && shotTick === null) shotTick = i - (recv >= 0 ? recv : i);
      if (e.type === 'goal') goal = true;
    }
    if (dry && recv >= 0) break;
    if (goal || st.phase !== 'play') break;
    if (!dry && shotTick !== null && i > recv + 90) break;
    if (passed && i - passTick > 150) break;
  }
  const heldTicks = passTick >= 0 && recv >= 0 ? recv - passTick - 1 + Math.round((c.heldBefore ?? 0) * 60) : 0;
  return { received: recv >= 0, swatted, shotTick, goal, passed, recv, heldTicks };
}
function oneTimer(seed: number, c: OtCfg): (OtResult & { heldTicks: number }) | null {
  const dry = otRun(seed, c, true, -1);
  if (!dry.passed || !dry.received) return null;
  return otRun(seed, c, false, dry.recv);
}

if (on('onetimer')) {
  console.log(`== one-timers: JOSH feeds PAL on a called-for pass (${N} trials per row) ==`);
  const slotCfg = { pal: { x: 1.5, z: 19.5 } };
  // (1) SHOOT pressed 0.2 s early, held into the reception: must not poke the pass away
  let ok = 0;
  let swat = 0;
  let fired = 0;
  let goals = 0;
  let valid = 0;
  for (let i = 0; i < N; i++) {
    // SHOOT goes down 0.07-0.25 s before the puck reaches the blade (the poke
    // would resolve 0.08 s after the press, with the pass within reach)
    const r = oneTimer(7000 + i, {
      ...slotCfg,
      pressAt: -4 - (i % 12),
      releaseAfter: 30,
      aim: i % 2 ? { left: true } : { right: true },
      facePasser: i % 3 === 0,
    });
    if (!r) continue;
    valid++;
    if (r.received || (r.shotTick !== null && !r.swatted)) ok++;
    if (r.swatted) swat++;
    if (r.shotTick !== null && r.shotTick <= 1) fired++;
    if (r.goal) goals++;
  }
  console.log(`early SHOOT (0.07-0.25 s early), slot 7 m: received ${ok}/${valid}, swatted ${swat}, instant one-timer ${fired}, goals ${goals}`);
  check('one-timer pressed up to 0.25 s early is received (>= 90%), never swatted', valid > 0 && ok / valid >= 0.9 && swat === 0, `${ok}/${valid} received, ${swat} swatted`);
  check('one-timer pressed up to 0.25 s early fires on reception in the slot', valid > 0 && fired / valid >= 0.85, `${fired}/${valid}`);

  // (1b) the reviewer's repro: SHOOT goes down as the pass comes within 2.5 m
  let nOk = 0;
  let nSwat = 0;
  let nValid = 0;
  for (let i = 0; i < N; i++) {
    const r = oneTimer(7000 + i, { ...slotCfg, pressAt: 0, pressNear: 2.5, releaseAfter: 30 });
    if (!r) continue;
    nValid++;
    if (r.received) nOk++;
    if (r.swatted) nSwat++;
  }
  console.log(`SHOOT as the pass comes within 2.5 m: received ${nOk}/${nValid}, swatted ${nSwat}`);
  check('one-timer pressed as the pass nears is received (>= 90%), never swatted', nValid > 0 && nOk / nValid >= 0.9 && nSwat === 0, `${nOk}/${nValid} received, ${nSwat} swatted`);

  // (2) SHOOT held >= 1.2 s before reception: windup on pickup, the release shoots
  let held = 0;
  let heldShot = 0;
  let heldEarly = 0;
  for (let i = 0; i < Math.min(N, 200); i++) {
    // a feed from JOSH in the neutral zone: SHOOT goes down as the pass leaves, counted as held 1.2 s already
    const r = oneTimer(7000 + i, { pal: { x: 1.5, z: 19.5 }, from: { x: -4, z: 5 }, pressOnPass: true, heldBefore: 1.2, pressAt: 0, releaseAfter: 20 });
    // the pass itself (not a late pickup of a missed pass; those run out of trial ticks)
    if (!r || !r.received || r.heldTicks < 72 || r.heldTicks > 72 + 90) continue;
    held++;
    if (r.shotTick !== null && r.shotTick >= 19 && r.shotTick <= 22) heldShot++;
    if (r.shotTick !== null && r.shotTick < 19) heldEarly++;
  }
  console.log(`SHOOT held >= 1.2 s before reception, released 20 ticks after: ${heldShot}/${held} shot on release, ${heldEarly} early`);
  check('held >= 1.2 s one-timer shoots on release', held > 0 && heldShot === held, `${heldShot}/${held}`);

  // (3) beyond 18 m: no automatic one-timer; the release shoots
  let far = 0;
  let farAuto = 0;
  let farRel = 0;
  for (let i = 0; i < Math.min(N, 200); i++) {
    const r = oneTimer(7000 + i, { pal: { x: 2, z: 6 }, from: { x: -6, z: 0 }, pressAt: -12, releaseAfter: 15 });
    if (!r || !r.received) continue;
    far++;
    if (r.shotTick !== null && r.shotTick < 14) farAuto++;
    if (r.shotTick !== null && r.shotTick >= 14 && r.shotTick <= 17) farRel++;
  }
  console.log(`one-timer attempt from ~20 m (neutral zone): ${farAuto}/${far} auto-fired, ${farRel} shot on release`);
  check('no automatic one-timer beyond 18 m', far > 0 && farAuto === 0, `${farAuto}/${far} auto`);
  check('beyond 18 m the release still shoots', far > 0 && farRel === far, `${farRel}/${far}`);
}

// ------------------------------------------------- buttons, pass in flight ----
if (on('buttons')) {
  console.log(`== PASS / SHOOT while a teammate's pass is in flight (${N} trials) ==`);
  let checks = 0;
  let pokes = 0;
  let trials = 0;
  for (let i = 0; i < N; i++) {
    setRandom(mulberry32(7000 + i));
    const st = play();
    const d = st.skaters[0];
    const j = st.skaters[1];
    let passed = false;
    const pin = () => {
      freeze(st, [1]);
      if (!passed) {
        j.pos = { x: -7, z: 10 };
        j.vel = { x: 0, z: 0 };
        st.puck.owner = 1;
      }
      d.pos = { x: 2, z: 14 };
      d.vel = { x: 0, z: 0 };
    };
    for (let k = 0; k < 3; k++) {
      pin();
      stepGame(st, P({}));
    }
    let prevP = false;
    let prevS = false;
    let pt = -1;
    for (let k = 0; k < 120; k++) {
      pin();
      // call for it, then mash X (and Z on odd trials) while the pass travels
      const relP = pt >= 0 ? k - pt : -1;
      const x = k === 0 || (relP >= 1 && relP <= 30 && relP % 4 === 1);
      const z = i % 2 === 1 && relP >= 1 && relP <= 30 && relP % 4 === 3;
      stepGame(st, P({ up: true }, [z, prevS], [x, prevP]));
      prevP = x;
      prevS = z;
      for (const e of st.events) if (e.type === 'pass' && e.from === 1 && !passed) (passed = true), (pt = k);
      if (passed && st.puck.owner === null && relP >= 0) {
        if (d.state === 'check') checks++;
        if (d.state === 'poke') pokes++;
      }
      if (st.puck.owner === 0 || (passed && relP > 40)) break;
    }
    if (passed) trials++;
  }
  console.log(`X/Z mashed during ${trials} passes in flight: check ticks ${checks}, poke ticks ${pokes}`);
  check('X during a teammate pass in flight never starts a check', trials > 0 && checks === 0, `${checks} check ticks`);
  check('Z during a teammate pass in flight never pokes', trials > 0 && pokes === 0, `${pokes} poke ticks`);
}

console.log('\n' + results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
