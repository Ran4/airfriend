// The whole SNES interface, drawn onto a 256x224 2D canvas laid over the 3D
// view on the same pixel grid. Public API: constructor(canvas),
// onEvents(events, state), draw(state, dt, project).
//
// Timing: banners are stamped with SIM time (state.time) when their event
// arrives, so they line up with the sim's phase durations at any ?speed=.
// Blinking and palette cycling use a wall clock that keeps running while
// paused, like a real cartridge's frame counter.
//
// Every banner is event-driven, with a phase-driven fallback: if the HUD
// finds itself in phase 'goal' / 'penalty' / 'periodEnd' without having seen
// the event (e.g. it was constructed mid-game), it rebuilds the banner from
// state, so nothing is ever missing.

import { DOG_ID, RULES, SCREEN, TEAMS } from '../config';
import { BARK_COOLDOWN } from '../sim/actions';
import type { GameEvent, GameState, GoalInfo, PadState, Penalty, Phase, Skater, TeamId } from '../types';
import { banner, bannerChars, bannerStyle, cycle, pingPong } from './banners';
import { drawText, textWidth } from './font';
import { atPeriodStart, blink, clockStr, jersey, periodName, periodTitle, slide } from './format';
import { C, GRAD, snes, TEAM_PAL, teamGrad } from './palette';
import { drawControls, drawFinal, drawIntermission, drawIntro, drawPause, drawPeriodCard, FINAL_PAGES, type PauseStatus } from './screens';
import {
  drawBarkBubble,
  drawChip,
  drawIcon,
  drawJerseyIcon,
  drawMeter,
  drawPortrait,
  drawWindow,
  ICONS,
  rect,
  teamTheme,
  THEMES,
  type G,
  type WindowTheme,
} from './window';

export type Projector = (x: number, y: number, z: number) => { x: number; y: number; onScreen: boolean };

const W = SCREEN.width;
const H = SCREEN.height;

type CenterKind = 'drop' | 'falseStart' | 'goal' | 'periodEnd';
interface Center {
  kind: CenterKind;
  t0: number;
  team?: TeamId;
  period?: number;
  /** DROP! / FALSE START!: the row it was posted on (kept so it never jumps when the card goes) */
  y?: number;
  /** FALSE START!: show the 'WAIT FOR THE DROP!' coaching line */
  hint?: boolean;
}

/**
 * Top safe line: the first free row under the score bug (y 7-25), or under
 * the strip row (y 27-41) while it is up: power play / 4 ON 4 / IS BACK, the
 * SOG chyron while the puck is dead, or the DELAYED PENALTY chip. When the
 * chip has to stack under a power-play strip (y 43-57) the line is `chip`.
 * Banners, the off-screen arrow, name tags and pops all stay below it.
 */
const SAFE = { bug: 28, strip: 44, chip: 60 } as const;

/** DELAYED PENALTY chip rows (top y): the strip row, or under a strip that is up */
const DELAYED_ROW = { strip: 27, under: 43 } as const;
/** the phases the chip can show in (the call itself is a 'penalty' phase) */
const DELAYED_PHASES: Phase[] = ['play', 'stoppage'];

interface Delayed {
  team: TeamId;
  skaterId: number;
}

/**
 * The sim's delayed penalty (team = the offending team), read defensively:
 * `GameState.delayedPenalty` is an additive gameplay-lane field that may not
 * exist (yet). Anything absent or malformed reads as "none".
 */
function readDelayed(state: GameState): Delayed | null {
  const d = (state as unknown as { delayedPenalty?: unknown }).delayedPenalty;
  if (!d || typeof d !== 'object') return null;
  const { team, skaterId } = d as { team?: unknown; skaterId?: unknown };
  if (team !== 0 && team !== 1) return null;
  return { team, skaterId: typeof skaterId === 'number' ? skaterId : -1 };
}

/**
 * Faceoff lineup rows (top y of each line), in one place so the safe-area
 * layout can offset them together. The period / OVERTIME! card sits on top;
 * the action line (FACE OFF! / FALSE START! / DROP!) drops below whatever
 * card is up. Values are for the bare score bug (SAFE.bug); with the PP
 * strip up the whole stack moves down by SAFE.strip - SAFE.bug.
 */
const LINEUP = {
  card: 34, // 2ND PERIOD / OVERTIME!
  sudden: 56, // SUDDEN DEATH, under OVERTIME!
  action: 44, // action line with no card
  actionCard: 62, // ... under a period card
  actionOT: 80, // ... under OVERTIME! + SUDDEN DEATH
  chip: 20, // team chip below FALSE START!
  hint: 34, // WAIT FOR THE DROP! below FALSE START!
} as const;

type WinKind = 'scorer' | 'penalty';
interface Win {
  kind: WinKind;
  t0: number;
  goal?: GoalInfo;
  penalty?: Penalty;
  seq: number;
}

interface Pop {
  text: string;
  t0: number;
  world: { x: number; y: number; z: number } | null;
  sx: number;
  sy: number;
  grad: readonly string[];
  life: number;
}

/** power-play strip contents (null = no strip this frame) */
interface Strip {
  /** drawn in yellow ahead of `text` (the SOG label) */
  lead?: string;
  text: string;
  theme: WindowTheme;
  color: string;
  remain: number;
}

/** the controlled skater's marker reaches this far above the head point */
const MARKER_REACH = 18;
/** how far the turbo window drops to get out of the scorer window's way (with PAL's tab on top) */
const TURBO_HIDE = 46;
/** turbo window: bottom-left corner; PAL's ARF balloon sits in its right column */
const TURBO = { x: 8, y: 194, w: 98, h: 22 } as const;
/** the PAL status tab stacked on the turbo window while a kid has control */
const TAB_H = 15;
/** PAL READY tab: grass green, so it can't be mistaken for the red box tab */
const READY_THEME: WindowTheme = {
  top: snes('#48c048'),
  bottom: snes('#085010'),
  edge: C.winEdge,
  light: C.winLight,
  mid: snes('#a0d0a0'),
  inner: snes('#043008'),
};

/**
 * GOAL!! banner row (top y), placed away from the net the camera is framing
 * (measured with tools/hud-goalcheck.mjs). The camera always sits behind
 * HOME's defending end, so a HOME goal is in the far net (net, crease and
 * lamp at y ~30-115 while celebrating): the word goes in the lower-middle
 * third, clear of the scorer window; PAL's PAWSOME! line, which rises into
 * that row, takes over from it. An AWAY goal is in the near net (y ~98-170):
 * the word goes in the upper third, just under the PP strip's row so it never
 * has to move for it.
 */
const GOAL_ROW: Record<TeamId, number> = { 0: 118, 1: SAFE.strip + 2 };
/** the GOAL!! word's footprint below its row: 32 px of 2x banner font + outline and drop */
const GOAL_H = 36;
/** the scorer window's resting top edge */
const SCORER_Y = 160;
/** PAL's flavor line (PAWSOME! ...) pops up this long after the scorer window */
const FLAVOR_AT = 0.25;

const GOAL_FLAVOR = ['WHAT A DOG!', 'GOOD BOY!', 'AIR FRIEND!', 'PAWSOME!', "WHO'S A GOOD BOY?", 'ARF ARF ARF!'];

