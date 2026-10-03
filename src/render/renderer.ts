// Composition root for the 3D view. Owned by the RINK agent (keep the public
// API: constructor(container), render(), onEvents(), worldToScreen(), canvas).
//
// URL params (debug, read only on the dev server or with ?test=1, the same gate
// main.ts puts on the test API, so a shipped build always looks the same):
// ?post=0 shows the raw 24-bit render, ?dither=N sets the ordered-dither
// strength in 5-bit steps (0 = off).
import * as THREE from 'three';
import { SCREEN } from '../config';
import type { GameEvent, GameState } from '../types';
import { ActorLayer } from './actors';
import { buildSpriteLibrary, type SpriteLibrary } from './art';
import { CameraRig } from './camera';
import { Effects } from './effects';
import { PostFX } from './post';
import { buildRink, type RinkView } from './rink';

interface ScreenPoint {
  x: number; // framebuffer pixels, 0..256
  y: number; // framebuffer pixels, 0..224 (top = 0)
  onScreen: boolean;
}

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly sprites: SpriteLibrary;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private rig = new CameraRig();
  private rink: RinkView;
  private actors: ActorLayer;
  private effects: Effects;
  private post: PostFX;
  private lastPeriod = -1;
  private needSnap = false;
  private v = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(SCREEN.width, SCREEN.height, false);
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);
    // the arena's dark rafters (only the intro's high shot sees past the stands)
    this.scene.background = new THREE.Color(0x080c18);
    this.sprites = buildSpriteLibrary();
    this.rink = buildRink(this.scene);
    this.actors = new ActorLayer(this.scene, this.sprites);
    this.effects = new Effects(this.scene, this.sprites);
    this.post = new PostFX(this.renderer);
    const params = new URLSearchParams(location.search);
    if (import.meta.env.DEV || params.has('test')) {
      if (params.get('post') === '0') this.post.quantize = false;
      if (params.has('dither')) this.post.dither = Number(params.get('dither')) || 0;
    }
  }

  onEvents(events: GameEvent[], state: GameState): void {
    for (const e of events) if (e.type === 'rematch') this.needSnap = true;
    this.rink.onEvents(events, state);
    this.actors.onEvents(events);
    this.effects.onEvents(events, state);
  }

  render(state: GameState, dt: number): void {
    if (state.period !== this.lastPeriod || this.needSnap) {
      this.lastPeriod = state.period;
      this.needSnap = false;
      this.rig.snap(state);
    }
    this.rig.update(state, dt);
    this.rink.update(state, dt);
    this.actors.update(state, this.rig.camera, dt);
    this.effects.update(state, this.rig.camera);
    this.post.render(this.scene, this.rig.camera);
  }

  /** jump the camera to its target framing on the next render (tests, restarts) */
  snapCamera(): void {
    this.needSnap = true;
  }

  /** project a world point to framebuffer pixels (for HUD overlays) */
  worldToScreen(x: number, y: number, z: number): ScreenPoint {
    this.v.set(x, y, z).project(this.rig.camera);
    return {
      x: (this.v.x * 0.5 + 0.5) * SCREEN.width,
      y: (-this.v.y * 0.5 + 0.5) * SCREEN.height,
      onScreen: this.v.z < 1 && Math.abs(this.v.x) <= 1 && Math.abs(this.v.y) <= 1,
    };
  }
}
