#!/usr/bin/env node
// Headless playtest harness. Starts its own Vite dev server on a free port,
// opens the game in headless Chromium (never shows a window), optionally
// drives the keyboard, and saves screenshots + a state dump.
//
// Usage:
//   node tools/playtest.mjs [--params "autoplay=1&speed=4"] [--seconds 10]
//        [--shots 1,3,6] [--keys keys.json] [--out tools/out/run1] [--eval "js"]
//
//   --shots   seconds (wall clock since load) at which to screenshot.
//             Each shot is saved as shot-<t>.png (256x224 native) and
//             shot-<t>-x3.png (3x nearest-neighbor, easier to inspect).
//   --keys    JSON file: [{"t":1.0,"key":"ArrowUp","action":"down"}, {"t":1.5,"key":"ArrowUp","action":"up"},
//                         {"t":2.0,"key":"KeyZ","action":"press"} ...]   (t = seconds since load)
//   --page    path to load instead of the game, e.g. /tools/art-preview.html
//             (if the page has no window.__airfriend, shots are full-page
//             screenshots saved as shot-<t>.png)
//   --eval    JS expression evaluated in the page at the end; result printed as JSON
//             (window.__airfriend.state is the live GameState)
//
// Prints: console errors/warnings, page errors, and a final state summary.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const params = opt('params', '');
const seconds = Number(opt('seconds', '6'));
const shots = (opt('shots', '') || '').split(',').filter(Boolean).map(Number);
const keysFile = opt('keys', '');
const evalExpr = opt('eval', '');
const pagePath = opt('page', '/');
const out = opt('out', path.join('tools/out', `run-${process.pid}`));
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } }); // hmr off: other edits must not reload the page mid-run
await server.listen();
const addr = server.httpServer.address();
const url = `http://127.0.0.1:${addr.port}${pagePath}?${params}`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[console.${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
const isGame = pagePath === '/' || pagePath === '/index.html';
if (isGame) await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 15000 }).catch(() => logs.push('[harness] __airfriend never appeared'));

const keys = keysFile ? JSON.parse(fs.readFileSync(keysFile, 'utf8')) : [];
const timeline = [
  ...keys.map((k) => ({ t: k.t, kind: 'key', k })),
  ...shots.map((t) => ({ t, kind: 'shot' })),
].sort((a, b) => a.t - b.t);

async function shot(t) {
  const tag0 = String(t).replace('.', '_');
  if (!(await page.evaluate(() => !!window.__airfriend).catch(() => false))) {
    await page.screenshot({ path: path.join(out, `shot-${tag0}.png`), fullPage: true });
    return;
  }
  const data = await page.evaluate(() => {
    const src = new Image();
    return new Promise((res) => {
      src.onload = () => {
        const c = document.createElement('canvas');
        c.width = 768;
        c.height = 672;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(src, 0, 0, 768, 672);
        res({ native: src.src, x3: c.toDataURL('image/png') });
      };
      src.src = window.__airfriend.capture();
    });
  }).catch((e) => (logs.push(`[harness] capture failed: ${e.message}`), null));
  if (!data) return;
  const tag = String(t).replace('.', '_');
  fs.writeFileSync(path.join(out, `shot-${tag}.png`), Buffer.from(data.native.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(out, `shot-${tag}-x3.png`), Buffer.from(data.x3.split(',')[1], 'base64'));
}

for (const ev of timeline) {
  const wait = ev.t * 1000 - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  if (ev.kind === 'shot') await shot(ev.t);
  else if (ev.k.action === 'down') await page.keyboard.down(ev.k.key);
  else if (ev.k.action === 'up') await page.keyboard.up(ev.k.key);
  else await page.keyboard.press(ev.k.key, { delay: ev.k.hold ? ev.k.hold * 1000 : 30 });
}
const remain = seconds * 1000 - (Date.now() - t0);
if (remain > 0) await page.waitForTimeout(remain);

const summary = await page
  .evaluate(() => {
    const s = window.__airfriend?.state;
    if (!s) return null;
    return {
      phase: s.phase,
      period: s.period,
      clock: +s.clock.toFixed(1),
      score: s.score,
      shots: s.shots,
      hits: s.hits,
      penalties: s.penalties.length,
      goals: s.goals.length,
      tick: s.tick,
      puck: { x: +s.puck.pos.x.toFixed(2), z: +s.puck.pos.z.toFixed(2), owner: s.puck.owner },
      nan: s.skaters.some((k) => !Number.isFinite(k.pos.x) || !Number.isFinite(k.pos.z)) || !Number.isFinite(s.puck.pos.x),
    };
  })
  .catch((e) => ({ error: e.message }));
let evalResult;
if (evalExpr) evalResult = await page.evaluate(evalExpr).catch((e) => `eval error: ${e.message}`);

console.log(`URL: ${url}`);
console.log(`OUT: ${out}`);
console.log(logs.length ? logs.join('\n') : '[no console errors]');
console.log('STATE:', JSON.stringify(summary));
if (evalExpr) console.log('EVAL:', JSON.stringify(evalResult, null, 1));
await browser.close();
await server.close();
