// Small non-character sprites: puck, blob shadows, the controlled-player
// marker, the ARF! and HEY! bubbles, ice spray and the sparkle star. Hand-pixelled
// with their own outlines (no auto-outline pass), palette chars from BASE.

import type { ArtFrame } from './frames';
import { grid, parse, stamp, type Grid } from './grid';

const f = (g: Grid, ax: number, ay: number): ArtFrame => ({ g, ax, ay });

// 7 = puck black, 8 = rim glint (the 3/4 view shows the top face). Solid and
// near-black on purpose: the darkest thing on the ice, darker than every skate
// carve and blob shadow, so it reads at a glance even at 1x. The glint is 2 px
// on the back rim, lit from the top-left like everything else.
const PUCK = parse(['.887.', '77777', '.777.']);
// The same puck ringed in ice-white (e). Drawn instead of PUCK when it sits
// over a player sprite: a near-black puck alone would melt into navy pants,
// skates and outlines. Same pixels, one row/column of rim all around.
const PUCK_LIT = parse([
  '..eee..',
  '.e887e.',
  'e77777e',
  '.e777e.',
  '..eee..',
]);

// 9 = translucent cool shadow, 0 = puck shadow (darker than 9, so it still
// shows over worn ice and inside a skater's blob)
const SHADOW = parse([
  '...99999999...',
  '.999999999999.',
  '99999999999999',
  '.999999999999.',
  '...99999999...',
]);
// 5x2 so it centres under the 5-px puck. On the ice the top row hides behind
// the puck and the full-width bottom row peeks out as a contact shadow; in the
// air the whole blob separates from the puck as the height cue.
const PUCK_SHADOW = parse(['.000.', '00000']);

// Down-pointing marker arrow (1 yellow, 2 gold, 3 white shine, k outline)
const ARROW = parse([
  'kkkkkkkkk',
  'k3311112k',
  'kk31112kk',
  '.k31112k.',
  '.kk312kk.',
  '..k312k..',
  '..kk2kk..',
  '...k2k...',
  '....k....',
]);
// Flash frame: white body, yellow edge - the marker blinks as it bounces
const ARROW_FLASH = parse([
  'kkkkkkkkk',
  'k3333331k',
  'kk33331kk',
  '.k33331k.',
  '.kk331kk.',
  '..k331k..',
  '..kk1kk..',
  '...k1k...',
  '....k....',
]);

function marker(): ArtFrame[] {
  // bounce toward the head: offsets 0,1,2,3,2,1 inside a 9x12 cell
  const offs = [0, 1, 2, 3, 3, 2, 1, 0];
  return offs.map((o, i) => {
    const g = grid(9, 12);
    stamp(g, i === 3 || i === 4 ? ARROW_FLASH : ARROW, 0, o);
    return f(g, 4.5, 0);
  });
}

// "ARF!" bubble: white balloon, dark outline, red letters with a dark drop
// shadow (J/j = HOME jersey red - the misc atlas uses the HOME palette).
function arf(jitter: number): ArtFrame {
  const g = parse([
    '..kkkkkkkkkkkkkkk..',
    '.k333333333333333k.',
    'k33333333333333333k',
    'k33333333333333333k',
    'k33333333333333333k',
    'k33333333333333333k',
    'k33333333333333333k',
    'k33333333333333333k',
    'k33333333333333333k',
    '.k333333333333333k.',
    '..kkk3kkkkkkkkkkk..',
    '...k3k.............',
    '...kk..............',
    '..k................',
  ]);
  const letters = [
    ['.J.', 'J.J', 'JJJ', 'J.J', 'J.J'], // A
    ['JJ.', 'J.J', 'JJ.', 'J.J', 'J.J'], // R
    ['JJJ', 'J..', 'JJ.', 'J..', 'J..'], // F
    ['J', 'J', 'J', '.', 'J'], // !
  ];
  let x = 3;
  const y = 3 + jitter;
  for (const L of letters) {
    // dark-red bottom edge under each stroke gives the letters some weight
    stamp(g, parse(L.map((r) => r.replace(/J/g, 'j'))), x, y + 1, { under: true });
    stamp(g, parse(L), x, y);
    x += L[0].length + 1;
  }
  return f(g, 2.5, 0);
}

// "HEY!" call-for-pass bubble: smaller than ARF!, navy letters (a kid's or
// PAL's shout to the carrier, not a bark), tail down-left toward the caller.
function hey(jitter: number): ArtFrame {
  const g = parse([
    '.kkkkkkkkkkkkkkkk.',
    'k3333333333333333k',
    'k3333333333333333k',
    'k3333333333333333k',
    'k3333333333333333k',
    'k3333333333333333k',
    'k3333333333333333k',
    'k3333333333333333k',
    '.kk3kkkkkkkkkkkkk.',
    '..k3k.............',
    '..kk..............',
    '.k................',
  ]);
  const letters = [
    ['b.b', 'b.b', 'bbb', 'b.b', 'b.b'], // H
    ['bbb', 'b..', 'bb.', 'b..', 'bbb'], // E
    ['b.b', 'b.b', '.b.', '.b.', '.b.'], // Y
    ['b', 'b', 'b', '.', 'b'], // !
  ];
  let x = 2;
  const y = 2 + jitter;
  for (const L of letters) {
    stamp(g, parse(L), x, y);
    x += L[0].length + 1;
  }
  return f(g, 1.5, 0);
}

const SPRAY0 = parse(['.45.', '4556', '5566', '.65.']);
const SPRAY1 = parse(['4...5', '..5..', '.4.6.', '6...4']);

const STAR_BIG = parse([
  '...k...',
  '..k1k..',
  '.kk3kk.',
  'k13331k',
  '.kk3kk.',
  '..k1k..',
  '...k...',
]);
const STAR_MID = parse([
  '.......',
  '...k...',
  '..k3k..',
  '.k333k.',
  '..k3k..',
  '...k...',
  '.......',
]);
const STAR_X = parse([
  '.......',
  '.k...k.',
  '..k3k..',
  '...3...',
  '..k3k..',
  '.k...k.',
  '.......',
]);

/** Per-misc animation timing (frame() style: loop or clamp). */
export const MISC_ANIM: Record<string, { fps: number; loop: boolean }> = {
  puck: { fps: 1, loop: true },
  puckLit: { fps: 1, loop: true },
  shadow: { fps: 1, loop: true },
  puckShadow: { fps: 1, loop: true },
  marker: { fps: 12, loop: true },
  arf: { fps: 8, loop: true },
  hey: { fps: 8, loop: true },
  spray0: { fps: 1, loop: true },
  spray1: { fps: 1, loop: true },
  star: { fps: 10, loop: true },
};

export function buildMiscArt(): Record<string, ArtFrame[]> {
  return {
    puck: [f(PUCK, 2.5, 0)],
    puckLit: [f(PUCK_LIT, 3.5, 1)],
    shadow: [f(SHADOW, 7, 2.5)],
    puckShadow: [f(PUCK_SHADOW, 2.5, 1)],
    marker: marker(),
    arf: [arf(0), arf(-1)],
    hey: [hey(0), hey(-1)],
    spray0: [f(SPRAY0, 2, 2)],
    spray1: [f(SPRAY1, 2.5, 2)],
    star: [f(STAR_MID, 3.5, 3.5), f(STAR_BIG, 3.5, 3.5), f(STAR_X, 3.5, 3.5), f(STAR_BIG, 3.5, 3.5)],
  };
}
