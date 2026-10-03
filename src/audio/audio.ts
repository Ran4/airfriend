// AIR FRIEND HOCKEY sound: SNES-flavored WebAudio synthesis, no sample files.
//
//   core.ts       context graph: buses, SNES echo, compressor, waves, noise
//   synth.ts      voices (ADSR, sweeps, vibrato), music instruments, drum kit
//   sfx.ts        one recipe per game sound + rate limits
//   crowd.ts      ambience bed (plays during live action) + reactions
//   windup.ts     the player's shot-charge pulse (follows s.windup)
//   sequencer.ts  tracker-pattern player with a lookahead scheduler
//   songs.ts      the soundtrack
//
// Music follows the 16-bit hockey convention: organ and stingers during the
// intro and stoppages, never over live play, where only the crowd bed runs
// and swells with the danger on the ice.

/// <reference types="vite/client" />
import { DOG_ID, RINK, RULES } from '../config';
import { attackDir } from '../sim/rink';
import type { GameEvent, GameState, GoalInfo, Phase } from '../types';
import { AudioCore, type CoreOptions } from './core';
import { Crowd } from './crowd';
import { compileSong, MusicPlayer, type CompiledSong } from './sequencer';
import { playSfx, type SfxName, type SfxParams } from './sfx';
import { SONGS, type SongName } from './songs';
import { ChargeTone } from './windup';

/**
 * How far ahead (s) the sequencer schedules notes. Music is never reactive
 * (it changes on phase changes, which fade it), so a long window costs
 * nothing and rides out timer stalls up to ~0.3 s. SFX are scheduled now.
 */
const LOOKAHEAD = 0.3;
/** goal fanfare enters as the horn's sustain ends (horn = V, fanfare = I) */
const FANFARE_DELAY = 1.55;
/**
 * Chromium's compressors start fully gained down and need ~0.15 s to open
 * (measured with tools/audio-chain.ts): a sound on the first render quantum
 * comes out at -30 dB. Anything requested before this settles is deferred,
 * so the key press that unlocks audio (often a bark!) isn't swallowed.
 */
const CHAIN_SETTLE = 0.2;
/**
 * Faceoffs are a reaction test (pressing early is a false start), so the
 * drop must be heard: the organ starts fading this long before the drop and
 * is silent by the time the puck leaves the ref's hand.
 */
const DROP_HUSH = 0.45;
const DROP_HUSH_FADE = 0.35;
/**
 * Loudest the crowd bed gets during live play. Above this it starts masking
 * the stick clicks (pickups, passes, wrist shots) the game is played by ear
 * with; the reaction one-shots (ooh, cheer, roar) carry the big moments.
 */
const PLAY_CROWD_MAX = 0.65;
/** delayed penalty: the ref's arm-up chime trails the foul (usually a check) by this much */
const REF_ARM_DELAY = 0.2;
/** localStorage key for the M toggle (survives reloads) */
const MUTE_KEY = 'airfriend.muted';

interface AudioEngineOptions extends CoreOptions {
  /** render into this context instead of creating an AudioContext (tests) */
  context?: BaseAudioContext;
  /** false keeps the crowd bed silent (tests that measure single sounds) */
  ambience?: boolean;
}

/** 0..1, and 0 for NaN (sim values reach here; Math.min/max keep NaN) */
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : x === Infinity ? 1 : 0);

export class AudioEngine {
  muted = false;
  core: AudioCore | null = null;
  crowd: Crowd | null = null;
  /** the controlled skater's shot wind-up pulse (one voice, see windup.ts) */
  charge: ChargeTone | null = null;
  /** debug counters (read by playtests via window.__airfriendAudio, which main.ts sets with its test API) */
  readonly stats = { played: {} as Record<string, number>, dropped: 0, cues: [] as string[], ctxState: 'none' as string, eventErrors: 0, lastEventError: '' };

