#!/usr/bin/env node
// Smoke-test the PRODUCTION build: serves dist/ with `vite preview` and runs
// it headless (no window), reporting errors and the phase.
//   npm run build && node tools/integ-dist.mjs [--out dir]
//
// Two page loads:
//   1. ?test=1&autoplay=1&speed=2 -- the test API is switched on by ?test=1
//      (a build has no import.meta.env.DEV), so the game can be read and must
//      be running: ticks advancing, autoplay honoured, no console errors.
//   2. ?autoplay=1&speed=32 without ?test -- a normal player's page: the game
//      must boot and draw, but window.__airfriend must not exist and the test
//      switches must be ignored.
// Exits non-zero if any check fails.
import { preview } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : '';
if (out) fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
  console.error('dist/ missing: run `npm run build` first');
  process.exit(1);
}
const server = await preview({ root, logLevel: 'error', preview: { port: 0, host: '127.0.0.1' } });
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const logs = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/${query}`);
  return { page, logs };
}

/** distinct colours in the visible composite: > a handful means the game is drawing */
const visibleColours = (page) =>
  page.evaluate(() => {
    const src = document.querySelector('canvas.display');
    if (!src || !src.width) return 0;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 96;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });

// 1. test mode on a build
{
  const { page, logs } = await open('?test=1&autoplay=1&speed=2');
  await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 15000 }).catch(() => {});
  const read = () =>
    page.evaluate(() => {
      const s = window.__airfriend?.state;
      return s && { phase: s.phase, tick: s.tick, clock: +s.clock.toFixed(1), autoplay: s.autoplay };
    });
  const a = await read();
  await page.waitForTimeout(8000);
  const st = await read();
  console.log('STATE', JSON.stringify(st));
  check('?test=1: window.__airfriend exposed', !!st);
  check('?test=1: sim advancing', !!(a && st && st.tick > a.tick + 60), `tick ${a?.tick} -> ${st?.tick}`);
  if (st && 'autoplay' in st && st.autoplay !== undefined) check('?test=1: autoplay honoured', st.autoplay === true);
  check('?test=1: no console errors', logs.length === 0, logs.join(' | '));
  if (out) await page.screenshot({ path: path.join(out, 'dist-test.png') });
  await page.close();
}

// 2. a player's page: same switches, no ?test
{
  const { page, logs } = await open('?autoplay=1&speed=32');
  await page.waitForTimeout(4000);
  const probe = await page.evaluate(() => ({
    api: typeof window.__airfriend,
    hasKey: '__airfriend' in window,
  }));
  const colours = await visibleColours(page);
  check('no ?test: window.__airfriend undefined', probe.api === 'undefined' && !probe.hasKey, JSON.stringify(probe));
  check('no ?test: game boots and draws', colours > 16, `${colours} colours on screen`);
  check('no ?test: no console errors', logs.length === 0, logs.join(' | '));
  if (out) await page.screenshot({ path: path.join(out, 'dist-player.png') });
  await page.close();
}

await browser.close();
await new Promise((r) => server.httpServer.close(r));
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
