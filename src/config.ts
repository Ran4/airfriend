// Tunable constants. Gameplay agents may tune numbers here; don't rename keys
// without updating every importer.

import type { Position, SkaterAttrs, SkaterKind, TeamId } from './types';

// ---------------------------------------------------------------- screen ----
export const SCREEN = {
  width: 256, // SNES framebuffer
  height: 224,
  displayAspect: 4 / 3, // shown like a SNES on a CRT (pixels 8:7 wide)
} as const;

// Sprite pixel density shared by ART (authoring), ACTORS (billboard size) and
// RINK (camera tuning). A kid is ~26 px tall => ~1.95 m on screen (cartoon
// scale; players are drawn a bit larger than their physics radius, like every
// 16-bit sports game). The camera is tuned so that ~1 sprite texel ~= 1 screen
// pixel around the middle of the screen, i.e. ~13 px per meter there, which
// shows ~19 m of rink width (the camera pans sideways to follow play).
export const SPRITE_METERS_PER_PIXEL = 0.075;

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

// ------------------------------------------------------------------ rink ----
// Real NHL geometry, meters. Origin = center ice.
export const RINK = {
  halfWidth: 13.0, // 26 m wide
  halfLength: 30.5, // 61 m long
  cornerRadius: 8.5,
  goalLineZ: 26.5, // |z| of each goal line
  blueLineZ: 7.6, // |z| of each blue line (line center)
  lineWidth: 0.3,
  centerCircleR: 4.5,
  faceoffCircleR: 4.5,
  endDot: { x: 6.7, z: 20.5 }, // end-zone faceoff dots at (+-x, +-z)
  neutralDot: { x: 6.7, z: 6.1 }, // neutral-zone dots (no circles)
  creaseR: 1.8,
  boardHeight: 1.07,
  glassHeight: 2.4,
  // penalty boxes sit outside the +x boards. Box for team t is centered at
  // z = penaltyBoxZ[t]. Boxed skaters are parked at x = penaltyBoxX.
  penaltyBoxX: 14.6,
  penaltyBoxZ: [-4.0, 4.0] as const,
} as const;

export const GOAL = {
  halfWidth: 0.915, // 1.83 m mouth
  height: 1.22,
  depth: 1.0, // net extends this far behind the goal line
  postRadius: 0.05,
} as const;

// --------------------------------------------------------------- physics ----
export const PHYS = {
  // A released pad settles: from 9 m/s PAL coasts ~14 m / ~2.9 s (it used to be 34 m / 7.5 s)
  iceFriction: 2.8, // m/s^2 skater coast decel, no direction held
  coastStopFriction: 5.0, // ... rising linearly to this as he slows from coastStopSpeed to 0 (no creeping)
  coastStopSpeed: 4.0,
  windupGlide: 1.2, // coast decel while loading a shot with no direction held (keeps the rush-shot glide)
  stopDecel: 14.0, // m/s^2 when actively braking/turning hard
  turboMul: 1.35, // max speed multiplier while turbo
  staminaDrain: 0.45, // per second of turbo
  staminaRegen: 0.18, // per second when not turbo
  skaterRestitution: 0.35, // skater-vs-boards bounce
  puckFriction: 1.0, // m/s^2 on ice
  puckAirDrag: 0.05, // fraction/s
  puckRestitution: 0.7, // puck-vs-boards
  postRestitution: 0.8,
  gravity: 9.8,
  puckRadius: 0.0381,
  puckCarryDist: 0.55, // puck is carried this far in front of the skater
  pickupRadius: 0.75, // loose puck within this of the stick = pickup
  maxPickupSpeed: 22, // faster pucks need a reflex roll to receive
  shotSpeedMin: 21, // tap shot (quick release beats a goalie caught moving)
  shotSpeedMax: 34, // full windup slapper
  windupTime: 0.9, // seconds to full charge
  passSpeed: 17,
  pokeRange: 1.5,
  checkLungeSpeed: 3.0, // extra speed added during a check lunge
  checkRange: 1.2,
  knockdownForce: 5.0, // force above which the victim falls
  fallTime: 1.1,
} as const;

