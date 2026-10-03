import { PHYS, RINK } from '../config';
import type { GameState, Skater, TeamId, Vec2 } from '../types';
import { BARK_FUMBLE_RADIUS, BARK_RADIUS, barkWanted } from '../sim/actions';
import { canAct, isGoalie, onIce, skatersOnIce, stickPoint } from '../sim/query';
import { boardsInfo } from '../sim/rink';
import { angleDiff, clamp, gs, headingOf, rand, randRange, segDist, sk } from '../sim/util';
import { aiMem, type Assignment, type Brain } from './memory';
import type { LaneRead } from './util';
import {
  atPoint,
  cycleBonus,
  inOZ,
  isD,
  pointCarryTarget,
  protectTarget,
  protectThreat,
  PROTECT_R,
  PROTECT_R_ALONE,
  PROTECT_TIME,
  screenUp,
  unsupported,
} from './ozone';
import {
  W,
  ZERO,
  alongOf,
  arrive,
  blend,
  closing,
  d2,
  inFront,
  interceptPoint,
  lane,
  oppGoal,
  OPEN_READ,
  SHARP_READ,
  openness,
  ownGoal,
  passRisk,
  pickCorner,
  receivers,
  rush,
  safeTarget,
  separation,
  shotQuality,
  unit,
} from './util';

/*
 * Per-skater behavior. Each role produces a movement intent every tick, but
 * discrete choices (shoot / pass / which lane / which way to dangle / poke /
 * check) are only re-evaluated at each skater's own "think" times, a few
 * times a second with jitter. That plus reaction delays and a per-kid
 * temperament keeps the AI from twitching or acting in lockstep.
 */

/** Body-check attempts per second of eligible contact, before skill/temperament. Tuned for ~1-4 penalties a game. */
const CHECK_RATE = 0.9;
/**
 * ... times this per team. The PUPS kids are lighter checkers on paper (0.55-0.7 vs up to
 * 0.85) and used to finish ~3 hits a game to the BLIZZARD's ~4.5 (some games none at all);
 * this brings them up to a few a game, still mostly on the carrier and inside the same
 * force limits, so not into the box.
 */
const CHECK_TEAM: readonly [number, number] = [1.5, 1];
/** Poke attempts per second while the carrier's puck is in reach. */
const POKE_RATE = 2.6;
/** Bonus a home kid adds to passing options that go to PAL (the Air Bud factor) ... */
const DOG_FEED = 0.3;
/** ... only through a lane this clean (passRisk): the kids feed the dog, not the Blizzard */
const DOG_FEED_RISK = 0.25;
/**
 * A pass to the dog only leaves the stick through a lane with passRisk below this. A
 * feed (called for or not) that doesn't get one within PASS_WAIT is dropped: the kid keeps
 * carrying, and a fresh call starts it over.
 */
const DOG_PASS_RISK = 0.5;
export const PASS_WAIT = 1.0;
/** ... and only this far (m): a long feed to the dog mostly slides past it or gets picked off */
const DOG_FEED_MAX = 18;
/**
 * How carefully each pass is read (ai/util LaneRead). Feeds to the dog get everything: the
 * kids know those have to get through. The BLIZZARD read every pass sharply (a blade on the
 * line, a defender shadowing the receiver: BLIZZARD_READ); the PUPS kids' other passes run
 * the open-ice race alone. Picking off passes is most of the home team's defense, so this
 * is a strong balance lever. History: a blade-only read (0.35 m, then 0.55 m) used to hold
 * the human bot to ~70-78% wins; a full sharp read swung it to ~35% back then. With the
 * offensive-zone game in (ai/ozone.ts: protect, cycle, point shots), the full sharp read
 * gives the BLIZZARD the breakouts they were missing (+2-3 offensive-zone trips a game)
 * and puts the skill-1 bot at ~62-66%.
 */
const BLIZZARD_READ: LaneRead = SHARP_READ;
/**
 * Working the puck in the offensive zone (the cycle, ai/ozone.ts) the BLIZZARD read lanes
 * like that but expect the defenders to hold their spots (LaneRead.chase): measured, their
 * zone passes that the full open-ice race rated ~1.0 still got through ~80-90% of the time,
 * because markers mark, they don't jump lanes. The PUPS kids just run the race, as everywhere.
 */
const OZ_CHASE = 0.5;
const OZ_READ: readonly [LaneRead, LaneRead] = [OPEN_READ, { ...SHARP_READ, chase: OZ_CHASE }];
const laneRead = (state: GameState, s: Skater, to: Skater): LaneRead =>
  to.kind === 'dog' ? SHARP_READ : inOZ(state, s.team, s.pos) ? OZ_READ[s.team] : s.team === 1 ? BLIZZARD_READ : OPEN_READ;
/** Any other planned pass is called off if its lane has closed this much by the release. */
const PASS_RELEASE_RISK = 0.9;
/**
 * Shot selection. A kid with a checker (or the dog) in his face inside RELEASE_RANGE,
 * looking at the net with a bit of it showing, gets it off with probability RELEASE_P
 * per think. A skater at the point (usually a D) with nobody in the shooting lane lets one
 * go with POINT_SHOT_P per think (more on the power play).
 */
const RELEASE_RANGE = 11;
const RELEASE_SQ = 0.35;
const RELEASE_P = 0.4;
const POINT_SHOT_P = 0.1;
/**
 * The offensive-zone clock (TeamMem.ozSince): for the first SETUP_TIME seconds in the zone a
 * carrier wants ENTRY_BAR more of a look before shooting (also on a rushed release), and sets
 * it up instead (protect, cycle). After that the team shoots more readily: WORKED_BAR off the
 * bar, and a rushed release from WORKED_RELEASE_RANGE with WORKED_RELEASE_SQ of the net
 * (low-danger volume: point shots, wristers from the wall through a screen).
 */
const SETUP_TIME = 1.2;
const ENTRY_BAR = 0.12;
/**
 * ... a carrier just in the zone with no shot or pass delays (protects the puck from the
 * nearest man within ENTRY_DELAY_R m: curls off along the wall) with this chance per think
 */
const ENTRY_DELAY_P = 0.6;
const ENTRY_DELAY_R = 8;
/** ... and a carrier protecting the puck wants this much more of a look (measured: few lose it while protecting) */
const PROTECT_BAR = 0.15;
const WORKED_BAR: readonly [number, number] = [0.04, 0.1];
const WORKED_RELEASE_RANGE = 15;
const WORKED_RELEASE_SQ: readonly [number, number] = [0.25, 0.12];
/** ... plus this for a defenseman at the point (ai/ozone.ts), and this again with a screen in front */
const POINT_SHOT_D = 0.3;
const POINT_SCREEN = 0.08;
/** ... through a lane this wide (m; elsewhere 1.1): from out there, a shot through a seam is a shot */
const POINT_LANE = 0.8;
/** ... with at least this much time to load it (a weak one from out there is still a shot on goal) */
const POINT_SHOT_CHARGE = 0.3;
/** ... a defenseman at the point snaps one off with less (it's a shot on goal and a rebound) */
const POINT_SNAP_CHARGE = 0.08;
/**
 * Per-team trigger scale on those optional shots: the BLIZZARD fire away; the PUPS kids
 * would rather feed the dog (and shouldn't flood AI-vs-AI games with shots).
 */