  private opts: AudioEngineOptions;
  private songs = new Map<SongName, CompiledSong>();
  private player: MusicPlayer | null = null;
  private cue: SongName | null = null;
  private fading: MusicPlayer[] = [];
  private prevPhase: Phase | null = null;
  private prevPaused = false;
  private prevDropped = false;
  /** next THEME riff for a stoppage (order index; 0 is the intro flourish) */
  private themeCursor = 1;
  private lastCharge = -100;
  private excitement = 0;
  private lastCrowdTarget = -1;
  private lastWhistle = -100;
  private lastGoalHome = false;
  private readyAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** the tab is hidden (setHidden): context suspended, music held */
  private hidden = false;
  /** music sequencer held (game paused or tab hidden) */
  private musicHeld = false;
  /** write the M toggle to localStorage (off for a ?mute=1 session) */
  private persistMute = false;
  /** skater whose wind-up the charge tone is following (-1 = none) */
  private chargeId = -1;

  constructor(opts: AudioEngineOptions = {}) {
    this.opts = opts;
    // the real game remembers M across reloads; test renders (own context) don't
    if (!opts.context) {
      // main.ts applies ?mute=1 by toggling once right after construction:
      // start that session unmuted so the toggle forces mute, and leave the
      // saved preference alone (a test URL shouldn't mute the next visit)
      const forced = urlParam('mute') === '1';
      this.persistMute = !forced;
      this.muted = forced ? false : loadMuted();
    }
  }

  /** call from a user gesture (first keydown) - creates/resumes the AudioContext */
  unlock(): void {
    if (this.core) {
      this.resumeContext();
      return;
    }
    const ctx = this.opts.context ?? new AudioContext({ latencyHint: 'interactive' });
    const core = new AudioCore(ctx, this.opts);
    core.master.gain.value = this.muted ? 0 : 1;
    this.core = core;
    this.readyAt = core.now() + CHAIN_SETTLE;
    this.crowd = new Crowd(core);
    this.charge = new ChargeTone(core);
    if (this.opts.ambience !== false) this.crowd.setLevel(0.2, core.now(), 0.8);
    for (const [name, def] of Object.entries(SONGS)) this.songs.set(name as SongName, compileSong(def));
    if (isRealtime(ctx)) {
      ctx.onstatechange = () => {
        this.stats.ctxState = ctx.state;
        // suspended/interrupted behind our back (iOS audio session, device
        // change): try now; if the browser wants a gesture, ensureRunning()
        // on the next key press retries
        try {
          this.resumeContext();
        } catch {
          // ignore
        }
      };
      this.stats.ctxState = ctx.state;
      // first input in a tab that is already hidden: stay quiet until shown
      if (this.hidden) settle(ctx.suspend());
      else this.resumeContext();
      // rAF stalls on hitches; a timer keeps the lookahead window topped up
      this.timer = setInterval(() => this.pump(), 40);
    }
  }

  /**
   * Tab visibility (main.ts calls this on every visibilitychange). Hidden:
   * the music sequencer is held and the AudioContext suspended, so neither
   * the crowd bed nor the looping theme plays on in a background tab (rAF
   * stops there, so update() can't duck anything). Shown: the context
   * resumes; the next update() releases the music unless the game is paused.
   * Never throws.
   */
  setHidden(hidden: boolean): void {
    try {
      this.hidden = !!hidden;
      const core = this.core;
      if (!core) return;
      if (this.hidden) {
        this.holdMusic(core.now(), true);
        this.stopCharge(core.now());
        const ctx = core.ctx;
        if (isRealtime(ctx) && ctx.state !== 'closed') settle(ctx.suspend());
      } else {
        this.resumeContext();
      }
    } catch {
      // audio must never take the game down
    }
  }

  /**
   * Cheap; call on every keydown/pointerdown. Creates the context on the
   * first gesture, and resumes one the browser suspended or interrupted
   * (autoplay policy, iOS audio session, device change). Never throws.
   */
  ensureRunning(): void {
    try {
      if (!this.core) this.unlock();
      else this.resumeContext();
    } catch {
      // audio must never take the game down
    }
  }

  /** resume a realtime context that isn't running (unless the tab is hidden) */
  private resumeContext(): void {
    const ctx = this.core?.ctx;
    if (!ctx || !isRealtime(ctx) || this.hidden) return;
    const st = ctx.state as string; // 'interrupted' (Safari) isn't in every lib.dom
    if (st !== 'running' && st !== 'closed') settle(ctx.resume());
  }

