// Sloped stands with an animated pixel crowd, the stands' front wall, the
// upper concourse wall with lit suites, and the dark floor around the rink.
//
// The crowd is a 32x8-person tile (8x8 texels per fan) painted in several
// frames: two idle frames (fidgeting), and for each of HOME / AWAY / ALL a
// pair of cheer frames in which that group's fans jump with arms up in two
// alternating halves. Swapping material.map animates it; no per-fan objects.
import * as THREE from 'three';
import { TEAMS } from '../../config';
import { bandGeometry, wallGeometry } from './geom';
import { spriteZoomOf } from '../fx/pixelsprites';
import { Pix, biasMips, rgba, rng } from './pixels';

const COLS = 32;
const ROWS = 8;
const CELL = 8;
const FAN_W = 0.75; // meters per fan along the row
const ROW_RISE = 0.46;
const ROW_RUN = 0.84;
// crowd mip bias: sharp in every game framing, calm in the intro's wide shot
// (camera ~2x to ~4x farther than the game lens, see the onBeforeRender hook)
const CROWD_BIAS_NEAR = -0.5;
const CROWD_BIAS_FAR = 0.5;
const CROWD_FAR_START = 1.15;
const CROWD_FAR_FULL = 1.8;
// how far the 2-texel-per-fan level is softened toward a plain average: the
// crisp faces-over-shirts rows read as confetti at full contrast
const CROWD_FAR_CALM = 0.5;

// stands geometry, as offsets beyond the boards (meters)
const STANDS = {
  front: 3.7, // stands' front wall (behind benches / penalty boxes)
  frontHeight: 1.5,
  rows: 17,
} as const;
const BACK = STANDS.front + STANDS.rows * ROW_RUN;
const TOP = STANDS.frontHeight + STANDS.rows * ROW_RISE;

type Group = 'home' | 'away' | 'neutral';
export type CheerKind = 'idle' | 'home' | 'away' | 'all';

interface Fan {
  empty: boolean;
  group: Group;
  shirt: number;
  shirtDark: number;
  skin: number;
  hair: number;
  half: 0 | 1; // which cheer half this fan jumps on
  fidget: boolean; // moves in idle frame B
  sign: number; // 0 = none, else a held-up sign color (goal frames)
}

function darker(hex: string): number {
  const c = new THREE.Color(hex).multiplyScalar(0.62);
  return rgba(`#${c.getHexString()}`);
}

function makeFans(): Fan[][] {
  const r = rng(31337);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const home = TEAMS[0].colors;
  const away = TEAMS[1].colors;
  const neutralShirts = ['#f8d800', '#38a838', '#f87800', '#3878f8', '#e0e0e0', '#303038', '#a05828', '#f878b8', '#58c8f8'];
  const skins = ['#f8d0a8', '#f0b888', '#d89860', '#a86838', '#704828'];
  const hairs = ['#382010', '#f8d878', '#804818', '#181010', '#c86020', '#909098', '#583018'];
  const fans: Fan[][] = [];
  for (let row = 0; row < ROWS; row++) {
    const line: Fan[] = [];
    for (let col = 0; col < COLS; col++) {
      const roll = r();
      const group: Group = roll < 0.5 ? 'home' : roll < 0.68 ? 'away' : 'neutral';
      const shirt = group === 'home' ? pick([home.jersey, home.jersey, '#f8f8f8']) : group === 'away' ? pick([away.jersey, away.trim]) : pick(neutralShirts);
      line.push({
        empty: r() < 0.06,
        group,
        shirt: rgba(shirt),
        shirtDark: darker(shirt),
        skin: rgba(pick(skins)),
        hair: rgba(pick(hairs)),
        half: r() < 0.5 ? 0 : 1,
        fidget: r() < 0.35,
        sign: r() < 0.07 ? rgba(pick(['#f8f8f8', '#f8e800', home.jersey])) : 0,
      });
    }
    fans.push(line);
  }
  return fans;
}

/** aisles every 16 fans: grey steps instead of people */
const isAisle = (col: number) => col % 16 === 0;

