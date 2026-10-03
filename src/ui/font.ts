// Hand-made 8x8 bitmap font (bit data below) plus a 16x16 banner font derived
// from it with EPX/Scale2x, the way 16-bit games got smooth "big" lettering
// without a second hand-drawn set. Glyphs are pre-baked into tiny per-style
// atlases (solid color or per-row gradient, outline, drop shadow) and blitted
// with drawImage at integer scales. Never touches ctx.fillText.

// Each glyph: 7 rows of up to 7 columns ('#' = ink) inside an 8x8 cell. The
// free 8th row/column is where the drop shadow lands.
const GLYPHS: Record<string, string[]> = {
  A: ['..###..', '.##.##.', '##...##', '##...##', '#######', '##...##', '##...##'],
  B: ['######.', '##...##', '##...##', '######.', '##...##', '##...##', '######.'],
  C: ['..####.', '.##..##', '##.....', '##.....', '##.....', '.##..##', '..####.'],
  D: ['#####..', '##..##.', '##...##', '##...##', '##...##', '##..##.', '#####..'],
  E: ['#######', '##.....', '##.....', '######.', '##.....', '##.....', '#######'],
  F: ['#######', '##.....', '##.....', '######.', '##.....', '##.....', '##.....'],
  G: ['..####.', '.##..##', '##.....', '##.####', '##...##', '.##..##', '..#####'],
  H: ['##...##', '##...##', '##...##', '#######', '##...##', '##...##', '##...##'],
  I: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '######'],
  J: ['...####', '.....##', '.....##', '.....##', '##...##', '##...##', '.#####.'],
  K: ['##...##', '##..##.', '##.##..', '####...', '##.##..', '##..##.', '##...##'],
  L: ['##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '#######'],
  M: ['##...##', '###.###', '#######', '##.#.##', '##...##', '##...##', '##...##'],
  N: ['##...##', '###..##', '####.##', '##.####', '##..###', '##...##', '##...##'],
  O: ['..###..', '.##.##.', '##...##', '##...##', '##...##', '.##.##.', '..###..'],
  P: ['######.', '##...##', '##...##', '######.', '##.....', '##.....', '##.....'],
  Q: ['..###..', '.##.##.', '##...##', '##...##', '##.#.##', '.##.##.', '..##.##'],
  R: ['######.', '##...##', '##...##', '######.', '##.##..', '##..##.', '##...##'],
  S: ['.#####.', '##...##', '##.....', '.#####.', '.....##', '##...##', '.#####.'],
  T: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  U: ['##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  V: ['##...##', '##...##', '##...##', '##...##', '.##.##.', '..###..', '...#...'],
  W: ['##...##', '##...##', '##...##', '##.#.##', '#######', '###.###', '##...##'],
  X: ['##...##', '##...##', '.##.##.', '..###..', '.##.##.', '##...##', '##...##'],
  Y: ['##..##', '##..##', '##..##', '.####.', '..##..', '..##..', '..##..'],
  Z: ['#######', '....##.', '...##..', '..##...', '.##....', '##.....', '#######'],
  '0': ['.####.', '##..##', '##..##', '##..##', '##..##', '##..##', '.####.'],
  '1': ['..##..', '.###..', '..##..', '..##..', '..##..', '..##..', '.####.'],
  '2': ['.####.', '##..##', '....##', '..###.', '.##...', '##....', '######'],
  '3': ['.####.', '##..##', '....##', '..###.', '....##', '##..##', '.####.'],
  '4': ['...##.', '..###.', '.####.', '##.##.', '######', '...##.', '...##.'],
  '5': ['######', '##....', '#####.', '....##', '....##', '##..##', '.####.'],
  '6': ['..###.', '.##...', '##....', '#####.', '##..##', '##..##', '.####.'],
  '7': ['######', '....##', '...##.', '..##..', '..##..', '..##..', '..##..'],
  '8': ['.####.', '##..##', '##..##', '.####.', '##..##', '##..##', '.####.'],
  '9': ['.####.', '##..##', '##..##', '.#####', '....##', '...##.', '.###..'],
  ' ': [''],
  '.': ['', '', '', '', '', '.##', '.##'],
  ',': ['', '', '', '', '', '.##', '.##', '##.'],
  ':': ['', '.##', '.##', '', '.##', '.##', ''],
  ';': ['', '.##', '.##', '', '.##', '.##', '##.'],
  '!': ['.##', '.##', '.##', '.##', '.##', '', '.##'],
  '?': ['.####.', '##..##', '....##', '...##.', '..##..', '', '..##..'],
  "'": ['.##', '.##', '##.'],
  '"': ['##.##', '##.##', '#..#.'],
  '-': ['', '', '', '######', '', '', ''],
  '_': ['', '', '', '', '', '', '#######'],
  '=': ['', '', '######', '', '######', '', ''],
  '/': ['.....##', '....##.', '...##..', '..##...', '.##....', '##.....', ''],
  '#': ['.##.##.', '#######', '.##.##.', '.##.##.', '#######', '.##.##.', ''],
  '*': ['', '...#...', '##.#.##', '.#####.', '##.#.##', '...#...', ''],
  '+': ['', '..##..', '..##..', '######', '..##..', '..##..', ''],
  '(': ['...##', '..##.', '.##..', '.##..', '.##..', '..##.', '...##'],
  ')': ['##...', '.##..', '..##.', '..##.', '..##.', '.##..', '##...'],
  '%': ['##...##', '##..##.', '...##..', '..##...', '.##....', '##..##.', '#...##.'],
  '&': ['.###...', '##.##..', '.###...', '.###.##', '##.###.', '##..##.', '.###.##'],
  '<': ['...##', '..##.', '.##..', '##...', '.##..', '..##.', '...##'],
  '>': ['##...', '.##..', '..##.', '...##', '..##.', '.##..', '##...'],
  // specials
  '★': ['...#...', '..###..', '#######', '.#####.', '..###..', '.##.##.', '.#...#.'],
  '●': ['', '..###..', '.#####.', '.#####.', '.#####.', '..###..', ''],
  '·': ['', '', '', '.##', '.##', '', ''],
  '©': ['.#####.', '#.....#', '#.###.#', '#.#...#', '#.###.#', '#.....#', '.#####.'],
  '←': ['...#...', '..##...', '.######', '#######', '.######', '..##...', '...#...'],
  '→': ['...#...', '...##..', '######.', '#######', '######.', '...##..', '...#...'],
  '↑': ['...#...', '..###..', '.#####.', '#######', '..###..', '..###..', '..###..'],
  '↓': ['..###..', '..###..', '..###..', '#######', '.#####.', '..###..', '...#...'],
  '▶': ['##.....', '####...', '######.', '#######', '######.', '####...', '##.....'],
  '◀': ['.....##', '...####', '.######', '#######', '.######', '...####', '.....##'],
  '▲': ['', '...#...', '..###..', '.#####.', '#######', '', ''],
  '▼': ['', '#######', '.#####.', '..###..', '...#...', '', ''],
};

interface FontData {
  cw: number; // cell width
  ch: number; // cell height
  gap: number; // proportional letter gap
  index: Map<string, number>;
  masks: Uint8Array[];
  widths: number[]; // ink width per glyph (proportional mode)
}

const CHARS = Object.keys(GLYPHS);

function buildSmall(): FontData {
  const masks: Uint8Array[] = [];
  const widths: number[] = [];
  const index = new Map<string, number>();
  CHARS.forEach((ch, i) => {
    const m = new Uint8Array(64);
    let w = 0;
    GLYPHS[ch].forEach((row, y) => {
      for (let x = 0; x < row.length && x < 8; x++) {
        if (row[x] === '#') {
          m[y * 8 + x] = 1;
          w = Math.max(w, x + 1);
        }
      }
    });
    index.set(ch, i);
    masks.push(m);
    widths.push(ch === ' ' ? 4 : w);
  });
  return { cw: 8, ch: 8, gap: 1, index, masks, widths };
}

// EPX / Scale2x on a 1-bit mask: rounds every staircase into a smooth curve,
// which turns the 2-px-stroke font into a fat, friendly banner face.
function epx(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * 2 * h * 2);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = at(x, y);
      const a = at(x, y - 1);
      const b = at(x + 1, y);
      const c = at(x - 1, y);
      const d = at(x, y + 1);
      let p1 = p, p2 = p, p3 = p, p4 = p;
      if (c === a && c !== d && a !== b) p1 = a;
      if (a === b && a !== c && b !== d) p2 = b;
      if (d === c && d !== b && c !== a) p3 = c;
      if (b === d && b !== a && d !== c) p4 = d;
      const o = y * 2 * w * 2 + x * 2;
      out[o] = p1;
      out[o + 1] = p2;
      out[o + w * 2] = p3;
      out[o + w * 2 + 1] = p4;
    }
  }
  return out;
}

