#!/usr/bin/env node
// Pixel-exact presentation check for src/core/display.ts, in headless Chromium
// at several devicePixelRatios (never shows a window). For each viewport:
//   place   the 4:3 box sits on whole device pixels, at the computed size
//   rows    a 1-px alternating-row test pattern (painted over the HUD canvas)
//           maps every source row to the same whole number of device rows,
//           with no blended rows (row-run histogram has one value)
//   cols    a 1-px alternating-column pattern: one pure run per source
//           column, and each column's edge lands within 0.25 device px of
//           where an exact 8:7 stretch puts it (sharp bilinear: only the
//           fractional seam blends; plain nearest would be off by up to 0.5)
//   crt     on a flat grey frame the CRT overlay repeats the same bright/dark
//           device-row pattern for every source row (no moiré)
//   game    a real frame (and one with CRT on) is saved for a visual check
// It also changes the DPR live (CDP) to prove the matchMedia re-fit, and
// checks capture() still returns the native 256x224 frame.
// Exits non-zero if any check fails.
//
// Usage: node tools/integ-dpr.mjs [--out tools/out/integ-dpr]

import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.resolve(root, outArg >= 0 ? args[outArg + 1] : 'tools/out/integ-dpr');
fs.mkdirSync(out, { recursive: true });

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const { port } = server.httpServer.address();
const GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ headless: true, args: GL });

/**
 * 'real': a browser started at that device scale factor (what 125% Windows
 * scaling or a HiDPI panel gives). 'emu': Playwright's DevTools-style
 * emulation, which renders at the ratio but reports CSS px as the
 * device-pixel-content-box; both must come out exact.
 */
async function openPage(dpr, vw, vh, mode) {
  if (mode === 'emu') {
    const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
    return { page, close: () => page.close() };
  }
  const b = await chromium.launch({ headless: true, args: [...GL, `--force-device-scale-factor=${dpr}`, `--window-size=${vw},${vh}`] });
  const page = await b.newPage({ viewport: null });
  return { page, close: () => b.close() };
}

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
}

const CONFIGS = [
  [1, 1280, 800],
  [1.25, 1280, 800],
  [1.5, 1280, 720],
  [1, 1280, 777],
  [1.5, 1366, 768],
  [1.75, 1100, 700],
  [2, 1280, 800],
  [1.25, 1920, 1080],
  [1, 420, 330], // 1x: no room for scanlines
  [1.25, 1280, 800, 'emu'],
  [1.5, 1366, 768, 'emu'],
];

/** paint a test pattern over the HUD canvas after each HUD draw; counts frames */
const installPattern = () => {
  const af = window.__airfriend;
  const hud = af.hud;
  const draw = hud.draw.bind(hud);
  window.__pat = null;
  window.__frames = 0;
  hud.draw = (...a) => {
    draw(...a);
    window.__frames++;
    const mode = window.__pat;
    if (!mode) return;
    const g = hud.canvas.getContext('2d');
    const { width: W, height: H } = hud.canvas;
    if (mode === 'flat') {
      g.fillStyle = 'rgb(160,160,160)';
      g.fillRect(0, 0, W, H);
      return;
    }
    for (let i = 0; i < (mode === 'rows' ? H : W); i++) {
      g.fillStyle = i % 2 ? 'rgb(0,0,255)' : 'rgb(255,0,0)';
      if (mode === 'rows') g.fillRect(0, i, W, 1);
      else g.fillRect(i, 0, 1, H);
    }
  };
};

async function frames(page, n = 3) {
  const f0 = await page.evaluate(() => window.__frames);
  await page.waitForFunction((t) => window.__frames >= t, f0 + n, { timeout: 15000 });
}

