// ACTORS preview: a mini scene with the real SpriteLibrary + ActorLayer +
// Effects and a mocked GameState. Load /tools/actors-preview.html?scene=<name>
// (see SCENES). tools/actors-shots.mjs drives it headlessly:
//   window.__preview.advance(seconds) steps the mock at a fixed 60 Hz and renders.
import * as THREE from 'three';
import { GOAL, RINK, SCREEN, TEAMS } from '../src/config';
import { ActorLayer } from '../src/render/actors';
import { buildSpriteLibrary } from '../src/render/art';
import { Effects } from '../src/render/effects';
import { buildRink } from '../src/render/rink';
import { Projector } from '../src/render/fx/pixelsprites';
import type { GameEvent, GameState, Skater, SkaterKind, SkaterState, TeamId } from '../src/types';

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene') ?? 'facings';

// ------------------------------------------------------------ three setup ----
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(SCREEN.width, SCREEN.height, false);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101828);
const camera = new THREE.PerspectiveCamera(Number(params.get('fov') ?? 32), SCREEN.displayAspect, 0.5, 300);

function aimCamera(tx: number, tz: number, heading: 1 | -1, pitchDeg = 50, dist = 30): void {
  const p = (pitchDeg * Math.PI) / 180;
  camera.position.set(tx, Math.sin(p) * dist, tz - heading * Math.cos(p) * dist);
  camera.lookAt(tx, 0, tz);
  camera.updateMatrixWorld();
  camera.userData.spriteZoom = 1; // 1:1 sprites unless a scene says otherwise
}

function iceTexture(): THREE.CanvasTexture {
  const ppm = 8;
  const W = RINK.halfWidth * 2 * ppm;
  const H = RINK.halfLength * 2 * ppm;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e8f0ff';
  g.fillRect(0, 0, W, H);
  // 1 m grid so planted feet / sliding are easy to judge
  for (let m = 0; m <= RINK.halfWidth * 2; m++) {
    g.fillStyle = m % 5 === 0 ? '#a8b8d8' : '#d0dcf0';
    g.fillRect(m * ppm, 0, 1, H);
  }
  for (let m = 0; m <= RINK.halfLength * 2; m++) {
    g.fillStyle = m % 5 === 0 ? '#a8b8d8' : '#d0dcf0';
    g.fillRect(0, m * ppm, W, 1);
  }
  const zl = (z: number) => (RINK.halfLength - z) * ppm; // canvas row for world z (texture flipped)
  g.fillStyle = '#d82828';
  g.fillRect(0, zl(0) - 1, W, 3);
  g.fillStyle = '#2848c8';
  g.fillRect(0, zl(RINK.blueLineZ) - 1, W, 3);
  g.fillRect(0, zl(-RINK.blueLineZ) - 1, W, 3);
  g.fillStyle = '#d82828';
  g.fillRect(0, zl(RINK.goalLineZ), W, 1);
  g.fillRect(0, zl(-RINK.goalLineZ), W, 1);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ?rink=1 builds the RINK agent's real arena instead of the grid ice + test nets
const realRink = params.get('rink') === '1' ? buildRink(scene) : null;
if (!realRink) {
  const ice = new THREE.Mesh(new THREE.PlaneGeometry(RINK.halfWidth * 2, RINK.halfLength * 2), new THREE.MeshBasicMaterial({ map: iceTexture() }));
  ice.rotation.x = -Math.PI / 2;
  scene.add(ice);
}

function addGoal(z: number): void {
  const s = Math.sign(z);
  const red = new THREE.MeshBasicMaterial({ color: 0xe02020 });
  const post = new THREE.BoxGeometry(0.1, GOAL.height, 0.1);
  for (const x of [-GOAL.halfWidth, GOAL.halfWidth]) {
    const m = new THREE.Mesh(post, red);
    m.position.set(x, GOAL.height / 2, z);
    scene.add(m);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(GOAL.halfWidth * 2, 0.1, 0.1), red);
  bar.position.set(0, GOAL.height, z);
  scene.add(bar);
  // netting: solid white back + sides (good enough to test occlusion)
  const net = new THREE.MeshBasicMaterial({ color: 0xd8d8e8, side: THREE.DoubleSide });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(GOAL.halfWidth * 2, GOAL.height), net);
  back.position.set(0, GOAL.height / 2, z + s * GOAL.depth);
  scene.add(back);
  for (const x of [-GOAL.halfWidth, GOAL.halfWidth]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(GOAL.depth, GOAL.height), net);
    side.rotation.y = Math.PI / 2;
    side.position.set(x, GOAL.height / 2, z + (s * GOAL.depth) / 2);
    scene.add(side);
  }
}
if (!realRink) {
  addGoal(RINK.goalLineZ);
  addGoal(-RINK.goalLineZ);
}