const SMALL = buildSmall();
const BIG: FontData = {
  cw: 16,
  ch: 16,
  gap: 2,
  index: SMALL.index,
  masks: SMALL.masks.map((m) => epx(m, 8, 8)),
  widths: SMALL.widths.map((w) => w * 2),
};

// ------------------------------------------------------------- baking ----
type Layer = 'fill' | 'outline' | 'shadow' | 'shadowOutline';
const atlases = new Map<string, HTMLCanvasElement>();

/** cell = glyph + 1 px margin left/top + 2 px right/bottom (outline + shadow) */
const cellW = (f: FontData) => f.cw + 3;
const cellH = (f: FontData) => f.ch + 3;

function dilate(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array((w + 2) * (h + 2));
  const W = w + 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let dy = 0; dy <= 2; dy++) for (let dx = 0; dx <= 2; dx++) out[(y + dy) * W + x + dx] = 1;
    }
  return out;
}

function hexBytes(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function atlas(f: FontData, layer: Layer, colors: readonly string[]): HTMLCanvasElement {
  const key = `${f.cw}|${layer}|${colors.join(',')}`;
  let c = atlases.get(key);
  if (c) return c;
  const CW = cellW(f);
  const CH = cellH(f);
  c = document.createElement('canvas');
  c.width = CW * f.masks.length;
  c.height = CH;
  const g = c.getContext('2d')!;
  const img = g.createImageData(c.width, c.height);
  const rgb = colors.map(hexBytes);
  const put = (px: number, py: number, row: number) => {
    // row = glyph-space row, used to pick the gradient band
    const [r, gg, b] = rgb[Math.max(0, Math.min(rgb.length - 1, Math.floor((row * rgb.length) / f.ch)))];
    const o = (py * c!.width + px) * 4;
    img.data[o] = r;
    img.data[o + 1] = gg;
    img.data[o + 2] = b;
    img.data[o + 3] = 255;
  };
  f.masks.forEach((m, i) => {
    const ox = i * CW;
    if (layer === 'fill' || layer === 'shadow') {
      const d = layer === 'fill' ? 1 : 2;
      for (let y = 0; y < f.ch; y++) for (let x = 0; x < f.cw; x++) if (m[y * f.cw + x]) put(ox + x + d, y + d, y);
    } else {
      const dm = dilate(m, f.cw, f.ch);
      const d = layer === 'outline' ? 0 : 1;
      const W = f.cw + 2;
      for (let y = 0; y < f.ch + 2; y++)
        for (let x = 0; x < W; x++) if (dm[y * W + x]) put(ox + x + d, y + d, Math.max(0, y - 1));
    }
  });
  g.putImageData(img, 0, 0);
  atlases.set(key, c);
  return c;
}

// ------------------------------------------------------------ drawing ----
export interface TextStyle {
  /** solid fill color (ignored when grad is set) */
  color?: string;
  /** per-row gradient, top to bottom */
  grad?: readonly string[];
  /** drop shadow (+1,+1 glyph px). Default: navy ink for the small font */
  shadow?: string | null;
  /** 1 glyph-px outline on all 8 sides */
  outline?: string | null;
  /** integer pixel scale */
  scale?: number;
  /** 16x16 banner font */
  big?: boolean;
  /** monospaced advance (default: true for small font, false for big) */
  mono?: boolean;
  align?: 'left' | 'center' | 'right';
}

const fontOf = (s: TextStyle) => (s.big ? BIG : SMALL);

function advance(f: FontData, ch: string, mono: boolean): number {
  if (mono) return f.cw;
  const i = f.index.get(ch);
  if (i === undefined) return f.cw;
  return f.widths[i] + f.gap;
}

const norm = (text: string) => text.toUpperCase();

/** pixel width of `text` (excluding outline/shadow overhang) */
export function textWidth(text: string, style: TextStyle = {}): number {
  const f = fontOf(style);
  const mono = style.mono ?? !style.big;
  const s = style.scale ?? 1;
  let w = 0;
  for (const ch of norm(text)) w += advance(f, ch, mono);
  if (!mono && text.length) w -= f.gap; // no trailing gap
  return w * s;
}

/**
 * Draw `text` with its top-left at (x, y) (or centered/right-aligned on x).
 * Positions are floored so glyphs always land on whole pixels.
 */
export function drawText(g: CanvasRenderingContext2D, text: string, x: number, y: number, style: TextStyle = {}): number {
  const f = fontOf(style);
  const mono = style.mono ?? !style.big;
  const s = Math.max(1, Math.round(style.scale ?? 1));
  const t = norm(text);
  const w = textWidth(t, style);
  let px = Math.floor(style.align === 'center' ? x - w / 2 : style.align === 'right' ? x - w : x);
  const py = Math.floor(y);
  const fill = style.grad ?? [style.color ?? '#f8f8f8'];
  const shadow = style.shadow === undefined ? (style.big || style.outline ? null : '#000818') : style.shadow;
  const layers: [Layer, readonly string[]][] = [];
  if (shadow) layers.push([style.outline ? 'shadowOutline' : 'shadow', [shadow]]);
  if (style.outline) layers.push(['outline', [style.outline]]);
  layers.push(['fill', fill]);
  const CW = cellW(f);
  const CH = cellH(f);
  g.imageSmoothingEnabled = false;
  // layer-major so no glyph's outline ever covers its neighbour's fill
  for (const [layer, cols] of layers) {
    const a = atlas(f, layer, cols);
    let cx = px;
    for (const ch of t) {
      const i = f.index.get(ch);
      if (i !== undefined && ch !== ' ') g.drawImage(a, i * CW, 0, CW, CH, cx - s, py - s, CW * s, CH * s);
      cx += advance(f, ch, mono) * s;
    }
  }
  return w;
}

/** pen advance after `ch` (scaled), matching drawText's layout */
export function charAdvance(ch: string, style: TextStyle = {}): number {
  const f = fontOf(style);
  return advance(f, ch.toUpperCase(), style.mono ?? !style.big) * (style.scale ?? 1);
}