/** screenshot (device pixels) -> analysis run in the page */
async function analyse(page, mode, fit) {
  const png = await page.screenshot();
  return page.evaluate(
    async ({ b64, mode, fit }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = (x, y) => g.getImageData(x, y, 1, 1).data;
      const row = (y) => g.getImageData(0, y, bmp.width, 1).data;
      const col = (x) => g.getImageData(x, 0, 1, bmp.height).data;
      const { devLeft: L, devTop: T, devW: W, devH: H } = fit;
      const res = { size: [bmp.width, bmp.height] };
      const black = (p) => p[0] + p[1] + p[2] < 12;
      // box edges: black just outside, picture just inside (where there is an outside)
      const mx = L + (W >> 1), my = T + (H >> 1);
      res.edges = {
        top: T === 0 || black(px(mx, T - 1)),
        bottom: T + H >= bmp.height || black(px(mx, T + H)),
        left: L === 0 || black(px(L - 1, my)),
        right: L + W >= bmp.width || black(px(L + W, my)),
        insideTop: !black(px(mx, T)),
        insideBottom: !black(px(mx, T + H - 1)),
        insideLeft: !black(px(L, my)),
        insideRight: !black(px(L + W - 1, my)),
      };
      const cls = (r, gg, b) => (r > 250 && gg < 5 && b < 5 ? 'A' : r < 5 && gg < 5 && b > 250 ? 'B' : '~');
      if (mode === 'rows') {
        // a few columns across the box (left edge, middle, right edge)
        res.cols = [L + 2, mx, L + W - 3].map((x) => {
          const d = col(x);
          const runs = [];
          let blended = 0;
          for (let y = T; y < T + H; y++) {
            const k = cls(d[y * 4], d[y * 4 + 1], d[y * 4 + 2]);
            if (k === '~') blended++;
            if (runs.length && runs[runs.length - 1].k === k) runs[runs.length - 1].n++;
            else runs.push({ k, n: 1 });
          }
          const hist = {};
          for (const r of runs) if (r.k !== '~') hist[r.n] = (hist[r.n] || 0) + 1;
          return { x, runs: runs.length, blended, hist, firstRun: runs[0]?.k };
        });
      } else if (mode === 'cols') {
        res.rows = [T + 2, my, T + H - 3].map((y) => {
          const d = row(y);
          // red weight per device column; edge position = where coverage crosses 50%
          const runs = [];
          const edges = [];
          let prevPure = null;
          let acc = 0; // fractional coverage of the outgoing colour over the blend
          let blendStart = -1;
          for (let x = L; x < L + W; x++) {
            const r = d[x * 4], b = d[x * 4 + 2];
            const k = cls(r, d[x * 4 + 1], b);
            if (k === '~') {
              if (blendStart < 0) {
                blendStart = x;
                acc = 0;
              }
              const wA = r / (r + b || 1);
              acc += prevPure === 'A' ? wA : 1 - wA;
              continue;
            }
            if (prevPure && k !== prevPure) edges.push((blendStart >= 0 ? blendStart : x) + acc - L);
            if (prevPure && k === prevPure && blendStart >= 0) edges.push(NaN); // blend inside a run: lost column
            if (runs.length && runs[runs.length - 1].k === k && blendStart < 0) runs[runs.length - 1].n++;
            else runs.push({ k, n: 1 });
            prevPure = k;
            blendStart = -1;
            acc = 0;
          }
          const f = W / 256;
          let worst = 0;
          edges.forEach((e, i) => {
            worst = Math.max(worst, Number.isNaN(e) ? 99 : Math.abs(e - (i + 1) * f));
          });
          const pure = runs.map((r) => r.n);
          return { y, pureRuns: runs.length, edges: edges.length, worstEdgeErr: +worst.toFixed(3), pureMin: Math.min(...pure), pureMax: Math.max(...pure) };
        });
      } else if (mode === 'crt') {
        const d = col(mx);
        const lum = [];
        for (let y = T; y < T + H; y++) lum.push(d[y * 4]);
        const s = H / 224;
        const base = lum.slice(0, s);
        let mismatches = 0;
        for (let y = 0; y < H; y++) if (Math.abs(lum[y] - base[y % s]) > 2) mismatches++;
        res.crt = { pattern: base, mismatches, distinct: [...new Set(lum)].length };
      }
      return res;
    },
    { b64: png.toString('base64'), mode, fit },
  );
}

