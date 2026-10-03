// AI scenario tests (deterministic, seeded). Each test sets up a situation and
// checks that the AI responds the way the design asks.
//   npx tsx tools/ai-tests.ts [filter]
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { carryPoint, stickPoint } from '../src/sim/query';
import { touchPuck } from '../src/sim/puckops';
import { mulberry32, setRandom } from '../src/sim/util';
import { aiMem } from '../src/ai/memory';
import { OPEN_READ, SHARP_READ, passRisk } from '../src/ai/util';
import { PASS_WAIT } from '../src/ai/skater';
import type { GameState, PadState, Vec2 } from '../src/types';

const filter = process.argv[2] ?? '';
let passed = 0;
let failed = 0;
function test(name: string, fn: () => string | true): void {
  if (filter && !name.includes(filter)) return;
  setRandom(mulberry32(42));
  let res: string | true;
  try {
    res = fn();
  } catch (e) {
    res = `threw ${(e as Error).stack}`;
  }
  if (res === true) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}: ${res}`);
  }
}

/** A game in phase 'play' (period 1: HOME attacks +z) with the listed skaters on the ice. */
function scene(onIce: number[], autoplay = false): GameState {
  const st = createGame({ autoplay });
  st.phase = 'play';
  st.tick = 100;
  st.time = 10;
  for (const s of st.skaters) if (!onIce.includes(s.id)) s.state = 'box';
  return st;
}
function give(st: GameState, id: number, pos: Vec2, facing = 0): void {
  const s = st.skaters[id];
  s.pos = { ...pos };
  s.facing = facing;
  st.puck.owner = id;
  st.puck.pos = carryPoint(s, st.time);
  touchPuck(st, id);
}
const step = (st: GameState, n: number, pad: (i: number) => PadState = () => emptyPad()) => {
  for (let i = 0; i < n; i++) stepGame(st, pad(i));
};
const press = (b: 'pass' | 'shoot') => (i: number): PadState => {
  const p = emptyPad();
  if (i === 0) p[b] = { held: true, pressed: true, released: false };
  if (i === 1) p[b] = { held: false, pressed: false, released: true };
  return p;
};

// ---------------------------------------------------------------------------

test('call for pass: with a clean lane the carrier feeds the dog within ~0.35 s (most of the time)', () => {
  // (the two Blizzard wingers start right in this lane; the next test is that case)
  let ok = 0;
  const N = 30;
  for (let t = 0; t < N; t++) {
    const st = scene([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    give(st, 1, { x: -6 + Math.random() * 3, z: 2 });
    st.skaters[0].pos = { x: 3, z: 14 + Math.random() * 4 };
    st.skaters[7].pos = { x: -9, z: 9 };
    st.skaters[8].pos = { x: 9, z: 8 };
    let when = -1;
    const t0 = st.time;
    for (let i = 0; i < 40 && when < 0; i++) {
      stepGame(st, press('pass')(i));
      for (const e of st.events) if (e.type === 'pass' && e.from === 1 && e.to === 0) when = st.time - t0;
    }
    if (when >= 0 && when <= 0.4) ok++;
  }
  return ok >= N * 0.8 ? true : `only ${ok}/${N} called-for passes went to the dog in time`;
});

test('call for pass into a shadowed lane: no forced feed; the kid gives up, carries on, and feeds once it opens', () => {
  // a Blizzard D stands between PAL and the carrier, 1.5 m off PAL: the old AI forced
  // the pass after 0.9 s (picked off); now the kid keeps it, and a fresh call goes once the
  // defender is gone
  let forced = 0;
  let gaveUp = 0;
  let fedLater = 0;
  const N = 20;
  for (let t = 0; t < N; t++) {
    const st = scene([0, 1, 4, 7, 9]);
    give(st, 1, { x: -5 + Math.random() * 2, z: -2 });
    const pal = st.skaters[0];
    pal.pos = { x: 3, z: 12 + Math.random() * 3 };
    const d7 = st.skaters[7];
    const pin = () => {
      const c = st.skaters[1].pos;
      const L = Math.hypot(pal.pos.x - c.x, pal.pos.z - c.z);
      d7.pos = { x: pal.pos.x + ((c.x - pal.pos.x) / L) * 1.5, z: pal.pos.z + ((c.z - pal.pos.z) / L) * 1.5 };
      d7.vel = { x: 0, z: 0 };
      d7.facing = Math.atan2(c.x - d7.pos.x, c.z - d7.pos.z);
    };
    const n1 = Math.round((PASS_WAIT + 0.3) * 60);
    for (let i = 0; i < n1; i++) {
      pin();
      stepGame(st, press('pass')(i));
      for (const e of st.events) if (e.type === 'pass' && e.from === 1 && e.to === 0) forced++;
    }
    const b = aiMem(st).brains[1];
    if (st.puck.owner === 1 && !(b.plan === 'pass' && b.passTo === 0)) gaveUp++;
    // the defender leaves; PAL calls again
    d7.pos = { x: -11, z: -22 };
    let fed = false;
    for (let i = 0; i < 30 && !fed; i++) {
      stepGame(st, press('pass')(i));
      for (const e of st.events) if (e.type === 'pass' && e.from === 1 && e.to === 0) fed = true;
    }
    if (fed) fedLater++;
  }
  if (forced) return `${forced}/${N} passes forced into the shadowed lane`;
  if (gaveUp < N * 0.9) return `only ${gaveUp}/${N} gave the feed up and kept the puck`;
  return fedLater >= N * 0.8 ? true : `only ${fedLater}/${N} fed PAL once the lane opened`;
});

test('pass risk: a sharp read sees a shadowing defender and a blade already on the path', () => {
  const st = scene([0, 1, 4, 5, 9]);
  give(st, 1, { x: 0, z: 5 });
  const pal = st.skaters[0];
  pal.pos = { x: 0, z: 15 };
  pal.vel = { x: 0, z: 0 };
  const d = st.skaters[5];
  const risk = (read: typeof SHARP_READ) => passRisk(st, st.puck.pos, pal, 0, read);
  // the blade case: his body is off the line, his stick is on it, right by the passer
  d.pos = { x: 1.1, z: 6.6 };
  d.vel = { x: 0, z: 0 };
  d.facing = -Math.PI / 2;
  const bladeSharp = risk(SHARP_READ);
  const bladeOpen = risk(OPEN_READ);
  if (!(bladeSharp >= 0.99 && bladeOpen < 0.5)) return `blade on the path: sharp ${bladeSharp.toFixed(2)}, open ${bladeOpen.toFixed(2)}`;
  // shadowing: 1.6 m in front of PAL, a step off the line, standing still facing the passer
  d.pos = { x: 1.1, z: 13.6 };
  d.facing = Math.PI;
  const sh = risk(SHARP_READ);
  if (sh < 0.99) return `shadowing defender: sharp risk ${sh.toFixed(2)}`;
  // and nobody near the lane is no risk
  d.pos = { x: 9, z: 9 };
  const clear = risk(SHARP_READ);
  return clear < 0.05 ? true : `clear lane: ${clear.toFixed(2)}`;
});

test('puck protection: a Blizzard carrier tucks the puck away from a stick reaching in from the side', () => {
  let ok = 0;
  let farther = 0;
  const N = 20;
  for (let t = 0; t < N; t++) {
    const st = scene([0, 4, 6, 9]);
    const side = t % 2 ? 1 : -1;
    give(st, 6, { x: side * 2, z: 6 }, Math.PI); // skating at the home net (-z)
    const c = st.skaters[6];
    c.vel = { x: 0, z: -4 };
    const pal = st.skaters[0];
    for (let i = 0; i < 30; i++) {
      // PAL hangs on his shoulder, stick at the puck
      const f = { x: Math.sin(c.facing), z: Math.cos(c.facing) };
      const r = { x: -f.z * side, z: f.x * side };
      pal.pos = { x: c.pos.x + r.x * 1.35 + f.x * 0.3, z: c.pos.z + r.z * 1.35 + f.z * 0.3 };
      pal.vel = { ...c.vel };
      pal.facing = Math.atan2(st.puck.pos.x - pal.pos.x, st.puck.pos.z - pal.pos.z);
      stepGame(st, emptyPad());
    }
    if (st.puck.owner !== 6) continue;
    const sh = c.intent.shield ?? 0;
    // PAL is on the carrier's `side` (rightOf * side): the puck should go the other way
    const sp = stickPoint(pal);
    const tucked = carryPoint(c, st.time);
    const save = c.intent.shield;
    c.intent.shield = undefined;
    const plain = carryPoint(c, st.time);
    c.intent.shield = save;
    if (Math.abs(sh) > 0.8) ok++;
    if (Math.hypot(tucked.x - sp.x, tucked.z - sp.z) > Math.hypot(plain.x - sp.x, plain.z - sp.z) + 0.25) farther++;
  }
  if (ok < N * 0.8) return `only ${ok}/${N} carriers tucked the puck in`;
  return farther >= N * 0.8 ? true : `only ${farther}/${N} tucks took the puck away from the blade`;
});

test('call for shot: the carrier shoots right away', () => {
  let ok = 0;
  const N = 30;
  for (let t = 0; t < N; t++) {
    const st = scene([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    give(st, 1, { x: -3, z: 16 + Math.random() * 3 });
    st.skaters[0].pos = { x: 4, z: 10 };
    let shot = false;
    for (let i = 0; i < 30 && !shot; i++) {
      stepGame(st, press('shoot')(i));
      for (const e of st.events) if (e.type === 'shot' && e.shooter === 1) shot = true;
    }
    if (shot) ok++;
  }
  return ok >= N * 0.85 ? true : `only ${ok}/${N} called-for shots within 0.5 s`;
});

test('call for shot out of range: no shot from the defensive zone (a pass to the caller, or nothing)', () => {
  // SHOOT is also the poke button: a human mashing it while a kid carries out of
  // his own zone must not make the kid fire from 30-45 m
  let shots = 0;
  let passes = 0;
  const N = 30;
  for (let t = 0; t < N; t++) {
    const st = scene([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    give(st, 1, { x: -7 + Math.random() * 14, z: -20 + Math.random() * 18 });
    st.skaters[0].pos = { x: Math.random() < 0.5 ? -5 : 5, z: st.skaters[1].pos.z + 9 };
    for (const [i, id] of [5, 6, 7, 8].entries()) st.skaters[id].pos = { x: -9 + i * 6, z: 12 };
    for (let i = 0; i < 30; i++) {
      stepGame(st, press('shoot')(i));
      for (const e of st.events) {
        if (e.type === 'shot' && e.shooter === 1) shots++;
        if (e.type === 'pass' && e.from === 1 && e.to === 0) passes++;
      }
    }
  }
  if (shots) return `${shots}/${N} out-of-range calls for a shot were answered with a shot`;
  console.log(`        (${passes}/${N} turned into a pass to the caller)`);
  return true;
});

test('point shot: a Blizzard D at the point with a clear lane shoots; not with a body in the lane', () => {
  // KYLE (away RD) holds the puck at the right point (away attacks -z in period 1). He is
  // pinned there (no walking in), opponents far away, so only the point shot can fire.
  const trial = (blocked: boolean): boolean => {
    const st = scene(blocked ? [0, 4, 8, 9] : [4, 8, 9]);
    const spot = { x: 6 + Math.random() * 2, z: -14 - Math.random() * 2.5 };
    if (blocked) {
      // PAL (human, idle pad) standing in the shooting lane, 6 m out
      const g = { x: 0, z: -26.5 };
      const u = { x: (g.x - spot.x) / Math.hypot(g.x - spot.x, g.z - spot.z), z: (g.z - spot.z) / Math.hypot(g.x - spot.x, g.z - spot.z) };
      st.skaters[0].pos = { x: spot.x + u.x * 6, z: spot.z + u.z * 6 };
      st.skaters[0].barkCooldown = 5;
    }
    give(st, 8, spot, Math.PI);
    for (let i = 0; i < 180; i++) {
      if (st.skaters[8].state !== 'windup' && st.puck.owner === 8) {
        st.skaters[8].pos = { ...spot };
        st.skaters[8].vel = { x: 0, z: 0 };
        st.skaters[8].facing = Math.PI;
      }
      stepGame(st, emptyPad());
      if (st.events.some((e) => e.type === 'shot' && e.shooter === 8)) return true;
      if (st.puck.owner !== 8 && st.skaters[8].state !== 'shoot') return false;
    }
    return false;
  };
  const N = 30;
  let clear = 0;
  let blocked = 0;
  for (let t = 0; t < N; t++) if (trial(false)) clear++;
  for (let t = 0; t < N; t++) if (trial(true)) blocked++;
  if (clear < N * 0.8) return `only ${clear}/${N} clear-lane point shots within 3 s`;
  if (blocked > N * 0.3) return `${blocked}/${N} shots straight into a body in the lane`;
  console.log(`        (clear lane ${clear}/${N}, blocked lane ${blocked}/${N})`);
  return true;
});

test('goalie cuts the angle: settles on the puck-to-goal line, out of the net', () => {
  const spots: Vec2[] = [
    { x: 0, z: -18 },
    { x: 6, z: -20 },
    { x: -7, z: -22 },
    { x: 3, z: -24 },
  ];
  for (const sp of spots) {
    const st = scene([4]);
    st.puck.owner = null;
    st.puck.pos = { ...sp };
    st.puck.vel = { x: 0, z: 0 };
    st.puck.y = 0;
    step(st, 70);
    const g = st.skaters[4];
    const gz = -26.5;
    const out = g.pos.z - gz;
    const ideal = sp.x * (out / (sp.z - gz));
    if (Math.abs(g.pos.x - ideal) > 0.25) return `puck at ${sp.x},${sp.z}: goalie x ${g.pos.x.toFixed(2)} vs ideal ${ideal.toFixed(2)}`;
    if (out < 0.25 || out > 1.6) return `puck at ${sp.x},${sp.z}: goalie depth ${out.toFixed(2)} m`;
  }
  return true;
});

test('goalie hugs the near post when the puck is below the goal line', () => {
  const st = scene([4]);
  st.puck.owner = null;
  st.puck.pos = { x: 4, z: -28.5 };
  st.puck.vel = { x: 0, z: 0 };
  step(st, 70);
  const g = st.skaters[4];
  // (the net frame keeps his 0.5 m body radius off the goal line)
  return g.pos.x > 0.5 && g.pos.x < 0.9 && g.pos.z - -26.5 < 0.6 ? true : `goalie at ${g.pos.x.toFixed(2)}, ${g.pos.z.toFixed(2)}`;
});

test('goalie clears a puck he picked up to an open teammate', () => {
  const st = scene([4, 2, 3, 1]);
  st.skaters[2].pos = { x: -6, z: -18 };
  st.skaters[3].pos = { x: 6, z: -17 };
  st.skaters[1].pos = { x: 0, z: -5 };
  give(st, 4, { x: 0, z: -25.5 });
  let to = -1;
  for (let i = 0; i < 70 && to < 0; i++) {
    stepGame(st, emptyPad());
    for (const e of st.events) if (e.type === 'pass' && e.from === 4) to = e.to ?? -1;
  }
  return to === 1 || to === 2 || to === 3 ? true : `goalie pass target ${to}`;
});

test('shorthanded: the PK collapses into a box around the slot', () => {
  // away killing a penalty (one away skater boxed), home sets up in the away zone
  const st = scene([0, 1, 2, 3, 4, 5, 6, 8, 9], true);
  give(st, 2, { x: 5, z: 17 });
  st.skaters[0].pos = { x: -2, z: 21 };
  st.skaters[1].pos = { x: -6, z: 23 };
  st.skaters[3].pos = { x: -5, z: 17 };
  for (const id of [5, 6, 8]) st.skaters[id].pos = { x: (id - 6) * 3, z: 10 };
  st.penalties.push({ skaterId: 7, team: 1, infraction: 'ROUGHING', duration: 30, remaining: 30, major: false });
  // keep the home carrier's puck glued (we're testing the PK shape, not its forecheck)
  let checked = 0;
  for (let i = 0; i < 120; i++) {
    give(st, 2, { x: 5, z: 17 });
    st.skaters[2].vel = { x: 0, z: 0 };
    stepGame(st, emptyPad());
    const T = aiMem(st).teams[1];
    if (T.mode !== 'defend' || i < 60) continue;
    checked++;
    const boxers = [...T.assign.values()].filter((a) => a.role === 'box');
    if (boxers.length < 2) return `only ${boxers.length} box roles (${[...T.assign.values()].map((a) => a.key).join(',')})`;
    for (const id of [5, 6, 8]) {
      const s = st.skaters[id];
      const a = T.assign.get(id);
      if (i > 100 && a?.role === 'box' && (s.pos.z < 15 || Math.abs(s.pos.x) > 6.5)) return `${s.name} in box role but at ${s.pos.x.toFixed(1)},${s.pos.z.toFixed(1)}`;
    }
  }
  return checked > 30 ? true : 'the PK never read the play as defense';
});

test('defense: someone is goal-side of the carrier (lane) and one man pressures', () => {
  const st = scene([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], true);
  give(st, 5, { x: 3, z: -2 }, Math.PI); // away carrier skating at the home goal
  st.skaters[5].vel = { x: 0, z: -6 };
  for (const [i, id] of [0, 1, 2, 3].entries()) st.skaters[id].pos = { x: -6 + i * 4, z: -10 - (i % 2) * 4 };
  step(st, 40);
  const T = aiMem(st).teams[0];
  const roles = [...T.assign.values()];
  const press = roles.filter((a) => a.role === 'pressure').length;
  const lane = roles.some((a) => a.key === 'lane');
  if (press !== 1) return `${press} pressers`;
  if (!lane) return `no lane defender (${roles.map((a) => a.key).join(',')})`;
  return true;
});

test('defense around a human: an absent human holds no spot, the lane D takes the net front in close', () => {
  // PAL (human) is caught up ice; a Blizzard carrier is 9-11 m from the home net. The AI
  // must not leave the lane spot to a dog 20 m away, and the lane man stands at the doorstep
  const st = scene([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  give(st, 6, { x: 4, z: -17 }, Math.PI);
  st.skaters[6].vel = { x: -1, z: -3 };
  st.skaters[0].pos = { x: -3, z: 6 };
  st.skaters[1].pos = { x: -6, z: -14 };
  st.skaters[2].pos = { x: 2, z: -18 };
  st.skaters[3].pos = { x: -2, z: -20 };
  for (const [i, id] of [5, 7, 8].entries()) st.skaters[id].pos = { x: -6 + i * 5, z: -12 };
  for (let i = 0; i < 20; i++) {
    give(st, 6, { x: 4, z: -17 }, Math.PI);
    st.skaters[0].pos = { x: -3, z: 6 };
    stepGame(st, emptyPad());
  }
  const T = aiMem(st).teams[0];
  const pal = T.assign.get(0);
  if (pal && pal.key !== 'human') return `the absent human holds the '${pal.key}' spot`;
  const lane = [...T.assign.entries()].find(([, a]) => a.key === 'lane');
  if (!lane) return `no lane defender (${[...T.assign.values()].map((a) => a.key).join(',')})`;
  if (lane[0] === 0) return 'the lane spot went to the human';
  const r = Math.hypot(lane[1].pos.x, lane[1].pos.z + 26.5);
  return r >= 2.4 && r <= 3.6 ? true : `lane spot ${r.toFixed(1)} m out (want the net front, 2.5-3.5 m)`;
});

test('stability: roles do not flicker, nobody stands still for long, goalies stay home', () => {
  setRandom(mulberry32(5));
  const st = createGame({ autoplay: true });
  const last = new Map<number, { key: string; prev: string; at: number }>();
  let changes = 0;
  let flicker = 0;
  let battles = 0;
  let playTicks = 0;
  const still = new Map<number, number>();
  let worstStill = 0;
  let goalieOut = 0;
  while (st.phase !== 'gameOver') {
    stepGame(st, emptyPad());
    if (st.phase !== 'play') continue;
    playTicks++;
    const mem = aiMem(st);
    for (const s of st.skaters) {
      if (s.kind === 'goalie') {
        const gz = s.team === 0 ? (st.period % 2 === 1 || st.period > 3 ? -26.5 : 26.5) : st.period % 2 === 1 || st.period > 3 ? 26.5 : -26.5;
        if (Math.hypot(s.pos.x, s.pos.z - gz) > 2.6) goalieOut++;
        continue;
      }
      if (s.state === 'box') continue;
      const a = mem.teams[s.team].assign.get(s.id);
      const key = st.puck.owner === s.id ? 'carrier' : a?.role ?? '?';
      const l = last.get(s.id);
      if (l && l.key !== key) {
        changes++;
        // A -> B -> A within 0.3 s is jitter, not a decision. Possession
        // swaps (carrier <-> anything) are puck battles, not role picks: they
        // made this number swing 1.6..3.0 between seeds with the same AI.
        if (key === l.prev && st.time - l.at < 0.3) {
          if (key === 'carrier' || l.key === 'carrier') battles++;
          else flicker++;
        }
        last.set(s.id, { key, prev: l.key, at: st.time });
      } else if (!l) last.set(s.id, { key, prev: '', at: st.time });
      const sp = Math.hypot(s.vel.x, s.vel.z);
      const n = sp < 0.3 ? (still.get(s.id) ?? 0) + 1 : 0;
      still.set(s.id, n);
      worstStill = Math.max(worstStill, n);
    }
  }
  const perMin = changes / 8 / (playTicks / 3600);
  const flickMin = flicker / 8 / (playTicks / 3600);
  if (flickMin > 2) return `${flickMin.toFixed(1)} role flickers (A-B-A < 0.3 s) per skater-minute`;
  if (worstStill > 60 * 6) return `a skater stood still for ${(worstStill / 60).toFixed(1)} s`;
  if (goalieOut / playTicks > 0.03) return `goalies out of the crease area ${((goalieOut / playTicks) * 100).toFixed(1)}% of the time`;
  console.log(`        (${perMin.toFixed(1)} role changes/skater-min, ${flickMin.toFixed(2)} flickers + ${(battles / 8 / (playTicks / 3600)).toFixed(2)} puck battles, longest still ${(worstStill / 60).toFixed(1)} s, goalies out ${((goalieOut / playTicks) * 100).toFixed(2)}%)`);
  return true;
});

test('autoplay dog: barks now and then, not constantly, and only when it startles someone', () => {
  setRandom(mulberry32(9));
  const st = createGame({ autoplay: true });
  let barks = 0;
  let useful = 0;
  let fumbles = 0;
  while (st.phase !== 'gameOver') {
    stepGame(st, emptyPad());
    for (const e of st.events) {
      if (e.type === 'bark') {
        barks++;
        if (e.startled.length) useful++;
      }
      if (e.type === 'fumble') fumbles++;
    }
  }
  // a bark at nobody (a sprint press that happened to bark) is wasted: the AI barks on purpose
  const ok = barks >= 5 && barks <= 30 && useful >= 0.9 * barks;
  return ok ? true : `${barks} barks, ${useful} startled someone (${fumbles} fumbles)`;
});

test('turbo: AI sprints are rare and long, not 1-second pulses', () => {
  // Every rising edge of TURBO is a turboStart (a whoosh). The AI used to start ~7.5
  // sprints per skater-minute, most of them the 1.0 s minimum, as marks hovered around
  // a distance threshold and every deke fired one. Then ~4.2 (~220 a game): a mark beaten
  // by the puck sprinted even when his spot wasn't behind him, a carrier with open ice
  // sprinted wherever he skated. Now a sprint goes somewhere: back to the net, up ice.
  setRandom(mulberry32(11));
  let starts = 0;
  let skaterMin = 0;
  const lens: number[] = [];
  for (let g = 0; g < 2; g++) {
    const st = createGame({ autoplay: true });
    const since = new Array(10).fill(-1);
    while (st.phase !== 'gameOver') {
      stepGame(st, emptyPad());
      for (const e of st.events) if (e.type === 'turboStart') starts++;
      for (const s of st.skaters) {
        if (s.kind === 'goalie') continue;
        if (st.phase === 'play' && s.state !== 'box') skaterMin += 1 / 3600;
        if (s.turboActive && since[s.id] < 0) since[s.id] = st.time;
        if (!s.turboActive && since[s.id] >= 0) {
          lens.push(st.time - since[s.id]);
          since[s.id] = -1;
        }
      }
    }
  }
  lens.sort((a, b) => a - b);
  const rate = starts / skaterMin;
  const med = lens[Math.floor(lens.length / 2)];
  const msg = `${rate.toFixed(2)} sprints per skater-minute, median ${med.toFixed(2)} s`;
  console.log(`        (${msg})`);
  return rate < 3.9 && med >= 1.4 ? true : msg; // (was ~8.3 and 1.0 s, then ~4.2; now ~3.4)
});

test('faceoff and dead-puck phases: AI keeps intents finite and buttons released', () => {
  setRandom(mulberry32(3));
  const st = createGame({ autoplay: true });
  let bad = '';
  while (st.phase !== 'gameOver' && !bad) {
    stepGame(st, emptyPad());
    for (const s of st.skaters) {
      const it = s.intent;
      if (!Number.isFinite(it.move.x) || !Number.isFinite(it.move.z) || Math.hypot(it.move.x, it.move.z) > 1.0001) bad = `bad move for ${s.name}`;
      // (the first faceoff tick still shows the last live intent: the AI doesn't run in stoppages)
      if (st.phase === 'faceoff' && st.phaseTime > 0.05 && (it.shoot.held || it.pass.held)) bad = `${s.name} holds a button in a faceoff`;
    }
  }
  return bad || true;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