const TRIGGER: readonly [number, number] = [0.5, 1.3];

/**
 * Puck protection. An opponent's blade within POKE_THREAT_R of my puck, pointed at it, is a
 * poke coming. After a beat the carrier tucks the puck in on the far side of his skates
 * (Intent.shield), curls sideways off the blade's line, dangles away from it, and moves the
 * puck if there's a really clean outlet. He doesn't blindly dump it into traffic any more,
 * and he doesn't back off either: giving up ice only feeds the forecheck (both measured).
 */
const POKE_THREAT_R = 1.8;
/** how fast the tuck slides over (a full tuck takes 1/SHIELD_RATE s: the puck moves, it doesn't jump) */
const SHIELD_RATE = 6;
/** steering weight of curling sideways, off that blade's line */
const SHIELD_W = 0.6;
/** chance per think of a dangle away from it */
const POKE_DANGLE_P = 0.6;
/** an outlet at most this risky on a sharp read (ai/util passRisk) makes the pass this much readier */
const OUTLET_RISK = 0.35;
const POKE_PASS_MARGIN = 0.35;
/**
 * Offensive zone (ai/ozone.ts). A carrier with a checker on him moves it this much readier
 * (the cycle: the first clean lane gets it) ...
 */
const CYCLE_PASS_MARGIN = 0.2;
/** ... and otherwise protects it with chance PROTECT_HANDS - handling per think (0.3..0.8): good hands dangle instead */
const PROTECT_HANDS = 1.25;
/** ... only on the wall (within this of the boards, m) or down low (past this along): in the middle he drives */
const PROTECT_WALL = 4.5;
const PROTECT_LOW = 19;
/** passing back out of the zone (offense) costs this much score: it kills the attack */
const ZONE_EXIT_PASS = 0.4;

interface Out {
  move: Vec2;
  shoot: boolean;
  pass: boolean;
  /** wants to sprint (turned into a held button with hysteresis) */
  turbo: boolean;
  /** carrying: tuck the puck to this side (Intent.shield) */
  shield?: number;
}

const thinkGap = (s: Skater): number => (s.kind === 'dog' ? randRange(0.1, 0.2) : randRange(0.14, 0.3));

export function skaterAI(state: GameState, s: Skater, b: Brain, a: Assignment | undefined, dt: number): Out {
  const out: Out = { move: { x: 0, z: 0 }, shoot: false, pass: false, turbo: false };
  if (!canAct(s)) {
    b.hadPuck = false;
    b.plan = 'carry';
    b.shield = 0;
    return out;
  }
  const has = state.puck.owner === s.id;
  if (!has) b.shield = 0;
  if (!has && b.hadPuck) {
    b.hadPuck = false;
    b.plan = 'carry';
    b.protectUntil = -1;
  }
  const role = has ? 'carrier' : a?.role ?? 'idle';
  if (has) carrierAI(state, s, b, out, dt);
  else {
    switch (role) {
      case 'chase':
        chaseAI(state, s, b, a!, out);
        break;
      case 'pressure':
        pressureAI(state, s, b, a!, out, dt);
        break;
      default:
        positionAI(state, s, b, a, out, dt);
    }
    if (role !== 'pressure') opportunistic(state, s, b, out, dt);
  }
  // positional skaters carve around instead of slamming on the brakes and reversing
  // (urgent roles and a carrier mid-dangle may stop hard: that's the ice spray you want to see)
  if (role !== 'pressure' && role !== 'chase' && state.time >= b.dangleUntil && !out.pass) out.move = carve(s, out.move);
  if (s.kind === 'dog') dogBark(state, s, b, out);
  return out;
}

/** Limit how far the move intent points away from the current velocity at speed (max ~110 deg). */
function carve(s: Skater, m: Vec2): Vec2 {
  const sp = Math.hypot(s.vel.x, s.vel.z);
  const ml = Math.hypot(m.x, m.z);
  if (sp < 3.5 || ml < 0.2) return m;
  const hv = headingOf(s.vel.x, s.vel.z);
  const ang = angleDiff(headingOf(m.x, m.z), hv);
  const MAX = 1.9;
  if (Math.abs(ang) <= MAX) return m;
  const h = hv + Math.sign(ang) * MAX;
  return { x: Math.sin(h) * ml, z: Math.cos(h) * ml };
}

// ---------------------------------------------------------------------------
// Carrier

function carrierAI(state: GameState, s: Skater, b: Brain, out: Out, dt: number): void {
  const now = state.time;
  const team = s.team;
  const goal = oppGoal(state, team);
  if (!b.hadPuck) {
    b.hadPuck = true;
    b.gotPuckAt = now;
    b.plan = 'carry';
    b.dangleUntil = -1;
    b.laneUntil = -1;
    // a beat to collect it (faster for the dog), then decide
    b.thinkAt = now + (s.kind === 'dog' ? randRange(0.05, 0.12) : randRange(0.1, 0.22));
    // a rebound or a one-timer-ish feed right on the doorstep: bang it in
    const sq = shotQuality(state, s.pos, team);
    if (d2(s.pos, goal) < 6.5 && sq > 0.3 && rand() < 0.75) startShot(state, s, b, randRange(0, 0.12));
  }

  // a stick reaching for the puck (seen after a beat): tuck the puck in on the far side
  // from that blade, whatever else I'm doing (eased: the puck slides over, it doesn't jump)
  const stick = pokeThreat(state, s);
  if (stick && b.pokeSeenAt < 0) b.pokeSeenAt = now + randRange(0.06, 0.2);
  if (!stick) b.pokeSeenAt = -1;
  // protecting it in the zone (ai/ozone.ts): tucked away from the man I'm turning my back on
  const prot = protecting(state, s, b);
  const from = stick && pokeSeen(state, b) ? stick : prot && d2(prot.pos, s.pos) < 3.5 ? prot : null;
  const want = from ? shieldSide(s, from) : 0;
  b.shield += clamp(want - b.shield, -SHIELD_RATE * dt, SHIELD_RATE * dt);
  out.shield = Math.abs(b.shield) > 0.02 ? b.shield : undefined;

  // --- answer a call for pass/shot (usually the human's dog yelling for it)
  const cf = state.callFor;
  if (cf && cf.carrier === s.id && cf.from !== s.id && b.callSeen !== cf.time && b.plan === 'carry') {
    b.callSeen = cf.time;
    if (cf.kind === 'shot' && shotCallOk(state, s)) startShot(state, s, b, randRange(0.05, 0.25));
    else if (cf.kind === 'pass' || callerOpen(state, s, cf.from)) {
      // (a "shoot!" from out of range reads as "give it here", if that pass is on)
      planPass(state, b, cf.from, randRange(0.06, 0.2));
    }
  }

  if (b.plan === 'windup') {
    windupAI(state, s, b, out);
    return;
  }
  if (b.plan === 'pass') {
    const to = state.skaters[b.passTo];
    const valid = to && to.team === team && canAct(to);
    if (!valid) b.plan = 'carry';
    else if (now >= b.planAt) {
      // look before you pass: the lane may have closed since the decision. A feed to the
      // dog waits (briefly) for a clean one; a pass to a kid just gets called off
      const toDog = to.kind === 'dog';
      const risk = passRisk(state, state.puck.pos, to, team, laneRead(state, s, to));
      const inRange = !toDog || d2(s.pos, to.pos) <= DOG_FEED_MAX;
      if (inRange && risk <= (toDog ? DOG_PASS_RISK : PASS_RELEASE_RISK)) {
        out.pass = true;
        s.intent.passTarget = b.passTo;
        b.plan = 'carry';
      } else if (toDog && now - b.passSince < PASS_WAIT) b.planAt = now + 0.05;
      else {
        b.plan = 'carry';
        b.thinkAt = Math.min(b.thinkAt, now + randRange(0.08, 0.16));
      }
    }
    out.move = carryMove(state, s, b);
    return;
  }

  // the dog closing in with its bark ready makes you look up NOW (after a human-ish beat)
  const dog = barkThreat(state, s);
  if (dog && b.dogSeenAt < 0) b.dogSeenAt = now + randRange(0.08, 0.25);
  if (!dog) b.dogSeenAt = -1;
  if (dog && b.dogSeenAt > 0 && now >= b.dogSeenAt && b.thinkAt > now + 0.02) b.thinkAt = now;
  if (now >= b.thinkAt) {
    b.thinkAt = now + thinkGap(s);
    decideCarrier(state, s, b);
    if (b.plan !== 'carry') {
      out.move = carryMove(state, s, b);
      if (b.plan === 'windup') windupAI(state, s, b, out);
      return;
    }
  }
  out.move = carryMove(state, s, b);
  out.turbo = carryTurbo(state, s, b, out.move);
}

