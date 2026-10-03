// Broadcast-from-behind "Mode 7" camera. It sits behind HOME's defending end,
// looks along cameraHeading(period) (see sim/rink.ts) and pans by TRANSLATING
// (never yawing), so screen-up always means "attack" and screenToWorld() holds.
//
// Lens math (the numbers DESIGN.md asks for). The projection is 4:3 (the CRT
// display aspect), so the 256 framebuffer columns span the horizontal FOV:
//   visible width at the look-at point  W = 2 * D * tan(fov/2) * 4/3
//   we want 1 m ~= 13.33 px there (1 / SPRITE_METERS_PER_PIXEL) => W = 19.2 m
// With fov 32 deg that gives D = 25.1 m; pitched 44 deg the lens sits 17.4 m up.
// A ground point seen `a` degrees above the screen center has relative scale
//   sin(pitch - a) / (sin(pitch) * cos(a))
// => 0.70x at the top edge, 1.30x at the bottom. Sprites draw 1:1 at any depth
// (fx/pixelsprites.ts), so this foreshortens only the ice and the arena: the
// far end recedes, the end boards curve and the crowd shows above them.
// (50/30, nearly orthographic at 0.78x/1.22x, was the original lens.)
// Ground visible: ~14.7 m ahead of the target, ~8.0 m behind it.
import * as THREE from 'three';
import { GOAL, RINK, RULES, SCREEN, SPRITE_METERS_PER_PIXEL } from '../config';
import { attackDir, cameraHeading } from '../sim/rink';
import type { GameState } from '../types';
import { SPRITE_ZOOM_KEY } from './fx/pixelsprites';

const DEG = Math.PI / 180;

export const CAMERA = {
  fov: 32, // vertical, degrees
  pitch: 44 * DEG, // below horizontal
  /** target px per meter (horizontal) at the screen center */
  pxPerMeter: 1 / SPRITE_METERS_PER_PIXEL,
  /** share of the controlled skater in the follow target (rest = puck) */
  ctrlBlend: 0.25,
  /**
   * seconds of puck velocity used as look-ahead. A critically damped spring
   * trails a moving goal by 2v/omega (~0.5 s here), so a lead longer than that
   * frames the ice the play is heading into instead of chasing it.
   */
  leadTime: 0.62,
  /**
   * longer look-ahead for the part of the puck's motion pointing AT the lens
   * (an opponent rush on HOME's net): only ~8 m of ice show below the
   * target, so the frame has to get there before the puck does
   */
  leadTimeNear: 0.85,
  leadMax: 7.0,
  leadSmooth: 0.22, // low-pass time constant on the lead (bounces, dekes)
  /** spring stiffness (rad/s) across and along the rink; critically damped */
  omegaX: 3.4,
  omegaZ: 4.0,
  /** how far past the boards the frame may show, meters */
  sideMargin: 3.1, // a skater sitting in the penalty box (x = 14.6) stays fully in frame
  /**
   * beyond the far end boards, at ice level: the stands rise into it. At the
   * clamp the end-board ads sit just below the score bug (y ~33) and the far
   * crossbar at y ~49, so the net keep (netTopPx) always fits inside the clamp.
   */
  farMargin: 5.5,
  nearMargin: 1.0, // beyond the near end boards
  /**
   * Keep-in-frame window for the controlled skater's feet. Top and bottom are
   * screen rows, not meters: sprites draw 1:1 at any depth, so "head below the
   * score bug" is a pixel distance whatever the lens does to the ice.
   */
  keepTopPx: 38, // a ~24 px kid's head clears the score bug (y 7-25)
  keepBottomPx: 197,
  keepSide: 1.6, // meters inside the side edges
  /**
   * the looser window holdCtrl() pins the spring OUTPUT to, so a skater who
   * outskates the spring still keeps his body on screen (feet rows; meters at
   * the sides). It also outranks the net keep: with it (and the per-row side
   * margin in ctrlWindow) PAL off-screen in live play went 1.8-2.5% -> 1.1-1.6%
   * (BOT=1, tools/rink-frame.ts 5 games, seeds 7 / 11) and 5.3-6.4% -> 2.6-3.7%
   * with the AI playing PAL. What is left is PAL 18+ m up-ice of the puck,
   * more than the frame spans with the puck above the TURBO window.
   */
  ctrlHoldTopPx: 16,
  ctrlHoldBottomPx: 214,
  ctrlHoldNetBottomPx: 226, // ctrlHoldBottomPx while the offensive-zone net keep is on
  ctrlHoldNetTopPx: 8, // ...and the far crossbar row it may push the net up to (on screen, under the score bug)
  ctrlHoldSide: 0.7,
  /**
   * keep-in-frame window for the puck (screen rows; meters at the sides). It
   * bounds the spring goal AND, as a hard clamp, the spring output: a
   * critically damped spring trails a goal moving at v by 2v/omega (~4 m on a
   * rush), which is more than the ice below the target.
   */
  puckTopPx: 19, // inside the score bug, but never past the top edge
  puckBottomPx: 190, // above the HUD turbo window (y 194-216): at 198 the puck hid under it ~1% of play
  puckKeepSide: 1.0,
  /** seconds to blend the controlled-skater window out/in around an opponent rush */
  rushEase: 0.2,
  /** keepTopPx while an opponent rush is on (feet still on screen) */
  rushKeepTopPx: 6,
  /** puck speed toward the lens (m/s) that counts as a rush */
  rushSpeed: 2.5,
  /**
   * Offensive-zone "net keep": while the puck is deep in HOME's attacking zone,
   * push the frame up-ice until the far crossbar projects at screen y >= netTopPx
   * (below the score bug, y 7-25, and the power-play strip, y 27-42), so the net
   * and its goalie are in the shot. Ramps in as the puck goes from netKeepFrom
   * to netKeepFull meters up-ice; the puck window still wins.
   */
  netTopPx: 44,
  netKeepFrom: 9.0,
  netKeepFull: 14.0,
  /** extra spring stiffness (x omegaZ) while chasing up-ice under the net keep */
  netCatchUp: 0.8,
  /**
   * Faceoff whip: when a faceoff lines up somewhere the frame isn't (after a
   * goal at the far net, a penalty in the corner), pan there in this many
   * seconds on an ease-in-out curve, zoom included, instead of letting the
   * ~0.6 s follow spring glide (the FACE OFF! banner would show over empty
   * ice), like the quick scroll of a 16-bit hockey game. Shorter moves than
   * whipMin meters keep the spring.
   */
  whipTime: 0.22,
  whipMin: 2.0,
  goalZoom: 0.86, // distance multiplier while celebrating
  goalFarExtra: 3.0, // meters the end clamp relaxes during a goal
} as const;

