// Flat-shaded blocks for arena furniture. No lights: each face gets a fixed
// brightness tier (top brightest), the way 16-bit artists shaded boxes.
import * as THREE from 'three';

// BoxGeometry face order: +x, -x, +y, -y, +z, -z
const TIERS = [0.78, 0.78, 1.0, 0.45, 0.88, 0.88];
const cache = new Map<string, THREE.MeshBasicMaterial[]>();

function shadedMaterials(color: string): THREE.MeshBasicMaterial[] {
  let m = cache.get(color);
  if (!m) {
    const base = new THREE.Color(color);
    m = TIERS.map((k) => new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(k) }));
    cache.set(color, m);
  }
  return m;
}

/** box centered at (x, y0 + h/2, z), sizes along x/y/z */
export function block(color: string, sx: number, sy: number, sz: number, x: number, y0: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), shadedMaterials(color));
  m.position.set(x, y0 + sy / 2, z);
  return m;
}

/**
 * A transparent DoubleSide mesh as two single-sided meshes: the back faces,
 * then the front faces. three's renderer draws such a material in exactly
 * those two passes on its own, but it flips `material.side` and flags the
 * material dirty around each pass, which re-derives its program parameters
 * and cache key every frame. Both halves share the geometry, so they get the
 * same sort depth, and three breaks that tie by object id: the back half is
 * created first, so it draws right before its front half, as before.
 * `mat` becomes the back half's material; the front half gets a clone.
 */
export function splitSides(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Group {
  const front = mat.clone();
  front.side = THREE.FrontSide;
  mat.side = THREE.BackSide;
  const pair = new THREE.Group();
  pair.add(new THREE.Mesh(geo, mat), new THREE.Mesh(geo, front));
  return pair;
}
