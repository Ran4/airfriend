// Billboarded pixel sprites for the 10 skaters, the referee and the puck, with
// blob shadows, 8-way facing + animation selection, the controlled-player
// marker and depth-correct layering. The heavy lifting (pixel-exact screen
// rectangles that still depth-sort in 3D) lives in fx/pixelsprites.ts.
import * as THREE from 'three';
import { GOAL, RINK } from '../config';
import type { GameEvent, GameState, Skater } from '../types';
import type { SpriteAnim, SpriteFrame, SpriteKind, SpriteLibrary } from './art';
import { boundsOf } from './fx/bounds';
import { insideRink, PixelSprites, type DrawInfo, type DrawOpts, type PixelRect } from './fx/pixelsprites';
import { actorScreens, PUCK_ID, REF_ID, type ActorScreen } from './fx/registry';
import { sectorAngle, stepSector } from './sector';

// idle <-> skate thresholds (m/s), with hysteresis so gliders don't twitch
const IDLE_BELOW = 0.45;
const SKATE_ABOVE = 0.9;
const BARK_ANIM_TIME = 0.4;
// how far in front of an occluding actor's depth plane the puck is pulled
const PUCK_FRONT = 0.08;
// what stands just past the rink edge, seen from the lens: the boards' cap band
// and outer wall (0.2 m, arena/boards.ts) and the goal judge's lamp on the end
// glass (to 0.45 m, arena/goals.ts)
const BOARDS_DEPTH = 0.5;
const HIT_FLASH_TIME = 0.14;
// warm white: a pure-white flash vanishes against the cool white ice
const FLASH = new THREE.Color('#fff4c0');

interface ActorAnim {
  anim: SpriteAnim | '';
  t: number;
  sector: number; // 0..7, -1 = unset (see sector.ts)
  since: number; // sim seconds in `sector`
  moving: boolean;
  bark: number; // seconds of bark anim left
  flash: number; // seconds of hit flash left
}

function newAnim(): ActorAnim {
  return { anim: '', t: 0, sector: -1, since: 0, moving: false, bark: 0, flash: 0 };
}

export class ActorLayer {
  private ps: PixelSprites;
  private anims: ActorAnim[] = [];
  private refAnim = newAnim();
  private puckClock = 0;
  private uiClock = 0;
  private markerPop = 0;
  private lastTime = -1;
  private screens: Map<number, ActorScreen>;
  private dist: number[] = [];
  /** actors drawn so far this frame that a loose puck may sort behind (ids into `screens`) */
  private occluders: number[] = [];

  constructor(scene: THREE.Scene, private sprites: SpriteLibrary) {
    this.ps = new PixelSprites(scene);
    this.screens = actorScreens(scene);
  }

  update(state: GameState, camera: THREE.Camera, dt: number): void {
    // Animate on SIM time: freezes on pause, speeds up with ?speed=N.
    let sdt = this.lastTime < 0 ? 0 : state.time - this.lastTime;
    if (!(sdt >= 0) || sdt > 0.25) sdt = 0;
    this.lastTime = state.time;
    this.uiClock += state.paused ? 0 : dt;
    this.markerPop = Math.max(0, this.markerPop - dt);

    const ps = this.ps;
    ps.begin(camera);
    const shadow = this.sprites.misc('shadow');
    this.occluders.length = 0;
    // The puck's shadow goes first: shadows darken each pixel once and the
    // first one drawn wins, so the darker puck shadow still shows inside a
    // skater's blob (a loose puck in a scrum keeps its contact shadow).
    const puckHidden = this.puckInGlove(state);
    if (!puckHidden) this.ps.flat(this.sprites.misc('puckShadow'), state.puck.pos.x, state.puck.pos.z);

    // The scorer is drawn last and pulled in front of the teammates mobbing
    // him, so a celebration never buries the goal hero (PAL is the smallest
    // sprite on the ice and the mob converges on him from every side).
    const scorer = this.scorerId(state);
    for (const s of state.skaters) if (s.id !== scorer) this.drawSkater(s, state, sdt, shadow, false);
    this.drawRef(state, sdt, shadow);
    const hero = scorer !== null ? state.skaters[scorer] : undefined;
    if (hero) this.drawSkater(hero, state, sdt, shadow, true);
    this.drawPuck(state, sdt, puckHidden);
    const ctl = state.skaters[state.controlledId];
    const head = this.screens.get(state.controlledId);
    if (ctl && ctl.state !== 'box' && head?.visible) this.drawMarker(ctl, head);

    ps.end();
  }