/** distance that gives CAMERA.pxPerMeter at the look-at point for a given fov */
function distanceFor(fovDeg: number): number {
  const widthM = SCREEN.width / CAMERA.pxPerMeter;
  return widthM / (2 * Math.tan((fovDeg * DEG) / 2) * SCREEN.displayAspect);
}

/** a range of look-at points, world x/z */
interface KeepWindow {
  xLo: number;
  xHi: number;
  zLo: number;
  zHi: number;
}

interface Pose {
  tx: number; // look-at point on the ice
  tz: number;
  yaw: number; // world heading the camera looks along (atan2(x, z))
  pitch: number;
  dist: number;
  fov: number;
}

/** critically damped spring, one axis */
class Spring {
  pos = 0;
  vel = 0;
  constructor(public omega: number) {}
  reset(x: number): void {
    this.pos = x;
    this.vel = 0;
  }
  step(goal: number, dt: number): void {
    // sub-step so a long frame (tab switch, speed=8) can't overshoot
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    const w = this.omega;
    for (let i = 0; i < n; i++) {
      this.vel += (w * w * (goal - this.pos) - 2 * w * this.vel) * h;
      this.pos += this.vel * h;
    }
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const INTRO_BLEND_OUT = 0.7; // seconds
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private sx = new Spring(CAMERA.omegaX);
  private sz = new Spring(CAMERA.omegaZ);
  private leadX = 0;
  private leadZ = 0;
  private zoom = 1; // eased distance multiplier
  private fresh = true;
  private lastPuck = { x: 0, z: 0 };
  /** observed puck velocity (world m/s) of the last update */
  private puckVx = 0;
  private puckVz = 0;
  /** 0..1, eased: an opponent rush on HOME's net (the lens end) is on */
  private rush = 0;
  /** pose of the previous frame while in the intro, to blend out of an early cut */
  private introPose: Pose | null = null;
  private blendFrom: Pose | null = null;
  private blendLeft = 0;
  /** the faceoff the rig has framed (a new state.faceoff object = a new lineup) */
  private faceoffSeen: GameState['faceoff'] = null;
  /** faceoff whip in progress: where it started, seconds left */
  private whipFrom: { x: number; z: number; zoom: number } | null = null;
  private whipLeft = 0;

  constructor() {
    // 256x224 framebuffer shown at 4:3 => the projection aspect is 4:3
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, SCREEN.displayAspect, 1, 400);
  }