  /** hold/release the music sequencer: held while the game is paused or the tab hidden */
  private holdMusic(now: number, hold: boolean): void {
    if (hold === this.musicHeld) return;
    this.musicHeld = hold;
    if (hold) this.player?.pause(now);
    else this.player?.resume(now);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.core?.setMaster(this.muted ? 0 : 1, 0.08);
    if (this.persistMute) saveMuted(this.muted);
    return this.muted;
  }

  onEvents(events: GameEvent[], state: GameState): void {
    const core = this.core;
    const crowd = this.crowd;
    if (!core || !crowd) return;
    if (!Array.isArray(events)) return;
    const t = Math.max(core.now(), this.readyAt);
    if (this.hidden) {
      // the context clock is frozen: anything scheduled now would all fire
      // at once when the tab comes back. Keep only the music bookkeeping.
      if (events.some((e) => e?.type === 'rematch')) this.onRematch(t);
      return;
    }
    for (const e of events) {
      // one malformed event (missing field, NaN) must not cost the others their sound
      try {
        this.onEvent(e, state, t, core, crowd);
      } catch (err) {
        this.stats.eventErrors++;
        this.stats.lastEventError = `${(e as { type?: unknown } | null)?.type}: ${String(err)}`;
      }
    }
  }

  private onEvent(e: GameEvent, state: GameState, t: number, core: AudioCore, crowd: Crowd): void {
    const sfx = (name: SfxName, p?: SfxParams, at = t) => {
      const end = playSfx(core, name, at, p);
      if (end === null) this.stats.dropped++;
      else this.stats.played[name] = (this.stats.played[name] ?? 0) + 1;
      return end;
    };
    const panOf = (id: number | null | undefined) => (id == null ? 0 : this.pan(state, state.skaters[id]?.pos.x ?? 0));
    // the camera follows the puck: skater sounds fade with distance from it
    const distOf = (id: number) => {
      const k = state.skaters[id];
      return k ? Math.hypot(k.pos.x - state.puck.pos.x, k.pos.z - state.puck.pos.z) : 0;
    };
    const att = (id: number) => Math.max(0.3, clamp01(1.15 - distOf(id) / 22));
    const react = (gap: number) => core.claim('crowd', t, gap, t + gap, 1);

    switch (e.type) {
      case 'periodStart':
        crowd.cheer(t, 0.8);
        break;
      case 'faceoffDrop':
        sfx('faceoffDrop', { pan: this.pan(state, state.faceoff?.spot.x ?? 0) });
        // normally already silent (update hushes the music before the drop)
        this.stopMusic(t, 0.7);
        break;
      case 'faceoffWin':
        sfx('faceoffWin', { pan: panOf(e.skaterId) });
        break;
      case 'pickup':
        sfx('pickup', { vol: 0.8, pan: panOf(e.skaterId) });
        break;
      case 'pass':
        sfx('pass', { vol: 0.55 + 0.45 * clamp01(e.speed / 20), pan: panOf(e.from) });
        break;
      case 'passReceived':
        sfx('receive', { pan: panOf(e.to) });
        break;
      case 'shot': {
        if (e.shooter === this.chargeId) this.stopCharge(t);
        sfx('shot', { vol: e.power, pan: panOf(e.shooter) });
        crowd.duck(t);
        const home = state.skaters[e.shooter]?.team === 0;
        this.excitement = Math.min(1, this.excitement + (home ? 0.35 : 0.2) + 0.25 * e.power);
        break;
      }
      case 'save': {
        sfx(e.caught ? 'catch' : 'save', { pan: panOf(e.goalie) });
        crowd.duck(t);
        const homeGoalie = state.skaters[e.goalie]?.team === 0;
        // home crowd cheers its goalie, groans at the other one
        if (react(1.4)) {
          if (homeGoalie) crowd.cheer(t + 0.12, 0.45);
          else crowd.ooh(t + 0.08, 0.5);
        }
        break;
      }
      case 'post':
        sfx('post', { pan: this.pan(state, e.pos.x) });
        crowd.duck(t);
        if (react(1.2)) crowd.ooh(t + 0.1, 1);
        this.excitement = 1;
        break;
      case 'boards':
        if (e.speed > 1.5) sfx('boards', { vol: Math.max(0.25, clamp01(e.speed / 24)), pan: this.pan(state, e.pos.x) });
        break;
      case 'bodyBoards':
        sfx('bodyBoards', { vol: (0.5 + 0.5 * clamp01(e.speed / 9)) * att(e.skaterId), pan: panOf(e.skaterId) });
        break;
      case 'netHit':
        sfx('netHit', { pan: this.pan(state, e.pos.x) });
        break;
      case 'goal':
        this.onGoal(state, e.info, t);
        break;
      case 'poke':
        sfx(e.success ? 'pokeHit' : 'poke', { vol: att(e.skaterId), pan: panOf(e.skaterId) });
        break;
      case 'steal': {
        const good = state.skaters[e.skaterId]?.team === 0;
        sfx('steal', { pan: panOf(e.skaterId), good });
        if (good && react(1.5)) crowd.cheer(t + 0.05, 0.35);
        break;
      }
      case 'check': {
        const v = Math.max(0.3, clamp01(e.force / 12));
        sfx('check', { vol: v * att(e.victim), pan: panOf(e.victim) });
        crowd.duck(t);
        if (e.knockedDown) {
          sfx('fall', { vol: 0.8 * att(e.victim), pan: panOf(e.victim) }, t + 0.16);
          if (e.force > 7 && react(1.2)) crowd.ooh(t + 0.12, clamp01(e.force / 12));
        }
        this.excitement = Math.min(1, this.excitement + 0.1 + 0.25 * v);
        break;
      }
      case 'whistle':
        // goals get the horn (or the groan) instead of the ref
        if (e.reason === 'goal') break;
        this.lastWhistle = t;
        sfx(e.reason === 'freeze' ? 'whistleLong' : 'whistle', { pan: this.pan(state, state.referee.pos.x) });
        break;
      case 'penalty':
        sfx('buzzer');
        if (t - this.lastWhistle > 1) {
          sfx('whistle', { pan: this.pan(state, state.referee.pos.x) }, t + 0.05);
          this.lastWhistle = t;
        }
        if (e.penalty.team === 0) crowd.boo(t + 0.35);
        else crowd.cheer(t + 0.3, 0.7);
        break;
      case 'delayedPenalty':
        // foul rolled, whistle held while the other team keeps the puck: the
        // ref's arm goes up (a short chime, just after the hit so it doesn't
        // land on the crunch) and the crowd murmurs, excited if the PUPS
        // are about to get a power play, grumbling if one of ours is going.
        // Both stay small and out of the stick-click band: play goes on.
        sfx('refArm', { pan: this.pan(state, state.referee.pos.x) }, t + REF_ARM_DELAY);
        if (react(1.2)) crowd.murmur(t + REF_ARM_DELAY + 0.1, e.team === 1);
        break;
      case 'penaltyExpired':
        sfx('boxDoor');
        break;
      case 'periodEnd':
        sfx('periodHorn');
        crowd.cheer(t + 0.2, 0.8);
        break;
      case 'gameOver':
        if (e.winner === 0) crowd.roar(t + 0.1, 0.8);
        else if (e.winner === 1) crowd.aww(t + 0.1);
        else crowd.cheer(t + 0.1, 0.5);
        break;
      case 'bark':
        sfx('bark', { pan: panOf(e.skaterId) });
        break;
      case 'callFor':
        // pressing PASS/SHOOT while a teammate carries: PAL yips, a kid
        // shouts HEY! (one per 0.6 s, see RULES, however fast it's mashed)
        sfx(state.skaters[e.skaterId]?.kind === 'dog' ? 'yip' : 'hey', { pan: panOf(e.skaterId) });
        break;
      case 'falseStart':
        sfx('falseStart', { pan: this.pan(state, state.referee.pos.x) });
        break;
      case 'turboStart':
        // the AI turbos ~450 times a game; only the player's own burst is feedback
        if (e.skaterId === state.controlledId) sfx('turbo', { vol: 0.8, pan: panOf(e.skaterId) });
        break;
      case 'hardStop': {
        // ~950 stops a game: the player's always sound, the AI's only near
        // the puck, quieter and throttled, so the ice doesn't hiss constantly
        const v = clamp01((e.speed - 4) / 7);
        if (e.skaterId === state.controlledId) sfx('hardStop', { vol: v, pan: panOf(e.skaterId) });
        else if (distOf(e.skaterId) < 10 && core.claim('hardStopNpc', t, 0.35, t, 0)) sfx('hardStop', { vol: v * 0.55 * att(e.skaterId), pan: panOf(e.skaterId) });
        break;
      }
      case 'fumble':
        sfx('fumble', { vol: att(e.skaterId), pan: panOf(e.skaterId) });
        break;
      case 'controlSwitch':
        this.stopCharge(t);
        sfx('blip');
        break;
      case 'clockWarning':
        sfx('clockBeep');
        break;
      case 'rematch':
        sfx('rematch');
        this.onRematch(t);
        break;
      default:
        break;
    }
  }

