// Off-ice furniture: penalty boxes + timekeeper (outside the +x boards) and
// the two team benches (outside the -x boards). Boxed skaters are drawn by the
// actor layer standing at (RINK.penaltyBoxX, RINK.penaltyBoxZ[team]), so the
// box floor sits at ice level and nothing tall stands between it and the camera.
import * as THREE from 'three';
import { RINK, TEAMS } from '../../config';
import type { TeamId } from '../../types';
import { block } from './blocks';
import { textWidth } from './font';
import { Pix, rgba } from './pixels';

const OUT0 = RINK.halfWidth + 0.2; // outer face of the boards
const DEPTH = 3.1; // how far the booths reach behind the boards

/** a sign texture: colored plate, 1 px light border, centered 5x7 text */
function signTexture(text: string, bg: string, fg: string, border: string, w = textWidth(text) + 8, h = 11): THREE.CanvasTexture {
  const p = new Pix(w, h, rgba(bg));
  p.rect(0, 0, w, 1, rgba(border));
  p.rect(0, h - 1, w, 1, rgba(border));
  p.rect(0, 0, 1, h, rgba(border));
  p.rect(w - 1, 0, 1, h, rgba(border));
  p.textC(text, w / 2, h / 2, rgba(fg), 1, { shadow: rgba('#000000') });
  return p.texture();
}

/** a sign standing upright on top of a wall, facing the ice (toward -side*x) */
function sign(tex: THREE.CanvasTexture, wPx: number, hPx: number, x: number, y: number, z: number, side: 1 | -1): THREE.Mesh {
  const ppm = 14;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(wPx / ppm, hPx / ppm),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
  );
  m.position.set(x, y + hPx / ppm / 2, z);
  // plane faces +z by default; turn it to face the rink
  m.rotation.y = side === 1 ? -Math.PI / 2 : Math.PI / 2;
  return m;
}

function rubberFloor(x0: number, x1: number, z0: number, z1: number, color = '#3c4458'): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }));
  m.rotation.x = -Math.PI / 2;
  m.position.set((x0 + x1) / 2, 0.01, (z0 + z1) / 2);
  return m;
}

function penaltyBox(team: TeamId): THREE.Group {
  const g = new THREE.Group();
  const zc = RINK.penaltyBoxZ[team];
  const len = 3.6;
  const xb = OUT0 + DEPTH; // back wall
  g.add(rubberFloor(OUT0, xb, zc - len / 2, zc + len / 2));
  // back wall + bench
  g.add(block('#283048', 0.16, 1.5, len, xb, 0, zc));
  g.add(block('#6878a0', 0.45, 0.42, len - 0.3, xb - 0.32, 0, zc));
  // side partitions: low white boards (glass above is implied)
  for (const s of [-1, 1]) g.add(block('#a8b0c8', DEPTH, 1.07, 0.12, OUT0 + DEPTH / 2, 0, zc + (s * len) / 2));
  const t = TEAMS[team];
  const label = `${t.abbr} PENALTY`;
  const tex = signTexture(label, t.colors.jersey, '#f8f8f8', t.colors.trim);
  g.add(sign(tex, textWidth(label) + 8, 11, xb - 0.1, 1.5, zc, 1));
  return g;
}

function timekeeper(): THREE.Group {
  const g = new THREE.Group();
  const xb = OUT0 + DEPTH;
  const z0 = RINK.penaltyBoxZ[0] + 1.8;
  const z1 = RINK.penaltyBoxZ[1] - 1.8;
  g.add(rubberFloor(OUT0, xb, z0, z1, '#303848'));
  g.add(block('#283048', 0.16, 1.5, z1 - z0, xb, 0, 0));
  // the scorer's desk with a lit clock panel
  g.add(block('#40486a', 0.8, 0.95, z1 - z0 - 0.4, OUT0 + 1.0, 0, 0));
  const clock = signTexture('TIME', '#101018', '#f8c800', '#606880', 32, 11);
  g.add(sign(clock, 32, 11, xb - 0.1, 1.5, 0, 1));
  return g;
}

function bench(team: TeamId): THREE.Group {
  const g = new THREE.Group();
  // HOME's bench is on the -z half (the end HOME defends in period 1)
  const zs = team === 0 ? -1 : 1;
  const z0 = zs * 2.5;
  const z1 = zs * 12.5;
  const zc = (z0 + z1) / 2;
  const len = Math.abs(z1 - z0);
  const x0 = -OUT0;
  const xb = -(OUT0 + DEPTH);
  const t = TEAMS[team];
  g.add(rubberFloor(xb, x0, Math.min(z0, z1), Math.max(z0, z1)));
  // back wall in team colors with a trim stripe
  g.add(block(t.colors.jerseyDark, 0.16, 1.3, len, xb, 0, zc));
  g.add(block(t.colors.trim, 0.18, 0.12, len, xb, 1.0, zc));
  // the bench itself
  g.add(block('#a07040', 0.5, 0.45, len - 0.4, xb + 0.4, 0, zc));
  for (const s of [-1, 1]) g.add(block('#a8b0c8', DEPTH, 1.07, 0.12, (x0 + xb) / 2, 0, zc + (s * len) / 2));
  // water bottles + towels: tiny blocks for a lived-in bench
  for (let i = 0; i < 5; i++) g.add(block(i % 2 ? '#f8f8f8' : t.colors.jersey, 0.12, 0.22, 0.12, xb + 0.4, 0.45, zc - len / 2 + 1.2 + i * 1.8));
  const label = `${t.city.split(' ')[0]} ${t.name}`;
  const tex = signTexture(label, t.colors.jersey, '#f8f8f8', t.colors.trim);
  g.add(sign(tex, textWidth(label) + 8, 11, xb + 0.1, 1.3, zc, -1));
  return g;
}

export function buildBooths(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'booths';
  g.add(penaltyBox(0), penaltyBox(1), timekeeper(), bench(0), bench(1));
  return g;
}