for (const [dpr, vw, vh, mode = 'real'] of CONFIGS) {
  const tag = `dpr-${dpr}-${vw}x${vh}${mode === 'emu' ? '-emu' : ''}`;
  console.log(`\n== ${tag}`);
  const { page, close } = await openPage(dpr, vw, vh, mode);
  const inner = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  if (inner[0] !== vw || inner[1] !== vh || inner[2] !== dpr) console.log(`   (viewport came out ${inner.join(' x ')})`);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?mute=1`);
  await page.waitForFunction(() => !!window.__airfriend);
  await page.evaluate(installPattern);
  await frames(page, 30);

  const info = await page.evaluate(() => {
    const d = document.querySelector('#screen canvas.display');
    const b = d.getBoundingClientRect();
    const sb = document.getElementById('screen').getBoundingClientRect();
    return { screen: [sb.left, sb.top, sb.width, sb.height], fit: window.__airfriend.display.fitInfo, rect: [b.left, b.top, b.width, b.height], dpr: devicePixelRatio, canvas: [d.width, d.height], pre: window.__airfriend.display.prescaleSize };
  });
  const { fit } = info;
  const [iw, ih] = inner;
  const devView = [Math.round(iw * dpr), Math.round(ih * dpr)];
  console.log(`   fit ${JSON.stringify(fit)}`);
  check(`${tag} scale is floor(min(H*dpr/224, W*dpr*3/4/224))`, fit.scale === Math.floor(Math.min((ih * dpr) / 224, (iw * dpr * 0.75) / 224) + 1e-6), `scale ${fit.scale}`);
  check(`${tag} display canvas covers the viewport 1:1 in device px`, info.rect[0] === 0 && info.rect[1] === 0 && info.canvas[0] === devView[0] && info.canvas[1] === devView[1], `canvas ${info.canvas}, viewport ${devView}`);
  check(`${tag} picture is a whole number of device rows per source row`, fit.devH === 224 * fit.scale && fit.devW === Math.round((224 * fit.scale * 4) / 3), `${fit.devW}x${fit.devH} at ${fit.devLeft},${fit.devTop}`);
  const sDev = info.screen.map((v) => v * dpr);
  check(`${tag} #screen keeps the picture rect (for tools that measure it)`, [fit.devLeft, fit.devTop, fit.devW, fit.devH].every((v, i) => Math.abs(v - sDev[i]) <= 1), sDev.map((v) => +v.toFixed(2)).join(','));
  check(`${tag} prescale canvas is an integer multiple`, info.pre[0] === 256 * fit.preX && info.pre[1] === 224 * fit.scale, `${info.pre}`);

  await page.evaluate(() => (window.__pat = 'rows'));
  await frames(page);
  const rows = await analyse(page, 'rows', fit);
  const ed = rows.edges;
  check(`${tag} box edges exact (black outside, picture inside)`, Object.values(ed).every(Boolean), JSON.stringify(ed));
  for (const c of rows.cols) {
    const keys = Object.keys(c.hist);
    check(`${tag} rows @x=${c.x}: 224 runs of ${fit.scale} device rows, none blended`, c.runs === 224 && c.blended === 0 && keys.length === 1 && +keys[0] === fit.scale, `runs ${c.runs}, blended ${c.blended}, hist ${JSON.stringify(c.hist)}`);
  }

  await page.evaluate(() => (window.__pat = 'cols'));
  await frames(page);
  const cols = await analyse(page, 'cols', fit);
  for (const r of cols.rows) {
    if (fit.scale < 2) {
      // 1x: the prescale is 1, so 256 -> 299 is plain bilinear and a 1-px
      // alternating pattern is mostly seam; nothing sharper exists at that size
      console.log(`info  ${tag} cols @y=${r.y} at 1x: pure runs ${r.pureRuns}, edges ${r.edges} (not checked)`);
      continue;
    }
    check(`${tag} cols @y=${r.y}: 256 columns, edges within 0.25 px of exact 8:7`, r.pureRuns === 256 && r.edges === 255 && r.worstEdgeErr <= 0.25, `pure runs ${r.pureRuns} (${r.pureMin}-${r.pureMax} px), edges ${r.edges}, worst err ${r.worstEdgeErr}`);
  }

  await page.evaluate(() => {
    window.__pat = 'flat';
    document.getElementById('screen').classList.add('crt');
  });
  await frames(page);
  const crt = await analyse(page, 'crt', fit);
  const s = fit.scale;
  const want = s >= 2 ? 'bright rows then dark rows' : 'clear (no room at 1x)';
  const patOk = s >= 2 ? crt.crt.pattern[0] > crt.crt.pattern[s - 1] && crt.crt.distinct === 2 : crt.crt.distinct === 1;
  check(`${tag} CRT scanlines repeat every ${s} device rows (${want})`, crt.crt.mismatches === 0 && patOk, `pattern ${crt.crt.pattern.join('/')}, mismatches ${crt.crt.mismatches}`);

  // real frames for the eye: crop of the box, CRT off and on
  await page.evaluate(() => (window.__pat = null));
  await frames(page);
  const clip = { x: fit.devLeft / dpr, y: fit.devTop / dpr, width: fit.devW / dpr, height: fit.devH / dpr };
  await page.screenshot({ path: path.join(out, `${tag}-crt.png`), clip });
  await page.evaluate(() => document.getElementById('screen').classList.remove('crt'));
  await frames(page);
  await page.screenshot({ path: path.join(out, `${tag}.png`), clip });

  check(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
  await close();
}

// live DPR change (zoom / dragging to another monitor) re-fits: resize, matchMedia,
// device-pixel-content-box or, failing all three (DevTools emulation), present()'s own check
{
  console.log('\n== live DPR change');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/?mute=1`);
  await page.waitForFunction(() => !!window.__airfriend);
  const before = await page.evaluate(() => window.__airfriend.display.fitInfo);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1.5, mobile: false });
  await page.waitForFunction(() => window.__airfriend.display.fitInfo.dpr === 1.5, null, { timeout: 5000 }).catch(() => {});
  const after = await page.evaluate(() => window.__airfriend.display.fitInfo);
  check('DPR 1 -> 1.5 re-fits', before.scale === 3 && after.dpr === 1.5 && after.scale === 5, `scale ${before.scale} -> ${after.scale}, dpr ${after.dpr}`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1.25, mobile: false });
  await page.waitForFunction(() => window.__airfriend.display.fitInfo.dpr === 1.25, null, { timeout: 5000 }).catch(() => {});
  const again = await page.evaluate(() => window.__airfriend.display.fitInfo);
  check('DPR 1.5 -> 1.25 re-fits (listener re-armed)', again.dpr === 1.25 && again.scale === 4, `scale ${again.scale}, dpr ${again.dpr}`);
  // the test hook still hands out the native framebuffer
  const cap = await page.evaluate(
    () =>
      new Promise((res) => {
        const i = new Image();
        i.onload = () => res([i.width, i.height]);
        i.src = window.__airfriend.capture();
      }),
  );
  check('capture() is still the 256x224 frame', cap[0] === 256 && cap[1] === 224, cap.join('x'));
  await page.close();
}

await browser.close();
await server.close();
console.log(`\nOUT: ${out}`);
console.log(failures.length ? `${failures.length} FAILED:\n  ${failures.join('\n  ')}` : 'ALL PASS');
process.exit(failures.length ? 1 : 0);