  /** jump straight to the target framing (after period switch / rematch) */
  snap(state: GameState): void {
    this.leadX = this.leadZ = 0;
    this.puckVx = this.puckVz = 0;
    this.rush = 0;
    const g = this.goal(state);
    this.sx.reset(g.x);
    this.sz.reset(g.z);
    this.zoom = state.phase === 'goal' ? CAMERA.goalZoom : 1;
    this.fresh = false;
    this.lastPuck = { ...state.puck.pos };
    this.introPose = null;
    this.blendFrom = null;
    this.blendLeft = 0;
    this.faceoffSeen = state.faceoff;
    this.whipFrom = null;
    this.whipLeft = 0;
    this.apply(this.livePose(state));
  }

  update(state: GameState, dt: number): void {
    if (this.fresh) return this.snap(state);
    dt = Math.min(dt, 0.25);
    // Look-ahead from the puck's observed motion (works whether or not the sim
    // fills puck.vel while the puck is carried), low-passed so bounces off the
    // boards don't jerk the frame. Teleports (faceoff resets) are ignored.
    const p = state.puck.pos;
    let vx = dt > 0 ? (p.x - this.lastPuck.x) / dt : 0;
    let vz = dt > 0 ? (p.z - this.lastPuck.z) / dt : 0;
    if (Math.hypot(p.x - this.lastPuck.x, p.z - this.lastPuck.z) > 4) vx = vz = 0;
    this.lastPuck = { x: p.x, z: p.z };
    this.puckVx = vx;
    this.puckVz = vz;
    const d = attackDir(0, state.period);
    const vf = vz * d; // along the view direction; < 0 = toward the lens
    let lx = vx * CAMERA.leadTime;
    let lz = d * vf * (vf < 0 ? CAMERA.leadTimeNear : CAMERA.leadTime);
    const ll = Math.hypot(lx, lz);
    if (ll > CAMERA.leadMax) {
      lx *= CAMERA.leadMax / ll;
      lz *= CAMERA.leadMax / ll;
    }
    if (state.phase !== 'play') lx = lz = 0;
    const k = 1 - Math.exp(-dt / CAMERA.leadSmooth);
    this.leadX += (lx - this.leadX) * k;
    this.leadZ += (lz - this.leadZ) * k;
    // An opponent (or a loose puck) heading for HOME's net: the play is coming
    // at the lens, so the controlled skater's window must not hold the frame up-ice.
    const owner = state.puck.owner;
    const oppPuck = owner === null || state.skaters[owner]?.team !== 0;
    const rushing = state.phase === 'play' && oppPuck && vf < -CAMERA.rushSpeed;
    this.rush += ((rushing ? 1 : 0) - this.rush) * (1 - Math.exp(-dt / CAMERA.rushEase));

    const g = this.goal(state);
    if (state.phase === 'faceoff' && state.faceoff !== this.faceoffSeen) {
      // a new lineup: whip to the dot if it is not already in the shot
      this.faceoffSeen = state.faceoff;
      const far = Math.hypot(g.x - this.sx.pos, g.z - this.sz.pos) > CAMERA.whipMin || Math.abs(this.zoom - 1) > 0.02;
      this.whipFrom = far && state.faceoff ? { x: this.sx.pos, z: this.sz.pos, zoom: this.zoom } : null;
      this.whipLeft = this.whipFrom ? CAMERA.whipTime : 0;
    } else if (state.phase !== 'faceoff') {
      this.whipFrom = null;
    }
    if (state.phase === 'intro') {
      // hold the follow springs on the faceoff framing the sweep lands on
      this.sx.reset(g.x);
      this.sz.reset(g.z);
    } else if (this.whipFrom) {
      // The faceoff whip: a fixed-time eased pan, landing on the dot at rest
      // (zero spring velocity), from where the follow springs carry on.
      this.whipLeft = Math.max(0, this.whipLeft - dt);
      const k = smooth(1 - this.whipLeft / CAMERA.whipTime);
      const f = this.whipFrom;
      this.sx.reset(f.x + (g.x - f.x) * k);
      this.sz.reset(f.z + (g.z - f.z) * k);
      this.zoom = f.zoom + (1 - f.zoom) * k;
      if (this.whipLeft <= 0) this.whipFrom = null;
    } else {
      // Up-ice into the offensive zone the frame has a net to reach, and the
      // spring's lag would leave it above the score bug: stiffen the chase.
      const chasing = (g.z - this.sz.pos) * d > 0 && state.phase === 'play';
      this.sz.omega = CAMERA.omegaZ * (chasing ? 1 + CAMERA.netCatchUp * netWeight(p.z, state.period) : 1);
      this.sx.step(g.x, dt);
      this.sz.step(g.z, dt);
      if (state.phase === 'play') {
        this.holdCtrl(state);
        this.holdPuck(state);
      }
    }
    if (!this.whipFrom) {
      const zoomGoal = state.phase === 'goal' && state.phaseTime > 0.4 ? CAMERA.goalZoom : 1;
      this.zoom += (zoomGoal - this.zoom) * (1 - Math.exp(-dt / 0.5));
    }
    let pose = this.livePose(state);
    if (state.phase === 'intro') {
      this.introPose = pose;
    } else if (this.introPose) {
      // The intro was cut short (a rematch skips most of it): ease out of the
      // sweep instead of popping to the game framing.
      this.blendFrom = this.introPose;
      this.blendLeft = INTRO_BLEND_OUT;
      this.introPose = null;
    }
    if (this.blendFrom && this.blendLeft > 0) {
      this.blendLeft = Math.max(0, this.blendLeft - dt);
      pose = lerpPose(this.blendFrom, pose, smooth(1 - this.blendLeft / INTRO_BLEND_OUT));
    } else if (state.phase !== 'intro' && Math.abs(this.zoom - 1) < 0.002) {
      pose = pixelSnap(pose);
    }
    this.apply(pose);
  }

