// Shared contracts for AIR FRIEND HOCKEY.
// Every module talks through these types. Keep this file free of logic.
//
// COORDINATES (sim + render agree on these):
//   meters; ice plane is X/Z, Y is up.
//   x: across the rink width   (-RINK.halfWidth .. +RINK.halfWidth)
//   z: along the rink length   (-RINK.halfLength .. +RINK.halfLength)
//   heading/facing angles: radians, a = atan2(dir.x, dir.z)
//     so a = 0 faces +z, a = +PI/2 faces +x.
//   See sim/rink.ts for attackDir() and screenToWorld().

export type TeamId = 0 | 1; // 0 = HOME (the human's team, with the dog), 1 = AWAY

export interface Vec2 {
  x: number;
  z: number;
}

export type SkaterKind = 'dog' | 'kid' | 'goalie';

// 4 skaters + goalie per team. The dog is HOME's center.
export type Position = 'C' | 'W' | 'LD' | 'RD' | 'G';

export interface SkaterAttrs {
  maxSpeed: number; // m/s, normal skating
  accel: number; // m/s^2
  turn: number; // agility 0..1 (higher = tighter turns, quicker stops)
  shot: number; // 0..1 shot power/accuracy
  pass: number; // 0..1 pass accuracy/speed
  check: number; // 0..1 body-check strength
  handling: number; // 0..1 puck control (resists pokes/fumbles)
  weight: number; // kg-ish, used in collisions/checks
  radius: number; // collision radius on ice, meters
}

// Edge-triggered button as seen by the sim (from human pad OR from AI).
export interface ButtonState {
  held: boolean;
  pressed: boolean; // went down this tick
  released: boolean; // went up this tick
}

// What a skater WANTS to do this tick. Written by input (human) or AI;
// interpreted identically by sim/actions.ts.
export interface Intent {
  move: Vec2; // desired direction in WORLD space, length 0..1
  shoot: ButtonState; // Z/J. with puck: hold=windup, release=shoot. without: poke check
  pass: ButtonState; // X/K. with puck: pass. without: body check (or "call for pass" if teammate has puck)
  turbo: ButtonState; // C/L. hold=sprint (stamina), press=bark (dog) / no-op (kids)
  // AI-only hints (humans leave undefined; sim picks automatically)
  passTarget?: number; // skater id to pass to
  aimAt?: Vec2; // world point to shoot at
  shield?: number; // carrying: tuck the puck in to this side (-1 backhand .. +1 forehand), away from a reaching stick
}

export type SkaterState =
  | 'skate' // normal (includes idle when slow)
  | 'windup' // charging a shot
  | 'shoot' // follow-through after release (short)
  | 'pass' // follow-through after pass (short)
  | 'poke' // poke-check animation
  | 'check' // body-check lunge
  | 'fallen' // knocked down, can't act
  | 'celebrate'
  | 'faceoff' // locked in faceoff stance
  | 'box' // in the penalty box (off the ice)
  // goalie-only
  | 'gReady'
  | 'gButterfly'
  | 'gDiveL' // diving toward SCREEN-left (camera view, see cameraHeading)
  | 'gDiveR' // diving toward SCREEN-right
  | 'gHold'; // goalie has covered the puck

interface SkaterStats {
  goals: number;
  assists: number;
  shots: number;
  hits: number;
  pim: number; // penalty seconds
}

export interface Skater {
  id: number; // 0..4 home (0 = dog), 5..9 away. goalies: 4 and 9
  team: TeamId;
  kind: SkaterKind;
  position: Position;
  name: string; // upper-case, <= 8 chars, e.g. "PAL", "TIMMY"
  number: string; // jersey, e.g. "K9", "17"
  attrs: SkaterAttrs;

  pos: Vec2;
  vel: Vec2;
  facing: number; // radians, see header
  intent: Intent;

  state: SkaterState;
  stateTime: number; // seconds since state entered
  windup: number; // 0..1 shot charge
  stamina: number; // 0..1 turbo meter
  turboActive: boolean;
  barkCooldown: number; // seconds until the dog can bark again
  stun: number; // seconds of reduced control left (startled/flinch)
  invuln: number; // seconds of check immunity after getting up

  stats: SkaterStats;
  /** sim-internal bookkeeping (always set by createGame). Render/HUD should not depend on it. */
  sim?: SkaterSimData;
}

