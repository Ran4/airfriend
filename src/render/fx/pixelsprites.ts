// Screen-space pixel sprites anchored in the 3D world. Shared by the actor
// layer and the effects.
//
// WHY screen space: a SNES sprite is drawn texel-for-pixel. A plain textured
// billboard under a camera pitched ~50 deg down gets squashed vertically
// (by cos(pitch)) and perspective-warped, which drops and doubles rows of the
// pixel art. So every sprite is laid out as an integer pixel rectangle around
// its projected anchor, and only its DEPTH comes from 3D: the rectangle's
// corners are un-projected onto an upright plane through the actor (normal =
// camera forward on the ice plane), so the depth buffer still orders sprites
// against each other and against boards, nets and glass. All those planes are
// parallel, so a nearer actor always wins, exactly like sorting by anchor depth.
// The vertex shader outputs w = 1, which makes UVs interpolate affinely in
// screen space: texel i lands exactly on pixel i, no perspective warp.

import * as THREE from 'three';
import { RINK, SCREEN } from '../../config';
import type { SpriteFrame } from '../art';

/**
 * world   upright, depth-tested + depth-written, alpha-tested (characters, puck, particles)
 * shadow  flat on the ice, half-transparent, drawn once per pixel (no double darkening)
 * overlay always on top, alpha-tested (marker, ARF! bubble, dizzy stars)
 * glow    always on top, SNES color-math half-transparency (flashes)
 */
export type SpriteLayer = 'world' | 'shadow' | 'overlay' | 'glow';

/** framebuffer pixels, y down, x1/y1 exclusive */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DrawOpts {
  layer?: SpriteLayer;
  /** solid color the sprite is mixed toward (hit flash, confetti) */
  tint?: THREE.Color;
  /** 0..1 mix amount for `tint` */
  tintAmount?: number;
  /** extra screen offset of the anchor in pixels (y down) */
  dx?: number;
  dy?: number;
  /** multiplier on the sprite scale (1 = one texel per pixel) */
  scale?: number;
  /** clamp the depth plane to at most this distance (draw in front of something) */
  maxDist?: number;
  /** stretch the frame to this pixel size instead of scaling it */
  sizePx?: { w: number; h: number };
  /** lay out and return the placement without drawing (blinking sprites) */
  hidden?: boolean;
  /**
   * The actor stands on the ice: no part of its sprite may sink behind the
   * side boards/glass (a skater hugging the boards keeps its stick visible).
   */
  onIce?: boolean;
}

/**
 * Where a draw landed. The object (and its rect) is owned by the PixelSprites
 * instance and stays valid until its next begin(); copy what must outlive that.
 */
export interface DrawInfo {
  rect: PixelRect;
  /** projected anchor, framebuffer pixels */
  sx: number;
  sy: number;
  /** pixels per source texel used */
  scale: number;
  /** horizontal distance from the camera to the sprite's depth plane */
  dist: number;
}

// shadows go first in the transparent pass so glass (which may write depth) can't cull them
const LAYER_ORDER: Record<SpriteLayer, number> = { shadow: -10, world: 10, glow: 90, overlay: 100 };
// sprite pixels nearest the ice sit this high, so the ice never z-fights them
const LIFT = 0.03;
const SHADOW_Y = 0.012;
// how far inside the boards a slid-back sprite corner ends up
const BOARD_MARGIN = 0.06;

/** Inside the rounded-rectangle boards, shrunk by `m`. */
export function insideRink(x: number, z: number, m: number): boolean {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const hw = RINK.halfWidth - m;
  const hl = RINK.halfLength - m;
  if (ax > hw || az > hl) return false;
  const r = RINK.cornerRadius - m;
  const cx = ax - (hw - r);
  const cz = az - (hl - r);
  return cx <= 0 || cz <= 0 || cx * cx + cz * cz <= r * r;
}

