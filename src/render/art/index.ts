// Sprite library contract + implementation. The exported types and the
// SpriteLibrary interface are fixed - the actor layer depends on them.
//
// All art is pixel data authored in code (dog.ts, kid.ts, goalie.ts, ref.ts,
// misc.ts) as palette-char grids, recolored per team (palette.ts) and packed
// into one atlas per kind x team (atlas.ts) on first use.

import * as THREE from 'three';
import type { TeamId } from '../../types';
import { SPRITE_METERS_PER_PIXEL, TEAMS } from '../../config';
import { packAtlas } from './atlas';
import { DIR_KEYS, nearestDir, type AnimDef, type Dir5, type DirKey, type KindArt } from './frames';
import { kindArt, miscArt, MISC_ANIM } from './library';
import { teamPalette } from './palette';

export type SpriteKind = 'dog' | 'kid' | 'goalie' | 'ref';

export type SpriteAnim =
  // skaters (dog + kid)
  | 'idle'
  | 'skate'
  | 'windup'
  | 'shoot'
  | 'pass'
  | 'poke'
  | 'check'
  | 'fallen'
  | 'celebrate'
  | 'faceoff'
  | 'bark' // dog only (kids fall back to 'idle')
  // goalie
  | 'gReady'
  | 'gSkate'
  | 'gButterfly'
  | 'gDiveL' // dive toward screen-left
  | 'gDiveR'
  | 'gHold'
  // referee
  | 'refSkate'
  | 'refWhistle'
  | 'refPoint';

export type MiscSprite =
  | 'puck'
  | 'puckLit' // the puck with a 1 px ice-white rim, for when it is drawn over a player
  | 'shadow' // blob shadow for skaters
  | 'puckShadow'
  | 'marker' // controlled-player indicator (drawn above head)
  | 'arf' // "ARF!" bark bubble
  | 'hey' // "HEY!" call-for-pass bubble
  | 'spray0' // ice-spray particle frames
  | 'spray1'
  | 'star'; // celebration sparkle

export interface SpriteFrame {
  texture: THREE.Texture;
  /** UV rect in the texture, (u0,v0) = bottom-left, three.js convention (flipY textures) */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** mirror horizontally when drawing */
  flipX: boolean;
  /** size in source pixels */
  w: number;
  h: number;
  /** anchor in source pixels from the frame's bottom-left: where the ice contact point is */
  ax: number;
  ay: number;
}

export interface SpriteLibrary {
  /**
   * @param screenAngle heading in SCREEN space: 0 = facing up-screen (away from
   *   the camera), +PI/2 = facing screen-right, PI = facing the camera.
   * @param t seconds into the animation (the lib chooses fps, loops looping anims,
   *   clamps one-shot anims on their last frame)
   * @param team palette (null for the referee)
   * @param number optional jersey number for kids and goalies (shown on back
   *   views); omitted = a generic number
   */
  frame(kind: SpriteKind, team: TeamId | null, anim: SpriteAnim, screenAngle: number, t: number, number?: string): SpriteFrame;
  misc(name: MiscSprite, t?: number): SpriteFrame;
  /** world meters per source pixel; every sprite uses the same density */
  readonly metersPerPixel: number;
}

// ----------------------------------------------------------- direction ----

const TAU = Math.PI * 2;
// 8 sectors of 45 degrees centered on N, NE, E, SE, S, SW, W, NW.
// SW/W/NW reuse SE/E/NE mirrored.
const DIR8: { dir: Dir5; flip: boolean }[] = [
  { dir: 'N', flip: false },
  { dir: 'NE', flip: false },
  { dir: 'E', flip: false },
  { dir: 'SE', flip: false },
  { dir: 'S', flip: false },
  { dir: 'SE', flip: true },
  { dir: 'E', flip: true },
  { dir: 'NE', flip: true },
];

