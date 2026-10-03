// RINK agent: numeric check of the camera lens against DESIGN.md section 5.
//   npx tsx tools/rink-camnum.ts
// Projects 1 m ground segments at the screen center/top/bottom, measures the
// visible width, and the vertical scale of an upright 1 m billboard.
import * as THREE from 'three';
import { SCREEN, SPRITE_METERS_PER_PIXEL } from '../src/config';
import { CAMERA, CameraRig, frameExtents } from '../src/render/camera';
import { createGame } from '../src/sim/game';

const rig = new CameraRig();
const state = createGame({ autoplay: true });
state.phase = 'play';
state.puck.pos = { x: 0, z: 0 };
state.skaters[0].pos = { x: 0, z: 0 };
rig.snap(state);
const cam = rig.camera;
const v = new THREE.Vector3();
const proj = (x: number, y: number, z: number) => {
  v.set(x, y, z).project(cam);
  return { x: (v.x * 0.5 + 0.5) * SCREEN.width, y: (-v.y * 0.5 + 0.5) * SCREEN.height };
};
// ground point under a given screen row (ray-plane intersection)
const groundAtRow = (row: number) => {
  const ndcY = -(row / SCREEN.height) * 2 + 1;
  const p = new THREE.Vector3(0, ndcY, 0.5).unproject(cam);
  const dir = p.sub(cam.position).normalize();
  const t = -cam.position.y / dir.y;
  return cam.position.clone().addScaledVector(dir, t);
};
const pxPerM = (row: number) => {
  const g = groundAtRow(row);
  const a = proj(g.x - 0.5, 0, g.z);
  const b = proj(g.x + 0.5, 0, g.z);
  const c = proj(g.x, 0, g.z - 0.5);
  const d = proj(g.x, 0, g.z + 0.5);
  // upright 1 m pole and a camera-facing 1 m segment (what a billboard tilted to the camera gets)
  const up = proj(g.x, 1, g.z);
  const base = proj(g.x, 0, g.z);
  return { z: g.z, across: Math.abs(b.x - a.x), along: Math.abs(d.y - c.y), upright: Math.abs(base.y - up.y) };
};
const dist = cam.position.distanceTo(new THREE.Vector3(0, 0, 0));
const e = frameExtents(CAMERA.pitch, CAMERA.fov, dist);
const fmt = (n: number) => n.toFixed(2);
console.log(`fov ${CAMERA.fov} deg (vertical, aspect 4:3)  pitch ${fmt((CAMERA.pitch * 180) / Math.PI)} deg`);
console.log(`distance to target ${fmt(dist)} m, camera height ${fmt(cam.position.y)} m, set back ${fmt(-cam.position.z)} m`);
console.log(`visible: width at center ${fmt(e.halfWidth * 2)} m, ice ahead ${fmt(e.ahead)} m, behind ${fmt(e.behind)} m`);
console.log(`target px/m ${fmt(1 / SPRITE_METERS_PER_PIXEL)}`);
const center = pxPerM(SCREEN.height / 2);
for (const [name, row] of [['top', 0], ['upper', 56], ['center', 112], ['lower', 168], ['bottom', 223]] as const) {
  const m = pxPerM(row);
  console.log(
    `${name.padEnd(7)} row ${String(row).padStart(3)}  z=${fmt(m.z).padStart(6)}  across ${fmt(m.across)} px/m (${fmt(m.across / center.across)}x)  ` +
      `ground-depth ${fmt(m.along)} px/m  upright-1m ${fmt(m.upright)} px`,
  );
}
// worldToScreen sanity
const p0 = proj(0, 0, 0);
const p1 = proj(-1, 0, 0);
console.log(`worldToScreen(0,0,0) = (${fmt(p0.x)}, ${fmt(p0.y)});  world -x is screen ${p1.x > p0.x ? 'RIGHT' : 'LEFT'} in period 1`);