function paintFrame(fans: Fan[][], cheer: CheerKind, phase: 0 | 1, seed: number): THREE.CanvasTexture {
  const p = new Pix(COLS * CELL, ROWS * CELL);
  const r = rng(seed);
  const seatHome = rgba(TEAMS[0].colors.jerseyDark);
  const seatAway = rgba(TEAMS[1].colors.jerseyDark);
  const seatBack = rgba('#181828');
  const black = rgba('#101018');
  for (let row = 0; row < ROWS; row++) {
    // canvas row 0 is the top of the tile = the highest row of the stands
    const y0 = row * CELL;
    for (let col = 0; col < COLS; col++) {
      const x0 = col * CELL;
      if (isAisle(col)) {
        p.rect(x0, y0, CELL, CELL, rgba('#687088'));
        p.rect(x0, y0 + 3, CELL, 1, rgba('#9098b0'));
        p.rect(x0, y0 + 7, CELL, 1, rgba('#9098b0'));
        p.rect(x0, y0, 1, CELL, rgba('#485068'));
        continue;
      }
      const seat = col < 16 ? seatHome : seatAway;
      p.rect(x0, y0, CELL, CELL - 1, seat);
      p.rect(x0, y0 + CELL - 1, CELL, 1, seatBack); // the row in front's seat backs
      const f = fans[row][col];
      if (f.empty) {
        p.rect(x0 + 1, y0 + 3, 6, 3, seatBack); // seat back
        p.rect(x0 + 1, y0 + 3, 6, 1, rgba('#585870'));
        continue;
      }
      const cheering = cheer === 'all' || (cheer === 'home' && f.group === 'home') || (cheer === 'away' && f.group === 'away');
      const up = cheering && f.half === phase; // jumping this frame
      const armsUp = cheering; // both halves keep arms up while cheering
      let dx = 0;
      if (cheer === 'idle' && phase === 1 && f.fidget) dx = r() < 0.5 ? -1 : 1;
      const dy = up ? -1 : 0;
      const bx = x0 + dx;
      const by = y0 + dy;
      // body
      p.rect(bx + 1, by + 4, 6, 3, f.shirt);
      p.rect(bx + 1, by + 6, 6, 1, f.shirtDark);
      // head
      p.rect(bx + 2, by + 1, 4, 3, f.skin);
      p.rect(bx + 2, by + 1, 4, 1, f.hair);
      p.set(bx + 2, by + 2, f.hair);
      if (armsUp) {
        p.rect(bx + 0, by + (up ? 0 : 1), 1, 3, f.skin);
        p.rect(bx + 7, by + (up ? 0 : 1), 1, 3, f.skin);
        p.set(bx + 0, by + 3, f.shirt);
        p.set(bx + 7, by + 3, f.shirt);
        if (f.sign && up) {
          // a home-made sign held overhead
          p.rect(bx + 0, by - 1, 8, 2, f.sign);
          p.set(bx + 2, by - 1, black);
          p.set(bx + 4, by - 1, black);
        }
      }
      // open mouths when cheering
      if (cheering) p.set(bx + 3 + (f.half ? 1 : 0), by + 3, black);
    }
  }
  // flash bulbs: a few white pops on cheering frames
  if (cheer !== 'idle') {
    for (let i = 0; i < 10; i++) {
      const x = Math.floor(r() * COLS * CELL);
      const y = Math.floor(r() * ROWS * CELL);
      p.set(x, y, rgba('#f8f8f8'));
      p.set(x + 1, y, rgba('#f8f8f8'));
      p.set(x, y + 1, rgba('#f8f8f8'));
    }
  }
  const tex = p.texture({ repeat: true, mipmaps: true });
  // Hand-drawn mip levels. A generated (box-filtered) chain averages each 8x8
  // fan into a pastel smear with no rows left; these redraw the same fans at
  // 4 and 2 texels each, so the far intro shot still shows rows of faces over
  // shirts. The 2-texel level is softened halfway toward the plain average
  // (at full contrast it reads as confetti). Past that (the highest, most
  // foreshortened rows) a fan is under a pixel and the chain is box-averaged.
  const l1 = paintLowRes(fans, cheer, phase, 4);
  const l2 = mix(paintLowRes(fans, cheer, phase, 2), halve(l1), CROWD_FAR_CALM);
  const chain = [l2];
  while (chain[chain.length - 1].w > 1 || chain[chain.length - 1].h > 1) chain.push(halve(chain[chain.length - 1]));
  tex.mipmaps = [p.canvas, l1.flush(), ...chain.map((m) => m.flush())];
  tex.generateMipmaps = false;
  return tex;
}

/** per-texel blend of two same-size levels: `t` = share of `b` */
function mix(a: Pix, b: Pix, t: number): Pix {
  for (let i = 0; i < a.px.length; i++) {
    const p = a.px[i];
    const q = b.px[i];
    let c = 0;
    for (let sh = 0; sh < 32; sh += 8) c |= Math.round(((p >>> sh) & 0xff) * (1 - t) + ((q >>> sh) & 0xff) * t) << sh;
    a.px[i] = c >>> 0;
  }
  return a;
}

