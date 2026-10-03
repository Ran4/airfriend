// Big chunky banner text: the 16x16 EPX font with a per-row gradient, a dark
// outline and a 1-glyph-pixel drop extrusion, plus per-letter animation.

import { charAdvance, drawText, textWidth, type TextStyle } from './font';
import { C } from './palette';
import type { G } from './window';

export function bannerStyle(grad: readonly string[], scale = 1, shadow: string = C.ink): TextStyle {
  return { big: true, grad, outline: C.ink, shadow, scale };
}

/** centered banner line; returns its width */
export function banner(g: G, text: string, cx: number, y: number, grad: readonly string[], scale = 1): number {
  return drawText(g, text, cx, y, { ...bannerStyle(grad, scale), align: 'center' });
}

interface CharFx {
  dx?: number;
  dy?: number;
  show?: boolean;
  grad?: readonly string[];
}

/**
 * Banner drawn one letter at a time so each can bounce/drop/flash on its own.
 * Letter positions use the same advance metrics as drawText, so the settled
 * result is identical to banner().
 */
export function bannerChars(
  g: G,
  text: string,
  cx: number,
  y: number,
  style: TextStyle,
  fx: (i: number, ch: string) => CharFx,
): void {
  const w = textWidth(text, style);
  let x = Math.floor(cx - w / 2);
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const f = fx(i, ch);
    if (f.show !== false && ch !== ' ') {
      drawText(g, ch, x + (f.dx ?? 0), y + (f.dy ?? 0), { ...style, grad: f.grad ?? style.grad, align: 'left' });
    }
    x += charAdvance(ch, style);
  }
}

/** rotate a gradient by k rows (palette cycling) */
export function cycle(grad: readonly string[], k: number): string[] {
  const n = grad.length;
  const s = ((Math.floor(k) % n) + n) % n;
  return [...grad.slice(s), ...grad.slice(0, s)];
}

/** gradient + its mirror, so cycling it reads as a smooth shimmer */
export function pingPong(grad: readonly string[]): string[] {
  return [...grad, ...[...grad].reverse()];
}