  /** where the follow springs are heading (clamped), world x/z of the look-at point */
  private goal(state: GameState): { x: number; z: number } {
    const p = state.puck.pos;
    let x = p.x;
    let z = p.z;
    const ctrl = state.skaters[state.controlledId];
    const phase = state.phase;
    if (phase === 'faceoff' && state.faceoff) {
      x = state.faceoff.spot.x;
      z = state.faceoff.spot.z;
    } else if (phase === 'penalty' && state.lastPenaltyCall && state.skaters[state.lastPenaltyCall.skaterId]) {
      // lean toward the offender on the way to the box, like a broadcast would
      const o = state.skaters[state.lastPenaltyCall.skaterId].pos;
      x += (o.x - x) * 0.55;
      z += (o.z - z) * 0.55;
    } else if (ctrl && ctrl.state !== 'box' && (phase === 'play' || phase === 'stoppage' || phase === 'penalty')) {
      const blend = CAMERA.ctrlBlend * (1 - 0.6 * this.rush); // a rush: mostly the puck
      x += (ctrl.pos.x - x) * blend;
      z += (ctrl.pos.z - z) * blend;
    } else if (phase === 'intermission' || phase === 'gameOver' || phase === 'intro') {
      // The intro lands on the opening (center-ice) faceoff; the full-screen
      // windows cover the rest, so keep a calm center-ice shot behind them.
      x = 0;
      z = 0;
    }
    x += this.leadX;
    z += this.leadZ;
    const live = phase === 'play' || phase === 'stoppage';
    if (live && ctrl && ctrl.state !== 'box') {
      // on a rush at the lens the dog's window shrinks to "feet on screen" (his
      // head may pass behind the score bug) so it stops holding the frame up-ice
      const w = this.ctrlWindow(ctrl.pos, state.period, z, this.ctrlTopPx(), CAMERA.keepBottomPx, CAMERA.keepSide);
      x = clamp(x, w.xLo, w.xHi);
      z = clamp(z, w.zLo, w.zHi);
    }
    // The net beats the dog's window in the GOAL, so the shot leans up-ice to
    // the far net; holdCtrl() on the spring OUTPUT then beats the net, so a
    // PAL hanging back at the blue line stays in frame (the human steers him)
    // and the crossbar slides under the score bug. The puck beats all of it.
    if (live || phase === 'faceoff') z = this.netKeep(z, p, state.period);
    if (live) {
      // the puck's own window wins over both: the play is never lost
      const w = this.puckWindow(state, z);
      x = clamp(x, w.xLo, w.xHi);
      z = clamp(z, w.zLo, w.zHi);
    }
    // on a goal, let the frame push past the end boards: lamp, net and the
    // cheering stands behind them are the shot
    const extraFar = phase === 'goal' ? CAMERA.goalFarExtra : 0;
    return this.clampTarget(x, z, state.period, extraFar);
  }