/** Sim-internal per-skater timers and flags (owned by src/sim). */
export interface SkaterSimData {
  actionCd: number; // poke/check cooldown
  lunge: Vec2; // body-check lunge direction
  hitDone: boolean; // this lunge already connected
  checkTurbo: boolean; // lunge started under turbo (heavier hit)
  pokeDone: boolean; // this poke already resolved
  stopCd: number; // hardStop event cooldown
  turboLock: boolean; // stamina hit 0: no turbo until > 0.25
  recvCd: number; // failed reception: can't touch the puck briefly
  lastOwnTime: number; // state.time when this skater last carried the puck
  shootHeldTime: number; // how long SHOOT has been held without the puck (one-timers)
  boardsCd: number; // bodyBoards event cooldown
  hitTime: number; // state.time of the last check received (for bodyBoards)
  pokedAt?: number; // state.time an opponent's poke last reached this carrier (he's guarding it now)
  turboTapAt?: number; // dog: state.time of a TURBO press that may still turn out to be a tap (= bark); -1/undefined = none
  // goalie
  react: number; // seconds until the goalie reacts to the incoming shot (-1 = none pending)
  shotSeq: number; // which shot the goalie is tracking
  saveX: number; // predicted world x where the shot crosses the goalie
  saveY: number; // predicted height there
  lateral: number; // smoothed lateral puck speed (slows reactions)
  carryTime: number; // goalie holding a loose puck it picked up (auto-clears)
  diveDir: number; // world x sign of the current dive
}

/** "Call for pass/shot": the human pressed PASS/SHOOT while a teammate carries the puck. */
interface CallFor {
  kind: 'pass' | 'shot';
  from: number; // skater who called (usually state.controlledId)
  carrier: number; // teammate carrying the puck when called
  time: number; // state.time of the call; expires after ~1.2 s or when the carrier loses the puck
}

/** Sim-internal game bookkeeping (owned by src/sim). */
export interface GameSimData {
  aiEnabled: boolean; // false in unit tests that drive intents by hand
  introLen: number;
  goalPending: TeamId | null; // set by puck physics, handled by game.ts
  outOfPlay: boolean; // puck left the rink
  frozenBy: number | null; // goalie holding the puck (gHold)
  holdTime: number;
  nextSpot: Vec2 | null; // faceoff spot after the current stoppage
  lastWarnSec: number;
  pass: { from: number; to: number; time: number } | null;
  lastShot: { shooter: number; team: TeamId; time: number; counted: boolean } | null;
  shotSeq: number; // bumps whenever a new shot/deflection starts
  touchChain: number[]; // same-team touch sequence (assists)
  lastTouchByTeam: [number | null, number | null];
  noTouchTime: number;
  takers: [number, number]; // faceoff takers
  react: [number, number]; // AI faceoff reaction delays
  aiFalseStart: [number, number]; // phaseTime of a scripted AI false start (-1 = none)
  faceoffDone: boolean;
  lastSwitchTime: number;
  /** state.time until which START is ignored (just after an intermission ends) */
  startGuardUntil: number;
  /** fouls rolled during live play whose whistle is delayed (see GameState.delayedPenalty), in order */
  pendingPenalties: Penalty[];
  /** a skater of a team with a pending foul touched the puck this tick: whistle at the end of it */
  delayedTouch: boolean;
  boardsCd: number;
  postCd: number;
  netCd: number;
}

interface Puck {
  pos: Vec2;
  y: number; // height above ice (lifted shots, saucer passes)
  vel: Vec2;
  vy: number;
  owner: number | null; // skater id carrying it
  lastTouch: number | null; // skater id
  prevTouch: number | null; // for assists (same team only counts)
  pickupBlock: number; // seconds during which `blockId` cannot pick it up
  blockId: number | null;
  spin: number; // visual only
}

export interface Penalty {
  skaterId: number;
  team: TeamId;
  infraction: string; // "ROUGHING", "CHARGING", "BOARDING", ...
  duration: number; // seconds total (game clock)
  remaining: number; // seconds left (counts down only while clock runs)
  major: boolean; // majors are served in full even if PP team scores
  /** which of the team's two penalty-box seats (0/1) the offender sits in; set when he goes in */
  seat?: number;
}

export type Phase =
  | 'intro' // game start: title flash + camera sweep, no input
  | 'faceoff' // players lined up, waiting for drop / drop happened, waiting for win
  | 'play'
  | 'goal' // goal scored: celebration, banner
  | 'stoppage' // whistle (goalie freeze, puck out) -> faceoff
  | 'penalty' // penalty called: banner, player to box -> faceoff
  | 'periodEnd' // horn; brief pause before intermission
  | 'intermission' // stats screen, teams switch ends
  | 'gameOver'; // final screen, START = rematch

interface FaceoffInfo {
  spot: Vec2;
  dropped: boolean;
  dropTime: number; // phaseTime at which the ref drops the puck
  earlyPress: [boolean, boolean]; // false start per team
}

export interface GoalInfo {
  team: TeamId; // team that SCORED
  scorer: number; // skater id
  assists: number[]; // up to 2 skater ids
  period: number;
  clock: number; // clock remaining when scored
  powerPlay: boolean;
  shortHanded: boolean;
}

interface Referee {
  pos: Vec2;
  vel: Vec2;
  facing: number;
  state: 'skate' | 'whistle' | 'point' | 'drop';
  stateTime: number;
}