/** A called-for shot is only answered from shooting range, roughly facing the net. */
const CALL_SHOT_RANGE = 16;
/** ... facing within this angle (rad) of the net */
const CALL_SHOT_FACING = 1.75;

function shotCallOk(state: GameState, s: Skater): boolean {
  const goal = oppGoal(state, s.team);
  if (d2(s.pos, goal) > CALL_SHOT_RANGE || alongOf(state, s.team, s.pos.z) > RINK.goalLineZ - 0.4) return false;
  return Math.abs(angleDiff(headingOf(goal.x - s.pos.x, goal.z - s.pos.z), s.facing)) < CALL_SHOT_FACING;
}

/** The caller of an out-of-range "shoot!" can take a pass instead (a lane a kid would try). */
function callerOpen(state: GameState, s: Skater, from: number): boolean {
  const to = state.skaters[from];
  if (!to || to.team !== s.team || !canAct(to) || isGoalie(to)) return false;
  const d = d2(s.pos, to.pos);
  return d > 2.5 && d < 30 && passRisk(state, state.puck.pos, to, s.team, laneRead(state, s, to)) < (to.kind === 'dog' ? DOG_PASS_RISK : 0.8);
}

function planPass(state: GameState, b: Brain, to: number, delay: number): void {
  b.plan = 'pass';
  b.passTo = to;
  b.planAt = state.time + delay;
  b.passSince = state.time;
}

/** Begin a windup that releases after `hold` seconds (0 = a quick wrister). */
function startShot(state: GameState, s: Skater, b: Brain, hold: number): void {
  b.plan = 'windup';
  b.planAt = state.time + hold;
  b.aimX = pickCorner(state, s, rand());
}

function windupAI(state: GameState, s: Skater, b: Brain, out: Out): void {
  const goal = oppGoal(state, s.team);
  const near = nearestOpp(state, s);
  // keep sliding toward the net while loading up
  out.move = blend([unit(goal.x - s.pos.x, goal.z - s.pos.z), 0.7]);
  s.intent.aimAt = { x: b.aimX, z: goal.z };
  const rushed = near.d < 1.3 && s.windup > 0.12;
  if (state.time >= b.planAt || rushed) {
    out.shoot = false; // release: the sim shoots on the falling edge
    b.plan = 'carry';
    b.thinkAt = state.time + 0.3;
  } else out.shoot = true;
}

function nearestOpp(state: GameState, s: Skater): { o: Skater | null; d: number } {
  let o: Skater | null = null;
  let d = 99;
  for (const k of state.skaters) {
    if (k.team === s.team || !onIce(k) || isGoalie(k) || k.state === 'fallen') continue;
    const dd = d2(k.pos, s.pos);
    if (dd < d) {
      d = dd;
      o = k;
    }
  }
  return { o, d };
}