  /**
   * World-space range of look-at points that keep the controlled skater's feet
   * between screen rows `topPx` and `bottomPx`, `side` meters inside the side
   * edges. The frame narrows toward the bottom, so the side margin is measured
   * on the skater's own row (taken relative to `atZ`); at the center-row width
   * a PAL low on screen went out through the bottom corners.
   */
  private ctrlWindow(ctrl: { x: number; z: number }, period: number, atZ: number, topPx: number, bottomPx: number, side: number): KeepWindow {
    const dist = distanceFor(CAMERA.fov);
    const e = frameExtents(CAMERA.pitch, CAMERA.fov, dist);
    const d = attackDir(0, period);
    const cf = ctrl.z * d;
    const fLo = cf - groundAheadAt(topPx, 0);
    const fHi = cf - groundAheadAt(bottomPx, 0);
    const rel = cf - clamp(atZ * d, fLo, fHi);
    const hw = e.halfWidth * (1 + (rel * Math.cos(CAMERA.pitch)) / dist) - side;
    return { xLo: ctrl.x - hw, xHi: ctrl.x + hw, zLo: d === 1 ? fLo : -fHi, zHi: d === 1 ? fHi : -fLo };
  }

  /** keepTopPx, shrunk toward rushKeepTopPx while an opponent rush is on */
  private ctrlTopPx(): number {
    return CAMERA.keepTopPx + (CAMERA.rushKeepTopPx - CAMERA.keepTopPx) * this.rush;
  }

  /**
   * Hard keep of the controlled skater on the spring OUTPUT, the PAL twin of
   * holdPuck() (which runs after it and wins): the goal keeps PAL in frame, but
   * the spring lags a skater who turns on the jets. A looser window than the
   * goal's (ctrlHold*), so it only catches the edges.
   */
  private holdCtrl(state: GameState): void {
    const ctrl = state.skaters[state.controlledId];
    if (!ctrl || ctrl.state === 'box') return;
    const top = Math.min(this.ctrlTopPx(), CAMERA.ctrlHoldTopPx);
    // with the offensive-zone net keep on, the dog's feet may sink past the
    // bottom edge (his body, the HUD's 0.9 m test point, stays on screen)
    // before he drags the far net under the score bug: a PAL at the point
    // (~10 m up-ice) and a crossbar just below the bug need ~8 m behind the target
    const nw = netWeight(state.puck.pos.z, state.period);
    const bottom = CAMERA.ctrlHoldBottomPx + (CAMERA.ctrlHoldNetBottomPx - CAMERA.ctrlHoldBottomPx) * nw;
    const w = this.ctrlWindow(ctrl.pos, state.period, this.sz.pos, top, bottom, CAMERA.ctrlHoldSide);
    if (nw > 0) {
      // ...but never so far that the far net leaves the top of the screen: a
      // dog back in the neutral zone gets the HUD arrow instead
      const d = attackDir(0, state.period);
      const floor = RINK.goalLineZ - groundAheadAt(CAMERA.ctrlHoldNetTopPx, GOAL.height) - (1 - nw) * 20;
      if (d === 1) w.zHi = Math.max(w.zHi, floor);
      else w.zLo = Math.min(w.zLo, -floor);
    }
    holdSpring(this.sx, w.xLo, w.xHi, ctrl.vel.x);
    holdSpring(this.sz, w.zLo, w.zHi, ctrl.vel.z);
  }

