#!/usr/bin/env node
// Delayed penalty through the REAL loop, headless: once play is live, stages a
// foul by the Blizzard with the real sim function (delayPenalty) while the
// Pups carry, then screenshots the delay (ref pointing, play going on) and the
// call. Prints what the state says next to each shot.
//
//   node tools/sim-delayedshot.mjs [--out tools/out/sim-delayed]
//
// Shots: <out>/<label>.png and <label>-x3.png. Headless Chromium only.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const out = opt('out', 'tools/out/sim-delayed');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/?autoplay=1&mute=1&speed=1`);
await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 30000 });

const res = await page.evaluate(async () => {
  const A = window.__airfriend;
  const { delayPenalty } = await import('/src/sim/penalties.ts');
  const { RULES } = await import('/src/config.ts');
  // no real hit gets called during the run: only the staged foul
  RULES.penaltyMaxChance = 0;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const shots = [];
  const snap = async (label) => {
    for (let i = 0; i < 3; i++) await frame();
    const s = A.state;
    shots.push({ label, raw: A.capture(), info: { phase: s.phase, t: +s.time.toFixed(2), ref: s.referee.state, dp: s.delayedPenalty ?? null, owner: s.puck.owner, boxed7: s.skaters[7].state === 'box' } });
  };
  // live play with a Pups carrier
  for (let i = 0; i < 6000; i++) {
    const s = A.state;
    if (s.phase === 'play' && s.puck.owner !== null && s.skaters[s.puck.owner].team === 0 && s.puck.owner !== 4) break;
    A.step(1);
    if (i % 8 === 0) await frame();
  }
  await snap('before');
  const s = A.state;
  delayPenalty(s, { skaterId: 7, team: 1, infraction: 'ROUGHING', duration: RULES.minorLength, remaining: RULES.minorLength, major: false });
  await snap('delay-0.0');
  for (const t of [0.5, 1.0]) {
    for (let i = 0; i < 30; i++) A.step(1);
    if (A.state.phase !== 'play') break;
    await snap(`delay-${t.toFixed(1)}`);
  }
  // run on to the call
  for (let i = 0; i < 700 && A.state.phase === 'play'; i++) A.step(1);
  await snap('called');
  return shots;
});
for (const s of res) {
  fs.writeFileSync(path.join(out, `${s.label}.png`), Buffer.from(s.raw.split(',')[1], 'base64'));
  const x3 = await page.evaluate(async (raw) => {
    const img = new Image();
    img.src = raw;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width * 3;
    c.height = img.height * 3;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }, s.raw);
  fs.writeFileSync(path.join(out, `${s.label}-x3.png`), Buffer.from(x3.split(',')[1], 'base64'));
  console.log(s.label.padEnd(10), JSON.stringify(s.info));
}
console.log(errors.length ? `[page errors] ${errors.join(' | ')}` : '[no page errors]');
await browser.close();
await server.close();