function addWall(x0: number, x1: number, z: number): void {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, RINK.boardHeight, 0.2), new THREE.MeshBasicMaterial({ color: 0xf0f0f0 }));
  m.position.set((x0 + x1) / 2, RINK.boardHeight / 2, z);
  scene.add(m);
  const kick = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.25, 0.22), new THREE.MeshBasicMaterial({ color: 0xf0c020 }));
  kick.position.set((x0 + x1) / 2, 0.125, z);
  scene.add(kick);
}

const sprites = buildSpriteLibrary();
const actors = new ActorLayer(scene, sprites);
const effects = new Effects(scene, sprites);

// -------------------------------------------------------------- mock state ----
function intent() {
  const b = () => ({ held: false, pressed: false, released: false });
  return { move: { x: 0, z: 0 }, shoot: b(), pass: b(), turbo: b() };
}

function mk(id: number, team: TeamId, kind: SkaterKind, x: number, z: number, facing = 0, speed = 0, st: SkaterState = 'skate'): Skater {
  const r = TEAMS[team].roster[Math.min(4, id % 5)];
  return {
    id,
    team,
    kind,
    position: r.position,
    name: r.name,
    number: r.number,
    attrs: r.attrs,
    pos: { x, z },
    vel: { x: Math.sin(facing) * speed, z: Math.cos(facing) * speed },
    facing,
    intent: intent(),
    state: st,
    stateTime: 0,
    windup: 0,
    stamina: 1,
    turboActive: false,
    barkCooldown: 0,
    stun: 0,
    invuln: 0,
    stats: { goals: 0, assists: 0, shots: 0, hits: 0, pim: 0 },
  };
}

const state: GameState = {
  phase: 'play',
  phaseTime: 0,
  period: 1,
  clock: 120,
  score: [0, 0],
  shots: [0, 0],
  hits: [0, 0],
  periodGoals: [[0, 0]],
  skaters: [],
  puck: { pos: { x: 0, z: 0 }, y: 0, vel: { x: 0, z: 0 }, vy: 0, owner: null, lastTouch: null, prevTouch: null, pickupBlock: 0, blockId: null, spin: 0 },
  referee: { pos: { x: 40, z: 0 }, vel: { x: 0, z: 0 }, facing: 0, state: 'skate', stateTime: 0 },
  penalties: [],
  faceoff: null,
  goals: [],
  lastPenaltyCall: null,
  controlledId: 0,
  winner: null,
  events: [],
  tick: 0,
  time: 0,
  paused: false,
  autoplay: true,
};

const proj = new Projector();
/** world ice point under a framebuffer pixel */
function iceAt(px: number, py: number): { x: number; z: number } {
  proj.update(camera);
  const v = proj.hitFlat(px, py, 0, new THREE.Vector3());
  return { x: v.x, z: v.z };
}
/** world heading for a screen direction (0 = up, +PI/2 = right) with the camera looking along `heading` */
function screenDirToFacing(theta: number, heading: 1 | -1): number {
  // camera looking +z: screen up = +z, screen right = -x (mirror); looking -z: both flip
  const x = -Math.sin(theta) * heading;
  const z = Math.cos(theta) * heading;
  return Math.atan2(x, z);
}

/** per-step scenario logic (moving things, firing events at times) */
let script: (t: number, dt: number, fire: (e: GameEvent) => void) => void = () => {};
const extraSkaters: Skater[] = [];