// how long each piece stays up (sim seconds)
const T = {
  drop: 0.75,
  falseStart: 1.5,
  goalText: 2.0,
  // GOAL!! slams in a beat after the puck crosses, so the net, the lamp and
  // the sparkle read first
  goalDelay: 0.35,
  scorerDelay: 1.5,
  scorer: 3.0,
  penalty: RULES.penaltyBannerTime + 0.2,
  winMin: 2.0, // a faceoff may only cut a window short after this long
  periodEnd: RULES.periodEndTime + 0.5,
  tag: 1.6,
  ppNotice: 1.6,
  // a period opener's card stays at least this long, even if the puck drops first
  cardHold: 1.5,
  // the ARF balloon's white flash when the bark comes back
  barkFlash: 0.3,
  // PAL IN THE BOX! (posted when the PENALTY window has gone)
  boxCallout: 2.0,
  // final screen: the result page stays up this long the first time (the
  // stars skate in until ~1.7 s), then the pages flip every finalPage
  finalFirst: 5.0,
  finalPage: 4.0,
  // SHOOT can't flip the final screen this soon after it opens
  finalShootGuard: 0.8,
} as const;

/** phases in which the in-game HUD (score bug, meters) is visible */
const LIVE: Phase[] = ['faceoff', 'play', 'goal', 'stoppage', 'penalty', 'periodEnd'];

/** seconds of opening live play (period 1, game clock) the controls card stays up */
const CONTROLS_PLAY_SECS = 6;