/**
 * Sprites are NEVER resampled in play: one texel is one framebuffer pixel, at
 * any depth, like SNES OBJ hardware. Perspective moves a sprite (its anchor)
 * and orders it (its depth plane), but never sizes it; even 0.93x drops rows
 * and doubles others, and the doubled rows crawl as the actor moves.
 *
 * The one exception is a camera that pulls far out (the intro's high wide
 * shot): the camera rig publishes a uniform `spriteZoom` < 1 on
 * `camera.userData` and every world sprite shrinks by it, so a 24 px kid
 * doesn't stand 6 m tall on a rink seen from 90 m. Uniform, not per sprite,
 * and it eases to exactly 1 as the shot lands on the game framing. A camera
 * without it (the preview tools) is 1:1.
 */
export const SPRITE_ZOOM_KEY = 'spriteZoom';
// a zoom this close to 1 snaps to 1 (sprites up to ~12 px tall round to their
// own size anyway; this keeps the last frames of the intro descent pristine)
const ZOOM_SNAP = 0.96;

/** Uniform pixels-per-texel for world sprites under `camera` (1 unless it is zoomed out). */
export function spriteZoomOf(camera: THREE.Camera): number {
  const z = camera.userData[SPRITE_ZOOM_KEY];
  if (typeof z !== 'number' || !(z > 0) || z >= ZOOM_SNAP) return 1;
  return z;
}

// ------------------------------------------------------------- projector ----
/** Camera math for one frame: project world points, cast rays through pixels. */
export class Projector {
  readonly W = SCREEN.width;
  readonly H = SCREEN.height;
  readonly camPos = new THREE.Vector3();
  /** camera forward / right flattened onto the ice plane (unit) */
  readonly fwdH = new THREE.Vector2(0, 1);
  readonly rightH = new THREE.Vector2(-1, 0);
  private vp = new THREE.Matrix4();
  private inv = new THREE.Matrix4();
  private view = new THREE.Matrix4();
  private p5 = 1;
  private ortho = false;
  private v4 = new THREE.Vector4();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();

  update(camera: THREE.Camera): void {
    // The renderer only refreshes these inside render(); we run before it.
    // Parents too, in case the camera hangs off a rig group.
    camera.updateWorldMatrix(true, false);
    this.view.copy(camera.matrixWorld).invert();
    this.vp.multiplyMatrices(camera.projectionMatrix, this.view);
    this.inv.copy(this.vp).invert();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    this.p5 = camera.projectionMatrix.elements[5];
    this.ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
    const e = camera.matrixWorld.elements;
    // forward = -Z column; fall back to camera up if looking straight down
    let fx = -e[8];
    let fz = -e[10];
    if (Math.hypot(fx, fz) < 1e-4) {
      fx = e[4];
      fz = e[6];
    }
    this.fwdH.set(fx, fz).normalize();
    let rx = e[0];
    let rz = e[2];
    if (Math.hypot(rx, rz) < 1e-4) {
      rx = -this.fwdH.y;
      rz = this.fwdH.x;
    }
    this.rightH.set(rx, rz).normalize();
  }

  /** Project to framebuffer pixels. Returns the clip w (view depth) or 0 if behind the camera. */
  project(x: number, y: number, z: number, out: { x: number; y: number }): number {
    const v = this.v4.set(x, y, z, 1).applyMatrix4(this.vp);
    if (v.w <= 1e-3) return 0;
    out.x = ((v.x / v.w) * 0.5 + 0.5) * this.W;
    out.y = (-(v.y / v.w) * 0.5 + 0.5) * this.H;
    return v.w;
  }

  /** Screen pixels per world meter for something perpendicular to the view at clip depth w. */
  pxPerMeter(w: number): number {
    return (this.H / 2) * this.p5 / (this.ortho ? 1 : w);
  }

  /** Horizontal distance of a world point along the camera's flattened forward. */
  planeDist(x: number, z: number): number {
    return (x - this.camPos.x) * this.fwdH.x + (z - this.camPos.z) * this.fwdH.y;
  }

  /** Ray through a framebuffer pixel position: origin on the near plane, unit direction. */
  ray(sx: number, sy: number, o: THREE.Vector3, d: THREE.Vector3): void {
    const nx = (sx / this.W) * 2 - 1;
    const ny = 1 - (sy / this.H) * 2;
    o.set(nx, ny, -1).applyMatrix4(this.inv);
    d.set(nx, ny, 1).applyMatrix4(this.inv).sub(o).normalize();
  }

