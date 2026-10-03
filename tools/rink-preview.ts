// RINK agent's scenario preview: renders the real GameRenderer against a
// hand-posed GameState (no sim stepping), so camera framing can be checked for
// any puck position / period / phase. Driven by tools/rink-shots.mjs.
import { GameRenderer } from '../src/render/renderer';
import { createGame } from '../src/sim/game';
import type { GameEvent, GameState, Phase } from '../src/types';

export interface Scenario {
  puck?: { x: number; z: number; vx?: number; vz?: number };
  period?: number;
  phase?: Phase;
  phaseTime?: number;
  /** move the controlled skater (dog) here */
  dog?: { x: number; z: number };
  /** scatter the skaters around the puck so the frame has players in it */
  formation?: boolean;
  events?: GameEvent[];
  /** frames to render before capture (camera settles), dt = 1/60 */
  frames?: number;
  /** skip the settle and snap the camera */
  snap?: boolean;
  /** hide everything but the arena (sprites/FX belong to other agents) */
  bare?: boolean;
  /** put these skater ids in their team's penalty box */
  boxed?: number[];
}

const renderer = new GameRenderer(document.getElementById('screen')!);
let state: GameState = createGame({ autoplay: true });

function setup(s: Scenario): void {
  state = createGame({ autoplay: true });
  state.period = s.period ?? 1;
  state.phase = s.phase ?? 'play';
  state.phaseTime = s.phaseTime ?? 5;
  if (s.puck) {
    state.puck.pos = { x: s.puck.x, z: s.puck.z };
    state.puck.vel = { x: s.puck.vx ?? 0, z: s.puck.vz ?? 0 };
    state.puck.owner = null;
  }
  const d = state.period % 2 === 1 || state.period > 3 ? 1 : -1;
  if (s.formation) {
    const p = state.puck.pos;
    const offs = [[0.8, -0.6], [-4, -3], [3, -6], [-3, -8], [0, -26], [1.5, 1.5], [-3, 3], [4, 4], [-2, 7], [0, 26]];
    state.skaters.forEach((k, i) => {
      const [ox, oz] = offs[i];
      k.pos = i === 4 || i === 9 ? { x: 0, z: oz > 0 ? 25.6 * d : -25.6 * d } : { x: p.x + ox, z: p.z + oz * d };
      k.facing = k.team === 0 ? (d === 1 ? 0 : Math.PI) : d === 1 ? Math.PI : 0;
    });
  }
  if (s.dog) state.skaters[0].pos = { ...s.dog };
  for (const id of s.boxed ?? []) {
    const k = state.skaters[id];
    k.state = 'box';
    k.pos = { x: 14.6, z: k.team === 0 ? -4 : 4 };
    k.facing = -Math.PI / 2;
  }
  state.referee.pos = { x: state.puck.pos.x + 3, z: state.puck.pos.z + 2 };
}

(window as unknown as { __rink: unknown }).__rink = {
  get state() {
    return state;
  },
  renderer,
  show(s: Scenario) {
    setup(s);
    // bare: the arena goes on layer 1 and the camera sees only that layer
    const r = renderer as unknown as { scene: import('three').Scene; rig: { camera: import('three').Camera } };
    r.scene.getObjectByName('arena')?.traverse((o) => o.layers.enable(1));
    if (s.bare) r.rig.camera.layers.set(1);
    else r.rig.camera.layers.enableAll();
    renderer.snapCamera();
    renderer.render(state, 1 / 60);
    if (s.events) {
      state.events = s.events;
      renderer.onEvents(s.events, state);
    }
    const n = s.snap ? 1 : (s.frames ?? 90);
    for (let i = 0; i < n; i++) {
      // advance clocks so phase-driven camera moves (intro, goal zoom) progress
      if (!s.snap && s.phase === 'intro') state.phaseTime = (s.phaseTime ?? 0) + (i / 60);
      renderer.render(state, 1 / 60);
    }
  },
  /** render n more frames, optionally moving the puck each frame */
  run(n: number, puckVel?: { x: number; z: number }) {
    for (let i = 0; i < n; i++) {
      if (puckVel) {
        state.puck.vel = { ...puckVel };
        state.puck.pos.x += puckVel.x / 60;
        state.puck.pos.z += puckVel.z / 60;
      }
      state.phaseTime += 1 / 60;
      renderer.render(state, 1 / 60);
    }
  },
  project(x: number, y: number, z: number) {
    return renderer.worldToScreen(x, y, z);
  },
  /** the ice texture as a PNG data URL (for checking the markings 1:1) */
  iceTexture() {
    const scene = (renderer as unknown as { scene: import('three').Scene }).scene;
    const ice = scene.getObjectByName('ice') as import('three').Mesh;
    const map = (ice.material as import('three').MeshBasicMaterial).map!;
    return (map.image as HTMLCanvasElement).toDataURL('image/png');
  },
  capture() {
    return renderer.canvas.toDataURL('image/png');
  },
};
(window as unknown as { __rinkReady: boolean }).__rinkReady = true;