  private onRematch(t: number): void {
    this.stopCharge(t);
    this.stopMusic(t, 0.3);
    this.prevPhase = null; // re-enter whatever phase comes next (intro)
    this.themeCursor = 1;
  }

  /** per-frame: music state machine, crowd ambience level */
  update(state: GameState, dt: number): void {
    const core = this.core;
    if (!core) return;
    const now = core.now();

    if (state.paused !== this.prevPaused) {
      this.prevPaused = state.paused;
      // duck what's already ringing (scheduled notes, the roar, the horn);
      // the jingle goes out on the ui bus, around the duck
      core.setPauseDuck(state.paused, now);
      if (!this.hidden) playSfx(core, 'pause', Math.max(now, this.readyAt), { good: !state.paused });
    }
    this.holdMusic(now, state.paused || this.hidden);
    if (state.phase !== this.prevPhase) {
      const from = this.prevPhase;
      this.prevPhase = state.phase;
      this.enterPhase(state, from, now);
    }
    const dropped = state.phase === 'faceoff' && !!state.faceoff?.dropped;
    if (dropped && !this.prevDropped) this.stopMusic(now, 0.7);
    this.prevDropped = dropped;
    // hush for the drop: whatever plays (period riff, a stoppage riff, CHARGE!,
    // the goal fanfare overrunning into the lineup) fades out before the
    // puck falls. Checked every frame, so a cue that starts late is cut too.
    if (state.phase === 'faceoff' && state.faceoff && !dropped && this.player && state.phaseTime >= dropTimeOf(state) - DROP_HUSH) {
      this.stopMusic(now, DROP_HUSH_FADE);
    }
    // belt and braces: nothing but the crowd during live action
    if (state.phase === 'play' && this.player && !this.player.stopped && this.player.startTime <= now) this.stopMusic(now, 0.5);

    this.pump();
    this.updateCrowd(state, dt, now);
    this.updateCharge(state, now);
  }

