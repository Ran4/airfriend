// Pixel particles & world FX: ice spray on hard stops/checks, puck streaks on
// hard shots, the "ARF!" bark bubble, the "HEY!" call-for-pass bubble, "!" on startled skaters, dizzy stars
// over fallen skaters, the goal sparkle burst + net flash, post puffs.
// Everything is a pooled pixel sprite (fx/pixelsprites.ts): no smooth alpha,
// only frame swaps, blinking and SNES-style half-transparency.
import * as THREE from 'three';
import { GOAL, RINK, TEAMS } from '../config';
import { attackDir } from '../sim/rink';
import type { GameEvent, GameState, Vec2 } from '../types';
import type { SpriteFrame, SpriteLibrary } from './art';
import { boundsOf } from './fx/bounds';
import { fxFrame } from './fx/fxatlas';
import { PixelSprites, type DrawOpts, type SpriteLayer } from './fx/pixelsprites';
import { actorScreens, type ActorScreen } from './fx/registry';

type Look = 'spray' | 'chip' | 'streak' | 'star' | 'goldStar' | 'twinkle' | 'puff' | 'spark' | 'confetti';

interface Particle {
  alive: boolean;
  look: Look;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  g: number; // gravity, m/s^2
  drag: number; // velocity fraction lost per second
  age: number;
  life: number;
  layer: SpriteLayer;
  tint: THREE.Color | null;
  land: boolean; // dies when it touches the ice
  blink: boolean; // blinks out over the last third of its life
  phase: number; // anim clock offset, so a burst doesn't twinkle in lockstep
}

