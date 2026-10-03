// Goals: red frame, alpha-tested pixel netting, and the red goal light on top
// of the end glass that flashes when the puck goes in (the net also bulges).
// Only the far end's lamp is shown: the near one would sit on the glass right
// in front of the lens, over the players behind HOME's net.
import * as THREE from 'three';
import { GOAL, RINK } from '../../config';
import { block, splitSides } from './blocks';
import { Pix, rgba } from './pixels';

// one 3x3 texel mesh cell: 0.1 m texels stay >= 1 screen px at the far net,
// so nearest sampling can't drop strands
const NET_TILE_M = 0.3;

/**
 * Mid-tone strands with darker knots, and a faint white haze in the gaps (a
 * real net reads as a white veil from the stands). Mid-tone strands stay
 * visible both over the shadowed net floor and over the white ice behind.
 */
function netTexture(): THREE.CanvasTexture {
  const p = new Pix(3, 3, rgba('#f8f8f8', 80));
  p.rect(0, 0, 3, 1, rgba('#c0cce0'));
  p.rect(0, 0, 1, 3, rgba('#c0cce0'));
  p.set(0, 0, rgba('#7888a8'));
  return p.texture({ repeat: true });
}

/**
 * Net in local space: mouth on z = 0 between the posts, bulging toward +z.
 * A skirt from the top frame down to the base frame, plus the roof.
 */
