// ART preview page (served by Vite at /tools/art-preview.html).
// Uses the real SpriteLibrary API (frame()/misc() UVs), so it also verifies
// the atlas math the actor layer relies on.
//
//   ?view=all      (default) in-context ice strip at 1x/2x + every atlas at 4x
//   ?view=context  just the ice strip
//   ?view=atlas    just the atlases (&scale=4)
//   ?view=anims&kind=dog&team=0&scale=4   every anim x 8 directions x frames
//   &t=1.25        freeze the ice strip at a fixed time (deterministic shots)

import { buildSpriteLibrary, type SpriteAnim, type SpriteFrame, type SpriteKind, type MiscSprite } from '../src/render/art';
import { kindArt } from '../src/render/art/library';
import type { TeamId } from '../src/types';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'all';
const scale = Number(params.get('scale')) || 4;
const freezeT = params.has('t') ? Number(params.get('t')) : null;
const app = document.getElementById('app')!;
const lib = buildSpriteLibrary();
// exposed for `playtest.mjs --eval` checks
(window as unknown as { __artlib: typeof lib }).__artlib = lib;

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const angleOf = (i: number) => (i * Math.PI) / 4;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function canvas(w: number, h: number, s = 1): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = el('canvas');
  c.width = w;
  c.height = h;
  c.style.width = `${w * s}px`;
  c.style.height = `${h * s}px`;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  return [c, g];
}

/** Draw a SpriteFrame with its anchor at (x, y) (y = ice line, canvas coords). */
function draw(g: CanvasRenderingContext2D, f: SpriteFrame, x: number, y: number, s = 1): void {
  const img = f.texture.image as HTMLCanvasElement;
  const sx = Math.round(f.u0 * img.width);
  const sy = Math.round((1 - f.v1) * img.height);
  const dx = Math.round(x - f.ax * s);
  const dy = Math.round(y - (f.h - f.ay) * s);
  g.save();
  if (f.flipX) {
    g.translate(dx + f.w * s, dy);
    g.scale(-1, 1);
    g.drawImage(img, sx, sy, f.w, f.h, 0, 0, f.w * s, f.h * s);
  } else {
    g.drawImage(img, sx, sy, f.w, f.h, dx, dy, f.w * s, f.h * s);
  }
  g.restore();
}

// ------------------------------------------------------------ ice strip ----

const ICE_W = 256;
const ICE_H = 224;

function iceScene(g: CanvasRenderingContext2D, t: number): void {
  // near-white cool ice with a few rink markings for color context
  g.fillStyle = '#e4ecf8';
  g.fillRect(0, 0, ICE_W, ICE_H);
  g.fillStyle = '#dce6f4';
  for (let i = 0; i < 90; i++) g.fillRect((i * 97) % ICE_W, (i * 53) % ICE_H, 2, 1);
  g.fillStyle = '#2850c8';
  g.fillRect(0, 96, ICE_W, 4);
  g.fillStyle = '#d82828';
  g.fillRect(0, 178, ICE_W, 3);

  const shadow = (x: number, y: number) => draw(g, lib.misc('shadow'), x, y);
  // rows of every direction, skating
  const rows: { kind: SpriteKind; team: TeamId | null; anim: SpriteAnim; y: number }[] = [
    { kind: 'dog', team: 0, anim: 'skate', y: 30 },
    { kind: 'kid', team: 0, anim: 'skate', y: 62 },
    { kind: 'kid', team: 1, anim: 'skate', y: 94 },
  ];
  for (const r of rows) {
    for (let i = 0; i < 8; i++) {
      const x = 16 + i * 30;
      shadow(x, r.y);
      draw(g, lib.frame(r.kind, r.team, r.anim, angleOf(i), t + i * 0.07), x, r.y);
    }
  }
  // goalies + ref
  const y4 = 128;
  const gl: [TeamId, SpriteAnim, number][] = [
    [0, 'gReady', 0],
    [0, 'gSkate', Math.PI / 2],
    [1, 'gReady', Math.PI],
    [1, 'gButterfly', Math.PI],
    [1, 'gDiveL', Math.PI],
    [0, 'gHold', 0],
  ];
  gl.forEach(([team, anim, a], i) => {
    const x = 16 + i * 30;
    shadow(x, y4);
    draw(g, lib.frame('goalie', team, anim, a, t), x, y4);
  });
  (['refSkate', 'refWhistle', 'refPoint'] as SpriteAnim[]).forEach((anim, i) => {
    const x = 196 + i * 26;
    shadow(x, y4);
    draw(g, lib.frame('ref', null, anim, Math.PI * 0.75, t), x, y4);
  });
  // PAL next to the kids (the shot that matters most)
  const y5 = 168;
  shadow(30, y5);
  draw(g, lib.frame('kid', 0, 'skate', Math.PI / 2, t), 30, y5);
  shadow(56, y5 + 2);
  draw(g, lib.frame('dog', 0, 'skate', Math.PI / 2, t + 0.1), 56, y5 + 2);
  draw(g, lib.misc('puck'), 70, y5);
  shadow(96, y5);
  draw(g, lib.frame('kid', 1, 'check', -Math.PI / 2, t), 96, y5);
  shadow(124, y5);
  draw(g, lib.frame('dog', 0, 'bark', Math.PI, t), 124, y5);
  draw(g, lib.misc('arf', t), 128, y5 - 22);
  draw(g, lib.frame('dog', 0, 'celebrate', 0, t), 152, y5);
  draw(g, lib.frame('dog', 0, 'fallen', 0, t), 180, y5);
  draw(g, lib.frame('kid', 1, 'fallen', Math.PI / 2, t), 210, y5);
  draw(g, lib.misc('star', t), 210, y5 - 22);
  shadow(236, y5);
  draw(g, lib.frame('kid', 0, 'celebrate', Math.PI, t), 236, y5);
  // misc row
  const y6 = 214;
  const misc: MiscSprite[] = ['puck', 'puckLit', 'puckShadow', 'shadow', 'marker', 'spray0', 'spray1', 'star', 'arf', 'hey'];
  misc.forEach((m, i) => draw(g, lib.misc(m, t), 12 + i * 22, y6));
  shadow(212, y6);
  draw(g, lib.frame('dog', 0, 'idle', Math.PI * 0.75, t), 212, y6);
  draw(g, lib.misc('marker', t), 212, y6 - 20);
  shadow(240, y6);
  draw(g, lib.frame('dog', 0, 'windup', Math.PI * 0.25, t), 240, y6);
}

