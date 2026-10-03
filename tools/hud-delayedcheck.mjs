#!/usr/bin/env node
// DELAYED PENALTY chip check through the REAL loop: forces the next body
// check to be called (RULES penalty chance maxed in the page), fast-forwards
// to the moment the sim raises state.delayedPenalty, then watches frame by
// frame until the whistle, comparing what the sim says with where the HUD
// drew the chip (hud.delayedBox).
//
//   node tools/hud-delayedcheck.mjs [--out tools/out/hud-delayed] [--max 240]
//
// Before the gameplay lane's delayed penalties exist (no `delayedPenalty`
// field on the state) the tool stages one itself for 3 s of sim time, so the
// HUD side can still be checked in the real loop; it says so in its output.
//
// Checks: the chip is up on every play/stoppage frame of the delayed penalty,
// never over the score bug (y >= 27 once popped out), stacked under a PP
// strip when one is up (y >= 43), and gone once the call is made.
// Shots: <out>/<sim-time>-<label>.png (+ -x3.png). Exits 1 on a problem.
// Headless Chromium only; no window is ever shown.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const out = opt('out', 'tools/out/hud-delayed');
const maxSim = Number(opt('max', '240')); // sim seconds to wait for a call
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// no HMR / file watching: other edits in the tree must not reload the page mid-run
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/?autoplay=1&mute=1&speed=1`);
await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 30000 });

const res = await page.evaluate(async (maxSim) => {
  const A = window.__airfriend;
  const { RULES } = await import('/src/config.ts');
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  // every check that lands is called (the roll caps at 0.95)
  RULES.penaltyForceMin = 0;
  RULES.penaltyMaxChance = 1;
  RULES.penaltyCurve = 0.01;
  const landed = 'delayedPenalty' in A.state;
  const dp = () => A.state.delayedPenalty ?? null;
  // past the intro and the opening faceoff
  for (let i = 0; i < 4000 && A.state.phase !== 'play'; i++) A.step(4), await frame();
  let staged = false;
  if (landed) {
    // fast-forward (unrendered) until the sim holds a call; a call made on
    // the spot (no delay) is fine, keep going
    const t0 = A.state.time;
    while (!dp() && A.state.time - t0 < maxSim && A.state.phase !== 'gameOver') {
      A.step(6);
      if (A.state.phase === 'intermission') A.step(600);
      await frame();
    }
    if (!dp()) return { landed, error: `no delayed penalty in ${maxSim} s of sim time` };
  } else {
    // stage one: BLZ #44 fouled, play goes on
    staged = true;
    A.state.delayedPenalty = { team: 1, skaterId: 7, t: A.state.time };
  }
  const start = A.state.time;
  const d0 = { ...dp() };
  const samples = [];
  const shots = [];
  const marks = [0, 0.1, 0.25, 0.6, 1.2, 2.0, 2.8];
  let mk = 0;
  let cleared = null;
  let after = 0;
  for (let i = 0; i < 6000; i++) {
    // the staged "call": clear the field the way the sim will at the whistle
    if (staged && A.state.time - start >= 3) A.state.delayedPenalty = null;
    await frame();
    const s = A.state;
    const t = s.time - start;
    const up = !!dp() && (s.phase === 'play' || s.phase === 'stoppage');
    const box = A.hud.delayedBox ? { ...A.hud.delayedBox } : null;
    samples.push({ t: +t.toFixed(3), phase: s.phase, up, box, pens: s.penalties.length });
    let label = null;
    if (mk < marks.length && t >= marks[mk]) {
      while (mk < marks.length && t >= marks[mk]) mk++;
      label = `chip-${t.toFixed(2)}`;
    }
    if (!dp() && cleared === null) {
      cleared = t;
      label = `cleared-${s.phase}`;
    }
    if (cleared !== null && t - cleared >= 0.4 && !after) {
      after = 1;
      label = `after-${s.phase}`;
    }
    if (label) shots.push({ label, t: +s.time.toFixed(2), raw: A.capture() });
    if (after) break;
  }
  return { landed, staged, d0, samples, shots };
}, maxSim);

let bad = 0;
if (res.error) {
  console.log(`FAIL: ${res.error} (gameplay field present: ${res.landed})`);
  bad++;
} else {
  console.log(
    res.staged
      ? 'NOTE: state.delayedPenalty does not exist yet (gameplay lane not landed): staged one for 3 s'
      : `sim raised a delayed penalty on team ${res.d0.team} (skater ${res.d0.skaterId})`,
  );
  let upFrames = 0;
  for (const s of res.samples) {
    const b = s.box;
    let why = '';
    if (s.up && !b) why = 'chip missing';
    else if (!s.up && b) why = 'chip shown without a delayed penalty';
    else if (b && s.t > 0.2 && b.y < 27) why = `chip over the score bug (y ${b.y})`;
    else if (b && s.t > 0.4 && s.pens > 0 && b.y < 43) why = `chip not under the PP strip (y ${b.y})`;
    if (s.up) upFrames++;
    if (why) {
      bad++;
      if (bad < 12) console.log(`  t=${s.t.toFixed(2)} ${s.phase}: ${why}`);
    }
  }
  const last = res.samples[res.samples.length - 1];
  const upFor = res.samples.filter((s) => s.up).pop()?.t ?? 0;
  console.log(`  chip up ${upFrames} frames (~${upFor.toFixed(2)} s), ended in phase '${last.phase}', ${res.samples.length} frames sampled`);
  for (const s of res.shots) {
    const name = `${s.t.toFixed(2)}-${s.label}`;
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(s.raw.split(',')[1], 'base64'));
  }
  // x3 copies (nearest) through the browser, like the other harnesses
  for (const s of res.shots) {
    const x3 = await page.evaluate(async (raw) => {
      const img = new Image();
      await new Promise((r) => ((img.onload = r), (img.src = raw)));
      const c = document.createElement('canvas');
      c.width = 768;
      c.height = 672;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, 768, 672);
      return c.toDataURL('image/png');
    }, s.raw);
    fs.writeFileSync(path.join(out, `${s.t.toFixed(2)}-${s.label}-x3.png`), Buffer.from(x3.split(',')[1], 'base64'));
  }
}
console.log(logs.length ? logs.join('\n') : '[no page errors]');
console.log(bad ? `FAIL: ${bad} problem(s)` : 'PASS: the DELAYED PENALTY chip followed the sim and kept clear of the score bug / PP strip');
await browser.close();
await server.close();
process.exit(bad ? 1 : 0);