// ------------------------------------------------------------ human shot ----
// How a pad shot is aimed (sim/actions.ts releaseShot). The AI aims through
// intent.aimAt instead and keeps its own corner choice (ai/util pickCorner).
export const SHOT = {
  cornerX: 0.68, // LEFT/RIGHT held: inside that post (posts at +-0.915; a standing goalie covers +-0.45)
  cornerXFull: 0.62, // ... pulled in toward this for a full slapper, whose spread is wider
  autoX: 0.58, // no side held: the side the goalie is leaving open
  // corner shots get their height from the charge (NHL '94): tap low, full slapper high
  cornerYLow: 0.22,
  cornerYHigh: 0.95,
  cornerYCurve: 1.5, // height = low + (high - low) * charge^curve: a half shot stays medium
  tapErr: 0.018, // aim error (rad, sigma) of a tap, before the shooter's skill
  // ... plus up to chargeErr, growing as sqrt(charge) and topping out at
  // chargeErrFull: any real windup sprays more than a wrister; a slapper no more than that
  chargeErr: 0.039,
  chargeErrFull: 0.5,
  oneTimerRange: 18, // automatic one-timers only this close to the attacked net (m)
  oneTimerMaxHold: 1.2, // SHOOT held longer than this before the puck arrived = load a windup instead
  matePassTime: 0.8, // a teammate's pass this fresh still counts as "we have it" for PASS/SHOOT
  passIncomingTime: 1.5, // a teammate's pass to you this fresh is still "on its way"
} as const;

// ----------------------------------------------------------------- rules ----
export const RULES = {
  periods: 3,
  periodLength: 120, // seconds (2:00)
  overtimeLength: 120, // sudden death; still tied after this => TIE
  minorLength: 30, // seconds (scaled-down 2:00 minor)
  majorLength: 60, // seconds (scaled-down 5:00 major)
  // Penalty chance on a body check, by check force:
  //   p = clamp((force - penaltyForceMin) / (penaltyForceMax - penaltyForceMin), 0, 1) ^ penaltyCurve * penaltyMaxChance
  // plus situational multipliers (victim without puck = interference,
  // hit from behind, near boards) - see sim/penalties.ts.
  penaltyForceMin: 4.0,
  penaltyForceMax: 14.0,
  penaltyCurve: 1.6,
  penaltyMaxChance: 0.75,
  majorForce: 17.0, // force above which a called penalty becomes a major (mostly big kids flattening the dog)
  // phase durations (seconds)
  introTime: 3.2,
  faceoffDropDelay: 1.1, // lineup -> drop: fallback only (the sim randomizes state.faceoff.dropTime)
  // lineup -> drop is random so the drop can't be timed by counting
  faceoffDropMin: 0.8,
  faceoffDropMax: 1.6,
  // period openers (P1 after the intro, P2, P3, OT) hold the lineup longer so
  // the PERIOD / OVERTIME card can be read
  faceoffOpenerDropMin: 1.9,
  faceoffOpenerDropMax: 2.5,
  faceoffLoserRecvCd: 0.3, // the losing center can't touch the drawn puck this long
  goalCelebrateTime: 4.0,
  stoppageTime: 1.6,
  penaltyBannerTime: 2.8,
  periodEndTime: 2.5,
  intermissionTime: 9.0, // START skips
  goalieHoldTime: 1.2, // goalie holding puck before whistle
} as const;

// ----------------------------------------------------------------- teams ----
export interface TeamColors {
  jersey: string; // main jersey color  (CSS hex)
  jerseyDark: string; // shading
  trim: string; // stripes / numbers
  pants: string;
  helmet: string;
  socks: string;
}

interface RosterEntry {
  name: string;
  number: string;
  kind: SkaterKind;
  position: Position;
  attrs: SkaterAttrs;
}