export class Hud {
  private g: CanvasRenderingContext2D;
  private wall = 0;
  private center: Center | null = null;
  private win: Win | null = null;
  private pops: Pop[] = [];
  /** mute / CRT switches for the pause window (set by main.ts; null = unknown) */
  status: PauseStatus | null = null;
  private tag: { id: number; t0: number } | null = null;
  private ppNotice: { t0: number; text: string } | null = null;
  private lastShot = { power: 0, time: -99 };
  private endedPeriod = 0;
  private nextPeriod = 0;
  private screenT0 = 0; // when intermission / final screen opened
  private lastPhase: Phase | null = null;
  private bugT0 = -99; // when the score bug started sliding in
  private bugShown = false;
  private scoreFlash: { team: TeamId; t0: number } | null = null;
  private falseSeen: [boolean, boolean] = [false, false];
  /** the human has already been told to WAIT FOR THE DROP! this game */
  private falseHinted = false;
  /** period / OVERTIME! card of the current period-opening faceoff */
  private card: { period: number; t0: number } | null = null;
  private winSeq = 0;
  private goalsShown = 0; // state.goals entries already celebrated
  private lastTime = 0;
  /** the sim shortens the intro to 1.5 s on a rematch (DESIGN.md 4) */
  private introLen: number = RULES.introTime;
  /** this frame's top safe line (SAFE.bug or SAFE.strip) */
  private top: number = SAFE.bug;
  /** the lineup's safe line: latched for a faceoff, so the stack never jumps up mid-lineup */
  private lineTop: number = SAFE.bug;
  /** turbo window drop (px): it slides down out of the scorer window's way */
  private turboDrop = 0;
  private lastDrawTime = 0;
  /** PAL's bark cooldown last frame, and when it last came back (sim time) */
  private barkPrev = 0;
  private barkReadyT = -99;
  /** PAL IN THE BOX! waiting for the PENALTY window to go (sim time it goes up) */
  private boxCallout: number | null = null;
  /** PAL status tab on the turbo window: what it shows and since when (sim time) */
  private palTab: { kind: 'box' | 'ready'; t0: number } | null = null;
  /** every penalty called this game, for the stat screens' PIM (sim stats only keep seconds) */
  private penLog: Penalty[] = [];
  /** final screen page: which one, since when (sim time), and for which screen opening */
  private book = { page: 0, t0: 0, screen: NaN };
  /** DELAYED PENALTY chip: the call it shows, when it popped (sim time) and its eased row */
  private delayed: (Delayed & { t0: number; y: number }) | null = null;
  /** where the GOAL!! banner was last drawn (screen px), for the test tools */
  goalBox: { x: number; y: number; w: number; h: number } | null = null;
  /** where the DELAYED PENALTY chip was last drawn (screen px), for the test tools */
  delayedBox: { x: number; y: number; w: number; h: number } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = SCREEN.width;
    canvas.height = SCREEN.height;
    this.g = canvas.getContext('2d')!;
    this.g.imageSmoothingEnabled = false;
  }

  // ------------------------------------------------------------- events ----
  onEvents(events: GameEvent[], state: GameState): void {
    this.sync(state);
    const now = state.time;
    const isRematch = events.some((e) => e.type === 'rematch');
    for (const e of events) {
      // gameplay's { type: 'delayedPenalty', team, skaterId } (matched loosely,
      // so this compiles before the event joins the GameEvent union): pop the
      // chip again. sync() has already put it up from state.delayedPenalty.
      if ((e as { type: string }).type === 'delayedPenalty') {
        if (this.delayed) this.delayed.t0 = now;
        continue;
      }
      switch (e.type) {
        case 'introStart':
        case 'rematch':
          this.reset(now);
          // the fresh game re-announces introStart on its first tick; that
          // one must not undo the short rematch intro
          if (isRematch) this.introLen = 1.5;
          else if (!(this.introLen < 2 && now < 0.5)) this.introLen = RULES.introTime;
          break;
        case 'faceoffSetup':
          // a faceoff ends whatever was on screen, but lets a window that has
          // barely appeared stay long enough to be read
          if (this.center?.kind !== 'falseStart') this.center = null;
          if (this.win && now - this.win.t0 > T.winMin) this.win = null;
          this.falseSeen = [false, false];
          break;
        case 'faceoffDrop':
          // a FALSE START! is the reason the faceoff is lost: let it finish
          // (it may well have been posted only a moment before the drop)
          if (this.center?.kind === 'falseStart' && now - this.center.t0 < T.falseStart) break;
          this.center = { kind: 'drop', t0: now, y: this.actionY() };
          break;
        case 'falseStart': {
          // sync() has normally posted it from the faceoff flags already
          if (this.center?.kind !== 'falseStart' || this.center.team !== e.team) this.postFalseStart(e.team, now);
          const c = this.center;
          // the first time the player jumps the drop, say what went wrong
          if (c && e.team === 0 && e.skaterId === state.controlledId && !state.autoplay && !this.falseHinted) {
            c.hint = true;
            this.falseHinted = true;
          }
          break;
        }
        case 'goal':
          this.onGoal(e.info, now, state.goals.length);
          break;
        case 'penalty':
          if (this.center?.kind !== 'goal') this.center = null;
          this.win = { kind: 'penalty', t0: now, penalty: e.penalty, seq: this.winSeq++ };
          // the PENALTY window tells the story of the hit; a BIG HIT! pop
          // would only collide with its title
          this.pops = [];
          // the delayed call has been made: its chip has done its job
          this.delayed = null;
          // the human just lost PAL to a kid: say so once the window has gone
          if (e.penalty.skaterId === DOG_ID) this.boxCallout = now + T.penalty;
          this.logPenalty(e.penalty);
          break;
        case 'check':
          if (e.knockedDown) {
            const v = state.skaters[e.victim];
            this.pop(e.force >= PHYS_BIG_HIT ? 'HUGE HIT!' : 'BIG HIT!', now, v ? { x: v.pos.x, y: 2.4, z: v.pos.z } : null, GRAD.fire);
          }
          break;
        case 'post':
          this.pop('POST!', now, { x: e.pos.x, y: 1.6, z: e.pos.z }, GRAD.silver);
          break;
        case 'shot':
          // power may arrive as 0..1 charge or as m/s; normalize to 0..1
          this.lastShot = { power: e.power > 1.5 ? e.power / 34 : e.power, time: now };
          break;
        case 'save': {
          const big = now - this.lastShot.time < 2.5 ? this.lastShot.power : 0;
          if (big >= 0.55) {
            const gk = state.skaters[e.goalie];
            this.pop(big >= 0.85 ? 'GREAT SAVE!' : 'SAVE!', now, gk ? { x: gk.pos.x, y: 2.6, z: gk.pos.z } : null, GRAD.ice);
          }
          break;
        }
        case 'whistle':
          if (e.reason === 'offIce') this.pop('OUT OF PLAY', now, null, GRAD.white, W / 2, 64);
          break;
        case 'periodEnd':
          this.endedPeriod = e.period;
          this.center = { kind: 'periodEnd', t0: now, period: e.period };
          if (this.win && now - this.win.t0 > T.winMin) this.win = null;
          break;
        case 'intermissionStart':
          this.nextPeriod = e.nextPeriod;
          this.screenT0 = now;
          this.center = null;
          this.pops = [];
          break;
        case 'gameOver':
          this.screenT0 = now;
          this.center = null;
          this.win = null;
          this.pops = [];
          break;
        case 'penaltyExpired': {
          const s = state.skaters[e.skaterId];
          this.ppNotice = { t0: now, text: s ? `${jersey(s)} ${s.name} IS BACK` : 'PENALTY OVER' };
          break;
        }
        case 'controlSwitch':
          this.tag = { id: e.skaterId, t0: now };
          break;
        default:
          break;
      }
    }
  }

  private onGoal(info: GoalInfo, now: number, count: number): void {
    this.goalsShown = count;
    this.center = { kind: 'goal', t0: now, team: info.team };
    this.win = { kind: 'scorer', t0: now + T.scorerDelay, goal: info, seq: this.winSeq++ };
    this.scoreFlash = { team: info.team, t0: now };
    this.pops = [];
  }

  private reset(now: number): void {
    this.center = null;
    this.win = null;
    this.pops = [];
    this.tag = null;
    this.ppNotice = null;
    this.scoreFlash = null;
    this.bugShown = false;
    this.endedPeriod = 0;
    this.lastShot = { power: 0, time: -99 };
    this.falseSeen = [false, false];
    this.falseHinted = false;
    this.card = null;
    this.goalsShown = 0;
    this.lastTime = now;
    this.turboDrop = 0;
    this.lastDrawTime = now;
    this.barkPrev = 0;
    this.barkReadyT = -99;
    this.boxCallout = null;
    this.palTab = null;
    this.penLog = [];
    this.book = { page: 0, t0: now, screen: NaN };
    this.delayed = null;
  }

  private logPenalty(p: Penalty | null): void {
    if (p && !this.penLog.includes(p)) this.penLog.push(p);
  }

  /**
   * Optional pad hook (main.ts may call it every tick with the human pad):
   * SHOOT flips the final screen's pages. Without it they flip on a timer.
   */
  onPad(pad: PadState, state: GameState): void {
    if (state.phase !== 'gameOver' || !pad.shoot?.pressed) return;
    const now = state.time;
    if (now - this.screenT0 < T.finalShootGuard) return;
    const b = this.finalBook(now);
    b.page = (b.page + 1) % FINAL_PAGES;
    b.t0 = now;
  }

  /** the final screen's current page, flipping on its timer */
  private finalBook(now: number): { page: number; t0: number } {
    let b = this.book;
    if (b.screen !== this.screenT0 || now < b.t0 - 0.01) b = this.book = { page: 0, t0: this.screenT0, screen: this.screenT0 };
    const first = b.page === 0 && b.t0 <= this.screenT0 + 1e-6;
    if (now - b.t0 >= (first ? T.finalFirst : T.finalPage)) {
      b.page = (b.page + 1) % FINAL_PAGES;
      b.t0 = now;
    }
    return b;
  }

  private postFalseStart(team: TeamId, now: number): void {
    this.falseSeen[team] = true;
    this.center = { kind: 'falseStart', t0: now, team, y: this.actionY() };
  }

  /** the lineup's action row: below the period card when one is up */
  private actionY(): number {
    const dy = this.lineTop - SAFE.bug;
    if (!this.card) return LINEUP.action + dy;
    return (this.card.period >= 4 ? LINEUP.actionOT : LINEUP.actionCard) + dy;
  }

  private pop(text: string, now: number, world: Pop['world'], grad: readonly string[], sx = W / 2, sy = 80): void {
    // a goal owns the screen, even if the post/save arrived in the same tick
    if (this.center?.kind === 'goal' && now - this.center.t0 < T.goalDelay + T.goalText) return;
    // newest first; never more than 3 on screen, like a sprite budget
    this.pops.unshift({ text, t0: now, world, sx, sy, grad, life: 1.0 });
    this.pops.length = Math.min(this.pops.length, 3);
  }

  /** per-frame bookkeeping that must work even without events */
  private sync(state: GameState): void {
    const now = state.time;
    // a fresh GameState (restart()) rewinds time: drop everything stale
    if (now + 1e-6 < this.lastTime) this.reset(now);
    this.lastTime = now;
    const entered = state.phase !== this.lastPhase;
    const phaseStart = now - state.phaseTime;
    if (entered) {
      this.lastPhase = state.phase;
      if (state.phase === 'intermission' || state.phase === 'gameOver') {
        if (now - this.screenT0 > state.phaseTime + 0.05 || this.screenT0 > now) this.screenT0 = phaseStart;
      }
      if (state.phase === 'intro') this.reset(now);
      // a period opener (2ND, 3RD, OT) gets its title card for the lineup
      if (state.phase === 'faceoff' && state.period >= 2 && atPeriodStart(state)) {
        this.card = { period: state.period, t0: phaseStart };
      }
    }
    if (this.card) {
      const lineup = state.phase === 'faceoff' && !state.faceoff?.dropped;
      const playing = state.phase === 'faceoff' || state.phase === 'play';
      // a FALSE START! / DROP! posted under the card keeps it for company
      const c = this.center;
      const under = !!c && (c.kind === 'falseStart' || c.kind === 'drop') && c.t0 >= this.card.t0;
      const held = lineup || under || now - this.card.t0 <= T.cardHold;
      if (!playing || state.period !== this.card.period || !held || now < this.card.t0 - 0.01) {
        this.card = null;
      }
    }
    // fallbacks for banners whose event we never saw
    if (state.phase === 'goal' && state.goals.length > this.goalsShown) {
      this.onGoal(state.goals[state.goals.length - 1], phaseStart, state.goals.length);
    }
    this.logPenalty(state.lastPenaltyCall);
    if (state.phase === 'penalty' && this.win?.kind !== 'penalty' && state.lastPenaltyCall && state.phaseTime < T.penalty) {
      this.win = { kind: 'penalty', t0: phaseStart, penalty: state.lastPenaltyCall, seq: this.winSeq++ };
      if (state.lastPenaltyCall.skaterId === DOG_ID) this.boxCallout = phaseStart + T.penalty;
    }
    this.syncPal(state, now);
    if (state.phase === 'periodEnd' && this.center?.kind !== 'periodEnd') {
      this.endedPeriod = state.period;
      this.center = { kind: 'periodEnd', t0: phaseStart, period: state.period };
    }
    // (the sim bumps state.period only when the intermission ends)
    if (state.phase === 'intermission' && !this.endedPeriod) this.endedPeriod = state.period;
    // false starts have no event of their own: watch the faceoff flags
    const fo = state.faceoff;
    if (state.phase === 'faceoff' && fo) {
      for (const t of [0, 1] as TeamId[]) {
        if (fo.earlyPress[t] && !this.falseSeen[t]) this.postFalseStart(t, now);
      }
    }
    // expire
    if (this.center) {
      const age = now - this.center.t0;
      const life =
        this.center.kind === 'drop' ? T.drop : this.center.kind === 'falseStart' ? T.falseStart : this.center.kind === 'goal' ? T.goalDelay + T.goalText : T.periodEnd;
      if (age > life || age < -0.01) this.center = null;
    }
    if (this.win) {
      const age = now - this.win.t0;
      const life = this.win.kind === 'scorer' ? T.scorer : T.penalty;
      if (age > life || age < -T.scorerDelay - 0.01) this.win = null;
    }
    this.pops = this.pops.filter((p) => now - p.t0 < p.life && now >= p.t0 - 0.01);
    if (this.tag && now - this.tag.t0 > T.tag) this.tag = null;
    if (this.ppNotice && now - this.ppNotice.t0 > T.ppNotice) this.ppNotice = null;
    // delayed penalty: up while the sim says so and the puck is in play (or
    // just whistled dead); a new offender pops a fresh chip
    const dp = DELAYED_PHASES.includes(state.phase) ? readDelayed(state) : null;
    const d = this.delayed;
    if (!dp) this.delayed = null;
    else if (!d || d.team !== dp.team || d.skaterId !== dp.skaterId || now < d.t0 - 0.01) this.delayed = { ...dp, t0: now, y: NaN };
    // top safe line; a faceoff lineup keeps the lowest one it has seen, so a
    // PP notice running out mid-lineup can't make the banners jump up
    const strip = !!this.strip(state);
    this.top = this.delayed ? (strip ? SAFE.chip : SAFE.strip) : strip ? SAFE.strip : SAFE.bug;
    if (entered && state.phase === 'faceoff') this.lineTop = this.top;
    else if (state.phase === 'faceoff' || this.card) this.lineTop = Math.max(this.lineTop, this.top);
    else this.lineTop = this.top;
    // score bug slides in each time it (re)appears
    const live = LIVE.includes(state.phase);
    if (live && !this.bugShown) this.bugT0 = now;
    this.bugShown = live;
  }

  /** PAL bookkeeping: the bark lamp's recharge flash and the box callout */
  private syncPal(state: GameState, now: number): void {
    const dog = state.skaters[DOG_ID];
    const cd = dog?.barkCooldown ?? 0;
    if (this.barkPrev > 0 && cd <= 0) this.barkReadyT = now;
    this.barkPrev = cd;
    if (this.boxCallout !== null && now >= this.boxCallout) {
      this.boxCallout = null;
      // only if he is really sitting (a full box queues him on the ice) and
      // nothing bigger has the screen
      const live = state.phase === 'faceoff' || state.phase === 'play' || state.phase === 'stoppage';
      if (dog?.state === 'box' && live && this.center?.kind !== 'goal') {
        this.pops.unshift({ text: 'PAL IN THE BOX!', t0: now, world: null, sx: W / 2, sy: 152, grad: GRAD.red, life: T.boxCallout });
        this.pops.length = Math.min(this.pops.length, 3);
      }
    }
  }

  /** PAL's penalty time left, counting any minor he still owes after this one */
  private dogBoxTime(state: GameState): number {
    let t = 0;
    for (const p of state.penalties) if (p.skaterId === DOG_ID) t += p.remaining;
    for (const p of state.penaltyQueue ?? []) if (p.skaterId === DOG_ID) t += p.remaining;
    return t;
  }

  // --------------------------------------------------------------- draw ----
  draw(state: GameState, dt: number, project: Projector): void {
    this.wall += Math.max(0, Math.min(0.25, dt));
    this.sync(state);
    // the sim's own intro length (3.2 s, or 1.5 s on a rematch) when it says
    if (state.sim && state.phase === 'intro') this.introLen = state.sim.introLen;
    const g = this.g;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, W, H);
    this.goalBox = null;
    this.delayedBox = null;
    const now = state.time;
    const phase = state.phase;
    // the scorer window rises over the turbo window's corner: slide it out
    // just before, and back once the window has gone (sim time, so it keeps
    // pace at any ?speed= and holds still while paused)
    const sdt = Math.max(0, Math.min(0.1, now - this.lastDrawTime));
    this.lastDrawTime = now;
    const hideTurbo = this.win?.kind === 'scorer' && now >= this.win.t0 - 0.25;
    const step = (TURBO_HIDE / 0.2) * sdt;
    this.turboDrop = hideTurbo ? Math.min(TURBO_HIDE, this.turboDrop + step) : Math.max(0, this.turboDrop - step);

    if (phase === 'intermission') {
      drawIntermission(g, state, {
        endedPeriod: this.endedPeriod || state.period,
        nextPeriod: this.nextPeriod > this.endedPeriod ? this.nextPeriod : Math.min(4, (this.endedPeriod || state.period) + 1),
        t: now - this.screenT0,
        left: RULES.intermissionTime - state.phaseTime,
        wall: this.wall,
        penalties: this.penLog,
      });
      if (state.paused) drawPause(g, this.wall, this.status ?? undefined);
      return;
    }
    if (phase === 'gameOver') {
      const book = this.finalBook(now);
      drawFinal(g, state, {
        t: now - this.screenT0,
        wall: this.wall,
        page: book.page,
        pageT: now - book.t0,
        penalties: this.penLog,
      });
      return;
    }

    const live = LIVE.includes(phase);
    if (live) {
      this.drawWorldOverlays(state, now, project);
      this.drawPops(now, project);
      // the controls card covers the same corner during the opening faceoff
      if (!this.showControls(state)) this.drawTurbo(state);
    }
    if (phase === 'intro') {
      // a short (rematch) intro skips the logo and goes straight to the period card
      drawIntro(g, state.phaseTime, this.introLen - state.phaseTime, this.wall, state.period, this.introLen >= 2);
    }
    this.drawWindowLayer(state, now);
    this.drawCenter(state, now);
    // the score bug lives on the highest-priority layer, like BG3 on a SNES
    // (the DELAYED PENALTY chip goes under it, so it can pop out from behind)
    if (live) {
      this.drawDelayed(state, sdt);
      this.drawScoreBug(state, now);
      this.drawPowerPlay(state);
    }
    if (this.showControls(state)) {
      if (phase === 'play') {
        // lingers into the first seconds of live play, then slides away
        const left = CONTROLS_PLAY_SECS - (RULES.periodLength - state.clock);
        drawControls(g, slide(0.25 - left, 0.25, 178, H + 4));
      } else {
        const t = phase === 'intro' ? state.phaseTime - (this.introLen >= 2 ? 0.6 : 0) : 1;
        if (t > 0) drawControls(g, slide(t, 0.25, H + 4, 178));
      }
    }
    if (state.paused) drawPause(g, this.wall, this.status ?? undefined);
  }

  private showControls(state: GameState): boolean {
    if (state.period !== 1 || state.goals.length || state.penalties.length) return false;
    if (state.phase === 'intro') return true;
    // a first-timer gets a few seconds of live play with the card still up
    if (state.phase === 'play') return RULES.periodLength - state.clock < CONTROLS_PLAY_SECS;
    if (state.phase !== 'faceoff' || !atPeriodStart(state)) return false;
    // hide once the puck has dropped
    return !state.faceoff?.dropped;
  }

  // --------------------------------------------------------- score bug ----
  private drawScoreBug(state: GameState, now: number): void {
    const g = this.g;
    const y = slide(state.time - this.bugT0, 0.25, -24, 7);
    const x = 38;
    const w = 180;
    drawWindow(g, x, y, w, 19);
    const iy = y + 4;
    for (const t of [0, 1] as TeamId[]) {
      const cx = x + 5 + t * 52;
      drawChip(g, cx, iy, t, TEAMS[t].abbr);
      // recessed score slot
      const sx = cx + 34;
      rect(g, sx, iy, 14, 11, C.winEdge);
      rect(g, sx + 1, iy + 1, 12, 9, snes('#081040'));
      const flashing = this.scoreFlash?.team === t && now - this.scoreFlash.t0 < 3.5 && blink(this.wall, 4);
      drawText(g, String(state.score[t]), sx + 7, iy + 2, { color: flashing ? C.yellow : C.white, align: 'center' });
    }
    // divider
    rect(g, x + 108, iy - 1, 1, 13, C.winShade);
    rect(g, x + 109, iy - 1, 1, 13, C.winMid);
    drawText(g, periodName(state.period), x + 113, iy + 2, { color: C.yellow });
    const warn = state.clock < 10 && state.clock > 0;
    const clockRun = state.phase === 'play';
    const red = warn && (!clockRun || blink(this.wall, 2));
    drawText(g, clockStr(state.clock), x + w - 5, iy + 2, { color: red ? C.red : C.white, align: 'right' });
  }

  /** what the power-play strip shows this frame, if anything */
  private strip(state: GameState): Strip | null {
    const pens: [Penalty[], Penalty[]] = [[], []];
    for (const p of state.penalties) pens[p.team].push(p);
    const short = [Math.min(2, pens[0].length), Math.min(2, pens[1].length)];
    // skaters on the ice per team (4 at even strength)
    const onIce = [4 - short[0], 4 - short[1]];
    if (short[0] !== short[1]) {
      const pp = (short[0] < short[1] ? 0 : 1) as TeamId; // team with the extra skater
      const offenders = pens[1 - pp];
      const remain = Math.min(...offenders.map((p) => p.remaining));
      const nums = offenders
        .slice(0, 2)
        .map((p) => (state.skaters[p.skaterId] ? jersey(state.skaters[p.skaterId]) : ''))
        .join(' ');
      const label =
        Math.abs(short[0] - short[1]) === 2 ? `${onIce[0]} ON ${onIce[1]}` : pp === 0 ? 'POWER PLAY' : 'SHORTHANDED';
      return { text: `${label} ${clockStr(remain)} ${nums}`, theme: teamTheme(pp), color: pp === 0 ? C.yellow : C.white, remain };
    }
    if (short[0] > 0) {
      const remain = Math.min(...state.penalties.map((p) => p.remaining));
      return { text: `${onIce[0]} ON ${onIce[1]} ${clockStr(remain)}`, theme: THEMES.blue, color: C.yellow, remain };
    }
    if (this.ppNotice) return { text: this.ppNotice.text, theme: THEMES.blue, color: C.white, remain: 0 };
    // broadcast shots-on-goal chyron while the puck is dead (a lineup, a
    // stoppage); never before the first shot of the game, and never over a
    // delayed penalty, whose chip takes the row
    if (this.delayed) return null;
    const dead = (state.phase === 'faceoff' && !state.faceoff?.dropped) || state.phase === 'stoppage';
    if (dead && state.shots[0] + state.shots[1] > 0) {
      return { lead: 'SOG ', text: `${state.shots[0]}-${state.shots[1]}`, theme: THEMES.blue, color: C.white, remain: 0 };
    }
    return null;
  }

  private drawPowerPlay(state: GameState): void {
    const g = this.g;
    const st = this.strip(state);
    if (!st) return;
    const y = 27;
    const lead = st.lead ?? '';
    const w = textWidth(lead + st.text) + 12;
    const x = Math.floor((W - w) / 2);
    drawWindow(g, x, y, w, 15, st.theme);
    // last 5 s of a power play: the countdown blinks
    const urgent = st.remain > 0 && st.remain < 5 && state.phase === 'play' && !blink(this.wall, 4);
    if (lead) drawText(g, lead, x + 6, y + 4, { color: C.yellow });
    drawText(g, st.text, x + 6 + textWidth(lead), y + 4, { color: urgent ? C.orange : st.color });
  }

  /**
   * DELAYED PENALTY chip in the offending team's colors: the ref's arm is up
   * and play goes on until they touch the puck. It pops out from behind the
   * score bug (flashing), then the words blink while the team stays lit. It
   * sits in the strip row, or stacks under a power-play strip already up.
   */
  private drawDelayed(state: GameState, sdt: number): void {
    const d = this.delayed;
    if (!d) return;
    const g = this.g;
    const age = state.time - d.t0;
    // eases between its rows when a power-play strip comes or goes
    const row = this.strip(state) ? DELAYED_ROW.under : DELAYED_ROW.strip;
    const step = ((DELAYED_ROW.under - DELAYED_ROW.strip) / 0.15) * sdt;
    d.y = Number.isNaN(d.y) ? row : d.y + Math.max(-step, Math.min(step, row - d.y));
    const y = Math.round(d.y) + slide(age, 0.16, -16, 0);
    const abbr = `${TEAMS[d.team].abbr} `;
    const text = 'DELAYED PENALTY';
    const w = textWidth(abbr + text) + 12;
    const x = Math.floor((W - w) / 2);
    const pal = TEAM_PAL[d.team];
    const pop = age < 0.36 && Math.floor(age * 20) % 2 === 0;
    const theme = teamTheme(d.team);
    drawWindow(g, x, y, w, 15, pop ? { ...theme, top: C.white, bottom: pal.main } : theme);
    this.delayedBox = { x, y, w, h: 15 };
    drawText(g, abbr, x + 6, y + 4, { color: C.yellow, shadow: C.ink });
    // lit solid through the pop, then a 2 Hz 3/4-duty blink (never gone for long)
    if (age < 0.6 || (this.wall * 2) % 1 < 0.75) {
      drawText(g, text, x + 6 + textWidth(abbr), y + 4, { color: pop ? C.yellow : C.white, shadow: C.ink });
    }
  }

  // ------------------------------------------------------------- turbo ----
  private drawTurbo(state: GameState): void {
    const g = this.g;
    const me = state.skaters[state.controlledId];
    if (!me) return;
    const { x, w, h } = TURBO;
    const y = TURBO.y + Math.round(this.turboDrop);
    const now = state.time;
    if (y >= H) return;
    this.drawPalTab(state, me, y);
    drawWindow(g, x, y, w, h);
    // whose meter it is: PAL's paw, or the kid's jersey and number
    if (me.kind === 'dog') drawIcon(g, ICONS.paw, x + 5, y + 7);
    else drawJerseyIcon(g, x + 3, y + 6, me.team, me.number);
    drawText(g, me.name, x + 17, y + 4, { color: C.white });
    const empty = me.stamina < 0.25 && !me.turboActive;
    // out of gas: the meter row alternates with a red TIRED (the name line
    // keeps its name, so it never runs into the bark lamp)
    if (empty && blink(this.wall, 3)) drawText(g, 'TIRED', x + 17 + 59 / 2, y + 12, { color: C.red, align: 'center' });
    else drawMeter(g, x + 17, y + 13, 59, 5, me.stamina, [C.green, C.yellow, C.red], me.turboActive && blink(this.wall, 8));
    if (me.kind === 'dog') {
      // bark lamp: the ARF balloon from over his head. Lit when TURBO will
      // bark again, flashing white as it comes back, hollow and refilling
      // while it recharges
      const cd = me.barkCooldown;
      const since = now - this.barkReadyT;
      const lamp = cd > 0 ? 'cooling' : since >= 0 && since < T.barkFlash && Math.floor(since * 20) % 2 === 0 ? 'flash' : 'ready';
      drawBarkBubble(g, x + w - 20, y + 4, lamp, 1 - cd / Math.max(BARK_COOLDOWN, cd));
    }
  }

  /**
   * While a kid has the stick: a tab on top of the turbo window says where
   * PAL is. Red with his box time while he sits, green and blinking PAL READY
   * while he is back but the kid keeps the puck (state.dogReturnPending).
   */
  private drawPalTab(state: GameState, me: Skater, turboY: number): void {
    const dog = state.skaters[DOG_ID];
    const now = state.time;
    let kind: 'box' | 'ready' | null = null;
    if (dog && me.id !== DOG_ID) {
      if (dog.state === 'box') kind = 'box';
      else if (state.dogReturnPending === true) kind = 'ready';
    }
    if (!kind) {
      this.palTab = null;
      return;
    }
    if (this.palTab?.kind !== kind || now < this.palTab.t0 - 0.01) this.palTab = { kind, t0: now };
    const g = this.g;
    const x = TURBO.x;
    // slides up from behind the turbo window; its bottom edge stays tucked under it
    const y = slide(now - this.palTab.t0, 0.15, turboY, turboY - TAB_H + 2);
    if (kind === 'box') {
      const left = clockStr(this.dogBoxTime(state));
      const w = 17 + textWidth('PAL ') + textWidth(left) + 5;
      drawWindow(g, x, y, w, TAB_H, THEMES.red);
      drawIcon(g, ICONS.paw, x + 5, y + 3);
      drawText(g, 'PAL', x + 17, y + 4, { color: C.white });
      drawText(g, left, x + w - 5, y + 4, { color: C.yellow, align: 'right' });
    } else {
      const w = 17 + textWidth('PAL READY') + 5;
      drawWindow(g, x, y, w, TAB_H, READY_THEME);
      drawIcon(g, ICONS.paw, x + 5, y + 3);
      // a slow 3/4-duty blink: it asks for a pass without ever disappearing for long
      if ((this.wall * 2.5) % 1 < 0.72) drawText(g, 'PAL READY', x + 17, y + 4, { color: C.white });
    }
  }

  // ------------------------------------------------- world-anchored ----
  private drawWorldOverlays(state: GameState, now: number, project: Projector): void {
    const g = this.g;
    const me = state.skaters[state.controlledId];
    // shot power meter above the controlled skater while winding up
    if (me && me.state === 'windup') {
      const p = project(me.pos.x, headHeight(me) + 0.5, me.pos.z);
      // only over a visible shooter; clamped to an edge it would point at nothing
      if (p.onScreen && p.y > this.top + 6 && p.x > 8 && p.x < W - 8) {
      const full = me.windup >= 0.999;
      const bx = Math.round(p.x) - 12;
      const by = Math.round(p.y) - 6;
        drawMeter(g, clampI(bx, 2, W - 26), clampI(by, 2, H - 8), 24, 6, me.windup, [C.red, C.orange, C.yellow], full && blink(this.wall, 10));
      }
    }
    // the dog: off-screen arrow, edge name tag
    // (not during celebrations / banners, where it would only add clutter)
    const dog = state.skaters[DOG_ID];
    const arrowPhase = state.phase === 'play' || state.phase === 'faceoff' || state.phase === 'stoppage';
    if (dog && dog.state !== 'box' && arrowPhase) {
      const p = project(dog.pos.x, 0.9, dog.pos.z);
      const head = project(dog.pos.x, headHeight(dog) + 0.3, dog.pos.z);
      const off = !p.onScreen || p.x < 4 || p.x > W - 4 || p.y < this.top + 2 || p.y > H - 4;
      if (off) this.drawOffscreenArrow(p.x, p.y, 'PAL');
      else if (head.y - MARKER_REACH < this.top) {
        // his marker would hang behind the score bug / PP strip: tag him from below
        const feet = project(dog.pos.x, 0, dog.pos.z);
        this.drawNameTagBelow(feet.x, feet.y, 'PAL', 0);
      } else if (head.x < 28 || head.x > W - 28) this.drawNameTag(head.x, head.y, 'PAL', 0);
    }
    // name tag over a newly controlled skater
    if (this.tag) {
      const s = state.skaters[this.tag.id];
      const age = now - this.tag.t0;
      if (s && s.state !== 'box' && (age < 1 || blink(age, 4))) {
        const p = project(s.pos.x, headHeight(s) + 0.4, s.pos.z);
        if (p.onScreen) this.drawNameTag(p.x, p.y, s.name, s.team);
      }
    }
  }

  private drawNameTag(x: number, y: number, name: string, team: TeamId): void {
    const g = this.g;
    const w = textWidth(name) + 6;
    const tx = clampI(Math.round(x - w / 2), 4, W - w - 4);
    // sits above the actor layer's bouncing marker (~3-12 px over the head)
    const ty = clampI(Math.round(y) - 26, this.top + 2, H - 30);
    rect(g, tx + 1, ty, w - 2, 11, C.winEdge);
    rect(g, tx, ty + 1, w, 9, C.winEdge);
    rect(g, tx + 1, ty + 1, w - 2, 9, C.white);
    rect(g, tx + 1, ty + 8, w - 2, 2, C.gray);
    drawText(g, name, tx + 3, ty + 1, { color: team === 0 ? TEAM_PAL[0].main : TEAM_PAL[1].main, shadow: null });
    // pointer nub under the tag
    const nx = clampI(Math.round(x), tx + 3, tx + w - 4);
    rect(g, nx - 2, ty + 11, 5, 1, C.winEdge);
    rect(g, nx - 1, ty + 12, 3, 1, C.winEdge);
    rect(g, nx - 1, ty + 11, 3, 1, C.gray);
    rect(g, nx, ty + 12, 1, 1, C.gray);
  }

  /** name tag under the feet, its nub pointing up at the skater */
  private drawNameTagBelow(x: number, y: number, name: string, team: TeamId): void {
    const g = this.g;
    const w = textWidth(name) + 6;
    const tx = clampI(Math.round(x - w / 2), 4, W - w - 4);
    const ty = clampI(Math.round(y) + 5, this.top + 2, H - 16);
    const nx = clampI(Math.round(x), tx + 3, tx + w - 4);
    rect(g, nx - 1, ty - 2, 3, 1, C.winEdge);
    rect(g, nx - 2, ty - 1, 5, 1, C.winEdge);
    rect(g, nx, ty - 2, 1, 1, C.white);
    rect(g, nx - 1, ty - 1, 3, 1, C.white);
    rect(g, tx + 1, ty, w - 2, 11, C.winEdge);
    rect(g, tx, ty + 1, w, 9, C.winEdge);
    rect(g, tx + 1, ty + 1, w - 2, 9, C.white);
    rect(g, tx + 1, ty + 8, w - 2, 2, C.gray);
    rect(g, nx - 1, ty, 3, 1, C.white);
    drawText(g, name, tx + 3, ty + 1, { color: team === 0 ? TEAM_PAL[0].main : TEAM_PAL[1].main, shadow: null });
  }

  private drawOffscreenArrow(px: number, py: number, name: string): void {
    const g = this.g;
    // edge point along the ray from screen center toward the target
    const cx = W / 2;
    const cy = H / 2 + 8;
    let dx = px - cx;
    let dy = py - cy;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) dy = 1;
    const minX = 12, maxX = W - 20, minY = this.top + 6, maxY = H - 34;
    const sx = dx > 0 ? (maxX - cx) / dx : dx < 0 ? (minX - cx) / dx : Infinity;
    const sy = dy > 0 ? (maxY - cy) / dy : dy < 0 ? (minY - cy) / dy : Infinity;
    const s = Math.min(sx, sy);
    const ex = Math.round(cx + dx * s);
    const ey = Math.round(cy + dy * s);
    const horiz = sx < sy;
    const bob = blink(this.wall, 4) ? 1 : 0;
    const dir: Dir = horiz ? (dx > 0 ? 'r' : 'l') : dy > 0 ? 'd' : 'u';
    // (ax, ay) = arrow tip; the tag sits behind it
    const tipX = ex + (dir === 'r' ? 9 + bob : dir === 'l' ? -bob : 3);
    const tipY = ey + (dir === 'd' ? 9 + bob : dir === 'u' ? -bob : 3);
    drawArrow(g, tipX, tipY, dir);
    const ax = ex;
    const ay = ey;
    // name tag beside the arrow, on the inner side
    const tw = textWidth(name) + 6;
    let tx = horiz ? (dx > 0 ? ax - tw - 3 : ax + 13) : ax + 4 - tw / 2;
    let ty = horiz ? ay - 2 : dy > 0 ? ay - 14 : ay + 13;
    tx = clampI(Math.round(tx), 4, W - tw - 4);
    ty = clampI(Math.round(ty), this.top, H - 16);
    rect(g, tx + 1, ty, tw - 2, 11, C.winEdge);
    rect(g, tx, ty + 1, tw, 9, C.winEdge);
    rect(g, tx + 1, ty + 1, tw - 2, 9, C.white);
    rect(g, tx + 1, ty + 8, tw - 2, 2, C.gray);
    drawText(g, name, tx + 3, ty + 1, { color: TEAM_PAL[0].main, shadow: null });
  }

  private drawPops(now: number, project: Projector): void {
    const g = this.g;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    // oldest first so the newest draws on top
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      const age = now - p.t0;
      let x = p.sx;
      let y = p.sy;
      if (p.world) {
        const s = project(p.world.x, p.world.y, p.world.z);
        if (s.onScreen) {
          x = s.x;
          y = s.y - 16;
        }
      }
      const rise = Math.min(10, Math.floor(age * 24));
      // pop in at 3x for two frames, settle at 2x; flicker out at the end
      const scale = age < 0.05 ? 3 : 2;
      const w = textWidth(p.text, { scale });
      const h = 8 * scale + 2;
      const tx = clampI(Math.round(x - w / 2), 8, W - 8 - w);
      let ty = clampI(Math.round(y - rise - 8 * scale), this.top + 2, H - 40);
      // don't let two pops sit on top of each other: push down until clear
      for (let k = 0; k < 4 && placed.some((r) => tx < r.x + r.w && tx + w > r.x && ty < r.y + r.h && ty + h > r.y); k++) ty += h;
      placed.push({ x: tx, y: ty, w, h });
      if (age > p.life - 0.3 && Math.floor(age * 30) % 2) continue;
      drawText(g, p.text, tx, ty, { grad: p.grad, outline: C.ink, scale, shadow: null });
    }
  }

  // ------------------------------------------------------ windows ----
  private drawWindowLayer(state: GameState, now: number): void {
    const w = this.win;
    if (!w) return;
    const age = now - w.t0;
    if (age < 0) return;
    if (w.kind === 'scorer' && w.goal) this.drawScorer(state, w.goal, age, w.seq);
    if (w.kind === 'penalty' && w.penalty) this.drawPenalty(state, w.penalty, age);
  }

  private drawScorer(state: GameState, info: GoalInfo, age: number, seq: number): void {
    const g = this.g;
    const scorer = state.skaters[info.scorer];
    if (!scorer) return;
    // a little wider than the other windows to make room for the portrait
    const wx = 12;
    const ww = 232;
    const wh = 46;
    const y = slide(age, 0.22, H + 4, SCORER_Y);
    drawWindow(g, wx, y, ww, wh, teamTheme(info.team));
    // portrait inset on the left: PAL's mugshot, or a kid in team colors
    const pw = drawPortrait(g, wx + 6, y + 6, 30, 34, scorer.kind === 'dog' ? 'dog' : 'kid', info.team);
    const x = wx + 6 + pw + 6;
    const vx = x + 44; // value column
    drawText(g, 'GOAL', x, y + 6, { color: C.yellow });
    drawText(g, `${jersey(scorer)} ${scorer.name}`, vx, y + 6, { color: C.white });
    const tag = info.powerPlay ? 'PP' : info.shortHanded ? 'SH' : '';
    if (tag) {
      const tx = wx + ww - 32;
      rect(g, tx - 1, y + 4, 22, 11, C.winEdge);
      rect(g, tx, y + 5, 20, 9, info.powerPlay ? C.yellow : C.cyan);
      drawText(g, tag, tx + 2, y + 6, { color: C.ink, shadow: null });
    }
    const assists = info.assists.map((id) => state.skaters[id]).filter((s): s is Skater => !!s);
    if (assists.length) {
      drawText(g, 'ASST', x, y + 17, { color: C.yellow });
      // keep the line inside the window: tighten until it fits
      const room = wx + ww - 5 - vx;
      const full = assists.map((s) => `${jersey(s)} ${s.name}`);
      const names = assists.map((s) => s.name);
      const tries = [full.join(', '), full.join('/'), names.join(', '), names.join('/')];
      const line = tries.find((t) => textWidth(t) <= room) ?? names[0];
      drawText(g, line, vx, y + 17, { color: C.white });
    } else drawText(g, 'UNASSISTED', vx, y + 17, { color: C.gray });
    drawText(g, `${periodName(info.period)}  ${clockStr(info.clock)}`, x, y + 28, { color: C.sky });
    drawChip(g, wx + ww - 40, y + 26, info.team, TEAMS[info.team].abbr);
    // PAL scored: flavor text bouncing above the window
    if (scorer.kind === 'dog' && age > FLAVOR_AT) {
      const flavor = GOAL_FLAVOR[(seq >> 0) % GOAL_FLAVOR.length];
      const style = { grad: cycle(pingPong(GRAD.gold), this.wall * 12), outline: C.ink, shadow: null, scale: 2 } as const;
      const fw = textWidth(flavor, style);
      const sc = fw > 232 ? 1 : 2;
      const by = y - 22 - (blink(this.wall, 4) ? 1 : 0);
      drawText(g, flavor, W / 2, by + (sc === 1 ? 8 : 0), { ...style, scale: sc, align: 'center' });
    }
  }

  private drawPenalty(state: GameState, pen: Penalty, age: number): void {
    const g = this.g;
    const s = state.skaters[pen.skaterId];
    const ww = 200;
    const wh = 62;
    const wx = slide(age, 0.2, -ww - 8, (W - ww) / 2);
    const y = 70;
    drawWindow(g, wx, y, ww, wh, THEMES.red);
    banner(g, 'PENALTY', wx + ww / 2, y + 5, blink(this.wall, 3) && age < 1 ? GRAD.white : GRAD.gold);
    const x = wx + 10;
    const right = wx + ww - 10;
    if (s) {
      drawText(g, `${jersey(s)} ${s.name}`, x, y + 26, { color: C.white });
      drawChip(g, right - 32, y + 24, s.team, TEAMS[s.team].abbr);
    }
    const dur = pen.major ? `MAJOR ${clockStr(pen.duration)}` : clockStr(pen.duration);
    const cols = Math.floor((ww - 20) / 8);
    if (pen.infraction.length + 1 + dur.length <= cols) {
      drawText(g, pen.infraction, x, y + 40, { color: C.yellow });
      drawText(g, dur, right, y + 40, { color: C.white, align: 'right' });
    } else {
      // long infraction names get their own line
      drawText(g, pen.infraction, x, y + 37, { color: C.yellow });
      drawText(g, dur, right, y + 47, { color: C.white, align: 'right' });
    }
    if (s?.kind === 'dog' && age > 0.5 && blink(this.wall, 3)) {
      drawText(g, 'BAD DOG!', W / 2, y + wh + 6, { grad: GRAD.red, outline: C.ink, shadow: null, scale: 2, align: 'center' });
    }
  }

  // ------------------------------------------------------- center ----
  private drawCenter(state: GameState, now: number): void {
    const g = this.g;
    const phase = state.phase;
    const c = this.center;

    // period opener: 2ND PERIOD / OVERTIME! + SUDDEN DEATH, up for the whole
    // lineup (sync() holds it until the drop, and at least T.cardHold)
    const card = this.card;
    const dy = this.lineTop - SAFE.bug;
    if (card) {
      const t = now - card.t0;
      if (card.period >= 4) {
        drawPeriodCard(g, 'OVERTIME!', t, this.wall, null, LINEUP.card + dy);
        // steady (never blinking), so it can't fall between two glances
        const x = slide(t, 0.18, -140, W / 2);
        const grad = t < 0.6 ? GRAD.red : cycle(pingPong(GRAD.red), this.wall * 8);
        drawText(g, 'SUDDEN DEATH', x, LINEUP.sudden + dy, { grad, outline: C.ink, shadow: null, scale: 2, align: 'center' });
      } else {
        drawPeriodCard(g, periodTitle(card.period), t, this.wall, null, LINEUP.card + dy);
      }
    }
    const actionY = this.actionY();

    // FACE OFF! for the lineup (phase-driven so it can't be missed); a false
    // start takes its place on the same row
    if (phase === 'faceoff' && !state.faceoff?.dropped && c?.kind !== 'falseStart') {
      const t = state.phaseTime;
      const x = slide(t - 0.1, 0.2, -120, W / 2);
      if (t > 0.1) banner(g, 'FACE OFF!', x, actionY, GRAD.cool);
    }

    if (!c) return;
    const age = now - c.t0;
    switch (c.kind) {
      case 'drop': {
        if (age > T.drop - 0.25 && Math.floor(age * 30) % 2) break;
        const scale = age < 0.06 ? 2 : 1;
        banner(g, 'DROP!', W / 2, (c.y ?? actionY) + (scale === 2 ? -4 : 4), age < 0.1 ? GRAD.white : GRAD.fire, scale);
        break;
      }
      case 'falseStart': {
        // lit solid at first, then a slow 3/4-duty pulse, flickering out at the end
        if (age > T.falseStart - 0.2 && Math.floor(age * 30) % 2) break;
        if (age > 0.6 && (age * 2) % 1 > 0.75) break;
        const y = c.y ?? actionY;
        banner(g, 'FALSE START!', W / 2, y, age < 0.08 ? GRAD.white : GRAD.red);
        if (c.team !== undefined) drawChip(g, W / 2 - 16, y + LINEUP.chip, c.team, TEAMS[c.team].abbr);
        if (c.hint) drawText(g, 'WAIT FOR THE DROP!', W / 2, y + LINEUP.hint, { color: C.yellow, shadow: C.ink, align: 'center' });
        break;
      }
      case 'goal':
        this.drawGoal(state, c.team ?? 0, age - T.goalDelay);
        break;
      case 'periodEnd': {
        const p = c.period ?? state.period;
        const y = slide(age, 0.25, -40, this.top + 12);
        banner(g, 'END OF', W / 2, y, GRAD.ice);
        banner(g, p >= 4 ? 'OVERTIME' : periodTitle(p), W / 2, y + 20, GRAD.gold);
        break;
      }
    }
  }

  private drawGoal(state: GameState, team: TeamId, age: number): void {
    if (age < 0) return;
    const g = this.g;
    const text = 'GOAL!!';
    const style = bannerStyle(teamGrad(team), 2);
    const tg = teamGrad(team);
    const y = GOAL_ROW[team];
    const sc = this.scorerFootprint(state);
    // PAL's flavor line rises into the word's row: the word flickers out and
    // hands the screen over to it
    if (sc.top < y + GOAL_H && (!sc.soon || Math.floor(this.wall * 30) % 2)) return;
    // letters slam in one after another, then the whole word palette-cycles
    // and flashes between team colors and gold
    const flashGold = blink(this.wall, 4);
    const base = age < 0.5 ? tg : flashGold ? GRAD.gold : tg;
    const w = textWidth(text, style);
    this.goalBox = { x: Math.floor(W / 2 - w / 2) - 2, y: y - 2, w: w + 6, h: GOAL_H + 2 };
    // under the far net the letters hop up from below (falling in from the
    // top would cross the net); over the near net they drop from above
    const drop = team === 0 ? -20 : 70;
    const bounce = team === 0 ? -3 : 6;
    // starburst sparkles around the word, never over the score bug / PP strip
    // or onto the scorer window as it rises
    if (age > 0.4) {
      const k = Math.floor(this.wall * 10);
      for (let i = 0; i < 6; i++) {
        if ((k + i) % 3 === 0) continue;
        const ang = (i / 6) * Math.PI * 2 + age;
        const sy = y + 18 + Math.round(Math.sin(ang) * 30) - 3;
        if (sy < this.top || sy + 7 > sc.top) continue;
        drawIcon(g, ICONS.sparkle, W / 2 + Math.round(Math.cos(ang) * 112) - 3, sy);
      }
    }
    bannerChars(g, text, W / 2, y, style, (i) => {
      const t0 = i * 0.06;
      const a = age - t0;
      if (a < 0) return { show: false };
      const dy = a < 0.12 ? slide(a, 0.12, -drop, bounce) : a < 0.2 ? slide(a - 0.12, 0.08, bounce, 0) : 0;
      const grad = a < 0.1 ? GRAD.white : age > 0.5 ? cycle(pingPong(base), this.wall * 14 + i) : base;
      return { dy, grad };
    });
  }

  /**
   * Top edge of what the scorer window covers right now (H when it isn't up):
   * the window as it rises, plus PAL's flavor line above it. The flavor counts
   * from 0.15 s before it appears, so whatever it displaces can flicker out.
   */
  private scorerFootprint(state: GameState): { top: number; soon: boolean } {
    const w = this.win;
    if (w?.kind !== 'scorer' || !w.goal) return { top: H, soon: false };
    const age = state.time - w.t0;
    if (age < 0) return { top: H, soon: false };
    const y = slide(age, 0.22, H + 4, SCORER_Y);
    const dog = state.skaters[w.goal.scorer]?.kind === 'dog';
    if (!dog || age < FLAVOR_AT - 0.15) return { top: y, soon: false };
    // the flavor's 2x line, its 1-px bounce and outline
    return { top: SCORER_Y - 24, soon: age < FLAVOR_AT };
  }
}