  /**
   * World-space range of look-at points that keep the puck inside the frame
   * (CAMERA.puckTopPx / puckBottomPx / puckKeepSide). A lifted puck draws
   * higher on screen, so it counts as further up-ice; the frame narrows toward
   * the bottom, so the side margin is measured on the puck's own row (taken
   * relative to `atZ`, the current target).
   */
  private puckWindow(state: GameState, atZ: number): KeepWindow {
    const dist = distanceFor(CAMERA.fov);
    const e = frameExtents(CAMERA.pitch, CAMERA.fov, dist);
    const d = attackDir(0, state.period);
    const p = state.puck.pos;
    const pf = p.z * d + Math.max(0, state.puck.y) / Math.tan(CAMERA.pitch);
    const fLo = pf - groundAheadAt(CAMERA.puckTopPx, 0);
    const fHi = pf - groundAheadAt(CAMERA.puckBottomPx, 0);
    const rel = pf - clamp(atZ * d, fLo, fHi); // puck's ground offset ahead of the target
    const hw = e.halfWidth * (1 + (rel * Math.cos(CAMERA.pitch)) / dist) - CAMERA.puckKeepSide;
    return {
      xLo: p.x - hw,
      xHi: p.x + hw,
      zLo: d === 1 ? fLo : -fHi,
      zHi: d === 1 ? fHi : -fLo,
    };
  }

  /**
   * Hard puck keep on the spring OUTPUT. Clamping only the goal is not enough:
   * the spring lags a fast goal by ~2v/omega. Pin the look-at point to the
   * window edge and drop the velocity that pushes past it (down to the puck's
   * own speed, so the spring leaves the edge smoothly once the puck slows).
   */
  private holdPuck(state: GameState): void {
    const w = this.puckWindow(state, this.sz.pos);
    holdSpring(this.sx, w.xLo, w.xHi, this.puckVx);
    holdSpring(this.sz, w.zLo, w.zHi, this.puckVz);
  }

  /**
   * Offensive-zone net keep: with the puck deep in HOME's attacking zone, raise
   * the target's floor until the far crossbar projects at y >= CAMERA.netTopPx.
   */
  private netKeep(z: number, puck: { x: number; z: number }, period: number): number {
    const d = attackDir(0, period);
    const w = netWeight(puck.z, period);
    if (w <= 0) return z;
    const fMin = RINK.goalLineZ - groundAheadAt(CAMERA.netTopPx, GOAL.height);
    const f = z * d;
    return f < fMin ? (f + (fMin - f) * w) * d : z;
  }

  /** keep the frame from showing much beyond the boards */
  private clampTarget(x: number, z: number, period: number, extraFar = 0): { x: number; z: number } {
    const e = frameExtents(CAMERA.pitch, CAMERA.fov, distanceFor(CAMERA.fov));
    const xMax = Math.max(0, RINK.halfWidth + CAMERA.sideMargin - e.halfWidth);
    const d = attackDir(0, period);
    const f = z * d; // along the camera's forward axis
    const fMax = RINK.halfLength + CAMERA.farMargin + extraFar - e.ahead;
    // only the far end relaxes on a goal: the near stands face away from the
    // lens, so past the near boards there is nothing but their culled backs
    const fMin = -(RINK.halfLength + CAMERA.nearMargin) + e.behind;
    return { x: clamp(x, -xMax, xMax), z: clamp(f, fMin, fMax) * d };
  }

  private livePose(state: GameState): Pose {
    const fov = CAMERA.fov;
    const live: Pose = {
      tx: this.sx.pos,
      tz: this.sz.pos,
      yaw: cameraHeading(state.period),
      pitch: CAMERA.pitch + (1 - this.zoom) * 0.25,
      dist: distanceFor(fov) * this.zoom,
      fov,
    };
    if (state.phase !== 'intro') return live;
    // Intro: a high, wide, slowly swinging establishing shot that eases down
    // onto the faceoff framing as the title clears.
    const t = clamp(state.phaseTime / RULES.introTime, 0, 1);
    const k = smooth(clamp((t - 0.12) / 0.88, 0, 1));
    const wide: Pose = {
      tx: 0,
      tz: 0,
      yaw: live.yaw + 1.1 - t * 0.25,
      pitch: 58 * DEG,
      dist: 92,
      fov: 32,
    };
    return lerpPose(wide, live, k);
  }

