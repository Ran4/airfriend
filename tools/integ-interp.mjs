#!/usr/bin/env node
// Render-interpolation check for the real loop (src/main.ts + src/core/loop.ts).
// Boots the game in headless Chromium (never shows a window), gets to live
// play, then records every frame for a few seconds:
//   prev  = drawn positions at the start of the last sim step (input.poll runs
//           right before the snapshot),
//   drawn = what renderer.render saw, hud = what hud.draw saw,
//   after = the state right after the draw (audio.update runs after restore).
// Checks: render and HUD saw the same lerped positions; every object is at
// lerp(prev, after, alpha) with one alpha in [0,1] per frame (or at `after`
// after a >3 m teleport); `after` differs from `drawn` in most frames (so
// restore really put values back); the next step starts from exactly `after`;
// and all of that still holds while renderer.render throws every third frame.
// The bit-for-bit / determinism proof is the node test tools/integ-loop.ts.
//
// Usage: node tools/integ-interp.mjs [--speed 1] [--hz 60] [--seconds 4] [--out dir]
//   --hz 144 rescales rAF timestamps so the loop sees 144 Hz frame times.
// Exits non-zero on failure.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const speed = Number(opt('speed', '1'));
const seconds = Number(opt('seconds', '4'));
// emulate a display refresh rate: headless Chromium ticks rAF at 60 Hz, so
// rAF timestamps are rescaled to hand the loop the frame times of an `hz` panel
const hz = Number(opt('hz', '60'));
const out = opt('out', '');
if (out) fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

const page = await browser.newPage();
if (hz !== 60) {
  await page.addInitScript((scale) => {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => cb(t * scale));
  }, 60 / hz);
}
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/?autoplay=1&speed=${speed}&mute=1`);
await page.waitForFunction(() => !!window.__airfriend);
// skip the intro + opening faceoff with immediate steps
await page.evaluate(() => {
  const af = window.__airfriend;
  for (let i = 0; i < 3000 && af.state.phase !== 'play'; i++) af.step(1);
  af.step(30);
});

async function record(throwEvery) {
  await page.evaluate((throwEvery) => {
    const af = window.__airfriend;
    const pos = (s) => {
      const a = [];
      for (const k of s.skaters) a.push(k.pos.x, k.pos.z);
      a.push(s.puck.pos.x, s.puck.pos.z, s.puck.y, s.referee.pos.x, s.referee.pos.z);
      return a;
    };
    const rec = (window.__rec = { frames: [], tickStarts: [] });
    let prev = null;
    let cur = null;
    let n = 0;
    const wrap = (obj, m, fn) => {
      const orig = (obj[`__orig_${m}`] ??= obj[m].bind(obj));
      obj[m] = (...a) => fn(orig, ...a);
    };
    wrap(af.input, 'poll', (orig) => {
      prev = pos(af.state);
      rec.tickStarts.push({ tick: af.state.tick, pos: prev });
      return orig();
    });
    wrap(af.renderer, 'render', (orig, s, dt) => {
      cur = { tick: s.tick, prev, drawn: pos(s), hud: null };
      if (throwEvery && ++n % throwEvery === 0) throw new Error('simulated render exception');
      return orig(s, dt);
    });
    wrap(af.hud, 'draw', (orig, s, ...a) => {
      if (cur) cur.hud = pos(s);
      return orig(s, ...a);
    });
    wrap(af.audio, 'update', (orig, s, dt) => {
      if (cur) rec.frames.push({ ...cur, after: pos(s) });
      cur = null;
      return orig(s, dt);
    });
  }, throwEvery);
  await page.waitForTimeout(seconds * 1000);
  return page.evaluate(() => {
    const r = window.__rec;
    window.__rec = { frames: [], tickStarts: [] };
    return r;
  });
}

const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function analyse(label, rec) {
  const frames = rec.frames.filter((f) => f.prev);
  let lerped = 0;
  let hudMismatch = 0;
  let model = 0;
  let teleports = 0;
  let alphas = [];
  for (const f of frames) {
    if (!f.hud || !same(f.hud, f.drawn)) hudMismatch++;
    if (!same(f.drawn, f.after)) lerped++;
    const n = (f.drawn.length - 5) / 2;
    const groups = [];
    for (let k = 0; k < n; k++) groups.push([2 * k, 2 * k + 1]);
    groups.push([2 * n, 2 * n + 1, 2 * n + 2], [2 * n + 3, 2 * n + 4]);
    let alpha = null;
    let ok = true;
    for (const g of groups) {
      const d2 = g.reduce((s, i) => s + (f.after[i] - f.prev[i]) ** 2, 0);
      if (d2 > 9) {
        teleports++;
        if (!g.every((i) => Object.is(f.drawn[i], f.after[i]))) ok = false;
        continue;
      }
      for (const i of g) {
        const d = f.after[i] - f.prev[i];
        if (Math.abs(d) < 0.01) {
          // barely moving: just has to sit between the two
          if (f.drawn[i] < Math.min(f.prev[i], f.after[i]) - 1e-9 || f.drawn[i] > Math.max(f.prev[i], f.after[i]) + 1e-9) ok = false;
          continue;
        }
        const a = (f.drawn[i] - f.prev[i]) / d;
        if (alpha === null) alpha = a;
        else if (Math.abs(a - alpha) > 1e-6) ok = false;
      }
    }
    if (alpha !== null && (alpha < -1e-9 || alpha > 1 + 1e-9)) ok = false;
    if (alpha !== null) alphas.push(alpha);
    if (!ok) model++;
  }
  // the sim starts every step from the restored values: each tick start
  // equals the `after` of the last frame drawn before it
  let startBad = 0;
  let startChecked = 0;
  for (const t of rec.tickStarts) {
    const f = [...rec.frames].reverse().find((fr) => fr.tick === t.tick);
    if (!f) continue;
    startChecked++;
    if (!same(f.after, t.pos)) startBad++;
  }
  alphas.sort((a, b) => a - b);
  const q = (p) => (alphas.length ? alphas[Math.floor(p * (alphas.length - 1))].toFixed(3) : '-');
  console.log(`-- ${label}: ${frames.length} frames, ${lerped} lerped, ${teleports} teleports; alpha min/p50/max ${q(0)}/${q(0.5)}/${q(1)}`);
  check(frames.length >= 20, `${label}: enough frames recorded (${frames.length})`);
  check(lerped >= frames.length * 0.5, `${label}: most frames draw between ticks (${lerped}/${frames.length})`);
  check(hudMismatch === 0, `${label}: hud.draw saw the same positions as renderer.render (${hudMismatch} bad)`);
  check(model === 0, `${label}: drawn = lerp(prev, cur, alpha), one alpha per frame, teleports at cur (${model} bad)`);
  check(startChecked > 0 && startBad === 0, `${label}: each sim step starts from the restored positions (${startChecked} checked, ${startBad} bad)`);
}

analyse(`speed ${speed} @${hz} Hz`, await record(0));
if (out) {
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(700);
    const png = await page.evaluate(() => window.__airfriend.capture());
    fs.writeFileSync(path.join(out, `interp-${i}.png`), Buffer.from(png.split(',')[1], 'base64'));
  }
}
analyse(`speed ${speed} @${hz} Hz, render throws every 3rd frame`, await record(3));
const faults = await page.evaluate(() => window.__airfriend.faults());
check((faults.renderer?.count ?? 0) > 0, `render throws were caught (${faults.renderer?.count ?? 0})`);
check(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? ': ' + pageErrors[0] : ''}`);

await browser.close();
await server.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
