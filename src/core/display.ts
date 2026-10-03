// Putting the 256x224 framebuffer on the monitor, SNES-on-a-CRT style.
//
// The sim draws into two 256x224 canvases (3D + HUD) that are never shown
// themselves. Each frame they are composited nearest-neighbour into a
// prescale canvas at a whole multiple of the framebuffer, and that is drawn
// with bilinear filtering into the visible canvas: "sharp bilinear".
// Vertically the prescale IS the final size (s whole device rows per source
// row, a 1:1 copy). Horizontally the 8:7 pixel aspect is never a whole
// multiple (4.67x at 1080p), so only the fractional seam between two source
// columns blends, instead of strokes alternating 4 and 5 device px wide as
// they did under image-rendering: pixelated.
//
// Everything is in DEVICE pixels (CSS px x devicePixelRatio), so 125% / 150%
// OS scaling and browser zoom get the same whole-row mapping. The visible
// canvas covers the whole viewport with exactly one backing pixel per device
// pixel (ResizeObserver device-pixel-content-box) and the picture is placed
// inside it at a whole device-pixel offset by drawImage. Positioning a
// picture-sized element with CSS instead (left/top at k/dpr px) is at the
// mercy of the browser's layout snapping: measured in headless Chromium at
// (emulated) DPR 1.25 / 1.5 / 2, it landed up to a device px off, and every
// source row then blended into its neighbour. The CRT scanlines are drawn the same way, row by row on
// a device-resolution canvas, instead of a percentage gradient that moirés
// against the device grid.

import { SCREEN } from '../config';

interface DisplayFit {
  dpr: number;
  /** viewport size in device pixels (the visible canvas' backing store) */
  viewW: number;
  viewH: number;
  /** device rows per source row; 0 when the viewport is under 224 device rows */
  scale: number;
  /** prescale canvas: device px per source px, x and y */
  preX: number;
  preY: number;
  /** the 4:3 picture, in device pixels within the viewport */
  devW: number;
  devH: number;
  devLeft: number;
  devTop: number;
}

const EPS = 1e-6;

/** Pure layout maths (exported for tests): the 4:3 picture for a viewport of viewW x viewH device px. */
function computeFit(viewW: number, viewH: number, dpr: number): DisplayFit {
  dpr = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  viewW = Math.max(1, Math.round(viewW));
  viewH = Math.max(1, Math.round(viewH));
  const aspect = SCREEN.displayAspect;
  const room = Math.min(viewH, viewW / aspect);
  const scale = Math.max(0, Math.floor(room / SCREEN.height + EPS));
  // under 224 device rows no whole mapping exists: just fit it
  const devH = scale >= 1 ? scale * SCREEN.height : Math.max(1, Math.floor(room));
  const devW = Math.max(1, Math.round(devH * aspect));
  return {
    dpr,
    viewW,
    viewH,
    scale,
    preX: Math.max(1, Math.floor(devW / SCREEN.width + EPS)),
    preY: Math.max(1, scale),
    devW,
    devH,
    devLeft: Math.max(0, Math.round((viewW - devW) / 2)),
    devTop: Math.max(0, Math.round((viewH - devH) / 2)),
  };
}

export class Display {
  /** the visible canvas (whole viewport, one pixel per device pixel) */
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  /** sources composited at a whole prescale (never shown) */
  private readonly pre: HTMLCanvasElement;
  private readonly preG: CanvasRenderingContext2D;
  private readonly crtG: CanvasRenderingContext2D | null;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = (): void => this.fit();
  /** last device-pixel content size the ResizeObserver reported */
  private observed: { w: number; h: number; dpr: number } | null = null;
  /** raw devicePixelRatio the current fit was made for */
  private fitDpr = 0;
  fitInfo: DisplayFit;

  /**
   * @param box     the #screen element: sized here to the picture's rect (in
   *                CSS px, for anything that measures it); the canvases in it
   *                are position: fixed over the whole viewport
   * @param sources 256x224 canvases composited bottom to top each present()
   * @param crt     scanline overlay canvas, a child of box (CSS shows it when box has .crt)
   */
  constructor(
    private readonly box: HTMLElement,
    private readonly sources: readonly HTMLCanvasElement[],
    private readonly crt: HTMLCanvasElement,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'display';
    box.insertBefore(this.canvas, crt.parentElement === box ? crt : null);
    this.g = this.canvas.getContext('2d', { alpha: false })!;
    this.pre = document.createElement('canvas');
    this.preG = this.pre.getContext('2d', { alpha: false })!;
    this.crtG = crt.getContext('2d');
    this.fitInfo = this.measure();
    window.addEventListener('resize', () => this.fit());
    this.observe();
    this.fit();
  }

  /** [w, h] of the prescale canvas (tests) */
  get prescaleSize(): [number, number] {
    return [this.pre.width, this.pre.height];
  }