/** the next mip level down: each texel is the average of a 2x2 block */
function halve(src: Pix): Pix {
  const w = Math.max(1, src.w >> 1);
  const h = Math.max(1, src.h >> 1);
  const dst = new Pix(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const c = src.get(Math.min(src.w - 1, x * 2 + dx), Math.min(src.h - 1, y * 2 + dy));
          r += c & 0xff;
          g += (c >>> 8) & 0xff;
          b += (c >>> 16) & 0xff;
          a += c >>> 24;
          n++;
        }
      }
      dst.set(x, y, ((Math.round(a / n) << 24) | (Math.round(b / n) << 16) | (Math.round(g / n) << 8) | Math.round(r / n)) >>> 0);
    }
  }
  return dst;
}

/**
 * One crowd mip level at `cell` texels per fan (4 or 2): heads over shirts
 * over the row's seat-back line, with the cheer state (arms up, signs) kept.
 */
function paintLowRes(fans: Fan[][], cheer: CheerKind, phase: 0 | 1, cell: 4 | 2): Pix {
  const p = new Pix(COLS * cell, ROWS * cell);
  const seatBack = rgba('#181828');
  const aisle = rgba('#687088');
  const step = rgba('#9098b0');
  for (let row = 0; row < ROWS; row++) {
    const y0 = row * cell;
    for (let col = 0; col < COLS; col++) {
      const x0 = col * cell;
      const seat = rgba(col < 16 ? TEAMS[0].colors.jerseyDark : TEAMS[1].colors.jerseyDark);
      const f = fans[row][col];
      const cheering = cheer === 'all' || (cheer === 'home' && f.group === 'home') || (cheer === 'away' && f.group === 'away');
      const up = cheering && f.half === phase;
      if (isAisle(col)) {
        p.rect(x0, y0, cell, cell, aisle);
        p.rect(x0, y0 + cell - 1, cell, 1, step);
        continue;
      }
      p.rect(x0, y0, cell, cell, seat);
      if (cell === 2) {
        if (f.empty) {
          p.rect(x0, y0 + 1, 2, 1, seatBack);
          continue;
        }
        // a row of faces over a row of shirts: from the rafters a crowd reads
        // as stripes, not as individual hair colors. Signs on the jump frame.
        p.rect(x0, y0, 2, 1, up && f.sign ? f.sign : f.skin);
        p.rect(x0, y0 + 1, 2, 1, f.shirt);
        continue;
      }
      // cell 4: a hair row and a face row, a shirt row, the seat-back line
      p.rect(x0, y0 + 3, 4, 1, seatBack);
      if (f.empty) {
        p.rect(x0, y0 + 1, 4, 1, rgba('#585870'));
        p.rect(x0, y0 + 2, 4, 1, seatBack);
        continue;
      }
      p.set(x0 + 1, y0, f.hair);
      p.set(x0 + 2, y0, f.hair);
      p.set(x0 + 1, y0 + 1, f.skin);
      p.set(x0 + 2, y0 + 1, f.skin);
      p.rect(x0, y0 + 2, 4, 1, f.shirt);
      if (cheering) {
        const ay = up ? 0 : 1;
        p.set(x0, y0 + ay, f.skin);
        p.set(x0 + 3, y0 + ay, f.skin);
        if (up && f.sign) p.rect(x0, y0, 4, 1, f.sign);
      }
    }
  }
  return p;
}

function frontWallTexture(): THREE.CanvasTexture {
  // 4 m tile, 1.5 m tall
  const w = 64;
  const h = 24;
  const p = new Pix(w, h, rgba('#202840'));
  p.rect(0, 0, w, 2, rgba('#c8d0e0')); // railing
  p.rect(0, 2, w, 1, rgba('#606880'));
  p.rect(0, 9, w, 3, rgba(TEAMS[0].colors.jersey));
  p.rect(0, 12, w, 1, rgba('#f8f8f8'));
  p.rect(0, h - 2, w, 2, rgba('#141828'));
  // railing posts
  for (let x = 0; x < w; x += 16) p.rect(x, 0, 1, 3, rgba('#8890a8'));
  return p.texture({ repeat: true });
}

