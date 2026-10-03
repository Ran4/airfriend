// A scripted "human" that plays PAL through the gamepad ONLY (PadState: 8-way
// screen-relative directions + button presses with human-ish reaction times and
// sloppiness), against the real AI. It never touches the game state, it only
// reads it the way a player reads the screen.
//
// Library: newBot() + botPad(state, bot). Runner: tools/ai-human-bot.ts.
//
// skill scales reaction time and decision quality (0.6 = sloppy beginner,
// 1 = decent player, 1.3 = good player).
//
// TURBO is the sprint and the bark: the bot sprints with start/keep hysteresis and holds a
// sprint press at least TURBO_HOLD, so it never taps by accident, and barks only on purpose
// (a fresh press on a carrier within 2.2 m): ~30 barks a game at skill 1, ~21 at 0.6.
import { emptyPad } from '../src/core/input';
import { mulberry32 } from '../src/sim/util';
import { attackDir } from '../src/sim/rink';
import { RINK } from '../src/config';
import type { GameState, PadState, Skater, Vec2 } from '../src/types';

// the bot gets its own RNG so the game RNG stream stays the sim's
let botRng = mulberry32(13);
let skill = 1;
/** Seed the bot's private RNG and set its skill (call before a batch of games). */
export function configureBot(seed: number, sk: number): void {
  botRng = mulberry32(seed * 7919 + 13);
  skill = sk;
}
const r = () => botRng();
const rr = (a: number, b: number) => a + (b - a) * r();

export interface Bot {
  nextDecide: number;
  dir: Vec2; // desired WORLD direction (quantized to 8-way screen dirs when sent)
  shoot: boolean;
  pass: boolean;
  turbo: boolean;
  shootUntil: number; // hold shoot until (windup)
  pokeReady: number;
  checkReady: number;
  barkReady: number;
  callReady: number;
  faceoffPressAt: number;
  sawDropAt: number;
  prevShoot: boolean;
  prevPass: boolean;
  prevTurbo: boolean;
  /** when the turbo button went down (a sprint is held at least TURBO_HOLD) */
  turboAt: number;
}

export const newBot = (): Bot => ({
  nextDecide: 0,
  dir: { x: 0, z: 0 },
  shoot: false,
  pass: false,
  turbo: false,
  shootUntil: -1,
  pokeReady: 0,
  checkReady: 0,
  barkReady: 0,
  callReady: 0,
  faceoffPressAt: -1,
  sawDropAt: -1,
  prevShoot: false,
  prevPass: false,
  prevTurbo: false,
  turboAt: -1,
});

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const unit = (x: number, z: number): Vec2 => {
  const l = Math.hypot(x, z);
  return l > 1e-6 ? { x: x / l, z: z / l } : { x: 0, z: 0 };
};

