// Packs sprite grids into CanvasTextures (one atlas per kind x team) and
// computes the UV rects. The only module in art/ that touches the DOM/three.

import * as THREE from 'three';
import type { Grid } from './grid';
import { EMPTY, rgba, type Palette } from './palette';

interface PackedCell {
  x: number; // canvas pixels, top-left
  y: number;
  w: number;
  h: number;
}

interface PackedAtlas {
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  cells: PackedCell[]; // same order as the input grids
}

/** Paint a grid into an ImageData at (ox, oy). */
function paint(img: ImageData, g: Grid, ox: number, oy: number, pal: Palette, cache: Map<string, number[]>): void {
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const ch = g.d[y * g.w + x];
      if (ch === EMPTY) continue;
      let c = cache.get(ch);
      if (!c) {
        // unknown chars show up hot pink so authoring mistakes are obvious
        c = rgba(pal[ch] ?? '#ff00ff');
        cache.set(ch, c);
      }
      const o = ((oy + y) * img.width + ox + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = c[3];
    }
  }
}

function makeTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/**
 * Shelf-pack grids (any sizes) with a 1 px transparent gutter around every
 * cell, so nearest sampling at a quad edge never picks up a neighbor.
 */
export function packAtlas(grids: Grid[], pal: Palette, maxWidth = 512): PackedAtlas {
  const cells: PackedCell[] = [];
  let x = 1;
  let y = 1;
  let shelfH = 0;
  let width = 0;
  for (const g of grids) {
    if (x + g.w + 1 > maxWidth) {
      x = 1;
      y += shelfH + 2;
      shelfH = 0;
    }
    cells.push({ x, y, w: g.w, h: g.h });
    x += g.w + 2;
    shelfH = Math.max(shelfH, g.h);
    width = Math.max(width, x);
  }
  const height = y + shelfH + 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(canvas.width, canvas.height);
  const cache = new Map<string, number[]>();
  grids.forEach((g, i) => paint(img, g, cells[i].x, cells[i].y, pal, cache));
  ctx.putImageData(img, 0, 0);
  return { texture: makeTexture(canvas), canvas, cells };
}
