// Pure-data entry point: every sprite's frames, built once and memoized.
// No three.js / DOM here, so node tools (tools/art-dump.ts) can use it.

import { buildDogArt } from './dog';
import { buildKidArt } from './kid';
import { buildGoalieArt } from './goalie';
import { buildRefArt } from './ref';
import type { ArtFrame, KindArt } from './frames';
import { buildMiscArt, MISC_ANIM } from './misc';

export { MISC_ANIM };

type ArtKind = 'dog' | 'kid' | 'goalie' | 'ref';

// number = jersey number for kids/goalies (each number is its own art set)
const BUILDERS: Record<ArtKind, (number?: string) => KindArt> = {
  dog: buildDogArt,
  kid: buildKidArt,
  goalie: buildGoalieArt,
  ref: buildRefArt,
};

const cache = new Map<string, KindArt>();
let misc: Record<string, ArtFrame[]> | null = null;

const NUMBERED = new Set<ArtKind>(['kid', 'goalie']);

export function kindArt(kind: ArtKind, number?: string): KindArt {
  const num = NUMBERED.has(kind) ? number : undefined;
  const key = num ? `${kind}#${num}` : kind;
  let a = cache.get(key);
  if (!a) cache.set(key, (a = BUILDERS[kind](num)));
  return a;
}

export function miscArt(): Record<string, ArtFrame[]> {
  return (misc ??= buildMiscArt());
}