function decide(st: GameState, me: Skater, b: Bot): void {
  const now = st.time;
  const d = attackDir(0, st.period);
  const goal = { x: 0, z: d * RINK.goalLineZ };
  const own = { x: 0, z: -d * RINK.goalLineZ };
  const p = st.puck;
  const owner = p.owner !== null ? st.skaters[p.owner] : null;
  const opps = st.skaters.filter((s) => s.team === 1 && s.state !== 'box' && s.kind !== 'goalie');
  const nearOpp = opps.reduce((a, s) => Math.min(a, dist(s.pos, me.pos)), 99);
  b.pass = false;
  b.turbo = false;
  b.shoot = now < b.shootUntil;

  if (owner && owner.id === me.id) {
    // ---- I have it: go to the net, shoot from the slot, pass when swarmed
    const dGoal = dist(me.pos, goal);
    const side = me.pos.x >= 0 ? 1 : -1;
    let tgt = { x: side * 2, z: goal.z - d * 6.5 };
    if ((goal.z - me.pos.z) * d < 4) tgt = { x: side * 3, z: goal.z - d * 8 }; // too deep: come back out
    let dir = unit(tgt.x - me.pos.x, tgt.z - me.pos.z);
    // juke a defender straight ahead
    for (const o of opps) {
      const dd = dist(o.pos, me.pos);
      const u = unit(o.pos.x - me.pos.x, o.pos.z - me.pos.z);
      if (dd < 3 && u.x * dir.x + u.z * dir.z > 0.7) {
        const lat = u.x * dir.z - u.z * dir.x;
        const s = lat > 0 ? -1 : 1;
        dir = unit(dir.x * 0.5 + dir.z * s, dir.z * 0.5 - dir.x * s);
      }
    }
    b.dir = dir;
    b.turbo = sprint(b, (me.pos.z - own.z) * d < 30 && nearOpp > 3 && me.stamina > 0.3 && st.skaters[0].barkCooldown > 0, nearOpp > 2);
    // better players are pickier: they skate in closer before letting it go
    if (b.shootUntil < 0 && dGoal < 9.5 + (1 - skill) * 3 && Math.abs(me.pos.x) < 7) {
      // wind up longer with space, snap it off when pressured
      const hold = nearOpp < 2 ? rr(0.05, 0.25) : rr(0.35, 0.85) * Math.min(1.2, skill);
      b.shootUntil = now + hold;
      b.shoot = true;
      // aim: hold toward the far side like a player does
      b.dir = { x: -side * 0.8, z: d * 0.6 };
    } else if (nearOpp < 1.6 && r() < 0.35 * skill) {
      b.pass = true; // swarmed: dump it to a teammate (sim picks by held direction)
      const mates = st.skaters.filter((s) => s.team === 0 && s.id !== me.id && s.kind !== 'goalie' && s.state !== 'box');
      const best = mates.sort((a, c) => openness(st, c) - openness(st, a))[0];
      if (best) b.dir = unit(best.pos.x - me.pos.x, best.pos.z - me.pos.z);
    }
    return;
  }
  b.shootUntil = -1;

  if (owner && owner.team === 0) {
    // ---- teammate has it: get open in the slot and yell for it
    const tgt = { x: owner.pos.x > 0 ? -2.5 : 2.5, z: goal.z - d * 7 };
    b.dir = dist(tgt, me.pos) > 0.8 ? unit(tgt.x - me.pos.x, tgt.z - me.pos.z) : { x: 0, z: 0 };
    b.turbo = sprint(b, dist(tgt, me.pos) > 10 && me.stamina > 0.5 && st.skaters[0].barkCooldown > 0, dist(tgt, me.pos) > 4);
    if (now > b.callReady && dist(me.pos, goal) < 12 && nearOpp > 2 && r() < 0.5) {
      b.pass = true; // "HEY! pass it!"
      b.callReady = now + rr(1.5, 3);
    }
    return;
  }

  if (owner && owner.team === 1 && owner.kind !== 'goalie') {
    // ---- defend: get goal-side of the carrier, then poke / hit / bark
    const dc = dist(owner.pos, me.pos);
    const g = unit(own.x - owner.pos.x, own.z - owner.pos.z);
    const tgt = dc > 3 ? { x: owner.pos.x + g.x * 1.5 + owner.vel.x * 0.3, z: owner.pos.z + g.z * 1.5 + owner.vel.z * 0.3 } : owner.pos;
    b.dir = unit(tgt.x - me.pos.x, tgt.z - me.pos.z);
    b.turbo = sprint(b, dc > 6 && me.stamina > 0.3, dc > 3);
    if (dc < 1.5 && now > b.pokeReady && r() < 0.6 * skill) {
      b.shoot = true;
      b.shootUntil = now + 0.05;
      b.pokeReady = now + rr(0.5, 0.9);
    } else if (dc < 1.9 && now > b.checkReady && r() < 0.15) {
      b.pass = true;
      b.checkReady = now + rr(1.5, 3);
    }
    if (dc < 2.2 && me.barkCooldown <= 0 && now > b.barkReady && r() < 0.5) {
      b.turbo = !b.prevTurbo; // fresh press = bark
      b.barkReady = now + rr(0.5, 1.5);
    }
    return;
  }

  // ---- loose puck (or the goalie has it): go get it
  const lead = 0.35;
  const tgt = { x: p.pos.x + p.vel.x * lead, z: p.pos.z + p.vel.z * lead };
  b.dir = unit(tgt.x - me.pos.x, tgt.z - me.pos.z);
  b.turbo = sprint(b, dist(tgt, me.pos) > 7 && me.stamina > 0.4, dist(tgt, me.pos) > 3);
}