  // ------------------------------------------------------------ windup ----

  /**
   * The charge tone follows the controlled skater's wind-up: it sounds only
   * while that skater is in 'windup' during live, unpaused play in a visible
   * tab, and stops the moment any of that changes (shot, puck lost, control
   * switch, whistle, pause), so it can never outlive the wind-up.
   */
  private updateCharge(state: GameState, now: number): void {
    const charge = this.charge;
    if (!charge) return;
    const id = state.controlledId;
    const s = typeof id === 'number' ? state.skaters[id] : undefined;
    const winding = !!s && s.state === 'windup' && state.phase === 'play' && !state.paused && !this.hidden;
    if (!winding || id !== this.chargeId) this.stopCharge(now);
    if (!winding) return;
    const t = Math.max(now, this.readyAt);
    if (!charge.active) {
      if (!charge.start(t, s.windup)) return;
      this.chargeId = id;
      this.stats.played.windup = (this.stats.played.windup ?? 0) + 1;
    } else charge.set(t, s.windup);
  }

  private stopCharge(t: number): void {
    this.chargeId = -1;
    try {
      this.charge?.stop(t);
    } catch {
      // ChargeTone.stop guards itself; belt and braces
    }
  }

  // ------------------------------------------------------------- music ----

  /** Start a cue (crossfading out whatever plays). Public for tools/audio-test. */
  playCue(name: SongName, at?: number, opts: { orderIdx?: number; fadeIn?: number } = {}): MusicPlayer | null {
    const core = this.core;
    if (!core) return null;
    const now = core.now();
    this.stopMusic(now, 0.25);
    const song = this.songs.get(name)!;
    const start = Math.max(at ?? now + 0.02, this.readyAt);
    // the echo repeats on the cue's 8th notes (an echo off the beat smears it)
    core.setEchoTempo(song.def.bpm, Math.max(now, start - 0.15));
    this.player = new MusicPlayer(core, song, start, opts);
    if (this.musicHeld) this.player.pause(now);
    this.cue = name;
    const cues = this.stats.cues;
    cues.push(`${now.toFixed(1)} ${name}${opts.orderIdx ? '@' + opts.orderIdx : ''}`);
    if (cues.length > 40) cues.shift();
    this.pump();
    return this.player;
  }