// ------------------------------------------------------------- scenarios ----
const SCENES: Record<string, () => void> = {
  /** 8 dogs (inner ring) + 8 kids (outer) + 8 away kids, each skating outward in its screen direction */
  facings() {
    aimCamera(0, 0, 1);
    const ring = (n: number, r: number, mkOne: (i: number, px: number, py: number, f: number) => Skater) => {
      for (let i = 0; i < 8; i++) {
        const th = (i * Math.PI) / 4;
        const px = 128 + Math.sin(th) * r * 1.15;
        const py = 116 - Math.cos(th) * r;
        extraSkaters.push(mkOne(n + i, px, py, screenDirToFacing(th, 1)));
      }
    };
    ring(0, 30, (id, px, py, f) => {
      const p = iceAt(px, py);
      return mk(id, 0, 'dog', p.x, p.z, f, 5);
    });
    ring(8, 70, (id, px, py, f) => {
      const p = iceAt(px, py);
      return mk(id, (id % 2) as TeamId, 'kid', p.x, p.z, f, 5);
    });
    state.controlledId = 0;
  },
  /** same, period 2: camera looks -z, so world directions mirror */
  facings2() {
    state.period = 2;
    aimCamera(0, 0, -1);
    for (let i = 0; i < 8; i++) {
      const th = (i * Math.PI) / 4;
      const p = iceAt(128 + Math.sin(th) * 80, 116 - Math.cos(th) * 70);
      extraSkaters.push(mk(i, 0, i % 2 ? 'kid' : 'dog', p.x, p.z, screenDirToFacing(th, -1), 5));
      const q = iceAt(128 + Math.sin(th) * 34, 116 - Math.cos(th) * 30);
      extraSkaters.push(mk(8 + i, 1, 'goalie', q.x, q.z, screenDirToFacing(th, -1), 0, 'gReady'));
    }
  },
  /** every anim of dog / kid / goalie / ref laid out on a grid */
  anims() {
    aimCamera(0, 0, 1);
    const dogAnims: SkaterState[] = ['skate', 'skate', 'windup', 'shoot', 'pass', 'poke', 'check', 'fallen', 'celebrate', 'faceoff', 'skate'];
    let id = 0;
    const put = (col: number, row: number, kind: SkaterKind, team: TeamId, st: SkaterState, speed: number, facing = Math.PI * 0.75) => {
      const p = iceAt(16 + col * 28, 44 + row * 36);
      extraSkaters.push(mk(id++, team, kind, p.x, p.z, facing, speed, st));
    };
    dogAnims.forEach((st, i) => put(i % 6, Math.floor(i / 6), 'dog', 0, st, i === 1 ? 6 : 0));
    // last dog: bark
    const barker = id - 1;
    dogAnims.forEach((st, i) => put(i % 6, 2 + Math.floor(i / 6), 'kid', i % 2 ? 1 : 0, st, i === 1 ? 6 : 0));
    const gStates: SkaterState[] = ['gReady', 'gReady', 'gButterfly', 'gDiveL', 'gDiveR', 'gHold'];
    gStates.forEach((st, i) => put(i, 4, 'goalie', (i % 2) as TeamId, st, i === 1 ? 2 : 0, screenDirToFacing(Math.PI, 1)));
    state.referee = { pos: iceAt(200, 44), vel: { x: 0, z: 0 }, facing: screenDirToFacing(Math.PI, 1), state: 'skate', stateTime: 0 };
    state.controlledId = 0;
    script = (t, _dt, fire) => {
      if (Math.abs(t - 0.05) < 0.009) fire({ type: 'bark', skaterId: barker, startled: [] });
      if (t > 1.0) state.referee.state = 'whistle';
      if (t > 2.0) state.referee.state = 'point';
    };
  },
  /** overlapping skaters, carried puck behind a north-facing carrier, wall + net occlusion */
  overlap() {
    aimCamera(0, 22, 1);
    // a column of overlapping skaters, near to far
    extraSkaters.push(mk(0, 0, 'dog', -1.0, 20.0, 0, 4)); // carrier skating up-screen
    extraSkaters.push(mk(1, 1, 'kid', -0.7, 20.6, Math.PI, 3)); // defender right in front of the dog's puck
    extraSkaters.push(mk(2, 0, 'kid', -2.6, 19.4, Math.PI * 0.5, 0));
    extraSkaters.push(mk(3, 1, 'kid', -0.2, 21.4, -Math.PI * 0.5, 0, 'fallen'));
    // behind the net (net should hide its legs) and in front of the crease
    extraSkaters.push(mk(4, 1, 'goalie', 0.0, 25.6, Math.PI, 0, 'gReady'));
    extraSkaters.push(mk(5, 1, 'kid', 0.3, 28.0, Math.PI, 0));
    extraSkaters.push(mk(6, 0, 'kid', 1.2, 25.4, 0, 0));
    // behind a low wall
    addWall(3, 7, 18.5);
    extraSkaters.push(mk(7, 0, 'kid', 4.5, 19.0, Math.PI, 0));
    extraSkaters.push(mk(8, 1, 'kid', 6.0, 18.0, Math.PI * 0.8, 0));
    state.puck.owner = 0;
    state.controlledId = 0;
    script = () => {
      const d = state.skaters[0];
      state.puck.pos = { x: d.pos.x + Math.sin(d.facing) * 0.55 + 0.15, z: d.pos.z + Math.cos(d.facing) * 0.55 };
    };
  },
  /** skaters hugging the side boards and in the corners (use with rink=1) */
  boards() {
    aimCamera(-6, 20, 1);
    extraSkaters.push(mk(0, 0, 'dog', -12.35, 21, 0, 4));
    extraSkaters.push(mk(1, 0, 'kid', -12.5, 17, Math.PI, 3));
    extraSkaters.push(mk(2, 1, 'kid', -11.0, 27.0, -Math.PI / 4, 3)); // far corner
    extraSkaters.push(mk(3, 1, 'kid', -9.0, 29.6, -Math.PI / 2, 3)); // end boards
    extraSkaters.push(mk(4, 0, 'kid', -12.2, 13, -Math.PI / 2, 0)); // facing into the boards
    state.controlledId = 0;
  },
  /** near-to-far column: every sprite 1:1 whatever its depth (no perspective scale) */
  perspective() {
    aimCamera(0, 0, 1);
    for (let i = 0; i < 7; i++) {
      const p = iceAt(40 + i * 30, 214 - i * 30);
      extraSkaters.push(mk(i, (i % 2) as TeamId, i === 3 ? 'dog' : 'kid', p.x, p.z, screenDirToFacing(Math.PI, 1), 0));
    }
    const p = iceAt(220, 60);
    extraSkaters.push(mk(7, 1, 'goalie', p.x, p.z, screenDirToFacing(Math.PI, 1), 0, 'gReady'));
    state.controlledId = 3;
  },
  /** high wide intro-style shot */
  wide() {
    aimCamera(0, 0, 1, 70, 70);
    // the real intro camera publishes a uniform sprite shrink (render/camera.ts); fake it here
    camera.userData.spriteZoom = 0.45;
    for (let i = 0; i < 10; i++) extraSkaters.push(mk(i, (i < 5 ? 0 : 1) as TeamId, i === 0 ? 'dog' : i % 5 === 4 ? 'goalie' : 'kid', (i % 5) * 3 - 6, (i < 5 ? -1 : 1) * (3 + (i % 3) * 2), i < 5 ? 0 : Math.PI, 0, i % 5 === 4 ? 'gReady' : 'faceoff'));
    state.referee.pos = { x: 1, z: 0 };
  },
  /** close-up at the far net: post puff, saves, boards, faceoff drop, turbo dust */
  netfx() {
    aimCamera(0, 23, 1);
    const g = mk(9, 1, 'goalie', -1.6, 25.4, Math.PI, 0, 'gReady');
    const sprinter = mk(1, 0, 'kid', 5, 18, screenDirToFacing(Math.PI / 2, 1), 9);
    sprinter.turboActive = true;
    extraSkaters.push(g, sprinter);
    state.puck.pos = { x: -3, z: 22 };
    script = (t, dt, fire) => {
      sprinter.pos.x += sprinter.vel.x * dt;
      sprinter.pos.z += sprinter.vel.z * dt;
      if (once(t, 0.1)) fire({ type: 'post', pos: { x: GOAL.halfWidth, z: RINK.goalLineZ } });
      if (once(t, 0.2)) {
        state.puck.pos = { x: -0.4, z: 25.6 };
        state.puck.y = 0.4;
        fire({ type: 'save', goalie: 9, caught: false });
      }
      if (once(t, 0.3)) {
        state.puck.pos = { x: 0.4, z: 25.6 };
        state.puck.y = 0.8;
        fire({ type: 'save', goalie: 9, caught: true });
      }
      if (once(t, 0.25)) fire({ type: 'boards', pos: { x: 6.5, z: RINK.halfLength - 0.1 }, speed: 20 });
      if (once(t, 0.15)) {
        state.faceoff = { spot: { x: -RINK.endDot.x, z: RINK.endDot.z }, dropped: true, dropTime: 0, earlyPress: [false, false] };
        fire({ type: 'faceoffDrop' });
      }
    };
  },
  /** all effects, scripted over ~3 s */
  effects() {
    aimCamera(0, 18, 1);
    const dog = mk(0, 0, 'dog', 2, 17, screenDirToFacing(-Math.PI / 2, 1), 7); // skating screen-left
    const stopper = mk(1, 0, 'kid', -4, 14, screenDirToFacing(Math.PI / 2, 1), 7); // skating screen-right
    const hitter = mk(2, 0, 'kid', 4.4, 13.8, screenDirToFacing(Math.PI / 2 + 0.6, 1), 6);
    const victim = mk(5, 1, 'kid', 3.6, 13.5, screenDirToFacing(-Math.PI / 2, 1), 2);
    const startled = mk(6, 1, 'kid', 0.5, 18.5, screenDirToFacing(Math.PI, 1), 0);
    const shooter = mk(7, 1, 'kid', -3, 21, screenDirToFacing(0, 1), 0);
    extraSkaters.push(dog, stopper, hitter, victim, startled, shooter);
    state.controlledId = 0;
    let shotFired = false;
    script = (t, dt, fire) => {
      // dog skates left, barks at 0.3 s
      dog.pos.x += dog.vel.x * dt;
      dog.pos.z += dog.vel.z * dt;
      if (t < 0.5) {
        stopper.pos.x += stopper.vel.x * dt;
        stopper.pos.z += stopper.vel.z * dt;
      }
      if (once(t, 0.3)) fire({ type: 'bark', skaterId: 0, startled: [6] });
      if (once(t, 0.3)) startled.stun = 0.4;
      if (startled.stun > 0) startled.stun -= dt;
      // hard stop at 0.5 s
      if (once(t, 0.5)) {
        fire({ type: 'hardStop', skaterId: 1, speed: 7 });
        stopper.vel = { x: 0, z: 0 };
      }
      // knockdown check at 0.7 s
      if (once(t, 0.7)) {
        fire({ type: 'check', hitter: 2, victim: 5, force: 7, knockedDown: true });
        victim.state = 'fallen';
        hitter.state = 'check';
        victim.vel = { x: 0, z: 0 };
      }
      if (t > 1.0) hitter.state = 'skate';
      // hard shot at 0.4 s toward the net, post at ~1.0 s, goal at 1.6 s
      if (once(t, 0.4)) {
        state.puck.pos = { x: shooter.pos.x, z: shooter.pos.z + 0.6 };
        state.puck.vel = { x: 3.0 / 0.25 * 0.25, z: 30 };
        state.puck.owner = null;
        shooter.state = 'shoot';
        fire({ type: 'shot', shooter: 7, power: 0.9, lifted: true });
        shotFired = true;
      }
      if (shotFired && state.puck.pos.z < RINK.goalLineZ) {
        state.puck.pos.x += state.puck.vel.x * dt;
        state.puck.pos.z += state.puck.vel.z * dt;
        state.puck.y = Math.min(0.6, (state.puck.pos.z - 21.6) * 0.15);
      }
      if (once(t, 0.62)) fire({ type: 'post', pos: { x: GOAL.halfWidth, z: RINK.goalLineZ } });
      if (once(t, 0.66)) {
        state.puck.vel = { x: 0, z: 0 };
        state.puck.pos = { x: 0.3, z: RINK.goalLineZ + 0.5 };
        fire({ type: 'goal', info: { team: 1 as TeamId, scorer: 7, assists: [], period: 2, clock: 60, powerPlay: false, shortHanded: false } });
      }
    };
  },
};