function netGeometry(): THREE.BufferGeometry {
  const hw = GOAL.halfWidth;
  const h = GOAL.height;
  const top: Array<[number, number, number]> = [
    [hw, h, 0],
    [hw - 0.08, h - 0.05, 0.42],
    [-(hw - 0.08), h - 0.05, 0.42],
    [-hw, h, 0],
  ];
  const bot: Array<[number, number, number]> = [
    [hw, 0, 0],
    [hw - 0.1, 0, GOAL.depth * 0.75],
    [hw * 0.55, 0, GOAL.depth],
    [-hw * 0.55, 0, GOAL.depth],
    [-(hw - 0.1), 0, GOAL.depth * 0.75],
    [-hw, 0, 0],
  ];
  // resample the top to the bottom's vertex count so the skirt is a strip
  const topR: Array<[number, number, number]> = [top[0], top[1], [hw * 0.5, h - 0.05, 0.42], [-hw * 0.5, h - 0.05, 0.42], top[2], top[3]];
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let s = 0;
  for (let i = 0; i < bot.length; i++) {
    if (i > 0) s += Math.hypot(bot[i][0] - bot[i - 1][0], bot[i][2] - bot[i - 1][2]);
    pos.push(...topR[i], ...bot[i]);
    uv.push(s / NET_TILE_M, topR[i][1] / NET_TILE_M, s / NET_TILE_M, 0);
    if (i > 0) {
      const k = (i - 1) * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  // roof
  const base = pos.length / 3;
  for (const v of top) {
    pos.push(...v);
    uv.push(v[0] / NET_TILE_M, v[2] / NET_TILE_M);
  }
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** the net's base outline as a flat polygon just above the ice */
function netFloorGeometry(): THREE.BufferGeometry {
  const hw = GOAL.halfWidth;
  const ring: Array<[number, number]> = [
    [hw, 0],
    [hw - 0.1, GOAL.depth * 0.75],
    [hw * 0.55, GOAL.depth],
    [-hw * 0.55, GOAL.depth],
    [-(hw - 0.1), GOAL.depth * 0.75],
    [-hw, 0],
  ];
  const pos: number[] = [];
  for (const [x, z] of ring) pos.push(x, 0.01, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);
  return g;
}

function haloTexture(): THREE.CanvasTexture {
  const n = 16;
  const p = new Pix(n, n);
  // stepped (posterized) glow: three hard-edged rings, no smooth gradient
  p.disc(8, 8, 7.5, rgba('#ff2010', 70));
  p.disc(8, 8, 5.2, rgba('#ff3020', 140));
  p.disc(8, 8, 2.8, rgba('#fff0c0', 255));
  return p.texture();
}

interface GoalsView {
  group: THREE.Group;
  /** flash the light and bulge the net at the goal on the `end` side (+1 = +z) */
  goal(end: 1 | -1, seconds: number): void;
  /** `nearEnd`: the end behind the lens this period (+1 = +z); its lamp is hidden */
  update(dt: number, nearEnd: 1 | -1): void;
}

export function buildGoals(): GoalsView {
  const group = new THREE.Group();
  group.name = 'goals';
  const netTex = netTexture();
  const netMat = new THREE.MeshBasicMaterial({ map: netTex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const haloTex = haloTexture();
  const shadowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#182038'), transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
  // a flat, non-overlapping fan in one flat color: draw order inside it can't matter
  shadowMat.forceSinglePass = true;
  const ends: Array<{
    end: 1 | -1;
    light: THREE.MeshBasicMaterial;
    lamp: THREE.Group;
    halo: THREE.Sprite;
    net: THREE.Object3D;
    t: number;
    shake: number;
  }> = [];

  for (const end of [1, -1] as const) {
    const g = new THREE.Group();
    g.position.z = end * RINK.goalLineZ;
    g.rotation.y = end === 1 ? 0 : Math.PI;
    const t = 0.1; // pipe thickness: ~1.3 px at center screen, widened to read
    const frame = '#e81818';
    g.add(block(frame, t, GOAL.height, t, GOAL.halfWidth + t / 2, 0, 0));
    g.add(block(frame, t, GOAL.height, t, -GOAL.halfWidth - t / 2, 0, 0));
    g.add(block(frame, GOAL.halfWidth * 2 + t * 2, t, t, 0, GOAL.height, 0));
    // white base pad along the back of the net (the padded bottom frame)
    g.add(block('#d8e0f0', GOAL.halfWidth * 1.1, 0.06, 0.08, 0, 0, GOAL.depth - 0.02));
    // shadowed floor inside the net, so the white mesh reads against the white ice
    const floor = new THREE.Mesh(netFloorGeometry(), shadowMat);
    floor.renderOrder = 1;
    g.add(floor);
    const net = splitSides(netGeometry(), netMat);
    for (const m of net.children) m.renderOrder = 2;
    g.add(net);

    // goal judge's lamp on top of the end glass, right behind this net
    const lampZ = RINK.halfLength - RINK.goalLineZ + 0.25;
    const lampGroup = new THREE.Group();
    lampGroup.add(block('#383848', 0.5, 0.12, 0.4, 0, RINK.glassHeight, lampZ));
    const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#601818') });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.3), lightMat);
    lamp.position.set(0, RINK.glassHeight + 0.12 + 0.15, lampZ);
    lampGroup.add(lamp);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.scale.set(1.8, 1.8, 1);
    halo.position.copy(lamp.position);
    halo.visible = false;
    halo.renderOrder = 3;
    lampGroup.add(halo);
    g.add(lampGroup);
    group.add(g);
    ends.push({ end, light: lightMat, lamp: lampGroup, halo, net, t: 0, shake: 0 });
  }

  const off = new THREE.Color('#601818');
  const on = new THREE.Color('#ff3828');
  let clock = 0;
  return {
    group,
    goal(end, seconds) {
      const e = ends.find((x) => x.end === end);
      if (!e) return;
      e.t = seconds;
      e.shake = 0.7;
    },
    update(dt, nearEnd) {
      clock += dt;
      for (const e of ends) {
        e.lamp.visible = e.end !== nearEnd;
        e.t = Math.max(0, e.t - dt);
        const lit = e.t > 0 && Math.floor(clock * 6) % 2 === 0;
        e.light.color.copy(lit ? on : off);
        e.halo.visible = lit;
        // net bulge: the back of the mesh pushes out and wobbles back
        e.shake = Math.max(0, e.shake - dt);
        const k = e.shake > 0 ? Math.sin(e.shake * 30) * e.shake * 0.25 : 0;
        e.net.scale.set(1 + k * 0.3, 1, 1 + k);
      }
    },
  };
}
