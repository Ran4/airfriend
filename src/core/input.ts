// Keyboard -> PadState. Edges (pressed/released) are computed between poll()
// calls, and main.ts polls once per sim tick, so no press is ever lost or
// seen twice.

import type { ButtonState, PadState } from '../types';

type Btn = 'up' | 'down' | 'left' | 'right' | 'shoot' | 'pass' | 'turbo' | 'start';

const KEYMAP: Record<string, Btn> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  KeyZ: 'shoot',
  KeyJ: 'shoot',
  KeyX: 'pass',
  KeyK: 'pass',
  KeyC: 'turbo',
  KeyL: 'turbo',
  Enter: 'start',
  KeyP: 'start',
  Escape: 'start',
};

/** every physical key that drives each button (aliases share one button) */
const BTN_CODES = Object.entries(KEYMAP).reduce(
  (m, [code, b]) => ((m[b] ??= []).push(code), m),
  {} as Record<Btn, string[]>,
);

/**
 * Ctrl/Meta/Alt chords belong to the browser and the OS (Ctrl+L address bar,
 * Ctrl+S save, Cmd+M minimise, Ctrl+V paste...): the game neither reacts to
 * them nor swallows them. Shift is not a modifier here, it changes nothing.
 */
function isChord(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}

export class Input {
  /**
   * Physical keys (e.code) held right now. A button is held while ANY of its
   * mapped keys is, so mixing layouts (ArrowRight + D, Z + J) never drops a
   * held button or fakes a second press.
   */
  private codes = new Set<string>();
  /** presses that happened since the last poll, even if already released */
  private tapped = new Set<Btn>();
  private prev = new Set<Btn>();
  /** non-pad hotkeys (M = mute, V = CRT) delivered once each */
  private hotkeys: string[] = [];
  /** fired on the first user gesture (audio unlock) */
  onFirstInput: (() => void) | null = null;
  /**
   * fired on every user gesture (keydown, pointerdown), after onFirstInput:
   * browsers only let a suspended AudioContext resume inside one
   */
  onAnyInput: (() => void) | null = null;
  /**
   * F: called synchronously inside the keydown, because browsers only grant
   * fullscreen during a user gesture (a deferred hotkey could be refused)
   */
  onFullscreen: (() => void) | null = null;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      this.gesture();
      if (isChord(e)) return;
      const b = KEYMAP[e.code];
      if (b) {
        e.preventDefault();
        // A repeat is normally a key we already hold. It is new to us only
        // when the key went down inside a chord (Ctrl+Arrow, then Ctrl let go)
        // or before a blur cleared everything: from then on it is held.
        if (!this.codes.has(e.code)) {
          const was = this.held(b);
          this.codes.add(e.code);
          if (!was) this.tapped.add(b);
        }
        return;
      }
      if (!e.repeat && (e.code === 'KeyM' || e.code === 'KeyV')) this.hotkeys.push(e.code);
      if (!e.repeat && e.code === 'KeyF') {
        e.preventDefault();
        this.onFullscreen?.();
      }
    });
    target.addEventListener('keyup', (e) => {
      // always drop the key, modifiers or not, so nothing sticks if Ctrl went
      // down while it was held; only swallow what the game was using
      if (this.codes.delete(e.code) && !isChord(e)) e.preventDefault();
    });
    target.addEventListener('blur', () => this.codes.clear());
    target.addEventListener('pointerdown', () => this.gesture());
  }

  /** any physical key mapped to `b` is down */
  private held(b: Btn): boolean {
    return BTN_CODES[b].some((c) => this.codes.has(c));
  }

  private gesture(): void {
    if (this.onFirstInput) {
      const f = this.onFirstInput;
      this.onFirstInput = null;
      f();
    }
    this.onAnyInput?.();
  }

  /** Take pending hotkey presses (KeyM, KeyV). */
  takeHotkeys(): string[] {
    const h = this.hotkeys;
    this.hotkeys = [];
    return h;
  }

  poll(): PadState {
    const down = new Set<Btn>();
    for (const code of this.codes) down.add(KEYMAP[code]);
    const btn = (b: Btn): ButtonState => {
      const isDown = down.has(b);
      const wasDown = this.prev.has(b);
      const tap = this.tapped.has(b);
      return {
        // a tap shorter than one tick still counts as held for that tick
        held: isDown || tap,
        pressed: tap || (isDown && !wasDown),
        released: (wasDown || tap) && !isDown,
      };
    };
    const pad: PadState = {
      up: down.has('up') || this.tapped.has('up'),
      down: down.has('down') || this.tapped.has('down'),
      left: down.has('left') || this.tapped.has('left'),
      right: down.has('right') || this.tapped.has('right'),
      shoot: btn('shoot'),
      pass: btn('pass'),
      turbo: btn('turbo'),
      start: btn('start'),
    };
    this.prev = down;
    this.tapped.clear();
    return pad;
  }
}

const EMPTY_BUTTON: ButtonState = { held: false, pressed: false, released: false };

export function emptyPad(): PadState {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    shoot: { ...EMPTY_BUTTON },
    pass: { ...EMPTY_BUTTON },
    turbo: { ...EMPTY_BUTTON },
    start: { ...EMPTY_BUTTON },
  };
}