  onEvents(events: GameEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'bark':
          if (this.anims[e.skaterId]) this.anims[e.skaterId].bark = BARK_ANIM_TIME;
          break;
        case 'check':
          if (this.anims[e.victim] && (e.knockedDown || e.force > 3)) this.anims[e.victim].flash = HIT_FLASH_TIME;
          break;
        case 'controlSwitch':
          this.markerPop = 0.5;
          break;
        case 'rematch':
          this.lastTime = -1;
          for (const a of this.anims) Object.assign(a, newAnim());
          break;
      }
    }
  }

  // ------------------------------------------------------------ helpers ----

  /** One skater: animation, blob shadow, sprite. `inFront`: drawn over overlapping actors. */
  private drawSkater(s: Skater, state: GameState, sdt: number, shadow: SpriteFrame, inFront: boolean): void {
    const ps = this.ps;
    const a = (this.anims[s.id] ??= newAnim());
    a.bark = Math.max(0, a.bark - sdt);
    a.flash = Math.max(0, a.flash - sdt);
    const kind: SpriteKind = s.kind;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const angle = this.screenAngle(a, s.facing, sdt);
    const anim = this.pickAnim(s, a, speed);
    if (anim !== a.anim) {
      a.anim = anim;
      a.t = 0;
    } else {
      a.t += sdt * this.animRate(anim, speed);
    }
    const frame = this.sprites.frame(kind, s.team, anim, angle, a.t, s.number);

    // stunned (barked at): 1 px shiver. invulnerable: classic SNES blink.
    const dx = s.stun > 0 && s.state !== 'fallen' ? (Math.floor(state.time * 30) % 2 ? 1 : -1) : 0;
    const blinkOff = s.invuln > 0 && s.state !== 'fallen' && Math.floor(state.time * 20) % 2 === 1;
    const flashing = a.flash > 0 && Math.floor(a.flash * 30) % 2 === 0;

    this.drawShadow(shadow, frame, s.pos.x, s.pos.z);
    const onIce = s.state !== 'box' && insideRink(s.pos.x, s.pos.z, 0);
    let maxDist: number | undefined;
    // one options object for both draws (read synchronously, never kept)
    const o = this.skaterOpts;
    o.dx = dx;
    o.onIce = onIce;
    o.maxDist = undefined;
    o.tint = undefined;
    if (inFront) {
      // priority bit, as for the puck: lay out, then pull the depth plane in
      // front of every actor drawn so far whose opaque pixels overlap
      o.hidden = true;
      const probe = ps.upright(frame, s.pos.x, 0, s.pos.z, o);
      if (probe) {
        const occ = this.overActors(probe.rect, probe.dist);
        if (Number.isFinite(occ.front)) maxDist = occ.front;
      }
    }
    o.maxDist = maxDist;
    o.hidden = blinkOff; // still placed, so the marker stays steady through the blink
    o.tint = flashing ? FLASH : undefined;
    o.tintAmount = 0.8;
    const info = ps.upright(frame, s.pos.x, 0, s.pos.z, o);
    this.dist[s.id] = info && !blinkOff ? info.dist : Infinity;
    this.publish(s.id, info, frame);
    if (info && !blinkOff) this.occluders.push(s.id);
  }

  /** The goal scorer while his team celebrates (phase 'goal'), else null. */
  private scorerId(state: GameState): number | null {
    if (state.phase !== 'goal') return null;
    const g = state.goals[state.goals.length - 1];
    return g && state.skaters[g.scorer] ? g.scorer : null;
  }

  /**
   * Facing in screen space (DESIGN.md section 3): the heading vector expressed
   * in camera space, x = dot(dir, camRight), y = dot(dir, camForward) on the ice
   * plane. Quantized to the 8 sprite directions with hysteresis and a minimum
   * dwell (sector.ts) and returned as the sector's center angle, so the
   * library and we agree on the sector.
   */
  private screenAngle(a: ActorAnim, facing: number, sdt: number): number {
    const p = this.ps.proj;
    const dx = Math.sin(facing);
    const dz = Math.cos(facing);
    const xs = dx * p.rightH.x + dz * p.rightH.y;
    const ys = dx * p.fwdH.x + dz * p.fwdH.y;
    return sectorAngle(stepSector(a, Math.atan2(xs, ys), sdt));
  }

  private pickAnim(s: Skater, a: ActorAnim, speed: number): SpriteAnim {
    a.moving = a.moving ? speed > IDLE_BELOW : speed > SKATE_ABOVE;
    if (s.kind === 'goalie') {
      switch (s.state) {
        case 'gButterfly':
        case 'fallen':
          return 'gButterfly';
        case 'gHold':
          return 'gHold';
        case 'gDiveL':
        case 'gDiveR':
          // screen-relative in both the sim (goalie.ts) and the art
          return s.state;
        default:
          return a.moving ? 'gSkate' : 'gReady';
      }
    }
    switch (s.state) {
      case 'skate':
        if (a.bark > 0 && s.kind === 'dog') return 'bark';
        return a.moving ? 'skate' : 'idle';
      case 'box':
        return a.bark > 0 && s.kind === 'dog' ? 'bark' : 'idle';
      case 'windup':
      case 'shoot':
      case 'pass':
      case 'poke':
      case 'check':
      case 'fallen':
      case 'celebrate':
      case 'faceoff':
        return s.state;
      default:
        return a.moving ? 'skate' : 'idle';
    }
  }

  /** Stride frame rate follows skating speed; everything else runs at 1x. */
  private animRate(anim: SpriteAnim, speed: number): number {
    switch (anim) {
      case 'skate':
        return Math.min(1.6, Math.max(0.35, speed / 7));
      case 'gSkate':
        return Math.min(1.5, Math.max(0.5, speed / 2.5));
      case 'refSkate':
        return Math.min(1.4, speed / 5);
      default:
        return 1;
    }
  }

  /**
   * Blob shadow under an actor. Wide poses (a diving goalie, a skater lying on
   * the ice) get overlapping copies spread across the sprite's footprint;
   * shadows darken each pixel once, so the copies merge into one long blob.
   */
  private drawShadow(shadow: SpriteFrame, frame: SpriteFrame, x: number, z: number): void {
    const bb = boundsOf(frame);
    const w = bb.r - bb.l;
    const sw = boundsOf(shadow).r - boundsOf(shadow).l;
    if (w <= sw + 4) {
      this.ps.flat(shadow, x, z);
      return;
    }
    const l = frame.flipX ? frame.w - bb.r : bb.l;
    const center = l + w / 2 - frame.ax; // displayed px from the anchor
    const k = this.ps.scale;
    const spread = (w - sw) / 2;
    for (let i = -1; i <= 1; i++) this.ps.flat(shadow, x, z, { dx: Math.round((center + i * spread) * k) });
  }

  private publish(id: number, info: DrawInfo | null, frame: SpriteFrame): void {
    let scr = this.screens.get(id);
    if (!scr) {
      scr = { visible: false, sx: 0, sy: 0, top: 0, bottom: 0, left: 0, right: 0, scale: 1, dist: 0 };
      this.screens.set(id, scr);
    }
    if (!info) {
      scr.visible = false;
      return;
    }
    const bb = boundsOf(frame);
    const k = info.scale;
    // opaque extents in screen pixels (mirroring swaps left/right)
    const l = frame.flipX ? frame.w - bb.r : bb.l;
    const r = frame.flipX ? frame.w - bb.l : bb.r;
    const fx0 = info.sx - frame.ax * k; // ax is in displayed (mirrored) space
    scr.visible = true;
    scr.sx = info.sx;
    scr.sy = info.sy;
    scr.left = Math.round(fx0 + l * k);
    scr.right = Math.round(fx0 + r * k);
    scr.top = Math.round(info.sy - (bb.t - frame.ay) * k);
    scr.bottom = Math.round(info.sy - (bb.b - frame.ay) * k);
    scr.scale = k;
    scr.dist = info.dist;
  }

  private drawRef(state: GameState, sdt: number, shadow: SpriteFrame): void {
    const r = state.referee;
    const a = this.refAnim;
    const speed = Math.hypot(r.vel.x, r.vel.z);
    const angle = this.screenAngle(a, r.facing, sdt);
    a.moving = a.moving ? speed > IDLE_BELOW : speed > SKATE_ABOVE;
    const anim: SpriteAnim =
      r.state === 'whistle' ? 'refWhistle' : r.state === 'point' ? 'refPoint' : r.state === 'skate' && a.moving ? 'refSkate' : 'idle';
    if (anim !== a.anim) {
      a.anim = anim;
      a.t = 0;
    } else {
      a.t += sdt * this.animRate(anim, speed);
    }
    const frame = this.sprites.frame('ref', null, anim, angle, a.t);
    this.ps.flat(shadow, r.pos.x, r.pos.z);
    const info = this.ps.upright(frame, r.pos.x, 0, r.pos.z, { onIce: insideRink(r.pos.x, r.pos.z, 0) });
    this.publish(REF_ID, info, frame);
    if (info) this.occluders.push(REF_ID);
  }

  /** A goalie covering the puck holds it in the glove (drawn by the gHold art). */
  private puckInGlove(state: GameState): boolean {
    const pk = state.puck;
    return pk.owner !== null && state.skaters[pk.owner]?.state === 'gHold';
  }

  private drawPuck(state: GameState, sdt: number, inGlove: boolean): void {
    const pk = state.puck;
    const speed = Math.hypot(pk.vel.x, pk.vel.z);
    this.puckClock += sdt * (pk.owner !== null ? 4 : Math.min(8, speed / 3));
    const frame = this.sprites.misc('puck', this.puckClock);
    if (inGlove) {
      this.publish(PUCK_ID, null, frame);
      return;
    }
    const y = Math.max(0, pk.y);
    const onIce = insideRink(pk.pos.x, pk.pos.z, 0);
    // A carried puck stays visible on the carrier's stick even when it is
    // geometrically behind the carrier (skating up-screen).
    const carrierDist = pk.owner !== null ? this.dist[pk.owner] : undefined;
    let maxDist = carrierDist !== undefined && Number.isFinite(carrierDist) ? carrierDist - PUCK_FRONT : Infinity;
    // SNES priority bit: the puck is never hidden behind a player. A loose
    // puck under a scrum would otherwise sort behind legs and vanish, so lay
    // it out first and pull its depth plane in front of every actor whose
    // opaque pixels overlap it. Only the depth moves, never the pixels, and
    // boards, glass and nets nearer than that actor still cover it.
    // Over any player (in front of him or pulled there), the carrier
    // included, it gets the rimmed sprite so it doesn't melt into navy pants,
    // skates, outlines or the black tape on the blade it sits on.
    let drawn = frame;
    const probe = this.ps.upright(frame, pk.pos.x, y, pk.pos.z, { onIce, hidden: true });
    if (probe) {
      const occ = this.overActors(probe.rect, Math.min(probe.dist, maxDist));
      maxDist = Math.min(maxDist, occ.front);
      if (occ.over) drawn = this.sprites.misc('puckLit', this.puckClock);
    }
    // Same for the boards and glass between it and the lens: a puck tight to
    // the near boards would hide behind them (or behind a glass stanchion),
    // while the skaters next to it don't.
    const boards = onIce && y < RINK.glassHeight ? this.frontOfBoards(pk.pos.x, y, pk.pos.z) : Infinity;
    maxDist = Math.min(maxDist, boards, this.frontOfNet(pk.pos.x, pk.pos.z));
    const info = this.ps.upright(drawn, pk.pos.x, y, pk.pos.z, {
      maxDist: Number.isFinite(maxDist) ? maxDist : undefined,
      // a plane pulled out over the boards is outside the rink on purpose
      onIce: onIce && !Number.isFinite(boards),
    });
    // publish the plain puck's extents either way (the rim is decoration)
    this.publish(PUCK_ID, info, frame);
  }

  /**
   * A puck inside a net (the goal moment) is drawn in front of that net's
   * mesh and frame: seen through the back of the near net it would turn into
   * a gray smudge. Returns the depth plane, or Infinity when outside both.
   */
  private frontOfNet(x: number, z: number): number {
    const az = Math.abs(z);
    const hw = GOAL.halfWidth + 0.12;
    if (Math.abs(x) > hw || az < RINK.goalLineZ - 0.05 || az > RINK.goalLineZ + GOAL.depth + 0.1) return Infinity;
    const end = Math.sign(z);
    const p = this.ps.proj;
    let d = Infinity;
    for (const cx of [-hw, hw]) {
      // the back of the mesh bulges out to ~1.18x depth on a goal (arena/goals.ts)
      for (const cz of [RINK.goalLineZ - 0.1, RINK.goalLineZ + GOAL.depth * 1.2 + 0.05]) d = Math.min(d, p.planeDist(cx, end * cz));
    }
    return d - PUCK_FRONT;
  }

  /**
   * Depth plane just in front of the boards when they stand between the lens
   * and an on-ice point at height y (its sight line crosses the rink edge
   * below the top of the glass), or Infinity when they don't. The glass counts:
   * it is nearly clear, but its stanchions and glare streaks are not, and a
   * 5x3 puck fits behind one.
   */
  private frontOfBoards(x: number, y: number, z: number): number {
    const p = this.ps.proj;
    const cam = p.camPos;
    const dx = cam.x - x;
    const dz = cam.z - z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3 || cam.y <= y + 0.01) return Infinity;
    // past this horizontal distance the sight line clears the top of the glass
    const reach = Math.min(len, ((RINK.glassHeight - y) * len) / (cam.y - y));
    for (let s = 0.05; s < reach; s += 0.05) {
      const bx = x + (dx * s) / len;
      const bz = z + (dz * s) / len;
      if (!insideRink(bx, bz, 0)) return p.planeDist(x + (dx * (s + BOARDS_DEPTH)) / len, z + (dz * (s + BOARDS_DEPTH)) / len);
    }
    return Infinity;
  }

  private skaterOpts: DrawOpts = {};
  private occ = { front: Infinity, over: false };
  /**
   * For a sprite at `rect` (depth `dist`) against the actors drawn this frame:
   * whether it overlaps any of their opaque extents, and the
   * depth plane that puts it in front of all overlapping ones nearer than it
   * (Infinity if none is).
   */
  private overActors(rect: PixelRect, dist: number): { front: number; over: boolean } {
    const r = this.occ;
    r.front = Infinity;
    r.over = false;
    for (const id of this.occluders) {
      const o = this.screens.get(id);
      if (!o?.visible) continue;
      if (rect.x0 >= o.right || rect.x1 <= o.left || rect.y0 >= o.bottom || rect.y1 <= o.top) continue;
      r.over = true;
      const d = o.dist - PUCK_FRONT;
      if (d < dist) r.front = Math.min(r.front, d);
    }
    return r;
  }

  private drawMarker(s: Skater, head: ActorScreen): void {
    // During a control switch the marker blinks to draw the eye.
    if (this.markerPop > 0 && Math.floor(this.markerPop * 16) % 2 === 1) return;
    const m = this.sprites.misc('marker', this.uiClock);
    const mk = this.markerInfo();
    // If the art bounces the arrow inside its cell we keep the cell still so
    // the bounce shows; otherwise we bob it 1 px ourselves (2-step, SNES cursor).
    const bob = mk.animated ? 0 : Math.floor(this.uiClock * 4) % 2;
    const mb = boundsOf(m);
    const cx = (head.left + head.right) / 2;
    // Hang it at a fixed height over the STANDING sprite, not the current
    // frame's head, so stride bobs and celebration hops don't jiggle it.
    const top = Math.round(head.sy - this.standHeight(s) * head.scale);
    // the arrow's lowest point sits 3 px above the head; UI, so 1:1 scale
    const sy = top - 3 + (mk.minB - m.ay) - bob;
    const sx = Math.round(cx - ((mb.l + mb.r) / 2 - m.ax));
    this.ps.screen(m, sx, sy, 1, head.dist, { layer: 'overlay' });
  }

  private standHeights = new Map<string, number>();
  /** Opaque height above the anchor of a kind's idle pose (facing the camera), source px. */
  private standHeight(s: Skater): number {
    const key = `${s.kind}:${s.team}`;
    let h = this.standHeights.get(key);
    if (h === undefined) {
      const anim: SpriteAnim = s.kind === 'goalie' ? 'gReady' : 'idle';
      const f = this.sprites.frame(s.kind, s.team, anim, Math.PI, 0, s.number);
      h = boundsOf(f).t - f.ay;
      this.standHeights.set(key, h);
    }
    return h;
  }

  private markerMeta: { animated: boolean; minB: number } | null = null;
  private markerInfo(): { animated: boolean; minB: number } {
    if (!this.markerMeta) {
      const bs = new Set<number>();
      let minB = Infinity;
      for (let i = 0; i < 24; i++) {
        const b = boundsOf(this.sprites.misc('marker', i / 24)).b;
        bs.add(b);
        minB = Math.min(minB, b);
      }
      this.markerMeta = { animated: bs.size > 1, minB };
    }
    return this.markerMeta;
  }
}
