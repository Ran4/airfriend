// A tiny software pixel canvas. Canvas2D arcs and text are anti-aliased, which
// smears pixel art, so arena textures are rasterized here pixel by pixel and
// only uploaded at the end.
import * as THREE from 'three';
import { FONT_H, FONT_W, FONT_ADVANCE, glyphPixel, textWidth } from './font';

/** '#rrggbb' or '#rrggbbaa' -> packed little-endian ABGR (ImageData order). */
export function rgba(hex: string, alpha = 255): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : alpha;
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const CLEAR = 0;

/** Deterministic PRNG so the arena looks the same every boot (and in screenshots). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

export class Pix {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  readonly px: Uint32Array;

  constructor(readonly w: number, readonly h: number, fill = CLEAR) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(w, h);
    this.px = new Uint32Array(this.img.data.buffer);
    if (fill) this.px.fill(fill);
  }

  set(x: number, y: number, c: number): void {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = c;
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.px[(y | 0) * this.w + (x | 0)];
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) this.px.fill(c, yy * this.w + x0, yy * this.w + x1);
  }

  /** every pixel whose center satisfies `inside(x+0.5, y+0.5)` in the bbox */
  shape(x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean, c: number): void {
    const xa = Math.max(0, Math.floor(x0));
    const ya = Math.max(0, Math.floor(y0));
    const xb = Math.min(this.w - 1, Math.ceil(x1));
    const yb = Math.min(this.h - 1, Math.ceil(y1));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) if (inside(x + 0.5, y + 0.5)) this.px[y * this.w + x] = c;
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: number): void {
    this.shape(cx - rx, cy - ry, cx + rx, cy + ry, (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, c);
  }

  disc(cx: number, cy: number, r: number, c: number): void {
    this.ellipse(cx, cy, r, r, c);
  }

  /** annulus r0 <= d <= r1, optionally limited by a predicate (arcs) */
  ring(cx: number, cy: number, r0: number, r1: number, c: number, keep?: (x: number, y: number) => boolean): void {
    this.shape(cx - r1, cy - r1, cx + r1, cy + r1, (x, y) => {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      return d2 >= r0 * r0 && d2 <= r1 * r1 && (!keep || keep(x, y));
    }, c);
  }

  /**
   * 5x7 text. `rot180` paints it upside down (for lettering meant to be read
   * from the other end of the rink). (x, y) is the top-left of the unrotated box.
   */
  text(s: string, x: number, y: number, c: number, scale = 1, opts: { rot180?: boolean; shadow?: number } = {}): void {
    const w = textWidth(s, scale);
    const h = FONT_H * scale;
    const plot = (gx: number, gy: number, col: number) => {
      const px = opts.rot180 ? x + w - 1 - gx : x + gx;
      const py = opts.rot180 ? y + h - 1 - gy : y + gy;
      this.set(px, py, col);
    };
    const pass = (dx: number, dy: number, col: number) => {
      for (let i = 0; i < s.length; i++) {
        for (let gy = 0; gy < FONT_H; gy++) {
          for (let gx = 0; gx < FONT_W; gx++) {
            if (!glyphPixel(s[i], gx, gy)) continue;
            for (let sy = 0; sy < scale; sy++)
              for (let sx = 0; sx < scale; sx++) plot(i * FONT_ADVANCE * scale + gx * scale + sx + dx, gy * scale + sy + dy, col);
          }
        }
      }
    };
    if (opts.shadow !== undefined) pass(1, 1, opts.shadow);
    pass(0, 0, c);
  }

  /** text centered on (cx, cy) */
  textC(s: string, cx: number, cy: number, c: number, scale = 1, opts: { rot180?: boolean; shadow?: number } = {}): void {
    this.text(s, Math.round(cx - textWidth(s, scale) / 2), Math.round(cy - (FONT_H * scale) / 2), c, scale, opts);
  }

  /** push pixels to the canvas (call once after drawing) */
  flush(): HTMLCanvasElement {
    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }

  /** Nearest-filtered sRGB texture, the only kind the SNES look allows. */
  texture(opts: { repeat?: boolean; mipmaps?: boolean } = {}): THREE.CanvasTexture {
    this.flush();
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = opts.mipmaps ? THREE.NearestMipmapNearestFilter : THREE.NearestFilter;
    t.generateMipmaps = !!opts.mipmaps;
    if (opts.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 1;
    return t;
  }
}

/**
 * Bias mip selection toward the sharp level. With NearestMipmapNearest a
 * texture switches to its half-res level at ~1.4x minification, which would
 * soften the top of the gameplay view; a negative bias keeps level 0 there and
 * lets only the far intro shot fall back to mips (instead of sparkling noise).
 */
export function biasMips(mat: THREE.MeshBasicMaterial, bias: number | { value: number }): THREE.MeshBasicMaterial {
  // a number is baked into the shader; a { value } object becomes a uniform
  // the owner may change every frame (for a bias that follows the camera)
  const live = typeof bias !== 'number';
  const b = live ? 'mipBias' : bias.toFixed(2);
  mat.onBeforeCompile = (shader) => {
    if (live) {
      shader.uniforms.mipBias = bias;
      shader.fragmentShader = `uniform float mipBias;\n${shader.fragmentShader}`;
    }
    // chunks are still unexpanded here, so swap the whole include
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP\n  diffuseColor *= texture2D( map, vMapUv, ${b} );\n#endif`,
    );
  };
  mat.customProgramCacheKey = () => `mipbias${b}`;
  return mat;
}