function decideCarrier(state: GameState, s: Skater, b: Brain): void {
  const team = s.team;
  const now = state.time;
  const goal = oppGoal(state, team);
  const along = alongOf(state, team, s.pos.z);
  const dGoal = d2(s.pos, goal);
  const near = nearestOpp(state, s);
  const pressure = clamp((3.2 - near.d) / 2.2, 0, 1);
  const pp = skatersOnIce(state, team) > skatersOnIce(state, (1 - team) as TeamId);
  const held = now - b.gotPuckAt;
  const sq = shotQuality(state, s.pos, team);
  const trailingLate = state.clock < 20 && state.score[team] < state.score[1 - team] && state.period >= 3;
  const stick = pokeSeen(state, b) ? pokeThreat(state, s) : null;
  const oz = inOZ(state, team, s.pos);

  // ---- shoot? Value = how much net shows x how hard I can shoot before a checker arrives
  // (a loaded shot is what beats a set goalie; a tap only works if he's out of position)
  const cs = near.o ? Math.max(1.5, closing(near.o, s.pos) + 1) : 1.5;
  const free = near.o ? Math.max(0, near.d - 1.3) / cs : 2;
  const charge = clamp((free * 0.75) / PHYS.windupTime, 0, 1);
  const value = sq * (0.35 + 0.65 * charge);
  let bar = 0.56 - b.bold * 0.08;
  // the offensive-zone game (ai/ozone.ts): coming in, a so-so look is not worth giving the
  // puck up for (set it up first); once the zone is set up, put pucks on net
  const zt = zoneTime(state, team);
  const settling = oz && zt < SETUP_TIME;
  const worked = oz && zt >= SETUP_TIME;
  let relRange = RELEASE_RANGE;
  let relSq = RELEASE_SQ;
  if (now < b.protectUntil) {
    // protecting it: he's not losing it, so no junk shot off the turn; a real look still goes
    bar += PROTECT_BAR;
    relSq += PROTECT_BAR;
  } else if (settling) {
    bar += ENTRY_BAR;
    relSq += ENTRY_BAR;
  } else if (worked) {
    bar -= WORKED_BAR[team];
    relRange = WORKED_RELEASE_RANGE;
    relSq = WORKED_RELEASE_SQ[team];
  }
  if (pp) bar -= 0.06;
  if (held > 3) bar -= 0.05;
  if (trailingLate) bar -= 0.1;
  const trig = TRIGGER[team];
  const toGoal = Math.abs(angleDiff(headingOf(goal.x - s.pos.x, goal.z - s.pos.z), s.facing));
  const facing = toGoal < 1.2;
  // at the point with nobody between me and the net (the goalie doesn't count): let it go.
  // He sees it all the way, but it's a shot on goal, and the rebound is a chance. A
  // defenseman walking the line does it more, and more again with a screen in front
  const pointMan = isD(s) && atPoint(state, s);
  const pointP = POINT_SHOT_P + b.bold * 0.04 + (pointMan ? POINT_SHOT_D + (screenUp(state, s) ? POINT_SCREEN : 0) : 0);
  const pointShot =
    !(settling && pointMan && !pp) &&
    along > RINK.blueLineZ &&
    along < 17 &&
    dGoal > 11 &&
    charge > (pointMan ? POINT_SNAP_CHARGE : POINT_SHOT_CHARGE) &&
    (pointMan || toGoal < 1.2) &&
    laneClear(state, s, goal, pointMan ? POINT_LANE : 1.1) &&
    rand() < pointP * (pp ? 1.8 : 1) * trig;
  // about to lose it anyway (the dog's on me / a checker in my face): a quick shot from
  // decent ice beats nothing. This is where most shots on a goalie come from.
  const rushed = pressure > 0.6 || barkThreat(state, s) !== null;
  const release = rushed && dGoal < relRange && facing && sq > relSq && rand() < RELEASE_P * trig;
  if (release) {
    startShot(state, s, b, randRange(0, 0.15));
    return;
  }
  if ((value > bar && dGoal < 16 && rand() < 0.85) || pointShot) {
    let hold = charge * PHYS.windupTime * randRange(0.75, 1);
    if (dGoal < 5 && rand() < 0.5) hold = Math.min(hold, randRange(0, 0.25)); // quick release in tight
    startShot(state, s, b, hold);
    return;
  }

  // ---- pass?
  const best = bestPass(state, s);
  if (best) {
    const mySpace = clamp(near.d / 5, 0, 1);
    const carry = sq * 1.4 + mySpace * 0.7 + (along < RINK.blueLineZ ? 0.25 : 0);
    let margin = 0.25 + (rand() - 0.5) * 0.3;
    if (held > 2.5) margin -= 0.15;
    if (held < 0.35) margin += 0.4; // just got it: look up first
    if (s.kind === 'dog') margin += 0.2; // the star likes to carry
    if (barkThreat(state, s)) margin -= 0.6; // move it before he barks
    // a stick reaching in: move it if there's a really clean outlet; never a blind dump
    // (protecting it beats throwing it to the other team)
    const outlet = !!stick && passRisk(state, state.puck.pos, state.skaters[best.id], team, SHARP_READ) < OUTLET_RISK;
    if (outlet) margin -= POKE_PASS_MARGIN;
    // working it in the zone with a checker on me: the first clean lane gets it (the cycle)
    if (oz && (pressure > 0.2 || now < b.protectUntil)) margin -= CYCLE_PASS_MARGIN;
    const dump = pressure > 0.65 && best.score > 0.15 && (!stick || outlet) && rand() < 0.7;
    if (best.score > carry + margin || dump) {
      planPass(state, b, best.id, randRange(0.02, 0.1));
      return;
    }
  }

  // ---- protect it (ai/ozone.ts): in the zone with a checker coming, turn my back on him
  // and take it along the boards; the cycle pass comes off that. Good hands dangle instead
  if (oz && !pointMan && (along > PROTECT_LOW || boardsInfo(s.pos.x, s.pos.z).dist < PROTECT_WALL)) {
    let th = protectThreat(state, s, unsupported(state, s) ? PROTECT_R_ALONE : PROTECT_R) ?? barkThreat(state, s);
    // just in, nothing on: delay (curl off along the wall, let the others get set up)
    if (!th && settling && near.o && near.d < ENTRY_DELAY_R && rand() < ENTRY_DELAY_P) th = near.o;
    if (th && now >= b.protectUntil - 0.15 && rand() < clamp(PROTECT_HANDS - s.attrs.handling, 0.3, 0.8)) {
      b.protectUntil = now + randRange(PROTECT_TIME[0], PROTECT_TIME[1]);
      b.protectFrom = th.id;
      b.dangleUntil = -1;
    }
  }
  if (now < b.protectUntil) return;

  // ---- carry: choose a lane / a dangle
  if (now > b.laneUntil) {
    b.laneX = chooseLane(state, s, b);
    b.laneUntil = now + randRange(0.6, 1.1);
  }
  if (near.o && now > b.dangleUntil) {
    const fwd = carryDir(state, s, b);
    // dangle around the man in front, or away from a stick reaching in from anywhere
    const from = stick ?? near.o;
    const ahead = inFront(s, near.o.pos, fwd, 0.55);
    if ((stick && rand() < POKE_DANGLE_P) || (ahead && near.d < 3.0 && rand() < (s.kind === 'dog' ? 0.8 : 0.45))) {
      const rel = (from.pos.x - s.pos.x) * fwd.z - (from.pos.z - s.pos.z) * fwd.x;
      b.dangleSide = Math.abs(rel) > 0.25 ? -Math.sign(rel) : rand() < 0.5 ? 1 : -1;
      // don't dangle into the boards
      const sideV = { x: fwd.z * b.dangleSide, z: -fwd.x * b.dangleSide };
      const probe = boardsInfo(s.pos.x + sideV.x * 2.5, s.pos.z + sideV.z * 2.5);
      if (probe.dist < 1.0) b.dangleSide = -b.dangleSide;
      b.dangleUntil = now + randRange(0.4, 0.7);
    }
  }
}

/** No skating opponent (goalies don't count: shooting at him is the point) in the shooting lane. */
function laneClear(state: GameState, s: Skater, goal: Vec2, width = 1.1): boolean {
  for (const o of state.skaters) {
    if (o.team === s.team || !onIce(o) || isGoalie(o) || o.state === 'fallen') continue;
    const { d, t } = segDist(o.pos, s.pos, goal);
    if (t > 0.02 && t < 0.97 && d < width) return false;
  }
  return true;
}

/**
 * The opposing dog is close and can bark (a bark within 2.5 m makes an average kid
 * cough up the puck BARK_FUMBLE_BASE = 30% of the time). Returns it, or null.
 */
function barkThreat(state: GameState, s: Skater): Skater | null {
  if (s.kind === 'dog') return null;
  for (const o of state.skaters) {
    if (o.kind !== 'dog' || o.team === s.team || !canAct(o)) continue;
    if (o.barkCooldown > 0.4) continue;
    const d = d2(o.pos, s.pos);
    // a dog flying in at 10 m/s is a threat from further out
    if (d < 4.2 || (d < 7 && closing(o, s.pos) > 3)) return o;
  }
  return null;
}

/** An opponent's blade close to my puck and pointed at it (see POKE_THREAT_R), or null. */
function pokeThreat(state: GameState, s: Skater): Skater | null {
  const p = state.puck.pos;
  let best: Skater | null = null;
  let bd = POKE_THREAT_R;
  for (const o of state.skaters) {
    if (o.team === s.team || !canAct(o) || isGoalie(o) || o.stun > 0.1) continue;
    const sp = stickPoint(o);
    const d = Math.hypot(sp.x - p.x, sp.z - p.z);
    if (d >= bd) continue;
    // he pokes where he faces
    if (Math.abs(angleDiff(headingOf(p.x - o.pos.x, p.z - o.pos.z), o.facing)) > 1.3) continue;
    best = o;
    bd = d;
  }
  return best;
}