  private stopMusic(t: number, fade: number): void {
    const p = this.player;
    if (!p) return;
    if (this.cue === 'theme') {
      // resume the rotation after the riff that was playing
      const next = p.position + 1;
      this.themeCursor = next >= p.song.def.order.length ? (p.song.def.loop ?? 1) : Math.max(1, next);
    }
    p.stop(t, fade);
    this.fading.push(p);
    this.player = null;
    this.cue = null;
  }

  /** top up the lookahead window (called by update, a timer, and offline tests) */
  pump(): void {
    const core = this.core;
    if (!core) return;
    const until = core.now() + LOOKAHEAD;
    this.player?.pump(until);
    const now = core.now();
    this.fading = this.fading.filter((p) => {
      if (!p.finished(now)) return true;
      p.dispose();
      return false;
    });
    if (this.player?.finished(now)) {
      this.player.dispose();
      this.player = null;
      this.cue = null;
    }
  }

  private enterPhase(state: GameState, from: Phase | null, now: number): void {
    switch (state.phase) {
      case 'intro':
        this.themeCursor = 1;
        this.playCue('theme', now + 0.05, { orderIdx: 0 });
        break;
      case 'faceoff':
        // period openers get a riff; other faceoffs keep whatever the
        // stoppage started (theme riff, CHARGE!, goal fanfare)
        if (from === null || from === 'intermission' || from === 'intro') {
          if (!this.player || this.cue === 'intermission') this.playTheme(now);
        }
        break;
      case 'play':
        this.stopMusic(now, 0.5);
        break;
      case 'stoppage': {
        const homePP = state.penalties.some((p) => p.team === 1);
        const charge = (homePP || Math.random() < 0.25) && now - this.lastCharge > 20;
        if (charge) this.playCharge(now + 0.35);
        else this.playTheme(now + 0.25);
        break;
      }
      case 'penalty':
        // power play for the PUPS: CHARGE! after the buzzer. Our penalty:
        // the organist sits on his hands and the crowd boos.
        if (state.lastPenaltyCall?.team === 1) this.playCharge(now + 0.7);
        break;
      case 'periodEnd':
        this.stopMusic(now, 0.3);
        break;
      case 'intermission':
        this.playCue('intermission', now + 0.4, { fadeIn: 1.2 });
        break;
      case 'gameOver':
        this.playCue(state.winner === 0 ? 'victory' : state.winner === 1 ? 'defeat' : 'tie', now + 0.6);
        break;
      case 'goal':
        break;
    }
  }

  private playTheme(at: number): void {
    this.playCue('theme', at, { orderIdx: this.themeCursor, fadeIn: 0.04 });
  }

  private playCharge(at: number): void {
    this.lastCharge = at;
    this.playCue('charge', at);
  }

