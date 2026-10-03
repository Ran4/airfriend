// The ice: one procedurally rasterized pixel-art texture with every NHL
// marking, laid on a rounded-rectangle mesh. Canvas orientation matches the
// period-1 camera (canvas up = +z, canvas right = -x), so lettering painted
// upright reads correctly from the HOME end; a mirrored copy serves period 2.
import * as THREE from 'three';
import { RINK } from '../../config';
import { outlineShape } from './geom';
import { Pix, biasMips, rgba, rng } from './pixels';

/** texels per meter. 12 keeps the 0.3 m lines at 4 px and every thin line at >= 2 px. */
const ICE_PPM = 12;

const ICE_COLORS = {
  ice: '#e8f0f8',
  iceLight: '#f0f8f8',
  scratch: '#d8e4f4',
  rim: '#b0c0d8',
  rimDark: '#8898b8',
  red: '#d82020',
  redDark: '#a01010',
  blue: '#2048c0',
  crease: '#70b8f8',
  creaseLight: '#90c8f8',
  logoRed: '#d82828',
  logoDark: '#901818',
  navy: '#182870',
  white: '#f8f8f8',
  cream: '#f8e8c8',
  // the center paw is ice blue, not white: PAL (cream) stands on it at every
  // center faceoff and must not melt into it
  paw: '#98c8f8',
  pawShade: '#6098e0',
  pink: '#f898a8',
  black: '#101018',
  letter: '#b8d0f0',
} as const;

const C = Object.fromEntries(Object.entries(ICE_COLORS).map(([k, v]) => [k, rgba(v)])) as Record<keyof typeof ICE_COLORS, number>;

/** signed distance from the boards, positive inside the rink (meters) */
function insideDistance(x: number, z: number): number {
  const r = RINK.cornerRadius;
  const dx = Math.abs(x) - (RINK.halfWidth - r);
  const dz = Math.abs(z) - (RINK.halfLength - r);
  if (dx > 0 && dz > 0) return r - Math.hypot(dx, dz);
  return Math.min(RINK.halfWidth - Math.abs(x), RINK.halfLength - Math.abs(z));
}