  /** Where the pixel's ray hits the upright plane at horizontal distance `dist` (or the ice if it can't). */
  hitUpright(sx: number, sy: number, dist: number, out: THREE.Vector3): THREE.Vector3 {
    this.ray(sx, sy, this.a, this.b);
    const den = this.b.x * this.fwdH.x + this.b.z * this.fwdH.y;
    if (den < 0.02) return this.hitFlat(sx, sy, LIFT, out);
    const t = (dist - this.planeDist(this.a.x, this.a.z)) / den;
    return out.copy(this.a).addScaledVector(this.b, Math.max(0, t));
  }

  /** Where the pixel's ray hits the horizontal plane y. */
  hitFlat(sx: number, sy: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    this.ray(sx, sy, this.a, this.b);
    const t = Math.abs(this.b.y) < 1e-5 ? 50 : (y - this.a.y) / this.b.y;
    return out.copy(this.a).addScaledVector(this.b, t > 0 ? t : 50);
  }
}

// ----------------------------------------------------------------- batch ----
function patchMaterial(m: THREE.MeshBasicMaterial): void {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aTint;\nvarying vec4 vTint;')
      .replace(
        '#include <project_vertex>',
        // w = 1: affine (screen-linear) UVs. z/w stays the true depth of the
        // upright plane because z_ndc is screen-linear on any planar quad.
        '#include <project_vertex>\n\tvTint = aTint;\n\tgl_Position = vec4( gl_Position.xyz / gl_Position.w, 1.0 );',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vTint;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb = mix( diffuseColor.rgb, vTint.rgb, vTint.a );');
  };
  m.customProgramCacheKey = () => 'airfriend-pixelsprite';
}

function makeMaterial(tex: THREE.Texture, layer: SpriteLayer): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  // Every quad's corners sit on the rays through its screen rect's corners, so
  // all quads wind the same way on screen and one of the two passes three
  // makes for a transparent DoubleSide material (back faces, then front)
  // would draw nothing. The split also flags the material dirty around each
  // pass, which re-derives its program parameters and cache key every frame.
  // Single pass: same pixels, no churn.
  m.forceSinglePass = true;
  switch (layer) {
    case 'world':
      m.alphaTest = 0.5;
      m.depthFunc = THREE.LessEqualDepth; // equal depth: the later (nearer-sorted) sprite wins
      break;
    case 'shadow':
      m.transparent = true;
      m.alphaTest = 0.02;
      // Each pixel is darkened once even where shadows overlap, like a single
      // SNES color-math layer: every shadow lies on the same plane, so with
      // depth writes and a strict Less test the second one fails. Stencil does
      // the same where a stencil buffer exists.
      m.depthWrite = true;
      m.depthFunc = THREE.LessDepth;
      m.stencilWrite = true;
      m.stencilRef = 1;
      m.stencilFunc = THREE.NotEqualStencilFunc;
      m.stencilZPass = THREE.ReplaceStencilOp;
      break;
    case 'overlay':
      m.alphaTest = 0.5;
      m.depthTest = false;
      m.depthWrite = false;
      break;
    case 'glow':
      m.transparent = true;
      m.opacity = 0.5; // SNES half-transparency color math
      m.alphaTest = 0.25; // compared after opacity is applied
      m.depthTest = false;
      m.depthWrite = false;
      break;
  }
  patchMaterial(m);
  return m;
}

class Batch {
  readonly mesh: THREE.Mesh;
  count = 0;
  private cap = 0;
  private pos = new Float32Array(0);
  private uv = new Float32Array(0);
  private tint = new Float32Array(0);