/**
 * Which side to tuck the puck to against `o`'s blade: away from it when it reaches in from
 * the side or the front (from straight behind the puck is safest out in front: 0).
 */
function shieldSide(s: Skater, o: Skater): number {
  const sp = stickPoint(o);
  const dx = sp.x - s.pos.x;
  const dz = sp.z - s.pos.z;
  const f = { x: Math.sin(s.facing), z: Math.cos(s.facing) };
  const lat = dx * f.z - dz * f.x; // + = blade on my left (world x/z handedness as in carryMove)
  const fwd = dx * f.x + dz * f.z;
  if (fwd < -0.3 && Math.abs(lat) < 0.5) return 0;
  return Math.abs(lat) > 0.05 ? Math.sign(lat) : 1;
}

/** How long `team` has been working the puck in its offensive zone (s, 0 = not). */
function zoneTime(state: GameState, team: TeamId): number {
  const t = aiMem(state).teams[team].ozSince;
  return t < 0 ? 0 : state.time - t;
}

/** The man this carrier is protecting the puck from (ai/ozone.ts), while it lasts. */
function protecting(state: GameState, s: Skater, b: Brain): Skater | null {
  if (state.time >= b.protectUntil || b.protectFrom < 0) return null;
  const o = state.skaters[b.protectFrom];
  return onIce(o) && o.state !== 'fallen' && d2(o.pos, s.pos) < 6 ? o : null;
}

/** The carrier has seen that blade (after his reaction beat). */
const pokeSeen = (state: GameState, b: Brain): boolean => b.pokeSeenAt > 0 && state.time >= b.pokeSeenAt;

interface PassOption {
  id: number;
  score: number;
}

/** Score every teammate as a pass target (open, clean lane, dangerous spot, up ice, the dog). */
function bestPass(state: GameState, s: Skater): PassOption | null {
  const team = s.team;
  const myAlong = alongOf(state, team, s.pos.z);
  const pressure = clamp((3.2 - nearestOpp(state, s).d) / 2.2, 0, 1);
  const oz = inOZ(state, team, s.pos);
  let best: PassOption | null = null;
  for (const r of receivers(state, s)) {
    const d = d2(s.pos, r.pos);
    if (d < 3 || d > (r.kind === 'dog' ? DOG_FEED_MAX : 30)) continue;
    const lr = passRisk(state, state.puck.pos, r, team, laneRead(state, s, r));
    const feed = team === 0 && r.kind === 'dog' && s.kind !== 'dog';
    if (lr > (feed ? DOG_PASS_RISK : 0.6)) continue; // would be picked off
    const open = openness(state, r.pos, team);
    if (open < 1.4) continue; // covered: the defender's stick is closer than his
    const rq = shotQuality(state, r.pos, team);
    const prog = alongOf(state, team, r.pos.z) - myAlong;
    let score = rq * 1.5 + clamp(open / 4.5, 0, 1) * 0.7 + clamp(prog / 12, -0.5, 0.6) * 0.6 - lr * 1.6;
    if (d > 20) score -= 0.4;
    if (open < 1.6) score -= 0.5;
    // the cross-crease feed: a teammate on the far side of the net, uncovered
    if (rq > 0.45 && Math.sign(r.pos.x) !== Math.sign(s.pos.x) && myAlong > 15) score += 0.2;
    if (feed && lr < DOG_FEED_RISK) score += DOG_FEED;
    score += cycleBonus(state, s, r, pressure);
    if (oz && !inOZ(state, team, r.pos, -0.5)) score -= ZONE_EXIT_PASS;
    if (!best || score > best.score) best = { id: r.id, score };
  }
  return best;
}

/** Pick the x of the lane to carry up ice: open ice ahead, not too far from where I am. */
function chooseLane(state: GameState, s: Skater, b: Brain): number {
  const team = s.team;
  const ca = alongOf(state, team, s.pos.z);
  let bx = s.pos.x;
  let bs = -Infinity;
  for (const x of [-7, -3.5, 0, 3.5, 7]) {
    const probe = W(state, team, x, Math.min(ca + 7, 21));
    let sc = Math.min(openness(state, probe, team), 7) - Math.abs(x - s.pos.x) * 0.18;
    if (Math.abs(x - b.laneX) < 0.1) sc += 0.8; // stick with the plan
    if (x === 0) sc += 0.4;
    if (sc > bs) {
      bs = sc;
      bx = x;
    }
  }
  return bx;
}

/** Direction the carrier is trying to go (before dangles and avoidance). */
function carryDir(state: GameState, s: Skater, b: Brain): Vec2 {
  const t = carryTarget(state, s, b);
  return unit(t.x - s.pos.x, t.z - s.pos.z);
}

function carryTarget(state: GameState, s: Skater, b: Brain): Vec2 {
  const team = s.team;
  const ca = alongOf(state, team, s.pos.z);
  const prot = protecting(state, s, b);
  if (prot) return protectTarget(state, s, prot);
  if (isD(s) && ca > RINK.blueLineZ + 0.3 && atPoint(state, s)) return pointCarryTarget(state, s);
  if (ca < RINK.blueLineZ + 2) {
    // up ice in the chosen lane, drifting toward the middle as we cross the line
    return W(state, team, b.laneX, Math.min(ca + 10, 20));
  }
  const side = s.pos.x >= 0 ? 1 : -1;
  if (ca > RINK.goalLineZ - 0.6) {
    // behind the goal line: come out the side toward the slot
    return W(state, team, side * 4, 21.5);
  }
  if (ca > 21.5) return W(state, team, side * 1.0, 18.5); // too deep: curl back into the slot
  // drive the net on my side, cutting toward the slot
  return W(state, team, side * clamp(Math.abs(s.pos.x) * 0.5, 1.0, 3.0), 20.5);
}