/** Screen angle (0 = up-screen, +PI/2 = screen-right) -> sector index 0..7 (N, NE, E, SE, S, SW, W, NW). */
function dirIndex(screenAngle: number): number {
  if (!Number.isFinite(screenAngle)) return 4;
  const a = ((screenAngle % TAU) + TAU) % TAU;
  return Math.round(a / (Math.PI / 4)) % 8;
}

/** Frame index for an anim at time t (loops or clamps). */
function frameIndex(def: { fps: number; loop: boolean }, count: number, t: number): number {
  if (count <= 1 || !Number.isFinite(t) || t <= 0) return 0;
  const f = Math.floor(t * def.fps);
  return def.loop ? f % count : Math.min(f, count - 1);
}

/** The anim a kind actually draws for a requested anim (fallbacks for anims it lacks). */
function resolveAnim(art: KindArt, anim: SpriteAnim): SpriteAnim {
  if (art.anims[anim]) return anim;
  const fb = art.fallback[anim];
  if (fb && art.anims[fb]) return fb;
  return art.defaultAnim;
}

// ------------------------------------------------------------- library ----

interface KindAtlas {
  /** frames[anim][dir] = [unflipped, flipped][] per frame index */
  frames: Map<SpriteAnim, Map<DirKey, [SpriteFrame, SpriteFrame][]>>;
  canvas: HTMLCanvasElement;
}

function buildKindAtlas(kind: SpriteKind, team: TeamId | null, number?: string): KindAtlas {
  const art = kindArt(kind, number);
  const pal = teamPalette(team === null ? null : TEAMS[team].colors);
  const grids: import('./grid').Grid[] = [];
  const order: { anim: SpriteAnim; dir: DirKey; ax: number; ay: number }[] = [];
  for (const [anim, def] of Object.entries(art.anims) as [SpriteAnim, AnimDef][]) {
    for (const d of DIR_KEYS) {
      for (const f of def.dirs[d] ?? []) {
        grids.push(f.g);
        order.push({ anim, dir: d, ax: f.ax, ay: f.ay });
      }
    }
  }
  const packed = packAtlas(grids, pal);
  const W = packed.canvas.width;
  const H = packed.canvas.height;
  const frames: KindAtlas['frames'] = new Map();
  order.forEach((o, i) => {
    const c = packed.cells[i];
    const base: SpriteFrame = {
      texture: packed.texture,
      u0: c.x / W,
      u1: (c.x + c.w) / W,
      // flipY textures: canvas row 0 is v = 1
      v0: 1 - (c.y + c.h) / H,
      v1: 1 - c.y / H,
      flipX: false,
      w: c.w,
      h: c.h,
      ax: o.ax,
      ay: o.ay,
    };
    // ax is kept at w/2 by every sprite module, so mirroring needs no anchor change
    const flip: SpriteFrame = { ...base, flipX: true, ax: c.w - o.ax };
    let byDir = frames.get(o.anim);
    if (!byDir) frames.set(o.anim, (byDir = new Map()));
    let list = byDir.get(o.dir);
    if (!list) byDir.set(o.dir, (list = []));
    list.push([base, flip]);
  });
  return { frames, canvas: packed.canvas };
}

class Library implements SpriteLibrary {
  readonly metersPerPixel = SPRITE_METERS_PER_PIXEL;
  private atlases = new Map<string, KindAtlas>();
  private miscFrames = new Map<string, SpriteFrame[]>();
  miscCanvas: HTMLCanvasElement | null = null;

  constructor() {
    // Build the atlases the game always needs up front (no hitch mid-game).
    this.atlas('dog', 0);
    for (const t of [0, 1] as TeamId[]) {
      for (const r of TEAMS[t].roster) if (r.kind !== 'dog') this.atlas(r.kind, t, r.number);
    }
    this.atlas('ref', null);
    this.buildMisc();
  }

  /** Debug/preview: every built atlas canvas. */
  listAtlases(): { key: string; canvas: HTMLCanvasElement }[] {
    const out = [...this.atlases].map(([key, a]) => ({ key, canvas: a.canvas }));
    if (this.miscCanvas) out.push({ key: 'misc', canvas: this.miscCanvas });
    return out;
  }