  constructor(scene: THREE.Object3D, readonly material: THREE.MeshBasicMaterial, order: number) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = order;
    this.grow(16);
    scene.add(this.mesh);
  }

  private grow(cap: number): void {
    const pos = new Float32Array(cap * 12);
    const uv = new Float32Array(cap * 8);
    const tint = new Float32Array(cap * 16);
    pos.set(this.pos);
    uv.set(this.uv);
    tint.set(this.tint);
    const idx = new Uint16Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    // a fresh geometry on growth; replacing attributes in place leaks GPU buffers
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.pos = pos;
    this.uv = uv;
    this.tint = tint;
    this.cap = cap;
  }

  /**
   * corners: top-left, top-right, bottom-left, bottom-right. Takes the record
   * rather than its numbers: doubles passed to a call get boxed, every frame.
   */
  push(c: THREE.Vector3[], r: DrawRec): void {
    const f = r.frame;
    const u0 = f.flipX ? f.u1 : f.u0;
    const u1 = f.flipX ? f.u0 : f.u1;
    const v0 = f.v0;
    const v1 = f.v1;
    const t = r.tint;
    const ta = r.tintAmount;
    if (this.count >= this.cap) this.grow(this.cap * 2);
    const i = this.count++;
    for (let k = 0; k < 4; k++) {
      this.pos[i * 12 + k * 3] = c[k].x;
      this.pos[i * 12 + k * 3 + 1] = c[k].y;
      this.pos[i * 12 + k * 3 + 2] = c[k].z;
      const o = i * 16 + k * 4;
      this.tint[o] = t ? t.r : 0;
      this.tint[o + 1] = t ? t.g : 0;
      this.tint[o + 2] = t ? t.b : 0;
      this.tint[o + 3] = t ? ta : 0;
    }
    const uv = this.uv;
    const o = i * 8;
    uv[o] = u0;
    uv[o + 1] = v1;
    uv[o + 2] = u1;
    uv[o + 3] = v1;
    uv[o + 4] = u0;
    uv[o + 5] = v0;
    uv[o + 6] = u1;
    uv[o + 7] = v0;
  }

  flush(): void {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.count * 6);
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.attributes.aTint.needsUpdate = true;
    this.mesh.visible = this.count > 0;
  }
}

// --------------------------------------------------------------- sprites ----
interface DrawRec {
  frame: SpriteFrame;
  layer: SpriteLayer;
  /** returned to the caller; info.rect is the rect drawn */
  info: DrawInfo;
  dist: number; // upright plane distance (world/overlay/glow)
  flat: boolean;
  onIce: boolean;
  tint: THREE.Color | null;
  tintAmount: number;
  seq: number;
}

const NO_OPTS: DrawOpts = Object.freeze({});

function newRec(): DrawRec {
  return {
    frame: null as unknown as SpriteFrame,
    layer: 'world',
    info: { rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, sx: 0, sy: 0, scale: 1, dist: 0 },
    dist: 0,
    flat: false,
    onIce: false,
    tint: null,
    tintAmount: 0,
    seq: 0,
  };
}

/**
 * Group by layer (each layer lands in its own batches), then world far to
 * near; ties and the other layers keep submission order.
 */
function drawsBefore(a: DrawRec, b: DrawRec): boolean {
  const d = LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] || (a.layer === 'world' ? b.dist - a.dist : 0) || a.seq - b.seq;
  return d < 0;
}

/**
 * Insertion sort of recs[0, n): a few dozen records, and unlike
 * Array.prototype.sort it needs no scratch arrays. The seq tie-break makes
 * the order total, so the result is the one the stable sort gave.
 */
function sortRecs(recs: DrawRec[], n: number): void {
  for (let i = 1; i < n; i++) {
    const r = recs[i];
    let j = i - 1;
    while (j >= 0 && drawsBefore(r, recs[j])) {
      recs[j + 1] = recs[j];
      j--;
    }
    recs[j + 1] = r;
  }
}

/**
 * Collects sprite draws for one frame (begin -> draws -> end), sorts the world
 * layer far to near and writes one dynamic mesh per (texture, layer).
 */
export class PixelSprites {
  readonly proj = new Projector();
  private batches = new Map<THREE.Texture, Partial<Record<SpriteLayer, Batch>>>();
  private allBatches: Batch[] = [];
  // Every record ever made, handed out in order each frame (a hidden,
  // layout-only draw takes one too: the caller reads the DrawInfo it carries).
  // Neither array is ever shrunk, so steady play allocates nothing here.
  private store: DrawRec[] = [];
  private used = 0;
  /** this frame's visible draws: recs[0, count) */
  private recs: DrawRec[] = [];
  private count = 0;
  private p = { x: 0, y: 0 };
  private c = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private tmp = new THREE.Vector3();
  /** pixels per texel for world/shadow sprites this frame (see spriteZoomOf) */
  private zoom = 1;