function carryMove(state: GameState, s: Skater, b: Brain): Vec2 {
  const now = state.time;
  const t = carryTarget(state, s, b);
  let dir = unit(t.x - s.pos.x, t.z - s.pos.z);
  if (now < b.dangleUntil) {
    const side = { x: dir.z * b.dangleSide, z: -dir.x * b.dangleSide };
    dir = unit(dir.x * 0.45 + side.x * 0.9, dir.z * 0.45 + side.z * 0.9);
  }
  // swerve around opponents in the way
  let ax = 0;
  let az = 0;
  for (const o of state.skaters) {
    if (o.team === s.team || !onIce(o) || o.state === 'fallen') continue;
    const dx = o.pos.x - s.pos.x;
    const dz = o.pos.z - s.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 4 || d < 1e-3) continue;
    const fw = (dx * dir.x + dz * dir.z) / d;
    if (fw < 0.2) continue;
    const lat = (dx * dir.z - dz * dir.x) / d; // + = opponent on my right
    const w = ((4 - d) / 4) * fw * (isGoalie(o) ? 0.6 : 1.1);
    const sgn = Math.abs(lat) > 0.05 ? -Math.sign(lat) : 1;
    ax += dir.z * sgn * w;
    az += -dir.x * sgn * w;
  }
  // keep the puck away from a dog that's about to bark
  const dog = barkThreat(state, s);
  if (dog) {
    const away = unit(s.pos.x - dog.pos.x, s.pos.z - dog.pos.z);
    const w = clamp((7 - d2(dog.pos, s.pos)) / 7, 0, 1);
    ax += away.x * w * 1.2;
    az += away.z * w * 1.2;
  }
  // curl off the line of a stick reaching for the puck
  const stick = pokeSeen(state, b) ? pokeThreat(state, s) : null;
  if (stick) {
    // sideways only: keep going, just take the puck off his line (backing away from a
    // stick gives up the ice, and the dog skates faster than any kid anyway)
    const off = unit(s.pos.x - stick.pos.x, s.pos.z - stick.pos.z);
    const sgn = Math.sign(off.x * dir.z - off.z * dir.x) || 1;
    const away = { x: dir.z * sgn, z: -dir.x * sgn };
    const sp = stickPoint(stick);
    const w = clamp((POKE_THREAT_R + 0.4 - d2(sp, state.puck.pos)) / POKE_THREAT_R, 0.3, 1);
    ax += away.x * w * SHIELD_W;
    az += away.z * w * SHIELD_W;
  }
  // stay off the boards a bit (the puck dies there)
  const bi = boardsInfo(s.pos.x, s.pos.z);
  const wall = bi.dist < 1.8 ? (1.8 - bi.dist) / 1.8 : 0;
  return blend([dir, 1], [{ x: ax, z: az }, 1], [{ x: -bi.nx, z: -bi.nz }, wall * 0.9]);
}

function carryTurbo(state: GameState, s: Skater, b: Brain, move: Vec2): boolean {
  const ca = alongOf(state, s.team, s.pos.z);
  // a carrier sprints to go somewhere: up ice. Curling back, cutting across or protecting
  // it on the wall is no burst (a sprint going ends when he turns back)
  const ml = Math.hypot(move.x, move.z);
  const fwd = ml > 1e-6 ? alongOf(state, s.team, move.z) / ml : 0;
  if (fwd < (b.turboOn ? 0 : CARRY_TURBO_FWD)) return false;
  // a kid's dangle bursts past his man on the attack (that's where the shots come from);
  // back home, and for the (already quick) dog, it only rides a sprint that's going: every
  // deke used to be a turboStart
  if (state.time < b.dangleUntil) return ((ca > 0 && s.kind === 'kid') || b.turboOn) && s.stamina > 0.25;
  const near = nearestOpp(state, s);
  // open ice to burn into (the dog uses its speed more freely: it's the star);
  // a sprint already going keeps going a bit deeper and a bit closer to a checker
  if (s.kind === 'dog') return b.turboOn ? ca < 19 && near.d > 1.8 : ca < 17 && near.d > 2.5 && s.stamina > 0.35;
  // a kid breaks out with open ice ahead: up to the far blue line, nobody within 6 m
  return b.turboOn ? ca < 14 && near.d > 2.5 : ca < 8 && near.d > 6 && s.stamina > 0.5;
}

/** a carrier's sprint starts only with his skating this much up ice (cos of the angle) */
const CARRY_TURBO_FWD = 0.6;

/*
 * Turbo wishes off the puck have distance hysteresis: a sprint starts far from where
 * the skater wants to be and keeps going until he is nearly there. With one threshold
 * a mark hovering around it started a 1 s minimum burst every couple of seconds.
 */
/** a positional (mark / box) sprint starts this far (m) from the spot ... */
const SPOT_TURBO_START = 12;
/** ... or when beaten (farther from his own net than the puck) by this much */
const BEATEN_TURBO_START = 8;
/** ... and only if the spot is at least this far (m) back toward his own net */
const BACKCHECK_BACK = 3;
/** a far spot this much (m) up ice from him is no sprint (stepping up, not getting back) */
const SPOT_UP_ICE = 6;
/** ... and keeps going until this close to the spot */
const SPOT_TURBO_KEEP = 2.5;
/** a chaser sprints from this far off the puck, until this close */
const CHASE_TURBO_START = 12;
const CHASE_TURBO_KEEP = 3;
/** a presser sprints from this far off the carrier (and lets go at 3.5 m to settle in) */
const PRESS_TURBO_START = 9;
/** a supporting attacker sprints from this far off his spot, until this close */
const SUPPORT_TURBO_START = 18;
const SUPPORT_TURBO_KEEP = 6;
/** being beaten only counts for a mark whose man is this close to the puck (the play is there) */
const MARK_IN_PLAY = 12;

// ---------------------------------------------------------------------------
// Without the puck

function chaseAI(state: GameState, s: Skater, b: Brain, a: Assignment, out: Out): void {
  const p = state.puck;
  const dp = d2(s.pos, p.pos);
  let t = a.pos;
  if (dp < 2.5) {
    // close: put the blade on it (aim the stick point, not the body)
    const sp = stickPoint(s);
    t = { x: p.pos.x + p.vel.x * 0.12 - (sp.x - s.pos.x) * 0.6, z: p.pos.z + p.vel.z * 0.12 - (sp.z - s.pos.z) * 0.6 };
  }
  out.move = d2(s.pos, t) > 3 ? rush(s, t) : arrive(s, t, 9, 1, 0.1);
  out.turbo = b.turboOn ? d2(s.pos, t) > CHASE_TURBO_KEEP : d2(s.pos, t) > CHASE_TURBO_START && s.stamina > 0.45;
  // an opponent is about to collect it right in front of me: get a stick on it
  const c = state.puck.owner;
  if (c !== null && state.skaters[c].team !== s.team) tryPoke(state, s, b, out, 1 / 60);
}

function pressureAI(state: GameState, s: Skater, b: Brain, a: Assignment, out: Out, dt: number): void {
  const now = state.time;
  const c = state.skaters[a.target!];
  if (b.lastKey !== 'pressure') {
    b.lastKey = 'pressure';
    b.engageAt = now + randRange(0.12, 0.3);
  }
  const goal = ownGoal(state, s.team);
  const toGoal = unit(goal.x - c.pos.x, goal.z - c.pos.z);
  const d = d2(s.pos, c.pos);
  const goalSide = d2(s.pos, goal) < d2(c.pos, goal) - 0.3;
  const sh = skatersOnIce(state, s.team) < skatersOnIce(state, (1 - s.team) as TeamId);
  let t: Vec2;
  if (d > 3) {
    const lead = clamp(d / 9, 0.1, 0.8);
    const back = goalSide ? 0.8 : 1.6;
    t = { x: c.pos.x + c.vel.x * lead + toGoal.x * back, z: c.pos.z + c.vel.z * lead + toGoal.z * back };
    out.move = rush(s, t);
  } else {
    // in tight: shadow the puck, matching his speed, stick on the puck
    const pp = state.puck.pos;
    t = { x: pp.x + c.vel.x * 0.15 + toGoal.x * 0.35, z: pp.z + c.vel.z * 0.15 + toGoal.z * 0.35 };
    const chase = unit(t.x - s.pos.x, t.z - s.pos.z);
    const match = { x: c.vel.x / s.attrs.maxSpeed, z: c.vel.z / s.attrs.maxSpeed };
    out.move = blend([match, 0.7], [chase, 0.75]);
  }
  // shorthanded: don't chase the puck out past the top of the box
  if (sh && alongOf(state, s.team, c.pos.z) > -RINK.blueLineZ - 1) {
    const hold = W(state, s.team, c.pos.x * 0.4, -14);
    out.move = arrive(s, safeTarget(hold), 4);
  }
  out.move = blend([out.move, 1], [separation(state, s, 1.8), 0.4]);
  out.turbo = b.turboOn || (d > PRESS_TURBO_START && s.stamina > 0.45);
  if (d < 3.5) out.turbo = false; // settle in before contact
  if (now >= b.engageAt) {
    tryPoke(state, s, b, out, dt);
    tryCheck(state, s, b, c, out, dt, sh);
  }
}

