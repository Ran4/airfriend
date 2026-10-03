// Rounded-rectangle helpers shared by the ice, boards, glass and stands.
// Everything that hugs the rink outline is built from ringPath(offset), so the
// boards, glass and stands stay concentric with the sim's collision shape.
import * as THREE from 'three';
import { RINK } from '../../config';

interface RingPoint {
  x: number;
  z: number;
  /** outward unit normal (away from the ice) */
  nx: number;
  nz: number;
  /** distance along the path from its start, meters */
  s: number;
}

/**
 * The rink outline pushed outward by `offset` meters, as a closed path.
 * It starts at the middle of the +x side and runs toward +z, which is
 * counter-clockwise seen from above (x right, z up). Seen from INSIDE the rink
 * that direction is left-to-right on every wall, so texture u = s keeps board
 * lettering readable from the ice. The last point repeats the first.
 */
export function ringPath(offset: number, cornerSegs = 14): RingPoint[] {
  const hw = RINK.halfWidth;
  const hl = RINK.halfLength;
  const r = RINK.cornerRadius;
  const R = r + offset;
  const cx = hw - r;
  const cz = hl - r;
  const raw: Array<[number, number, number, number]> = [];
  const corner = (ox: number, oz: number, a0: number) => {
    for (let i = 0; i <= cornerSegs; i++) {
      const a = a0 + (i / cornerSegs) * (Math.PI / 2);
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      raw.push([ox + nx * R, oz + nz * R, nx, nz]);
    }
  };
  raw.push([hw + offset, 0, 1, 0]);
  corner(cx, cz, 0);
  corner(-cx, cz, Math.PI / 2);
  corner(-cx, -cz, Math.PI);
  corner(cx, -cz, (3 * Math.PI) / 2);
  raw.push([hw + offset, 0, 1, 0]);

  const out: RingPoint[] = [];
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    const [x, z, nx, nz] = raw[i];
    if (i > 0) {
      const p = out[out.length - 1];
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < 1e-6) continue; // joints between straight and arc
      s += d;
    }
    out.push({ x, z, nx, nz, s });
  }
  return out;
}

/** THREE.Shape of the outline (x, -z) for a ShapeGeometry laid flat by rotateX(-PI/2). */
export function outlineShape(offset = 0): THREE.Shape {
  const pts = ringPath(offset, 24);
  const shape = new THREE.Shape();
  // ShapeGeometry lives in XY; rotateX(-PI/2) maps shape y -> world -z.
  pts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
  return shape;
}

/**
 * A vertical wall following ringPath(offset) between heights y0 and y1.
 * u runs along the path in meters * uScale, v from 0 (y0) to 1 (y1).
 */
export function wallGeometry(offset: number, y0: number, y1: number, uScale: number): THREE.BufferGeometry {
  const pts = ringPath(offset);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  pts.forEach((p, i) => {
    pos.push(p.x, y0, p.z, p.x, y1, p.z);
    uv.push(p.s * uScale, 0, p.s * uScale, 1);
    if (i > 0) {
      const a = (i - 1) * 2;
      // winding so the face points toward the ice (inward normal)
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * A band between ringPath(o0) at height y0 and ringPath(o1) at height y1
 * (a flat ledge when y0 == y1, a slope otherwise). u = s(at o0) * uScale,
 * v = 0..vMax.
 */
export function bandGeometry(o0: number, y0: number, o1: number, y1: number, uScale: number, vMax = 1): THREE.BufferGeometry {
  const a = ringPath(o0);
  const b = ringPath(o1);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // both paths share their vertex layout (same corner segment count)
  const mid = (i: number) => (a[i].s + b[i].s) / 2;
  for (let i = 0; i < a.length; i++) {
    pos.push(a[i].x, y0, a[i].z, b[i].x, y1, b[i].z);
    uv.push(mid(i) * uScale, 0, mid(i) * uScale, vMax);
    if (i > 0) {
      const k = (i - 1) * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