function buildIceTexture(): THREE.CanvasTexture {
  const ppm = ICE_PPM;
  const hw = RINK.halfWidth;
  const hl = RINK.halfLength;
  const W = Math.round(hw * 2 * ppm);
  const H = Math.round(hl * 2 * ppm);
  const p = new Pix(W, H, C.ice);
  const X = (x: number) => (hw - x) * ppm; // world -> canvas
  const Y = (z: number) => (hl - z) * ppm;
  const toWorld = (cx: number, cy: number) => ({ x: hw - cx / ppm, z: hl - cy / ppm });
  const rand = rng(1994);

  // -- worn ice. Large areas stay flat: big two-tone blobs read as camouflage
  // and swallow the puck shadow. Wear goes only where skaters actually grind
  // the ice (faceoff dots, the creases, along the boards), as a few small,
  // light, nearly round patches.
  const wear: Array<[number, number]> = [];
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      wear.push([sx * RINK.endDot.x, sz * RINK.endDot.z]);
      wear.push([sx * RINK.neutralDot.x, sz * RINK.neutralDot.z]);
    }
  }
  for (const e of [1, -1]) wear.push([0, e * (RINK.goalLineZ - 1.6)]); // in front of each crease
  wear.push([0, 0]);
  for (const [i, [wx, wz]] of wear.entries()) {
    if (i % 3 === 2) continue; // 12 of the 15 spots: wear is uneven
    const a = rand() * Math.PI * 2;
    const d = 0.5 + rand() * 0.9; // just off the dot, where the skates dig in
    const rx = (0.2 + rand() * 0.3) * ppm;
    const ry = rx * (1 + rand() * 0.6);
    p.ellipse(X(wx + Math.cos(a) * d), Y(wz + Math.sin(a) * d), rx, ry, C.iceLight);
  }
  // snow along the boards, where skaters stop and turn
  for (let i = 0; i < 4; i++) {
    const side = i % 2 ? 1 : -1;
    const z = (rand() * 2 - 1) * (hl - RINK.cornerRadius);
    const rx = (0.25 + rand() * 0.2) * ppm;
    p.ellipse(X(side * (hw - 0.55)), Y(z), rx, rx * (1.2 + rand() * 0.4), C.iceLight);
  }
  // sparse 2x1 snow speckles (never single texels, which sparkle when minified)
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rand() * (W - 2));
    const y = Math.floor(rand() * H);
    p.set(x, y, C.iceLight);
    p.set(x + 1, y, C.iceLight);
  }
  // skate carves: long shallow arcs, 2 px wide so they don't sparkle when minified
  for (let i = 0; i < 58; i++) {
    const cx = X((rand() * 2 - 1) * hw);
    const cy = Y((rand() * 2 - 1) * hl);
    const R = (4 + rand() * 9) * ppm;
    const a0 = rand() * Math.PI * 2;
    const len = (1.5 + rand() * 3) * ppm;
    const steps = Math.ceil(len);
    for (let s = 0; s < steps; s++) {
      const a = a0 + s / R;
      const x = Math.round(cx + Math.cos(a) * R);
      const y = Math.round(cy + Math.sin(a) * R);
      p.set(x, y, C.scratch);
      p.set(x, y + 1, C.scratch);
    }
  }

  // -- creases (light blue, red outline), drawn before the goal lines
  for (const e of [1, -1]) {
    const gz = e * RINK.goalLineZ;
    const inCrease = (cx: number, cy: number) => {
      const w = toWorld(cx, cy);
      const out = (gz - w.z) * e; // distance out from the goal line toward center ice
      return out >= 0 && Math.abs(w.x) <= 1.22 && Math.hypot(w.x, out) <= RINK.creaseR;
    };
    const x0 = X(1.4);
    const x1 = X(-1.4);
    const ya = Math.min(Y(gz), Y(gz - e * 2));
    const yb = Math.max(Y(gz), Y(gz - e * 2));
    p.shape(Math.min(x0, x1), ya, Math.max(x0, x1), yb, inCrease, C.crease);
    // 2 px red outline: crease pixels with a non-crease neighbour within 2 px
    p.shape(Math.min(x0, x1), ya, Math.max(x0, x1), yb, (cx, cy) => {
      if (!inCrease(cx, cy)) return false;
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 0], [-1, 0], [0, 1], [0, -1]])
        if (!inCrease(cx + dx, cy + dy) && (gz - toWorld(cx + dx, cy + dy).z) * e >= 0) return true;
      return false;
    }, C.red);
    // highlight stripe inside the crease (shine)
    p.shape(Math.min(x0, x1), ya, Math.max(x0, x1), yb, (cx, cy) => {
      const w = toWorld(cx, cy);
      const out = (gz - w.z) * e;
      return inCrease(cx, cy) && Math.abs(out - 0.9) < 0.09 && Math.abs(w.x) < 0.7;
    }, C.creaseLight);
  }

  // faint painted-under-the-ice lettering in the neutral zone, one per end
  p.textC('AIR FRIEND', X(0), Y(5.95), C.letter, 2);
  p.textC('AIR FRIEND', X(0), Y(-5.95), C.letter, 2, { rot180: true });

  // -- lines. Thin real-world lines are widened to 2 px (Mode 7 shimmer rule).
  const lineZ = (z: number, widthM: number, col: number) => {
    const w = Math.max(2, Math.round(widthM * ppm));
    p.rect(0, Math.round(Y(z) - w / 2), W, w, col);
  };
  // goal lines
  for (const e of [1, -1]) lineZ(e * RINK.goalLineZ, 0.05, C.red);
  // blue lines
  for (const e of [1, -1]) lineZ(e * RINK.blueLineZ, RINK.lineWidth, C.blue);
  // center red line with the regulation "distinctive design": white ticks
  lineZ(0, RINK.lineWidth, C.red);
  {
    const w = Math.max(2, Math.round(RINK.lineWidth * ppm));
    const y0 = Math.round(Y(0) - w / 2);
    for (let x = 4; x < W; x += 12) p.rect(x, y0 + 1, 4, w - 2, C.white);
  }

  // circles: 2 px rings
  const ring = (x: number, z: number, rM: number, col: number) => p.ring(X(x), Y(z), rM * ppm - 1, rM * ppm + 1, col);
  ring(0, 0, RINK.centerCircleR, C.blue);

  // -- center-ice emblem, painted over the red line like a real logo, plus
  // FERNFIELD lettering readable from either end
  drawEmblem(p, Math.round(X(0)), Math.round(Y(0)), ppm);
  p.textC('FERNFIELD', X(0), Y(3.55), C.navy, 1);
  p.textC('FERNFIELD', X(0), Y(-3.55), C.navy, 1, { rot180: true });

  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const dx = sx * RINK.endDot.x;
      const dz = sz * RINK.endDot.z;
      ring(dx, dz, RINK.faceoffCircleR, C.red);
      // hash marks on the board side and the slot side of the circle
      for (const side of [1, -1]) {
        const xEdge = dx + side * RINK.faceoffCircleR;
        for (const hz of [0.88, -0.88]) {
          const a = X(xEdge);
          const b = X(xEdge + side * 0.62);
          p.rect(Math.min(a, b), Math.round(Y(dz + hz) - 1), Math.abs(b - a), 2, C.red);
        }
      }
      // the four L marks around the dot
      for (const lx of [1, -1]) {
        for (const lz of [1, -1]) {
          const cx = dx + lx * 0.6;
          const cz = dz + lz * 0.45;
          const a = X(cx);
          const b = X(cx + lx * 1.0);
          p.rect(Math.min(a, b), Math.round(Y(cz) - 1), Math.abs(b - a) + 1, 2, C.red);
          const c0 = Y(cz);
          const c1 = Y(cz + lz * 0.75);
          p.rect(Math.round(a - 1), Math.min(c0, c1), 2, Math.abs(c1 - c0) + 1, C.red);
        }
      }
      faceoffDot(p, X(dx), Y(dz), ppm);
    }
  }
  for (const sx of [1, -1]) for (const sz of [1, -1]) faceoffDot(p, X(sx * RINK.neutralDot.x), Y(sz * RINK.neutralDot.z), ppm);

  // goalie trapezoids behind the nets
  for (const e of [1, -1]) {
    for (const sx of [1, -1]) {
      const ax = X(sx * 3.35);
      const ay = Y(e * RINK.goalLineZ);
      const bx = X(sx * 4.27);
      const by = Y(e * RINK.halfLength);
      thickLine(p, ax, ay, bx, by, 1.0, C.red);
    }
  }

  // referee crease: semicircle at the timekeeper's bench (+x boards)
  p.ring(X(RINK.halfWidth), Y(0), 3 * ppm - 1, 3 * ppm + 1, C.red, (cx) => toWorld(cx, 0).x < RINK.halfWidth);

  // -- the boards' footprint: a crisp dark rim so the ice reads as a bowl
  p.shape(0, 0, W, H, (cx, cy) => {
    const w = toWorld(cx, cy);
    return insideDistance(w.x, w.z) < 0.16;
  }, C.rim);
  p.shape(0, 0, W, H, (cx, cy) => {
    const w = toWorld(cx, cy);
    return insideDistance(w.x, w.z) < 0.04;
  }, C.rimDark);

  return p.texture({ mipmaps: true });
}