/** Formation spot (support / mark / box / idle), with "get open" nudges and one-timer setups. */
function positionAI(state: GameState, s: Skater, b: Brain, a: Assignment | undefined, out: Out, dt: number): void {
  const now = state.time;
  const raw = a ? a.pos : s.pos;
  const key = a?.key ?? 'idle';
  if (!b.target) b.target = { ...raw };
  // follow the spot smoothly (snappier for marks, which shadow a moving man)
  const rate = a?.role === 'mark' ? 6 : 3.5;
  const k = 1 - Math.exp(-rate * dt);
  b.target.x += (raw.x - b.target.x) * k;
  b.target.z += (raw.z - b.target.z) * k;
  b.lastKey = key;

  let t = b.target;
  const G = gs(state);
  const incoming = G.pass && G.pass.to === s.id && state.puck.owner === null;

  if (a?.role === 'support') {
    // get open: every half second or so, try small shifts that clear the passing lane
    const c = state.puck.owner !== null ? state.skaters[state.puck.owner] : null;
    if (c && c.team === s.team && now > b.offsetUntil) {
      b.offsetUntil = now + randRange(0.45, 0.8);
      let best = b.offset;
      let bs = -Infinity;
      for (const o of [ZERO, { x: 2, z: 0 }, { x: -2, z: 0 }, { x: 0, z: 2 }, { x: 0, z: -2 }, b.offset]) {
        const p = { x: t.x + o.x, z: t.z + o.z };
        const sc = -lane(state, c.pos, p, s.team) * 2 + Math.min(openness(state, p, s.team), 5) * 0.35 - Math.hypot(o.x, o.z) * 0.12;
        if (sc > bs) {
          bs = sc;
          best = o;
        }
      }
      b.offset = best;
    }
    if (c && c.team === s.team) t = safeTarget({ x: t.x + b.offset.x, z: t.z + b.offset.z });
  }

  if (incoming) {
    // the pass is coming to me: go meet it with the stick on the ice. Skating
    // toward the puck turns the blade to it; a receiver drifting away with his
    // back to the pass gets it picked off by any defender facing the play.
    const ip = interceptPoint(state, s, 0.05).p;
    const pp = state.puck.pos;
    const toPuck = unit(pp.x - s.pos.x, pp.z - s.pos.z);
    const toIp = unit(ip.x - s.pos.x, ip.z - s.pos.z);
    const dIp = d2(ip, s.pos);
    out.move = dIp < 1.2 ? blend([toPuck, 0.45]) : blend([toIp, 0.75], [toPuck, 0.35]);
    // one-timer: open in a good spot -> load the stick while the puck travels
    const sq = shotQuality(state, s.pos, s.team);
    const dPuck = d2(state.puck.pos, s.pos);
    const wants = sq > (s.kind === 'dog' ? 0.32 : 0.4) && alongOf(state, s.team, s.pos.z) > 14 && openness(state, s.pos, s.team) > 1.5;
    if (b.oneTimerUntil < now && wants && dPuck > 3.5 && s.intent.shoot.held === false) b.oneTimerUntil = now + 1.1;
    if (now < b.oneTimerUntil) {
      out.shoot = true;
      s.intent.aimAt = { x: pickCorner(state, s, 0.4), z: oppGoal(state, s.team).z };
    }
    return;
  }
  b.oneTimerUntil = -1;

  // the gap defender steps up on a carrier that comes right at him (and always on the dog)
  if (a?.key === 'lane') {
    const o = state.puck.owner;
    const c = o !== null ? state.skaters[o] : null;
    if (c && c.team !== s.team && !isGoalie(c)) {
      const dc = d2(s.pos, c.pos);
      if (dc < (c.kind === 'dog' ? 4.5 : 3)) {
        const goal = ownGoal(state, s.team);
        const g = unit(goal.x - c.pos.x, goal.z - c.pos.z);
        t = { x: c.pos.x + c.vel.x * 0.2 + g.x * 0.6, z: c.pos.z + c.vel.z * 0.2 + g.z * 0.6 };
        out.move = rush(s, t);
        return;
      }
    }
  }
  const brake = a?.role === 'mark' || a?.role === 'box' ? 4.5 : 3.2;
  out.move = blend([arrive(s, t, brake), 1], [separation(state, s, 2.6), 0.55]);
  // backcheck: caught on the wrong side of the puck on defense -> sprint back
  const defending = a?.role === 'mark' || a?.role === 'box';
  const dSpot = d2(s.pos, t);
  if (defending) {
    const goal = ownGoal(state, s.team);
    const beatenBy = d2(s.pos, goal) - d2(state.puck.pos, goal);
    const man = a?.target !== undefined ? state.skaters[a.target] : null;
    const inPlay = !man || d2(man.pos, state.puck.pos) < MARK_IN_PLAY;
    // how far (m) the spot is back toward his own net: a defender's sprint is a race back.
    // A spot far up ice (stepping up on a man at their blue line) is skated to, and being
    // beaten by the puck while level with his man (spot not behind him) is no race either
    const back = alongOf(state, s.team, s.pos.z) - alongOf(state, s.team, t.z);
    // ... and it is a race only while they are coming: their puck, or a loose one
    const owner = state.puck.owner;
    const coming = owner === null || state.skaters[owner].team !== s.team;
    const start =
      (dSpot > SPOT_TURBO_START && back > -SPOT_UP_ICE && s.stamina > 0.5) ||
      (inPlay && coming && back > BACKCHECK_BACK && beatenBy > BEATEN_TURBO_START && dSpot > SPOT_TURBO_KEEP && s.stamina > 0.35);
    out.turbo = b.turboOn ? dSpot > SPOT_TURBO_KEEP : start;
  } else if (a?.role === 'support') out.turbo = b.turboOn ? dSpot > SUPPORT_TURBO_KEEP : dSpot > SUPPORT_TURBO_START && s.stamina > 0.6;
  else out.turbo = false;
}

/** Any defender the carrier skates past gets a stick on it now and then. */
function opportunistic(state: GameState, s: Skater, b: Brain, out: Out, dt: number): void {
  const o = state.puck.owner;
  if (o === null) return;
  const c = state.skaters[o];
  if (c.team === s.team || isGoalie(c)) return;
  if (d2(s.pos, c.pos) > 2.4) return;
  tryPoke(state, s, b, out, dt * 0.6);
  tryCheck(state, s, b, c, out, dt * 0.5, false);
  if (out.pass || out.shoot) {
    // commit: lean into the carrier for this tick
    const u = unit(c.pos.x - s.pos.x, c.pos.z - s.pos.z);
    out.move = { x: u.x, z: u.z };
  }
}