  constructor(private scene: THREE.Object3D, private orderBias = 0) {}

  begin(camera: THREE.Camera): void {
    this.proj.update(camera);
    this.zoom = spriteZoomOf(camera);
    this.used = 0;
    this.count = 0;
  }

  /** Pixels per texel that upright()/flat() use this frame: 1, except in a zoomed-out shot. */
  get scale(): number {
    return this.zoom;
  }

  /**
   * Draw a frame with its anchor on world point (x, y, z), standing upright.
   * y > 0 lifts it (a flying puck). Returns null when behind the camera.
   * Drawn at one texel per pixel whatever its distance (see spriteZoomOf).
   */
  upright(frame: SpriteFrame, x: number, y: number, z: number, o: DrawOpts = NO_OPTS): DrawInfo | null {
    if (!this.proj.project(x, y, z, this.p)) return null;
    const scale = this.zoom * (o.scale ?? 1);
    const sx = this.p.x + (o.dx ?? 0);
    const sy = this.p.y + (o.dy ?? 0);
    const r = this.take(o);
    const rect = this.layout(frame, sx, sy, scale, o.sizePx, r.info.rect);
    let dist = this.proj.planeDist(x, z);
    const layer = o.layer ?? 'world';
    if (layer === 'world') {
      // Pixels below the anchor (a lying-down pose, a skate blade) would sink
      // under the ice on a plane through the anchor; pull the plane toward the
      // camera until the sprite's bottom row sits on the ice.
      const bottom = this.proj.hitFlat(sx, rect.y1, LIFT, this.tmp);
      dist = Math.min(dist, this.proj.planeDist(bottom.x, bottom.z));
    }
    if (o.maxDist !== undefined) dist = Math.min(dist, o.maxDist);
    return this.fill(r, frame, layer, sx, sy, scale, dist, false, o);
  }

  /** Draw a frame lying flat on the ice (shadows), anchor on (x, 0, z). */
  flat(frame: SpriteFrame, x: number, z: number, o: DrawOpts = NO_OPTS): DrawInfo | null {
    if (!this.proj.project(x, 0, z, this.p)) return null;
    const scale = this.zoom * (o.scale ?? 1);
    const sx = this.p.x + (o.dx ?? 0);
    const sy = this.p.y + (o.dy ?? 0);
    const r = this.take(o);
    this.layout(frame, sx, sy, scale, o.sizePx, r.info.rect);
    return this.fill(r, frame, o.layer ?? 'shadow', sx, sy, scale, this.proj.planeDist(x, z), true, o);
  }

  /** Draw a frame with its anchor at a framebuffer pixel (UI-ish attachments). */
  screen(frame: SpriteFrame, sx: number, sy: number, scale: number, dist: number, o: DrawOpts = NO_OPTS): DrawInfo {
    const r = this.take(o);
    this.layout(frame, sx + (o.dx ?? 0), sy + (o.dy ?? 0), scale * (o.scale ?? 1), o.sizePx, r.info.rect);
    const info = this.fill(r, frame, o.layer ?? 'overlay', sx, sy, scale, dist, false, o);
    // the record draws at the clamped plane; the caller is told the plane it asked for
    if (o.maxDist !== undefined) r.dist = Math.min(dist, o.maxDist);
    return info;
  }

