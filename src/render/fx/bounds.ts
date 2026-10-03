// Opaque bounding boxes of sprite frames, read back from the atlas pixels once.
// Frames live in fixed-size cells (a 20 px dog in a 32 px cell), so "the top of
// the frame" is not "the top of the head". Markers, the ARF! bubble and dizzy
// stars need the real head position.

import type * as THREE from 'three';
import type { SpriteFrame } from '../art';

/** source pixels measured from the frame's bottom-left (unmirrored); t/r exclusive */
interface FrameBounds {
  l: number;
  r: number;
  b: number;
  t: number;
}

interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

const texPixels = new WeakMap<THREE.Texture, Pixels | null>();
const frameBounds = new WeakMap<THREE.Texture, Map<string, FrameBounds>>();
// Per frame object: frames are built once by the sprite library and asked for
// every frame (drawShadow alone asks three times per actor), so the common
// path is one WeakMap lookup with no string key. A mirrored frame is a
// separate object over the same cell; it still shares the texture-level entry.
const byFrame = new WeakMap<SpriteFrame, FrameBounds>();

function readPixels(tex: THREE.Texture): Pixels | null {
  if (texPixels.has(tex)) return texPixels.get(tex)!;
  let px: Pixels | null = null;
  const img = tex.image as unknown;
  try {
    if (img && typeof img === 'object' && 'data' in img && 'width' in img) {
      const d = img as Pixels;
      // DataTexture: only RGBA8 is understood
      if (d.data && d.data.length >= d.width * d.height * 4) px = d;
    } else if (img && typeof document !== 'undefined') {
      const src = img as HTMLCanvasElement | HTMLImageElement | ImageBitmap;
      const w = src.width;
      const h = src.height;
      let g: CanvasRenderingContext2D | null = null;
      if (src instanceof HTMLCanvasElement) g = src.getContext('2d', { willReadFrequently: true });
      if (!g) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        g = c.getContext('2d')!;
        g.drawImage(src as CanvasImageSource, 0, 0);
      }
      px = { data: g.getImageData(0, 0, w, h).data, width: w, height: h };
    }
  } catch {
    px = null;
  }
  texPixels.set(tex, px);
  return px;
}

/** Opaque bounds of a frame (alpha >= 128). Falls back to the full frame. */
export function boundsOf(f: SpriteFrame): FrameBounds {
  let bb = byFrame.get(f);
  if (!bb) byFrame.set(f, (bb = measure(f)));
  return bb;
}

function measure(f: SpriteFrame): FrameBounds {
  let m = frameBounds.get(f.texture);
  if (!m) {
    m = new Map();
    frameBounds.set(f.texture, m);
  }
  const key = `${f.u0},${f.v0},${f.u1},${f.v1}`;
  let bb = m.get(key);
  if (bb) return bb;
  bb = { l: 0, r: f.w, b: 0, t: f.h };
  const px = readPixels(f.texture);
  if (px) {
    const { width: W, height: H, data } = px;
    const flipY = f.texture.flipY;
    const ux = Math.min(f.u0, f.u1) * W;
    const vy = Math.min(f.v0, f.v1);
    let l = Infinity;
    let r = -Infinity;
    let b = Infinity;
    let t = -Infinity;
    for (let j = 0; j < f.h; j++) {
      // j counts rows up from the frame's bottom
      const vRow = vy * H + j; // texture row from the bottom
      const row = Math.floor(flipY ? H - 1 - vRow : vRow);
      if (row < 0 || row >= H) continue;
      for (let i = 0; i < f.w; i++) {
        const col = Math.floor(ux + i);
        if (col < 0 || col >= W) continue;
        if (data[(row * W + col) * 4 + 3] >= 128) {
          if (i < l) l = i;
          if (i + 1 > r) r = i + 1;
          if (j < b) b = j;
          if (j + 1 > t) t = j + 1;
        }
      }
    }
    if (r > l) bb = { l, r, b, t };
  }
  m.set(key, bb);
  return bb;
}