/** Poke at the carrier's puck when it's in reach and in front of the stick. */
function tryPoke(state: GameState, s: Skater, b: Brain, out: Out, dt: number): void {
  if (state.time < b.pokeReady || s.stun > 0 || out.pass) return;
  const p = state.puck.pos;
  const dx = p.x - s.pos.x;
  const dz = p.z - s.pos.z;
  const dd = Math.hypot(dx, dz);
  if (dd > PHYS.pokeRange - 0.1) return;
  const ang = Math.abs(angleDiff(headingOf(dx, dz), s.facing));
  if (ang > 1.0) return;
  if (rand() < dt * POKE_RATE * (0.7 + 0.6 * b.bold)) {
    out.shoot = true;
    b.pokeReady = state.time + randRange(0.7, 1.3);
  }
}

/** Rough lunge speed gain by contact time (the lunge adds speed for 0.3 s). */
const LUNGE_GAIN = 2.2;
/** Contact comes about this long after the decision: the victim's skating is projected that far. */
const CHECK_LOOKAHEAD = 0.3;
/**
 * How much lower a kid keeps his hits on the dog. The 14 kg dog turns any closing speed
 * into a big force (sqrt of the weight ratio, ~2x), so the estimate's error is ~2x too.
 */
const DOG_CHECK_MARGIN = 2.5;
/** a skater who released the puck this recently is off limits (a late hit is interference) */
const LATE_HIT_TIME = 0.35;

/**
 * The victim's velocity CHECK_LOOKAHEAD from now: eased toward what he is skating for
 * (his intent, at his own accel). The dog closing in on the hitter shows up here before
 * it shows up in his velocity.
 */
function projectedVel(c: Skater): Vec2 {
  const want = { x: c.intent.move.x * c.attrs.maxSpeed, z: c.intent.move.z * c.attrs.maxSpeed };
  const dx = want.x - c.vel.x;
  const dz = want.z - c.vel.z;
  const l = Math.hypot(dx, dz);
  const k = l > 1e-6 ? Math.min(1, (c.attrs.accel * CHECK_LOOKAHEAD) / l) : 0;
  return { x: c.vel.x + dx * k, z: c.vel.z + dz * k };
}

/**
 * Body check decision. The AI estimates the force at contact with the sim's
 * own formula and picks hits that knock the puck loose without being
 * reckless: kids know a heavy hit (worse: on the 14 kg dog, or from behind)
 * gets called. Bold kids cross the line now and then; that's where most
 * penalties come from.
 */
function tryCheck(state: GameState, s: Skater, b: Brain, c: Skater, out: Out, dt: number, sh: boolean): void {
  if (state.time < b.checkReady || s.stun > 0 || out.shoot || c.invuln > 0 || c.state === 'fallen') return;
  // he just got rid of it (or is following through): too late, that's interference
  if (c.state === 'pass' || c.state === 'shoot') return;
  if (state.puck.owner !== c.id && state.time - sk(c).lastOwnTime < LATE_HIT_TIME) return;
  const lead = { x: c.pos.x + c.vel.x * 0.15, z: c.pos.z + c.vel.z * 0.15 };
  const d = d2(s.pos, lead);
  if (d < 0.8 || d > 2.1) return;
  const n = unit(lead.x - s.pos.x, lead.z - s.pos.z);
  const close = (s.vel.x - c.vel.x) * n.x + (s.vel.z - c.vel.z) * n.z;
  if (close < 0.3) return;
  // the force at contact: from the closing speed now, or by then if he's skating into me
  const vc = projectedVel(c);
  const closeAt = Math.max(close, (s.vel.x - vc.x) * n.x + (s.vel.z - vc.z) * n.z);
  const bi = boardsInfo(c.pos.x, c.pos.z);
  const boards = bi.dist < 1.6 + c.attrs.radius && n.x * bi.nx + n.z * bi.nz > 0.3 ? 2.6 : 0;
  const force =
    (closeAt + LUNGE_GAIN) * Math.sqrt(s.attrs.weight / c.attrs.weight) * (0.6 + 0.8 * s.attrs.check) * (s.turboActive ? 1.2 : 1) + boards;
  const fromBehind = Math.sin(c.facing) * n.x + Math.cos(c.facing) * n.z > 0.55;
  // how hard this kid is willing to hit: a clean separation is ~4-8, bold kids go to ~11
  let limit = 7 + b.bold * 4;
  if (c.kind === 'dog') limit -= DOG_CHECK_MARGIN;
  if (fromBehind) limit -= 2.5;
  if (sh) limit -= 2;
  if (force > limit || force < 2.5) return;
  let rate = CHECK_RATE * CHECK_TEAM[s.team] * s.attrs.check * (0.5 + b.bold);
  // everybody wants a piece of the dog (and a poke rarely beats its handling)
  if (c.kind === 'dog') rate *= 1.6;
  if (sh) rate *= 0.4;
  if (rand() < dt * rate) {
    out.pass = true;
    out.move = n;
    b.checkReady = state.time + randRange(1.6, 3.2);
  }
}

// ---------------------------------------------------------------------------
// PAL (only when the AI drives the dog: autoplay)

/** Barks per second while a bark would be useful: the AI dog uses it like a player would, now and then. */
const BARK_RATE = 0.9;

function dogBark(state: GameState, s: Skater, b: Brain, out: Out): void {
  if (s.barkCooldown > 0) return;
  const owner = state.puck.owner;
  let want = false;
  const roll = rand() < BARK_RATE / 60;
  if (owner !== null && roll) {
    const c = state.skaters[owner];
    // startle the carrier into fumbling it
    if (c.team !== s.team && !isGoalie(c) && d2(c.pos, s.pos) < BARK_FUMBLE_RADIUS - 0.3) want = true;
    if (c.id === s.id) {
      // carrying: a defender squaring up right in front of me
      const near = nearestOpp(state, s);
      const fwd = unit(s.vel.x, s.vel.z);
      if (near.o && near.d < BARK_RADIUS - 1.2 && near.o.stun <= 0 && inFront(s, near.o.pos, fwd, 0.6)) want = true;
    }
  }
  // an accidental bark (turbo pressed with opponents around) would stun them for free: the
  // turbo hysteresis in index.ts avoids those, see dogTurboOk
  out.turbo = out.turbo && dogTurboOk(state, s);
  // a bark is a fresh TURBO press: if we're already holding turbo, let go for a tick first
  if (want && b.bark === 0) b.bark = s.intent.turbo.held ? 1 : 2;
}

/**
 * Starting a sprint is a TURBO press, which barks (if off cooldown) when an opponent is
 * near (sim/actions.ts barkWanted). Only start one then if we mean to bark.
 */
function dogTurboOk(state: GameState, s: Skater): boolean {
  if (s.intent.turbo.held || s.barkCooldown > 0) return true;
  return !barkWanted(state, s);
}