function contextSection(): void {
  app.appendChild(el('h2', '', 'IN CONTEXT - near-white ice, 1x (true size) and 2x'));
  const row = el('div', 'row');
  const [c1, g1] = canvas(ICE_W, ICE_H, 1);
  const [c2, g2] = canvas(ICE_W, ICE_H, 2);
  row.append(c1, c2);
  app.appendChild(row);
  const t0 = performance.now();
  const tick = (now: number) => {
    const t = freezeT ?? (now - t0) / 1000;
    iceScene(g1, t);
    g2.drawImage(c1, 0, 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// --------------------------------------------------------------- atlases ----

function atlasSection(): void {
  type Dbg = { listAtlases(): { key: string; canvas: HTMLCanvasElement }[] };
  for (const { key, canvas: src } of (lib as unknown as Dbg).listAtlases()) {
    app.appendChild(el('h2', '', `ATLAS ${key}  (${src.width}x${src.height}) at ${scale}x`));
    const [c, g] = canvas(src.width * scale, src.height * scale);
    g.fillStyle = '#3a3a44';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, src.width * scale, src.height * scale);
    const row = el('div', 'row');
    row.appendChild(c);
    app.appendChild(row);
  }
}

// ----------------------------------------------------------------- anims ----

function animsSection(kind: SpriteKind, team: TeamId | null): void {
  const art = kindArt(kind);
  app.appendChild(el('h2', '', `ANIMS ${kind} team ${team} at ${scale}x  (columns: N NE E SE S SW W NW)`));
  for (const [anim, def] of Object.entries(art.anims)) {
    const counts = Object.values(def!.dirs).map((d) => d!.length);
    const n = Math.max(...counts);
    const wrap = el('div');
    wrap.appendChild(el('div', 'lbl', `${anim}  ${n} frame(s) @ ${def!.fps} fps ${def!.loop ? 'loop' : 'once'}`));
    const row = el('div', 'row');
    for (let d = 0; d < 8; d++) {
      const cell = art.w * scale;
      const [c, g] = canvas(cell * n + (n - 1) * 2, art.h * scale);
      c.classList.add('ice');
      for (let i = 0; i < n; i++) {
        const f = lib.frame(kind, team, anim as SpriteAnim, angleOf(d), (i + 0.5) / def!.fps);
        draw(g, f, i * (cell + 2) + f.ax * scale, art.h * scale - f.ay * scale, scale);
      }
      const box = el('div');
      box.append(el('div', 'lbl', DIRS[d]), c);
      row.appendChild(box);
    }
    wrap.appendChild(row);
    app.appendChild(wrap);
  }
}

if (view === 'all' || view === 'context') contextSection();
if (view === 'anims') {
  const kind = (params.get('kind') ?? 'dog') as SpriteKind;
  const team = kind === 'ref' ? null : ((Number(params.get('team')) || 0) as TeamId);
  animsSection(kind, team);
}
if (view === 'all' || view === 'atlas') atlasSection();