  private onGoal(state: GameState, info: GoalInfo, t: number): void {
    const core = this.core!;
    const crowd = this.crowd!;
    const home = info.team === 0;
    this.lastGoalHome = home;
    if (home) {
      playSfx(core, 'horn', t);
      crowd.roar(t + 0.08, 1);
      // WHAT A DOG! PAL yips along with the horn
      if (info.scorer === DOG_ID) {
        playSfx(core, 'bark', t + 0.45, { vol: 0.9 });
        playSfx(core, 'bark', t + 0.75, { vol: 0.8 });
      }
      this.excitement = 1;
      this.playCue('goal', t + FANFARE_DELAY);
    } else {
      playSfx(core, 'whistleLong', t, { pan: this.pan(state, state.referee.pos.x) });
      crowd.aww(t + 0.15);
      this.excitement = 0;
    }
  }

  // ------------------------------------------------------------- crowd ----

  private updateCrowd(state: GameState, dt: number, now: number): void {
    const crowd = this.crowd!;
    if (this.opts.ambience === false) return;
    this.excitement = Math.max(0, this.excitement - dt * 0.6);
    let target: number;
    switch (state.phase) {
      case 'play': {
        // danger: how deep the puck is toward either net, squared so the
        // crowd only really stirs inside the zones
        const pz = state.puck.pos.z * attackDir(0, state.period);
        const attack = clamp01((pz - 5) / 20);
        const defend = clamp01((-pz - 5) / 20);
        const owner = state.puck.owner;
        const homePuck = owner !== null && state.skaters[owner]?.team === 0;
        target = 0.3 + 0.38 * attack * attack + 0.2 * defend * defend + (homePuck ? 0.05 : 0) + 0.15 * this.excitement;
        const close = Math.abs(state.score[0] - state.score[1]) <= 1;
        if (state.period >= 3 && state.clock < 30 && close) target += 0.1;
        // headroom for the horn and the roar when a chance turns into a goal,
        // and the bed never climbs over the stick-and-puck layer (crowd.ts)
        target = Math.min(PLAY_CROWD_MAX, target);
        break;
      }
      case 'faceoff':
        target = state.faceoff?.dropped ? 0.36 : 0.24; // hush before the drop
        break;
      case 'intro':
        target = 0.5;
        break;
      case 'goal':
        target = this.lastGoalHome ? 0.55 : 0.1; // the roar one-shot carries the peak
        break;
      case 'stoppage':
        target = 0.28;
        break;
      case 'penalty':
        target = 0.34;
        break;
      case 'periodEnd':
        target = 0.5;
        break;
      case 'intermission':
        target = 0.13;
        break;
      case 'gameOver':
        target = state.winner === 0 ? 0.6 : 0.14;
        break;
    }
    if (state.paused) target = 0.05;
    target = clamp01(target);
    // only touch the automation timeline when the target actually moves
    if (Math.abs(target - this.lastCrowdTarget) > 0.015) {
      crowd.setLevel(target, now, target > this.lastCrowdTarget ? 0.25 : 0.9);
      this.lastCrowdTarget = target;
    }
  }

  /** stereo position of a world x, as seen from the camera (screen-right = world -attackDir) */
  private pan(state: GameState, x: number): number {
    return Math.max(-1, Math.min(1, (-attackDir(0, state.period) * x) / RINK.halfWidth)) * 0.6;
  }

  /** stop timers (tests / hot reload) */
  dispose(): void {
    if (this.core) this.stopCharge(this.core.now());
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(name);
  } catch {
    return null;
  }
}

/** the saved M toggle (storage can be missing or throw: private mode, blocked site data) */
function loadMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(muted: boolean): void {
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // not saved; the toggle still works for this session
  }
}

/** fire-and-forget a context state change: resume()/suspend() reject on a closed context */
function settle(p: Promise<void> | undefined): void {
  p?.catch(() => {});
}

/** phaseTime of the drop (randomized by the sim; the config default if absent) */
function dropTimeOf(state: GameState): number {
  const t = state.faceoff?.dropTime;
  return typeof t === 'number' && Number.isFinite(t) ? t : RULES.faceoffDropDelay;
}

function isRealtime(ctx: BaseAudioContext): ctx is AudioContext {
  return typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
}