  /** Atlas for kind x team (built on first use). Exposed for the preview tool. */
  atlas(kind: SpriteKind, team: TeamId | null, number?: string): KindAtlas {
    // The referee has no team; skaters asked for team null use HOME colors.
    const tk: TeamId | null = kind === 'ref' ? null : (team ?? 0);
    // only kids and goalies wear per-player numbers (the dog's K9 is fixed)
    const num = kind === 'kid' || kind === 'goalie' ? number : undefined;
    const key = num ? `${kind}:${tk}#${num}` : `${kind}:${tk}`;
    let a = this.atlases.get(key);
    if (!a) this.atlases.set(key, (a = buildKindAtlas(kind, tk, num)));
    return a;
  }

  // (kind, team, number) -> art + atlas, without building string keys every draw
  private resolved = new Map<SpriteKind, Map<TeamId | null, Map<string | undefined, { art: KindArt; atlas: KindAtlas }>>>();

  private resolve(kind: SpriteKind, team: TeamId | null, number?: string): { art: KindArt; atlas: KindAtlas } {
    let byTeam = this.resolved.get(kind);
    if (!byTeam) this.resolved.set(kind, (byTeam = new Map()));
    let byNum = byTeam.get(team);
    if (!byNum) byTeam.set(team, (byNum = new Map()));
    let r = byNum.get(number);
    if (!r) byNum.set(number, (r = { art: kindArt(kind, number), atlas: this.atlas(kind, team, number) }));
    return r;
  }

  frame(kind: SpriteKind, team: TeamId | null, anim: SpriteAnim, screenAngle: number, t: number, number?: string): SpriteFrame {
    const { art, atlas } = this.resolve(kind, team, number);
    const a = resolveAnim(art, anim);
    const def = art.anims[a]!;
    const di = dirIndex(screenAngle);
    const byDir = atlas.frames.get(a)!;
    // an explicitly authored NW (frames with text) beats mirroring NE
    if (di === 7 && byDir.has('NW')) {
      const list = byDir.get('NW')!;
      return list[frameIndex(def, list.length, t)][0];
    }
    const sector = DIR8[di];
    const dir = byDir.has(sector.dir)
      ? sector.dir
      : nearestDir(sector.dir, [...byDir.keys()].filter((k): k is Dir5 => k !== 'NW'));
    const list = byDir.get(dir)!;
    const pair = list[frameIndex(def, list.length, t)];
    // screen-space anims (goalie dives) are already authored toward their side
    return def.screenSpace ? pair[0] : pair[sector.flip ? 1 : 0];
  }

  misc(name: MiscSprite, t = 0): SpriteFrame {
    const list = this.miscFrames.get(name) ?? this.miscFrames.get('puck')!;
    const def = MISC_ANIM[name] ?? { fps: 1, loop: true };
    return list[frameIndex(def, list.length, t)];
  }

  private buildMisc(): void {
    const all = miscArt();
    const names = Object.keys(all);
    const grids = names.flatMap((n) => all[n].map((f) => f.g));
    const packed = packAtlas(grids, teamPalette(TEAMS[0].colors));
    this.miscCanvas = packed.canvas;
    const W = packed.canvas.width;
    const H = packed.canvas.height;
    let i = 0;
    for (const n of names) {
      const list: SpriteFrame[] = [];
      for (const f of all[n]) {
        const c = packed.cells[i++];
        list.push({
          texture: packed.texture,
          u0: c.x / W,
          u1: (c.x + c.w) / W,
          v0: 1 - (c.y + c.h) / H,
          v1: 1 - c.y / H,
          flipX: false,
          w: c.w,
          h: c.h,
          ax: f.ax,
          ay: f.ay,
        });
      }
      this.miscFrames.set(n, list);
    }
  }
}

export function buildSpriteLibrary(): SpriteLibrary {
  return new Library();
}
