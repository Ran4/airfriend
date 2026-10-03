/// <reference types="vite/client" />
// Boot + main loop. Fixed 60 Hz simulation, render every animation frame.
// No menus: the game starts straight into the opening faceoff.
//
// URL params:
//   ?mute=1       start muted
//   ?crt=1        scanline overlay on (V toggles)
//   F or a double-click toggles fullscreen
// Test mode only (the dev server, or any build with ?test=1):
//   ?autoplay=1   AI controls the dog too (soak tests)
//   ?speed=N      run N sim ticks per frame-tick (fast-forward)
//   window.__airfriend (live state, step, pad override, capture, ...)
// A production build without ?test=1 is a cartridge: no debug surface.

import { AudioEngine } from './audio/audio';
import { SCREEN } from './config';
import { Display } from './core/display';
import { Input, emptyPad } from './core/input';
import { FixedClock, RenderInterp } from './core/loop';
import { GameRenderer } from './render/renderer';
import { createGame, stepGame } from './sim/game';
import type { GameState, PadState, Phase } from './types';
import { Hud } from './ui/hud';
import { isFullscreen, toggleFullscreen } from './core/fullscreen';

const params = new URLSearchParams(location.search);
/** dev server, or an explicit ?test=1 on a build (tools/integ-dist.mjs) */
const testMode = import.meta.env.DEV || params.has('test');
const autoplay = testMode && params.get('autoplay') === '1';
let speed = testMode ? Math.max(1, Math.min(32, Number(params.get('speed')) || 1)) : 1;

const screenEl = document.getElementById('screen')!;
if (params.get('crt') === '1') screenEl.classList.add('crt');

const renderer = new GameRenderer(screenEl);
const hudCanvas = document.createElement('canvas');
screenEl.appendChild(hudCanvas);
// CRT overlay sits above everything (the visible composite goes in below it)
screenEl.appendChild(document.getElementById('crt')!);
const hud = new Hud(hudCanvas);
const audio = new AudioEngine();
if (params.get('mute') === '1') audio.toggleMute();
const input = new Input(window);
input.onFirstInput = () => {
  // runs inside Input's keydown handler: a throw here would also eat the key
  try {
    audio.unlock();
  } catch (err) {
    fault('audio', err);
  }
};

const fullscreen = (): void => {
  // runs inside a keydown/dblclick handler (the gesture fullscreen needs)
  try {
    toggleFullscreen();
  } catch (err) {
    fault('input', err);
  }
};
input.onFullscreen = fullscreen;
window.addEventListener('dblclick', fullscreen);

let state: GameState = createGame({ autoplay });

// Sharp-bilinear, device-pixel-exact presentation of the two 256x224 canvases
// (see core/display.ts). Re-fits itself on resize and devicePixelRatio change.
const display = new Display(screenEl, [renderer.canvas, hudCanvas], document.getElementById('crt') as HTMLCanvasElement);

/** test hook: when set, replaces the keyboard pad */
let padOverride: ((state: GameState) => PadState) | null = null;

// ---------------------------------------------------------------------------
// Fault isolation. Every subsystem call in the loop runs in its own try/catch,
// so one exception (a bad sound, a HUD edge case, a WebGL hiccup) costs that
// subsystem one frame instead of freezing the whole game. The first error per
// subsystem is logged in full; repeats are only counted (window.__airfriend
// .faults()) so a per-frame throw cannot flood the console.

type Subsystem = 'sim' | 'audio' | 'hud' | 'renderer' | 'input' | 'display';
interface FaultRecord {
  count: number;
  first: string;
}
const faults: Partial<Record<Subsystem, FaultRecord>> = {};

function fault(sub: Subsystem, err: unknown): void {
  const rec = faults[sub];
  if (rec) {
    rec.count++;
    return;
  }
  faults[sub] = { count: 1, first: err instanceof Error ? (err.stack ?? err.message) : String(err) };
  console.error(`[airfriend] ${sub} threw; carrying on (further ${sub} errors are only counted):`, err);
}

/** consecutive failed sim steps; while > 0 the loop tries one step per frame */
let simFailStreak = 0;

/**
 * One fixed sim step plus event fan-out. Returns false when the sim itself
 * threw: the state may be half-stepped, so its events are not dispatched and
 * the caller stops stepping for this frame (the last state keeps rendering).
 */
function tick(): boolean {
  let pad: PadState;
  try {
    pad = padOverride ? padOverride(state) : input.poll();
    interp.snapshot(state);
    stepGame(state, pad);
    simFailStreak = 0;
  } catch (err) {
    fault('sim', err);
    simFailStreak++;
    // half-stepped: show the raw state rather than a slide into it
    interp.invalidate();
    return false;
  }
  // the final screen pages on SHOOT (the sim ignores the pad during gameOver)
  try {
    hud.onPad(pad, state);
  } catch (err) {
    fault('hud', err);
  }
  const events = state.events;
  if (events.length) {
    // each consumer gets the events even if an earlier one throws on them
    try {
      audio.onEvents(events, state);
    } catch (err) {
      fault('audio', err);
    }
    try {
      hud.onEvents(events, state);
    } catch (err) {
      fault('hud', err);
    }
    try {
      renderer.onEvents(events, state);
    } catch (err) {
      fault('renderer', err);
    }
  }
  return true;
}