export interface GameState {
  phase: Phase;
  phaseTime: number; // seconds in current phase
  period: number; // 1..3, 4 = overtime
  clock: number; // seconds remaining in period
  score: [number, number];
  shots: [number, number];
  hits: [number, number];
  periodGoals: number[][]; // [period-1][team]
  skaters: Skater[]; // always 10, index === id
  puck: Puck;
  referee: Referee;
  penalties: Penalty[]; // active (being served)
  faceoff: FaceoffInfo | null;
  goals: GoalInfo[]; // full scoring summary
  lastPenaltyCall: Penalty | null; // for the PENALTY banner
  controlledId: number; // home skater the human controls (0 = dog unless dog is boxed)
  /**
   * true while PAL is back on the ice from the box but control is deliberately
   * kept on the kid who has the puck (or a pass on its way, or a shot loading).
   * Control goes to PAL when the kid passes, shoots or loses it, or play stops.
   * The HUD shows 'PAL READY'. Undefined = false.
   */
  dogReturnPending?: boolean;
  /**
   * A delayed penalty: a foul has been rolled but play goes on until the
   * offending team (`team`) touches the puck, the puck goes dead, or 10 s
   * pass. `skaterId` is the (first) offender, `t` the state.time the delay
   * began. Non-null only during phase 'play'. Undefined = null.
   */
  delayedPenalty?: { team: TeamId; skaterId: number; t: number } | null;
  winner: TeamId | null | 'tie'; // set at gameOver
  events: GameEvent[]; // emitted during the most recent stepGame(); consumers read, sim clears
  tick: number; // sim ticks since game start
  time: number; // total sim seconds
  paused: boolean;
  /** true when the human pad is replaced by AI (?autoplay=1 / tests) */
  autoplay: boolean;
  /** active call for pass/shot (AI carriers should honor it), or null */
  callFor?: CallFor | null;
  /** penalties waiting for a box slot (a team never drops below 2 skaters + goalie) */
  penaltyQueue?: Penalty[];
  /** sim-internal bookkeeping (always set by createGame) */
  sim?: GameSimData;
}

// Events emitted by the sim each tick. Audio/HUD/render react to them.
export type GameEvent =
  | { type: 'introStart' }
  | { type: 'periodStart'; period: number }
  | { type: 'faceoffSetup'; spot: Vec2 }
  | { type: 'faceoffDrop' }
  | { type: 'faceoffWin'; team: TeamId; skaterId: number }
  | { type: 'pickup'; skaterId: number }
  | { type: 'pass'; from: number; to: number | null; speed: number }
  | { type: 'passReceived'; from: number; to: number }
  | { type: 'shot'; shooter: number; power: number; lifted: boolean }
  | { type: 'save'; goalie: number; caught: boolean }
  | { type: 'post'; pos: Vec2 }
  | { type: 'boards'; pos: Vec2; speed: number } // puck hits boards
  | { type: 'bodyBoards'; skaterId: number; speed: number } // skater slams boards
  | { type: 'netHit'; pos: Vec2 } // puck hits outside of net
  | { type: 'goal'; info: GoalInfo }
  | { type: 'poke'; skaterId: number; success: boolean }
  | { type: 'steal'; skaterId: number; fromId: number }
  | { type: 'check'; hitter: number; victim: number; force: number; knockedDown: boolean }
  | { type: 'whistle'; reason: 'freeze' | 'penalty' | 'offIce' | 'goal' }
  | { type: 'penalty'; penalty: Penalty }
  | { type: 'delayedPenalty'; team: TeamId; skaterId: number } // foul rolled, whistle delayed (team = offender)
  | { type: 'penaltyExpired'; skaterId: number }
  | { type: 'periodEnd'; period: number }
  | { type: 'intermissionStart'; nextPeriod: number }
  | { type: 'gameOver'; winner: TeamId | 'tie' }
  | { type: 'bark'; skaterId: number; startled: number[] }
  | { type: 'turboStart'; skaterId: number }
  | { type: 'hardStop'; skaterId: number; speed: number } // ice-spray stop
  | { type: 'fumble'; skaterId: number }
  | { type: 'controlSwitch'; skaterId: number }
  | { type: 'clockWarning' } // last 10 s of a period, once per second
  | { type: 'rematch' }
  | { type: 'falseStart'; team: TeamId; skaterId: number } // center jumped the faceoff drop
  | { type: 'callFor'; kind: 'pass' | 'shot'; skaterId: number; carrier: number }; // "HEY!" call to the carrier

// What the human's keyboard produces (screen-space). main.ts converts it via
// sim/rink.ts screenToWorld() into an Intent for skaters[controlledId].
export interface PadState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  shoot: ButtonState; // Z or J
  pass: ButtonState; // X or K
  turbo: ButtonState; // C or L
  start: ButtonState; // Enter / P / Esc  (pause, skip intermission, rematch)
}