const PHYS_BIG_HIT = 11;

type Dir = 'l' | 'r' | 'u' | 'd';

/** solid 45-degree triangle with its tip at (tx, ty), `len` px deep */
function tri(g: G, tx: number, ty: number, dir: Dir, len: number, color: string): void {
  g.fillStyle = color;
  for (let i = 0; i < len; i++) {
    if (dir === 'r') g.fillRect(tx - i, ty - i, 1, i * 2 + 1);
    else if (dir === 'l') g.fillRect(tx + i, ty - i, 1, i * 2 + 1);
    else if (dir === 'd') g.fillRect(tx - i, ty - i, i * 2 + 1, 1);
    else g.fillRect(tx - i, ty + i, i * 2 + 1, 1);
  }
}

/** team-red pointer with a white rim and ink outline (nested triangles) */
function drawArrow(g: G, tx: number, ty: number, dir: Dir): void {
  const back = (n: number): [number, number] =>
    dir === 'r' ? [tx - n, ty] : dir === 'l' ? [tx + n, ty] : dir === 'd' ? [tx, ty - n] : [tx, ty + n];
  tri(g, tx, ty, dir, 11, C.ink);
  tri(g, ...back(1), dir, 9, C.white);
  tri(g, ...back(3), dir, 6, TEAM_PAL[0].main);
}

function headHeight(s: Skater): number {
  return s.kind === 'dog' ? 1.3 : 2.0;
}

function clampI(v: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(hi, v)));
}