// Fixed-step clock and render interpolation (see core/loop.ts): the sim steps
// at exactly 60 Hz whatever the display does, and every frame draws actors
// between the last two sim states so motion is smooth at 120/144 Hz and on
// 59.94 Hz panels alike.
const clock = new FixedClock();
const interp = new RenderInterp();
let last = performance.now();
function frame(now: number): void {
  // schedule first: nothing below can stop the loop
  requestAnimationFrame(frame);
  const dt = FixedClock.frameSeconds((now - last) / 1000);
  last = now;
  try {
    for (const code of input.takeHotkeys()) {
      if (code === 'KeyM') audio.toggleMute();
      if (code === 'KeyV') screenEl.classList.toggle('crt');
    }
  } catch (err) {
    fault('input', err);
  }
  clock.advance(dt, speed, tick);
  // Render and HUD see lerped positions; the sim's own values go back in the
  // finally, bit-for-bit, so a draw exception cannot leave them in the sim.
  const lerped = interp.apply(state, clock.alpha);
  try {
    // the camera springs and crowd run on game time, so fast-forward runs
    // (?speed=N) frame the action the way a normal-speed run would
    try {
      renderer.render(state, dt * speed);
    } catch (err) {
      fault('renderer', err);
    }
    try {
      hud.status = { muted: audio.muted, crt: screenEl.classList.contains('crt'), fullscreen: isFullscreen() };
      hud.draw(state, dt, (x, y, z) => renderer.worldToScreen(x, y, z));
    } catch (err) {
      fault('hud', err);
    }
  } finally {
    if (lerped) interp.restore();
  }
  // same rAF as the draws (the WebGL canvas also keeps preserveDrawingBuffer);
  // a throw above still presents the last good pixels of that layer
  try {
    display.present();
  } catch (err) {
    fault('display', err);
  }
  try {
    audio.update(state, dt);
  } catch (err) {
    fault('audio', err);
  }
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Leaving the game. Hiding the tab or alt-tabbing away (window blur, browser
// still on screen) pauses any phase the sim would otherwise keep running with
// nobody at the pad; input already drops held keys on blur, so without this
// the AI would play on against a frozen PAL. Coming back stays paused until
// START, like a real console. Intro, intermission and the final screen have
// nothing at stake, and START there means "skip"/"rematch", so they run on.

const PAUSE_ON_LEAVE: readonly Phase[] = ['faceoff', 'play', 'stoppage', 'penalty', 'goal', 'periodEnd'];

function pauseOnLeave(): void {
  if (PAUSE_ON_LEAVE.includes(state.phase)) state.paused = true;
}

/**
 * AudioEngine focus API: setHidden suspends/resumes the AudioContext with the
 * tab, ensureRunning resumes it inside a user gesture.
 */
const audioFocus = audio;

function audioSetHidden(): void {
  try {
    audioFocus.setHidden(document.hidden);
  } catch (err) {
    fault('audio', err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseOnLeave();
  // every phase, intermission and game over included: no music in a background tab
  audioSetHidden();
});
window.addEventListener('blur', pauseOnLeave);
// opened straight into a background tab
if (document.hidden) audioSetHidden();

input.onAnyInput = () => {
  // runs inside Input's keydown/pointerdown handler: a throw here would eat the key
  try {
    audioFocus.ensureRunning();
  } catch (err) {
    fault('audio', err);
  }
};

// Debug / test API (used by tools/playtest.mjs). Test mode only: a live,
// writable state plus step/restart/setSpeed would be a one-line score cheat in
// the shipped game.
declare global {
  interface Window {
    __airfriend?: {
      get state(): GameState;
      /** advance n sim ticks immediately with an empty (or overridden) pad */
      step(n: number): void;
      setPadOverride(fn: ((state: GameState) => PadState) | null): void;
      emptyPad: typeof emptyPad;
      /** 256x224 PNG data URL of the composited frame (3D + HUD) */
      capture(): string;
      restart(opts?: { autoplay?: boolean }): void;
      /** change the fast-forward factor at runtime (tests) */
      setSpeed(n: number): void;
      /** errors swallowed by the loop's fault isolation, per subsystem */
      faults(): { simFailStreak: number } & Partial<Record<Subsystem, FaultRecord>>;
      /** live subsystems, so tests can patch a method (e.g. make it throw) */
      readonly audio: AudioEngine;
      readonly hud: Hud;
      readonly renderer: GameRenderer;
      /** visible composite + layout; fitInfo is the current device-pixel fit */
      readonly display: Display;
      /** keyboard reader; tools/integ-input.mjs wraps poll() to see every pad */
      readonly input: Input;
    };
    /** alias of __airfriend.audio (read by the tools/audio-*.mjs harnesses) */
    __airfriendAudio?: AudioEngine;
  }
}
if (testMode) installTestApi();

function installTestApi(): void {
  window.__airfriend = {
    get state() {
      return state;
    },
    step(n: number) {
      // stop at a sim fault instead of re-running the same throw n times
      for (let i = 0; i < n; i++) if (!tick()) break;
      // n ticks in one go: never slide from before them to after; draw raw until the next frame step
      interp.invalidate();
    },
    setPadOverride(fn) {
      padOverride = fn;
    },
    emptyPad,
    capture() {
      const c = document.createElement('canvas');
      c.width = SCREEN.width;
      c.height = SCREEN.height;
      const g = c.getContext('2d')!;
      g.drawImage(renderer.canvas, 0, 0);
      g.drawImage(hudCanvas, 0, 0);
      return c.toDataURL('image/png');
    },
    restart(opts) {
      state = createGame({ autoplay: opts?.autoplay ?? autoplay });
      renderer.snapCamera();
    },
    setSpeed(n: number) {
      speed = Math.max(1, Math.min(32, n || 1));
    },
    faults() {
      return { simFailStreak, ...JSON.parse(JSON.stringify(faults)) };
    },
    audio,
    hud,
    renderer,
    display,
    input,
  };
  window.__airfriendAudio = audio;
}