  end(): void {
    for (const b of this.allBatches) b.count = 0;
    const recs = this.recs;
    const n = this.count;
    sortRecs(recs, n);
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      const f = r.frame;
      const { x0, y0, x1, y1 } = r.info.rect;
      const c = this.c;
      if (r.flat) {
        this.proj.hitFlat(x0, y0, SHADOW_Y, c[0]);
        this.proj.hitFlat(x1, y0, SHADOW_Y, c[1]);
        this.proj.hitFlat(x0, y1, SHADOW_Y, c[2]);
        this.proj.hitFlat(x1, y1, SHADOW_Y, c[3]);
      } else {
        const d = Math.max(r.dist, 1);
        this.proj.hitUpright(x0, y0, d, c[0]);
        this.proj.hitUpright(x1, y0, d, c[1]);
        this.proj.hitUpright(x0, y1, d, c[2]);
        this.proj.hitUpright(x1, y1, d, c[3]);
        if (r.onIce) for (let k = 0; k < 4; k++) this.keepInside(c[k]);
      }
      this.batch(f.texture, r.layer).push(c, r);
    }
    for (const b of this.allBatches) b.flush();
  }

  /**
   * Slide a corner along its own camera ray (same pixel, nearer depth) until
   * it is back inside the boards. Depth is screen-affine across the quad, so
   * if every corner is in front of a board's plane, the whole sprite is.
   */
  private keepInside(p: THREE.Vector3): void {
    if (insideRink(p.x, p.z, BOARD_MARGIN)) return;
    const cam = this.proj.camPos;
    const len = Math.hypot(cam.x - p.x, cam.z - p.z);
    if (len < 1e-3) return;
    const step = 0.08 / len;
    let t = step;
    for (; t < 1 && t * len < 4; t += step) {
      if (insideRink(p.x + (cam.x - p.x) * t, p.z + (cam.z - p.z) * t, BOARD_MARGIN)) break;
    }
    if (t >= 1 || t * len >= 4) return;
    p.lerp(cam, t);
  }

  /** Integer pixel rect of `f` anchored at (sx, sy), written into `out`. */
  private layout(
    f: SpriteFrame,
    sx: number,
    sy: number,
    scale: number,
    size: { w: number; h: number } | undefined,
    out: PixelRect,
  ): PixelRect {
    const w = size ? size.w : Math.max(1, Math.round(f.w * scale));
    const h = size ? size.h : Math.max(1, Math.round(f.h * scale));
    const kx = w / f.w;
    const ky = h / f.h;
    // ax/ay are in the frame as DISPLAYED (the library already mirrors ax
    // for flipX frames), measured from its bottom-left
    const x0 = Math.round(sx - f.ax * kx);
    const y1 = Math.round(sy + f.ay * ky);
    out.x0 = x0;
    out.y0 = y1 - h;
    out.x1 = x0 + w;
    out.y1 = y1;
    return out;
  }

  /**
   * A record for one draw, valid until the next begin(). Hidden draws only
   * lay out; the rest join this frame's draw list.
   */
  private take(o: DrawOpts): DrawRec {
    let r = this.store[this.used];
    if (!r) this.store.push((r = newRec()));
    this.used++;
    if (!o.hidden) {
      r.seq = this.count;
      this.recs[this.count++] = r;
    }
    return r;
  }

  private fill(
    r: DrawRec,
    frame: SpriteFrame,
    layer: SpriteLayer,
    sx: number,
    sy: number,
    scale: number,
    dist: number,
    flat: boolean,
    o: DrawOpts,
  ): DrawInfo {
    r.frame = frame;
    r.layer = layer;
    r.dist = dist;
    r.flat = flat;
    r.onIce = !!o.onIce;
    r.tint = o.tint ?? null;
    r.tintAmount = o.tint ? (o.tintAmount ?? 1) : 0;
    const info = r.info;
    info.sx = sx;
    info.sy = sy;
    info.scale = scale;
    info.dist = dist;
    return info;
  }

  private batch(tex: THREE.Texture, layer: SpriteLayer): Batch {
    let byLayer = this.batches.get(tex);
    if (!byLayer) this.batches.set(tex, (byLayer = {}));
    let b = byLayer[layer];
    if (!b) {
      b = byLayer[layer] = new Batch(this.scene, makeMaterial(tex, layer), LAYER_ORDER[layer] + this.orderBias);
      this.allBatches.push(b);
    }
    return b;
  }

  dispose(): void {
    for (const b of this.allBatches) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.material.dispose();
    }
    this.batches.clear();
    this.allBatches.length = 0;
  }
}