interface TeamDef {
  id: TeamId;
  city: string;
  name: string; // "PUPS"
  abbr: string; // 3 letters for HUD
  colors: TeamColors;
  roster: RosterEntry[]; // exactly 5, order: C, W, LD, RD, G
}

const kid = (o: Partial<SkaterAttrs> = {}): SkaterAttrs => ({
  maxSpeed: 8.0,
  accel: 11.0,
  turn: 0.55,
  shot: 0.6,
  pass: 0.6,
  check: 0.55,
  handling: 0.55,
  weight: 45,
  radius: 0.42,
  ...o,
});

// The star. Light, quick, slippery; weak checker; startling bark (sim/actions.ts).
const DOG_ATTRS: SkaterAttrs = {
  maxSpeed: 9.0,
  accel: 15.0,
  turn: 0.9,
  shot: 0.75,
  pass: 0.75,
  check: 0.35,
  handling: 0.9,
  weight: 14,
  radius: 0.38,
};

const goalie = (o: Partial<SkaterAttrs> = {}): SkaterAttrs => ({
  maxSpeed: 4.0,
  accel: 14.0,
  turn: 0.7,
  shot: 0.3,
  pass: 0.5,
  check: 0.2,
  handling: 0.7, // goalie AI uses `handling` as reflex/save skill
  weight: 55,
  radius: 0.5,
  ...o,
});

export const TEAMS: [TeamDef, TeamDef] = [
  {
    id: 0,
    city: 'FERNFIELD',
    name: 'PUPS',
    abbr: 'PUP',
    colors: {
      jersey: '#d82828',
      jerseyDark: '#8c1010',
      trim: '#f8f8f8',
      pants: '#202040',
      helmet: '#d82828',
      socks: '#d82828',
    },
    roster: [
      { name: 'PAL', number: 'K9', kind: 'dog', position: 'C', attrs: DOG_ATTRS },
      { name: 'JOSH', number: '7', kind: 'kid', position: 'W', attrs: kid({ shot: 0.65, maxSpeed: 8.2 }) },
      { name: 'ANDREA', number: '4', kind: 'kid', position: 'LD', attrs: kid({ check: 0.65, pass: 0.65, weight: 50 }) },
      { name: 'TOM', number: '22', kind: 'kid', position: 'RD', attrs: kid({ check: 0.7, weight: 55, maxSpeed: 7.6 }) },
      { name: 'LARRY', number: '30', kind: 'goalie', position: 'G', attrs: goalie({ handling: 0.66 }) },
    ],
  },
  {
    id: 1,
    city: 'GLACIER BAY',
    name: 'BLIZZARD',
    abbr: 'BLZ',
    colors: {
      jersey: '#4830a8',
      jerseyDark: '#281870',
      trim: '#40d0c8',
      pants: '#181830',
      helmet: '#f8f8f8',
      socks: '#4830a8',
    },
    roster: [
      // the Blizzard are the better TEAM on paper (smoother hands, a sharper goalie); PAL evens it out
      { name: 'BRICK', number: '99', kind: 'kid', position: 'C', attrs: kid({ shot: 0.7, handling: 0.72, maxSpeed: 8.6, accel: 12 }) },
      { name: 'TANNER', number: '12', kind: 'kid', position: 'W', attrs: kid({ shot: 0.68, handling: 0.65, maxSpeed: 8.7, accel: 12 }) },
      { name: 'BUTCH', number: '44', kind: 'kid', position: 'LD', attrs: kid({ check: 0.85, handling: 0.62, weight: 62, maxSpeed: 7.9 }) },
      { name: 'KYLE', number: '5', kind: 'kid', position: 'RD', attrs: kid({ check: 0.75, handling: 0.62, weight: 58, maxSpeed: 8.1 }) },
      { name: 'IGOR', number: '1', kind: 'goalie', position: 'G', attrs: goalie({ handling: 0.76 }) },
    ],
  },
];

export const DOG_ID = 0;