const MAX_PARTICLES = 320;
const ARF_TIME = 0.7;
const HEY_TIME = 0.5;
const BANG_TIME = 0.55;
const GOAL_FLASH_TIME = 0.4;
const GOAL_TWINKLE_TIME = 1.8;
const STREAK_MIN_POWER = 0.45;
const STREAK_MIN_SPEED = 12;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Effects {
  private ps: PixelSprites;
  private parts: Particle[] = [];
  private free: Particle[] = [];
  private screens: Map<number, ActorScreen>;
  private lastTime = -1;
  private clock = 0;
  private arf: { id: number; t: number } | null = null;
  private heys = new Map<number, number>(); // skater id -> seconds left
  private bangs = new Map<number, number>();
  private streak: { t: number; x: number; y: number; z: number } | null = null;
  private goalFx: { t: number; z: number; team: 0 | 1; spawn: number } | null = null;
  private teamTints: [THREE.Color[], THREE.Color[]] = [
    [new THREE.Color(TEAMS[0].colors.jersey), new THREE.Color(TEAMS[0].colors.trim), new THREE.Color('#f8e030')],
    [new THREE.Color(TEAMS[1].colors.jersey), new THREE.Color(TEAMS[1].colors.trim), new THREE.Color('#f8f8f8')],
  ];
  private corner = { x: 0, y: 0 };
  /** draw options reused for every particle (read synchronously by the draw) */
  private partOpts: DrawOpts = {};
  private turboTimers: number[] = [];

  constructor(scene: THREE.Scene, private sprites: SpriteLibrary) {
    // +1: effect overlays draw above the actor layer's marker
    this.ps = new PixelSprites(scene, 1);
    this.screens = actorScreens(scene);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = { alive: false } as Particle;
      this.parts.push(p);
      this.free.push(p);
    }
  }

  update(state: GameState, camera: THREE.Camera): void {
    // sim time: effects freeze on pause and keep pace with ?speed=N
    let sdt = this.lastTime < 0 ? 0 : state.time - this.lastTime;
    if (!(sdt >= 0) || sdt > 0.25) sdt = 0;
    this.lastTime = state.time;
    this.clock += sdt;

    const ps = this.ps;
    ps.begin(camera);
    this.updateStreak(state, sdt);
    this.updateGoal(sdt);
    this.updateTurbo(state, sdt);

    for (const p of this.parts) {
      if (!p.alive) continue;
      p.age += sdt;
      if (p.age >= p.life) {
        this.kill(p);
        continue;
      }
      p.vy -= p.g * sdt;
      const k = Math.max(0, 1 - p.drag * sdt);
      p.vx *= k;
      p.vz *= k;
      p.x += p.vx * sdt;
      p.y += p.vy * sdt;
      p.z += p.vz * sdt;
      if (p.y < 0) {
        if (p.land) {
          this.kill(p);
          continue;
        }
        p.y = 0;
        p.vy = 0;
      }
      const u = p.age / p.life;
      if (p.blink && u > 0.66 && Math.floor(p.age * 30) % 2 === 1) continue;
      const o = this.partOpts;
      o.layer = p.layer;
      o.tint = p.tint ?? undefined;
      ps.upright(this.frameFor(p, u), p.x, p.y, p.z, o);
    }

    this.drawAttachments(state, sdt);
    ps.end();
  }

  onEvents(events: GameEvent[], state: GameState): void {
    for (const e of events) {
      switch (e.type) {
        case 'hardStop': {
          const s = state.skaters[e.skaterId];
          if (!s) break;
          const sp = Math.hypot(s.vel.x, s.vel.z);
          // spray flies the way the skater was travelling
          const a = sp > 1.5 ? Math.atan2(s.vel.x, s.vel.z) : s.facing;
          this.spray(s.pos.x, s.pos.z, a, Math.round(Math.min(18, Math.max(9, e.speed * 2))), Math.min(1.3, Math.max(0.8, e.speed / 6)));
          break;
        }
        case 'check': {
          const v = state.skaters[e.victim];
          const h = state.skaters[e.hitter];
          if (!v) break;
          const n = e.knockedDown ? 16 : 9;
          this.burst(v.pos.x, v.pos.z, n);
          if (h && (e.knockedDown || e.force > 4)) {
            this.spawn('spark', (v.pos.x + h.pos.x) / 2, 0.9, (v.pos.z + h.pos.z) / 2, 0, 0, 0, 0.16, { layer: 'overlay', g: 0 });
          }
          break;
        }
        case 'bodyBoards': {
          const s = state.skaters[e.skaterId];
          if (s) this.burst(s.pos.x, s.pos.z, 10);
          break;
        }
        case 'callFor':
          this.heys.set(e.skaterId, HEY_TIME);
          break;
        case 'bark':
          this.arf = { id: e.skaterId, t: ARF_TIME };
          for (const id of e.startled) this.bangs.set(id, BANG_TIME);
          break;
        case 'shot':
          if (e.power >= STREAK_MIN_POWER) {
            const pk = state.puck;
            this.streak = { t: 0.7, x: pk.pos.x, y: pk.y, z: pk.pos.z };
          }
          break;
        case 'post':
          this.postPuff(e.pos);
          break;
        case 'netHit':
          this.chips(e.pos.x, 0.2, e.pos.z, 4, 2);
          break;
        case 'boards':
          if (e.speed > 12) this.chips(e.pos.x, 0.15, e.pos.z, 3, 2);
          break;
        case 'save': {
          const pk = state.puck;
          if (e.caught) this.spawn('spark', pk.pos.x, Math.max(0.5, pk.y), pk.pos.z, 0, 0, 0, 0.14, { layer: 'overlay', g: 0 });
          else this.chips(pk.pos.x, Math.max(0.1, pk.y), pk.pos.z, 7, 3);
          break;
        }
        case 'goal':
          this.goalBurst(e.info.team, e.info.period, state.puck.pos.x);
          break;
        case 'turboStart': {
          const s = state.skaters[e.skaterId];
          if (!s) break;
          // a little kick of ice behind the skates
          const bx = -Math.sin(s.facing);
          const bz = -Math.cos(s.facing);
          for (let i = 0; i < 4; i++) {
            this.spawn('chip', s.pos.x + bx * 0.3, 0.05, s.pos.z + bz * 0.3, bx * rand(1, 2.5) + rand(-0.8, 0.8), rand(0.8, 1.6), bz * rand(1, 2.5) + rand(-0.8, 0.8), rand(0.18, 0.28), { land: true });
          }
          break;
        }
        case 'faceoffDrop': {
          const spot = state.faceoff?.spot ?? state.puck.pos;
          this.chips(spot.x, 0.05, spot.z, 5, 1.6);
          break;
        }
        case 'fumble':
          this.chips(state.puck.pos.x, 0.1, state.puck.pos.z, 4, 2);
          break;
        case 'rematch':
        case 'intermissionStart':
          this.clear();
          break;
      }
    }
  }

  // ---------------------------------------------------------- spawning ----

  private spawn(
    look: Look,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    o: { g?: number; drag?: number; layer?: SpriteLayer; tint?: THREE.Color; land?: boolean; blink?: boolean } = {},
  ): void {
    const p = this.free.pop();
    if (!p) return;
    p.alive = true;
    p.look = look;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.life = life;
    p.age = 0;
    p.g = o.g ?? 11;
    p.drag = o.drag ?? 0;
    p.layer = o.layer ?? 'world';
    p.tint = o.tint ?? null;
    p.land = o.land ?? false;
    p.blink = o.blink ?? false;
    p.phase = Math.random() * 2;
  }

  private kill(p: Particle): void {
    p.alive = false;
    this.free.push(p);
  }

  private clear(): void {
    for (const p of this.parts) if (p.alive) this.kill(p);
    this.arf = null;
    this.heys.clear();
    this.bangs.clear();
    this.streak = null;
    this.goalFx = null;
  }

  /** Directional ice spray (hockey stop): a fan of chips thrown along heading `a`. */
  private spray(x: number, z: number, a: number, n: number, power: number): void {
    const fx = Math.sin(a);
    const fz = Math.cos(a);
    for (let i = 0; i < n; i++) {
      const side = rand(-1, 1);
      const sp = rand(3, 7) * power;
      const vx = fx * sp - fz * side * 3;
      const vz = fz * sp + fx * side * 3;
      // every third grain is a small chip so the fan has texture
      this.spawn(i % 3 === 2 ? 'chip' : 'spray', x + fx * 0.4, rand(0.05, 0.3), z + fz * 0.4, vx, rand(1.5, 3.6), vz, rand(0.4, 0.65), { land: true, drag: 1.0 });
    }
  }

  /** Radial ice burst (body checks). */
  private burst(x: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
      const sp = rand(1.5, 3.8);
      this.spawn(i % 3 === 0 ? 'chip' : 'spray', x, 0.1, z, Math.sin(a) * sp, rand(1.5, 3.5), Math.cos(a) * sp, rand(0.3, 0.5), { land: true, drag: 1.2 });
    }
  }

  private chips(x: number, y: number, z: number, n: number, sp: number): void {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(0.5, 1) * sp;
      this.spawn('chip', x, y, z, Math.sin(a) * s, rand(0.8, 2.2), Math.cos(a) * s, rand(0.18, 0.32), { land: true });
    }
  }

  private postPuff(pos: Vec2): void {
    this.spawn('spark', pos.x, 0.25, pos.z, 0, 0, 0, 0.12, { layer: 'overlay', g: 0 });
    this.spawn('puff', pos.x, 0.25, pos.z, 0, 0, 0, 0.27, { g: 0 });
    this.chips(pos.x, 0.2, pos.z, 6, 2.2);
  }

  private goalBurst(team: 0 | 1, period: number, puckX: number): void {
    const gz = attackDir(team, period) * RINK.goalLineZ;
    const out = -Math.sign(gz); // out of the net, toward center ice
    const mx = Math.max(-0.75, Math.min(0.75, puckX));
    // a fountain of sparkles out of the goal mouth: the library's outlined
    // stars twinkle, solid gold stars keep it readable on white ice
    for (let i = 0; i < 20; i++) {
      const a = rand(-1.4, 1.4);
      const sp = rand(2.5, 7);
      this.spawn(i % 3 === 0 ? 'goldStar' : 'star', mx + rand(-0.5, 0.5), rand(0.3, 1.0), gz + out * 0.2, Math.sin(a) * sp, rand(3, 7), out * Math.cos(a) * sp, rand(0.8, 1.4), {
        layer: 'overlay',
        g: 7,
        drag: 0.9,
        blink: true,
        land: true,
      });
    }
    const tints = this.teamTints[team];
    for (let i = 0; i < 28; i++) {
      this.spawn('confetti', mx + rand(-0.6, 0.6), rand(1.2, 1.8), gz + out * rand(0, 0.5), rand(-2.5, 2.5), rand(2.5, 5), out * rand(0.5, 3), rand(1.4, 2.2), {
        g: 3.5,
        drag: 1.6,
        tint: tints[i % tints.length],
        land: true,
        blink: true,
      });
    }
    this.goalFx = { t: 0, z: gz, team, spawn: 0 };
  }

  // ----------------------------------------------------------- per frame ----

  /** Trail dots behind a hard shot until the puck slows, gets caught or stopped. */
  private updateStreak(state: GameState, sdt: number): void {
    const st = this.streak;
    if (!st) return;
    st.t -= sdt;
    const pk = state.puck;
    const speed = Math.hypot(pk.vel.x, pk.vel.z);
    if (st.t <= 0 || pk.owner !== null || speed < STREAK_MIN_SPEED) {
      this.streak = null;
      return;
    }
    const dx = pk.pos.x - st.x;
    const dz = pk.pos.z - st.z;
    const len = Math.hypot(dx, dz);
    if (len > 8) {
      st.x = pk.pos.x;
      st.z = pk.pos.z;
      st.y = pk.y;
      return;
    }
    const step = 0.22;
    const n = Math.floor(len / step);
    for (let i = 0; i < n; i++) {
      const f = (i * step) / len;
      this.spawn('streak', st.x + dx * f, Math.max(0, st.y + (pk.y - st.y) * f), st.z + dz * f, 0, 0, 0, 0.14, { g: 0 });
    }
    if (n > 0) {
      const f = (n * step) / len;
      st.x += dx * f;
      st.z += dz * f;
      st.y += (pk.y - st.y) * f;
    }
  }

  /** Sprinting skaters kick up a sparse trail of ice dust behind their skates. */
  private updateTurbo(state: GameState, sdt: number): void {
    if (sdt <= 0) return;
    for (const s of state.skaters) {
      const sp = Math.hypot(s.vel.x, s.vel.z);
      if (!s.turboActive || sp < 5 || s.state === 'box' || s.state === 'fallen') {
        this.turboTimers[s.id] = 0;
        continue;
      }
      const t = (this.turboTimers[s.id] ?? 0) - sdt;
      if (t > 0) {
        this.turboTimers[s.id] = t;
        continue;
      }
      this.turboTimers[s.id] = t + 0.09;
      const bx = -s.vel.x / sp;
      const bz = -s.vel.z / sp;
      const side = rand(-0.25, 0.25);
      this.spawn('chip', s.pos.x + bx * 0.35 - bz * side, 0.04, s.pos.z + bz * 0.35 + bx * side, bx * rand(0.5, 1.5), rand(0.6, 1.2), bz * rand(0.5, 1.5), rand(0.16, 0.24), { land: true });
    }
  }

  /** Goal mouth flash (half-transparent white, blinking) + twinkles in the net. */
  private updateGoal(sdt: number): void {
    const g = this.goalFx;
    if (!g) return;
    g.t += sdt;
    if (g.t > GOAL_TWINKLE_TIME) {
      this.goalFx = null;
      return;
    }
    const back = g.z + Math.sign(g.z) * GOAL.depth;
    if (g.t < GOAL_FLASH_TIME && Math.floor(g.t * 15) % 2 === 0) {
      // screen bbox of the whole goal frame
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let dist = Infinity;
      for (const cx of [-GOAL.halfWidth, GOAL.halfWidth]) {
        for (const cy of [0, GOAL.height]) {
          for (const cz of [g.z, back]) {
            if (!this.ps.proj.project(cx, cy, cz, this.corner)) continue;
            x0 = Math.min(x0, this.corner.x);
            x1 = Math.max(x1, this.corner.x);
            y0 = Math.min(y0, this.corner.y);
            y1 = Math.max(y1, this.corner.y);
            dist = Math.min(dist, this.ps.proj.planeDist(cx, cz));
          }
        }
      }
      if (Number.isFinite(x0)) {
        const solid = fxFrame('solid');
        const w = Math.max(1, Math.round(x1 - x0));
        const h = Math.max(1, Math.round(y1 - y0));
        // solid's anchor is its center
        this.ps.screen(solid, Math.round(x0) + w / 2, Math.round(y0) + h / 2, 1, dist, { layer: 'glow', sizePx: { w, h } });
      }
    }
    g.spawn -= sdt;
    while (g.spawn <= 0 && g.t < GOAL_TWINKLE_TIME - 0.3) {
      g.spawn += 0.06;
      const z = g.z + Math.sign(g.z) * rand(0, GOAL.depth * 0.8);
      this.spawn('twinkle', rand(-GOAL.halfWidth, GOAL.halfWidth), rand(0.1, GOAL.height), z, 0, 0, 0, 0.24, { layer: 'overlay', g: 0, blink: true });
    }
  }

  private drawAttachments(state: GameState, sdt: number): void {
    const ps = this.ps;
    // ARF! bubble, follows the dog's head
    if (this.arf) {
      const a = this.arf;
      a.t -= sdt;
      if (a.t <= 0 || !state.skaters[a.id]) this.arf = null;
      else this.drawBubble(state, 'arf', a.id, a.t, ARF_TIME);
    }
    // HEY! bubble over a skater calling for the puck (an ARF! on the same
    // head wins: one balloon at a time)
    for (const [id, t] of this.heys) {
      const nt = t - sdt;
      if (nt <= 0 || !state.skaters[id]) {
        this.heys.delete(id);
        continue;
      }
      this.heys.set(id, nt);
      if (this.arf?.id !== id) this.drawBubble(state, 'hey', id, nt, HEY_TIME);
    }
    // "!" over startled skaters
    for (const [id, t] of this.bangs) {
      const nt = t - sdt;
      if (nt <= 0) {
        this.bangs.delete(id);
        continue;
      }
      this.bangs.set(id, nt);
      const head = this.screens.get(id);
      if (!head?.visible) continue;
      const f = fxFrame('bang');
      const hop = BANG_TIME - nt < 0.08 ? 2 : 0;
      ps.screen(f, (head.left + head.right) / 2, head.top - 2 - f.h / 2 - hop, 1, head.dist, { layer: 'overlay' });
    }
    // dizzy stars circling over fallen skaters
    for (const s of state.skaters) {
      if (s.state !== 'fallen' || s.kind === 'goalie') continue;
      const head = this.screens.get(s.id);
      if (!head?.visible) continue;
      const cx = (head.left + head.right) / 2;
      const cy = head.top - 3;
      for (let k = 0; k < 2; k++) {
        const ang = this.clock * 7 + k * Math.PI + s.id;
        const front = Math.sin(ang) > 0;
        const f = fxFrame(front ? 'dizzy' : 'dizzyS');
        ps.screen(f, Math.round(cx + Math.cos(ang) * 6), Math.round(cy + Math.sin(ang) * 2), 1, head.dist, { layer: 'overlay' });
      }
    }
  }

  /**
   * A speech balloon over a skater's head, up and to the side he faces, clear
   * of the marker. `t` counts down from `life`: a tiny pop-in bounce at the
   * start, a blink-out over the last 0.15 s.
   */
  private drawBubble(state: GameState, name: 'arf' | 'hey', id: number, t: number, life: number): void {
    const head = this.screens.get(id);
    const s = state.skaters[id];
    if (!s || !head?.visible || (t < 0.15 && Math.floor(t * 30) % 2 === 1)) return;
    const f = this.sprites.misc(name, life - t);
    const bb = boundsOf(f);
    const pop = life - t < 0.06 ? 2 : 0;
    const facingLeft = this.screenX(s.facing) < -0.3;
    const bw = bb.r - bb.l;
    const left = facingLeft ? head.left - bw + 3 : head.right - 3;
    const bottom = head.top + 3 - pop;
    this.ps.screen(f, left - bb.l + f.ax, bottom + (bb.b - f.ay), 1, head.dist, { layer: 'overlay' });
  }

  /** screen-x component of a world heading (+1 = screen right) */
  private screenX(facing: number): number {
    const r = this.ps.proj.rightH;
    return Math.sin(facing) * r.x + Math.cos(facing) * r.y;
  }

  private frameFor(p: Particle, u: number): SpriteFrame {
    switch (p.look) {
      case 'spray':
        return this.sprites.misc(u < 0.5 ? 'spray0' : 'spray1', p.age);
      case 'chip':
        return fxFrame(u < 0.5 ? 'chip' : 'chipS');
      case 'streak':
        return fxFrame(u < 0.34 ? 'streak0' : u < 0.67 ? 'streak1' : 'streak2');
      case 'star':
        return this.sprites.misc('star', p.age + p.phase);
      case 'goldStar':
        return fxFrame(Math.floor((p.age + p.phase) * 10) % 4 === 3 ? 'dizzyS' : 'dizzy');
      case 'twinkle':
        return fxFrame(u < 0.5 ? 'dizzyS' : 'dot1');
      case 'puff':
        return fxFrame(u < 0.33 ? 'puff0' : u < 0.66 ? 'puff1' : 'puff2');
      case 'spark':
        return fxFrame(u < 0.5 ? 'spark' : 'dizzyS');
      case 'confetti':
        return fxFrame('confetti');
    }
  }
}