/**
 * Sprinting like a player: press when `start` holds, keep holding while `keep` does (a
 * looser test), and only while there is stamina left. One threshold made the bot's thumb
 * flicker: turbo pressed on one decision and let go on the next (0.12-0.24 s later), which
 * is a quick tap = a BARK nobody meant (~11 a game, mostly chasing loose pucks).
 */
function sprint(b: Bot, start: boolean, keep: boolean): boolean {
  return b.prevTurbo ? keep : start;
}

/** a sprint press is held at least this long (s): longer than BARK_TAP_TIME, so it never taps */
const TURBO_HOLD = 0.35;

function openness(st: GameState, s: Skater): number {
  let d = 99;
  for (const o of st.skaters) if (o.team !== s.team && o.state !== 'box') d = Math.min(d, dist(o.pos, s.pos));
  return d;
}

/** world direction -> 8-way screen pad (up = attack) */
function toPad(st: GameState, w: Vec2, pad: PadState): void {
  const d = attackDir(0, st.period);
  const sx = -d * w.x; // screen right = world -d on x
  const sy = d * w.z;
  const l = Math.hypot(sx, sy);
  if (l < 0.2) return;
  pad.right = sx / l > 0.38;
  pad.left = sx / l < -0.38;
  pad.up = sy / l > 0.38;
  pad.down = sy / l < -0.38;
}

function btn(held: boolean, prev: boolean) {
  return { held, pressed: held && !prev, released: !held && prev };
}

export function botPad(st: GameState, b: Bot): PadState {
  const pad = emptyPad();
  const now = st.time;
  const me = st.skaters[st.controlledId];
  if (st.phase === 'faceoff' && st.faceoff) {
    // wait for the drop, react like a person (sometimes jump it)
    if (st.faceoff.dropped && b.sawDropAt < 0) {
      b.sawDropAt = now;
      b.faceoffPressAt = now + rr(0.16, 0.38) / skill;
    }
    if (!st.faceoff.dropped && st.phaseTime > st.faceoff.dropTime - 0.12 && r() < 0.004) b.faceoffPressAt = now; // false start
    const press = b.faceoffPressAt > 0 && now >= b.faceoffPressAt && now < b.faceoffPressAt + 0.1;
    pad.shoot = btn(press, b.prevShoot);
    b.prevShoot = press;
    return pad;
  }
  b.sawDropAt = -1;
  b.faceoffPressAt = -1;
  if (st.phase !== 'play') {
    pad.shoot = btn(false, b.prevShoot);
    pad.pass = btn(false, b.prevPass);
    pad.turbo = btn(false, b.prevTurbo);
    b.prevShoot = b.prevPass = b.prevTurbo = false;
    // START through intermission and the final screen (also tests those paths)
    if ((st.phase === 'intermission' && st.phaseTime > 2) || st.phase === 'gameOver') pad.start = { held: true, pressed: true, released: false };
    return pad;
  }
  if (now >= b.nextDecide) {
    decide(st, me, b);
    b.nextDecide = now + rr(0.12, 0.24) / skill;
  }
  if (b.shootUntil > 0 && now >= b.shootUntil) b.shoot = false;
  // a held sprint isn't let go within TURBO_HOLD (a bark press is a press, not a tap: it
  // barks on the way down, so holding it on changes nothing)
  if (b.turbo && !b.prevTurbo) b.turboAt = now;
  if (!b.turbo && b.prevTurbo && now - b.turboAt < TURBO_HOLD) b.turbo = true;
  toPad(st, b.dir, pad);
  pad.shoot = btn(b.shoot, b.prevShoot);
  pad.pass = btn(b.pass, b.prevPass);
  pad.turbo = btn(b.turbo, b.prevTurbo);
  b.prevShoot = b.shoot;
  b.prevPass = b.pass;
  b.prevTurbo = b.turbo;
  // buttons are taps unless deliberately held
  b.pass = false;
  return pad;
}