  /** Re-layout for the current viewport and devicePixelRatio. */
  fit(): void {
    this.fitDpr = window.devicePixelRatio;
    const f = this.measure();
    this.fitInfo = f;
    if (this.canvas.width !== f.viewW || this.canvas.height !== f.viewH) {
      this.canvas.width = f.viewW;
      this.canvas.height = f.viewH;
    }
    // the border stays black; present() only ever touches the picture rect
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, f.viewW, f.viewH);
    const pw = SCREEN.width * f.preX;
    const ph = SCREEN.height * f.preY;
    if (this.pre.width !== pw || this.pre.height !== ph) {
      this.pre.width = pw;
      this.pre.height = ph;
    }
    // the box itself shows nothing (the fixed canvases draw everything); it
    // just keeps the picture's rect for whoever measures #screen
    const st = this.box.style;
    st.left = `${f.devLeft / f.dpr}px`;
    st.top = `${f.devTop / f.dpr}px`;
    st.width = `${f.devW / f.dpr}px`;
    st.height = `${f.devH / f.dpr}px`;
    this.drawScanlines(f);
    this.present();
    this.watchDpr(f.dpr);
  }

  /** Composite the sources and put them on screen. Call after they drew. */
  present(): void {
    // belt and braces for the events: DevTools device emulation (and some
    // browsers on a monitor move) change the ratio without resize/matchMedia
    if (window.devicePixelRatio !== this.fitDpr) {
      this.fit(); // calls present() again with the new fit
      return;
    }
    const f = this.fitInfo;
    const pg = this.preG;
    const { width: pw, height: ph } = this.pre;
    // resizing a canvas resets its state, so set smoothing every time
    pg.imageSmoothingEnabled = false;
    pg.fillStyle = '#000';
    pg.fillRect(0, 0, pw, ph);
    for (const src of this.sources) pg.drawImage(src, 0, 0, pw, ph);
    const g = this.g;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'low'; // plain bilinear ('high' may go bicubic and ring)
    g.drawImage(this.pre, f.devLeft, f.devTop, f.devW, f.devH);
  }

  /** viewport in device px: the observer's exact figure, else CSS px x dpr */
  private measure(): DisplayFit {
    const dpr = window.devicePixelRatio || 1;
    const w = (this.canvas.clientWidth || window.innerWidth) * dpr;
    const h = (this.canvas.clientHeight || window.innerHeight) * dpr;
    const o = this.observed;
    // the observer only refines the rounding; DevTools device emulation
    // reports CSS px there while rendering at the emulated ratio, so a figure
    // that disagrees by more than rounding is not trusted
    if (o && o.dpr === dpr && Math.abs(o.w - w) <= 2 && Math.abs(o.h - h) <= 2) return computeFit(o.w, o.h, dpr);
    return computeFit(w, h, dpr);
  }

  /**
   * device-pixel-content-box is the browser's own count of device pixels the
   * viewport-sized canvas covers (CSS px x dpr can be off by one at fractional ratios). It also
   * fires on zoom and on moving to a monitor with another scale.
   */
  private observe(): void {
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      const d = e?.devicePixelContentBoxSize?.[0];
      if (!d) return;
      const dpr = window.devicePixelRatio || 1;
      const o = this.observed;
      if (o && o.w === d.inlineSize && o.h === d.blockSize && o.dpr === dpr) return;
      this.observed = { w: d.inlineSize, h: d.blockSize, dpr };
      this.fit();
    });
    try {
      ro.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      // browser without device-pixel-content-box (Safari): CSS px x dpr it is
    }
  }

  /** zoom / moving to a monitor with another scale fires this, resize may not */
  private watchDpr(dpr: number): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${dpr}dppx)`) : null;
    this.dprQuery?.addEventListener('change', this.onDprChange);
  }

  /**
   * One canvas pixel per device pixel; each source row's device rows are
   * split bright on top, dark below (3x: 2+1, 4x: 2+2, 5x: 3+2). At 1x there
   * is no room for a scanline inside a row, so the overlay stays clear.
   */
  private drawScanlines(f: DisplayFit): void {
    const c = this.crt;
    if (c.width !== f.viewW || c.height !== f.viewH) {
      c.width = f.viewW;
      c.height = f.viewH;
    }
    const g = this.crtG;
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(0, 0, 0, 0.32)';
    for (let y = 0; y < SCREEN.height; y++) {
      const y0 = Math.round((y * f.devH) / SCREEN.height);
      const y1 = Math.round(((y + 1) * f.devH) / SCREEN.height);
      const dark = Math.floor((y1 - y0) / 2);
      if (dark > 0) g.fillRect(f.devLeft, f.devTop + y1 - dark, f.devW, dark);
    }
  }
}