function upperWallTexture(): THREE.CanvasTexture {
  // 8 m tile: a dark concourse wall with a row of lit suite windows and a
  // ribbon board strip
  const w = 128;
  const h = 64;
  const p = new Pix(w, h, rgba('#141a2c'));
  p.rect(0, 0, w, 6, rgba('#0c1020'));
  p.rect(0, h - 8, w, 3, rgba('#283050'));
  p.rect(0, h - 5, w, 1, rgba(TEAMS[0].colors.jersey));
  for (let i = 0; i < 4; i++) {
    const x = 6 + i * 32;
    p.rect(x, 16, 22, 10, rgba('#383050'));
    p.rect(x + 1, 17, 20, 8, rgba(i % 2 ? '#f8d070' : '#f0b850'));
    p.rect(x + 1, 22, 20, 1, rgba('#a07830'));
    p.rect(x + 11, 17, 1, 8, rgba('#383050'));
  }
  // banners hanging in the rafters above
  p.rect(20, 34, 10, 16, rgba(TEAMS[0].colors.jersey));
  p.rect(20, 34, 10, 2, rgba('#f8f8f8'));
  p.rect(24, 40, 2, 6, rgba('#f8f8f8'));
  p.rect(84, 34, 10, 16, rgba('#f8f8f8'));
  p.rect(84, 34, 10, 2, rgba(TEAMS[0].colors.jersey));
  p.rect(87, 40, 4, 4, rgba(TEAMS[0].colors.jersey));
  // stars of the arena lights
  for (let x = 4; x < w; x += 16) p.set(x, 3, rgba('#f8f8e0'));
  return p.texture({ repeat: true });
}

interface StandsView {
  group: THREE.Group;
  setCheer(kind: CheerKind, phase: 0 | 1, idlePhase: 0 | 1): void;
}

export function buildStands(): StandsView {
  const group = new THREE.Group();
  group.name = 'stands';

  // dark rubber floor around the rink (under the ice, booths and stands)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(140, 180),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#283044') }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  group.add(floor);

  const front = new THREE.Mesh(
    wallGeometry(STANDS.front, 0, STANDS.frontHeight, 1 / 4),
    new THREE.MeshBasicMaterial({ map: frontWallTexture(), side: THREE.DoubleSide }),
  );
  group.add(front);

  const fans = makeFans();
  const frames: Record<string, THREE.CanvasTexture> = {};
  const kinds: CheerKind[] = ['idle', 'home', 'away', 'all'];
  kinds.forEach((k, ki) => {
    for (const ph of [0, 1] as const) frames[`${k}${ph}`] = paintFrame(fans, k, ph, 100 + ki * 10 + ph);
  });
  const slopeRows = STANDS.rows;
  const mipBias = { value: CROWD_BIAS_NEAR };
  const crowdMat = biasMips(new THREE.MeshBasicMaterial({ map: frames.idle0, side: THREE.DoubleSide }), mipBias);
  const crowd = new THREE.Mesh(
    bandGeometry(STANDS.front, STANDS.frontHeight, BACK, TOP, 1 / (COLS * FAN_W), slopeRows / ROWS),
    crowdMat,
  );
  // Close up, a negative bias keeps every fan crisp. In the intro's high wide
  // shot the crowd is minified ~4x, and a level picked half a step too sharp
  // turns the per-pixel fans into shimmering RGB static; there the bias eases
  // up to +0.5, so each screen pixel samples the hand-drawn mip level whose
  // fans are about one pixel apart (see paintFrame), which holds still.
  crowd.onBeforeRender = (_r, _s, camera) => {
    const far = 1 / spriteZoomOf(camera); // how much wider than the game lens
    const k = Math.min(1, Math.max(0, (far - CROWD_FAR_START) / (CROWD_FAR_FULL - CROWD_FAR_START)));
    mipBias.value = CROWD_BIAS_NEAR + (CROWD_BIAS_FAR - CROWD_BIAS_NEAR) * k * k * (3 - 2 * k);
  };
  group.add(crowd);

  const upper = new THREE.Mesh(
    wallGeometry(BACK, TOP, TOP + 8, 1 / 8),
    new THREE.MeshBasicMaterial({ map: upperWallTexture(), side: THREE.DoubleSide }),
  );
  group.add(upper);

  return {
    group,
    setCheer(kind, phase, idlePhase) {
      const key = kind === 'idle' ? `idle${idlePhase}` : `${kind}${phase}`;
      const t = frames[key];
      if (crowdMat.map !== t) crowdMat.map = t;
    },
  };
}