function faceoffDot(p: Pix, cx: number, cy: number, ppm: number): void {
  p.disc(cx, cy, 0.32 * ppm, rgba(ICE_COLORS.red));
  // regulation dots have a white band through the middle
  p.rect(Math.round(cx - 0.2 * ppm), Math.round(cy - 1), Math.round(0.4 * ppm), 2, rgba(ICE_COLORS.white));
}

function thickLine(p: Pix, ax: number, ay: number, bx: number, by: number, half: number, col: number): void {
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  p.shape(Math.min(ax, bx) - 2, Math.min(ay, by) - 2, Math.max(ax, bx) + 2, Math.max(ay, by) + 2, (x, y) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
    return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= half;
  }, col);
}

/**
 * The FERNFIELD PUPS roundel: navy rim, white ring, red disc with a bevel, and
 * a big ice-blue paw print whose toes point up the ice. Laid out in texels (not
 * meters) so every bean keeps a clean 1 px navy outline and a gap.
 */
function drawEmblem(p: Pix, cx: number, cy: number, ppm: number): void {
  const R = Math.round(2.55 * ppm);
  p.disc(cx, cy, R + 2, C.navy);
  p.disc(cx, cy, R, C.white);
  p.disc(cx, cy, R - 3, C.logoRed);
  p.ring(cx, cy, R - 6, R - 3, C.logoDark, (x, y) => x - cx + (y - cy) > R * 0.55);
  p.ring(cx, cy, R - 6, R - 4, rgba('#f05050'), (x, y) => x - cx + (y - cy) < -R * 0.75);
  // [dx, dy, rx, ry] in texels; canvas -y = up the ice
  const beans: Array<[number, number, number, number]> = [
    [0, 5, 10, 8], // main pad
    [-11, -6, 3.6, 4.6],
    [-4, -12, 3.8, 4.8],
    [4, -12, 3.8, 4.8],
    [11, -6, 3.6, 4.6],
  ];
  for (const [dx, dy, rx, ry] of beans) p.ellipse(cx + dx, cy + dy, rx + 1.2, ry + 1.2, C.navy);
  for (const [dx, dy, rx, ry] of beans) {
    p.ellipse(cx + dx, cy + dy, rx, ry, C.paw);
    // darker shading on the lower edge of each bean
    p.shape(cx + dx - rx, cy + dy - ry, cx + dx + rx, cy + dy + ry, (x, y) => {
      const u = (x - (cx + dx)) / rx;
      const v = (y - (cy + dy)) / ry;
      return u * u + v * v <= 1 && v > 0.5;
    }, C.pawShade);
  }
  // the main pad's three-lobed bottom: two little notches
  p.set(cx - 4, cy + 13, C.navy);
  p.set(cx + 3, cy + 13, C.navy);
}

/** The ice surface mesh (rounded rectangle) with the marking texture. */
export function buildIce(): THREE.Mesh {
  const geo = new THREE.ShapeGeometry(outlineShape(0), 24);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    uv.setXY(i, (RINK.halfWidth - x) / (RINK.halfWidth * 2), (z + RINK.halfLength) / (RINK.halfLength * 2));
  }
  uv.needsUpdate = true;
  const mesh = new THREE.Mesh(geo, biasMips(new THREE.MeshBasicMaterial({ map: buildIceTexture() }), -1.3));
  mesh.name = 'ice';
  return mesh;
}