  private apply(pose: Pose): void {
    const c = this.camera;
    const ch = Math.cos(pose.pitch) * pose.dist;
    c.position.set(
      pose.tx - Math.sin(pose.yaw) * ch,
      Math.sin(pose.pitch) * pose.dist,
      pose.tz - Math.cos(pose.yaw) * ch,
    );
    c.up.set(0, 1, 0);
    c.lookAt(pose.tx, 0, pose.tz);
    if (c.fov !== pose.fov) {
      c.fov = pose.fov;
      c.updateProjectionMatrix();
    }
    // Make worldToScreen() valid immediately, even before the next render.
    c.updateMatrixWorld();
    // Sprites stay 1:1 in every game framing (the goal zoom-in included); only
    // a shot pulled out past the default lens, the intro's wide sweep, shrinks
    // them, uniformly, by its scale at the look-at point (fx/pixelsprites.ts).
    c.userData[SPRITE_ZOOM_KEY] = Math.min(1, distanceFor(pose.fov) / pose.dist);
  }
}

/** 0..1 ramp of the offensive-zone net keep for a puck at world z */
function netWeight(puckZ: number, period: number): number {
  const f = puckZ * attackDir(0, period);
  return smooth(clamp((f - CAMERA.netKeepFrom) / (CAMERA.netKeepFull - CAMERA.netKeepFrom), 0, 1));
}

function holdSpring(s: Spring, lo: number, hi: number, v: number): void {
  if (s.pos > hi) {
    s.pos = hi;
    s.vel = Math.min(s.vel, v);
  } else if (s.pos < lo) {
    s.pos = lo;
    s.vel = Math.max(s.vel, v);
  }
}

/**
 * How far ahead of the look-at point (meters along the ice, at zoom 1) a point
 * `h` meters up projects at screen row `yPx`. Inverts the pinhole projection of
 * the default lens: with up/forward the camera-space components of the point,
 * row = H/2 - (up / forward) * (H/2) / tan(fov/2).
 */
function groundAheadAt(yPx: number, h: number): number {
  const dist = distanceFor(CAMERA.fov);
  const k = ((SCREEN.height / 2 - yPx) / (SCREEN.height / 2)) * Math.tan((CAMERA.fov * DEG) / 2);
  const sp = Math.sin(CAMERA.pitch);
  const cp = Math.cos(CAMERA.pitch);
  const camH = sp * dist;
  const foot = cp * dist;
  return ((camH - h) * (k * sp + cp)) / (sp - k * cp) - foot;
}

/**
 * Scroll in whole pixels, like a SNES background layer: move the look-at point
 * in steps of one screen pixel at the screen center (across, and along the
 * foreshortened ice), so nearest-sampled ice texels don't crawl at sub-pixel
 * offsets while the camera pans.
 */
function pixelSnap(p: Pose): Pose {
  const pxPerRad = SCREEN.height / 2 / Math.tan((p.fov * DEG) / 2);
  const stepX = 1 / CAMERA.pxPerMeter;
  const stepZ = p.dist / (pxPerRad * Math.sin(p.pitch));
  return { ...p, tx: Math.round(p.tx / stepX) * stepX, tz: Math.round(p.tz / stepZ) * stepZ };
}

function lerpPose(a: Pose, b: Pose, k: number): Pose {
  let dy = b.yaw - a.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  return {
    tx: a.tx + (b.tx - a.tx) * k,
    tz: a.tz + (b.tz - a.tz) * k,
    yaw: a.yaw + dy * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k,
    dist: a.dist + (b.dist - a.dist) * k,
    fov: a.fov + (b.fov - a.fov) * k,
  };
}

/**
 * Ground footprint of the frame relative to the look-at point:
 * half the visible width at the center row, and how many meters of ice the
 * screen shows ahead of / behind the target along the view direction.
 */
export function frameExtents(pitch: number, fovDeg: number, dist: number): { halfWidth: number; ahead: number; behind: number } {
  const half = (fovDeg * DEG) / 2;
  const h = Math.sin(pitch) * dist;
  const foot = Math.cos(pitch) * dist; // horizontal distance camera -> target
  return {
    halfWidth: dist * Math.tan(half) * SCREEN.displayAspect,
    ahead: h / Math.tan(pitch - half) - foot,
    behind: foot - h / Math.tan(pitch + half),
  };
}