let simT = 0;
const fired = new Set<number>();
function once(t: number, at: number): boolean {
  if (t >= at && !fired.has(at)) {
    fired.add(at);
    return true;
  }
  return false;
}

(SCENES[sceneName] ?? SCENES.facings)();
state.skaters = extraSkaters;

function step(dt: number): void {
  simT += dt;
  state.time += dt;
  state.tick++;
  state.events = [];
  script(simT, dt, (e) => state.events.push(e));
  if (state.events.length) {
    actors.onEvents(state.events);
    effects.onEvents(state.events, state);
  }
}

const noDepth = params.get('nodepth') === '1'; // debug: sprites ignore the depth buffer
function render(dt: number): void {
  realRink?.update(state, dt);
  actors.update(state, camera, dt);
  effects.update(state, camera);
  if (noDepth) {
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && m.customProgramCacheKey?.() === 'airfriend-pixelsprite') m.depthTest = false;
    });
  }
  renderer.render(scene, camera);
}

declare global {
  interface Window {
    __preview: { advance(seconds: number): void; capture(): string; state: GameState };
  }
}
window.__preview = {
  advance(seconds: number) {
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) {
      step(1 / 60);
      render(1 / 60);
    }
    render(0);
  },
  capture() {
    render(0);
    return renderer.domElement.toDataURL('image/png');
  },
  state,
};
render(0);
