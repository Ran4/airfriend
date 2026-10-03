#!/usr/bin/env node
// RINK agent: screenshot the arena/camera for a list of posed scenarios via
// tools/rink-preview.html (headless Chromium, no window).
//   node tools/rink-shots.mjs [--out tools/out/rink/shots] [--only name1,name2] [--params "post=0"]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const out = opt('out', 'tools/out/rink/shots');
const only = (opt('only', '') || '').split(',').filter(Boolean);
const params = opt('params', '');
const evalExpr = opt('eval', '');
fs.mkdirSync(out, { recursive: true });

const F = { formation: true };
const SCENARIOS = [
  { name: 'center', puck: { x: 0, z: 0 }, ...F },
  { name: 'center-p2', puck: { x: 0, z: 0 }, period: 2, ...F },
  { name: 'faceoff', phase: 'faceoff', puck: { x: 0, z: 0 }, ...F },
  { name: 'attack-zone', puck: { x: 2, z: 20 }, ...F },
  { name: 'attack-net', puck: { x: 0, z: 27.5 }, ...F },
  { name: 'attack-corner-l', puck: { x: 11, z: 28 }, ...F },
  { name: 'attack-corner-r', puck: { x: -11, z: 28 }, ...F },
  { name: 'defend-zone', puck: { x: -3, z: -20 }, ...F },
  { name: 'defend-net', puck: { x: 0, z: -28.5 }, ...F },
  { name: 'defend-corner', puck: { x: -11, z: -28 }, ...F },
  { name: 'side-boards-l', puck: { x: 12.5, z: 2 }, ...F },
  { name: 'side-boards-r', puck: { x: -12.5, z: -4 }, ...F },
  { name: 'p2-attack-net', puck: { x: 1, z: -27 }, period: 2, ...F },
  { name: 'p2-defend-corner', puck: { x: 10, z: 28 }, period: 2, ...F },
  { name: 'intro-0', phase: 'intro', phaseTime: 0, snap: true },
  { name: 'intro-1', phase: 'intro', phaseTime: 1.2, snap: true },
  { name: 'intro-2', phase: 'intro', phaseTime: 2.2, snap: true },
  { name: 'intro-3', phase: 'intro', phaseTime: 3.1, snap: true },
  { name: 'box-p1', puck: { x: 12, z: 1 }, boxed: [7, 2], ...F },
  { name: 'box-p2', puck: { x: 12, z: -1 }, period: 2, boxed: [7, 2], ...F },
  { name: 'crowd-idle', puck: { x: 9, z: 26 }, bare: true },
  {
    name: 'crowd-cheer',
    phase: 'goal',
    phaseTime: 0,
    puck: { x: 9, z: 26 },
    bare: true,
    frames: 40,
    events: [{ type: 'goal', info: { team: 0, scorer: 0, assists: [], period: 1, clock: 60, powerPlay: false, shortHanded: false } }],
  },
  { name: 'bare-center', puck: { x: 0, z: 0 }, bare: true },
  { name: 'bare-net', puck: { x: 0, z: 25 }, bare: true },
  { name: 'bare-net-p2', puck: { x: 0, z: -25 }, period: 2, bare: true },
  { name: 'bare-boxes', puck: { x: 12, z: 0 }, bare: true },
  { name: 'bare-benches', puck: { x: -12, z: -6 }, bare: true },
  {
    name: 'goal',
    phase: 'goal',
    phaseTime: 0,
    puck: { x: 0.3, z: 27.0 },
    ...F,
    frames: 70,
    events: [{ type: 'goal', info: { team: 0, scorer: 0, assists: [], period: 1, clock: 60, powerPlay: false, shortHanded: false } }],
  },
];

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/tools/rink-preview.html?${params}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__rinkReady, null, { timeout: 20000 });

for (const sc of SCENARIOS) {
  if (only.length && !only.includes(sc.name)) continue;
  const t0 = Date.now();
  const data = await page.evaluate((s) => {
    window.__rink.show(s);
    const native = window.__rink.capture();
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 768;
        c.height = 672;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, 768, 672);
        res({ native, x3: c.toDataURL('image/png') });
      };
      img.src = native;
    });
  }, sc);
  fs.writeFileSync(path.join(out, `${sc.name}.png`), Buffer.from(data.native.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(out, `${sc.name}-x3.png`), Buffer.from(data.x3.split(',')[1], 'base64'));
  console.log(`${sc.name} (${Date.now() - t0} ms)`);
}
if (args.includes('--dyn')) {
  // motion tests: puck screen position over time (does the camera keep up?)
  const tests = [
    { name: 'slapshot center->net 30 m/s', start: { x: 0, z: 2 }, vel: { x: 0, z: 30 }, frames: 50 },
    { name: 'cross-ice pass 17 m/s', start: { x: 10, z: 10 }, vel: { x: -17, z: 0 }, frames: 70 },
    { name: 'breakout skate 9 m/s', start: { x: -2, z: -24 }, vel: { x: 0.5, z: 9 }, frames: 240 },
    { name: 'clear down ice p2 25 m/s', start: { x: 3, z: 20 }, vel: { x: -2, z: -25 }, frames: 80, period: 2 },
  ];
  for (const t of tests) {
    const res = await page.evaluate((t) => {
      window.__rink.show({ puck: t.start, period: t.period ?? 1, phase: 'play', snap: true, dog: { x: t.start.x, z: t.start.z } });
      const pts = [];
      for (let i = 0; i < t.frames; i++) {
        window.__rink.run(1, t.vel);
        // the dog chases the puck at a fixed lag
        const s = window.__rink.state;
        s.skaters[0].pos.x += (s.puck.pos.x - s.skaters[0].pos.x) * 0.05;
        s.skaters[0].pos.z += (s.puck.pos.z - s.skaters[0].pos.z) * 0.05;
        const p = window.__rink.project(s.puck.pos.x, 0, s.puck.pos.z);
        pts.push([+p.x.toFixed(0), +p.y.toFixed(0)]);
      }
      return pts;
    }, t);
    const xs = res.map((p) => p[0]);
    const ys = res.map((p) => p[1]);
    console.log(`${t.name}: x ${Math.min(...xs)}..${Math.max(...xs)}  y ${Math.min(...ys)}..${Math.max(...ys)}  every10: ${res.filter((_, i) => i % 10 === 0).map((p) => p.join(',')).join(' ')}`);
  }
}
if (args.includes('--ice')) {
  const url = await page.evaluate(() => window.__rink.iceTexture());
  fs.writeFileSync(path.join(out, 'ice-texture.png'), Buffer.from(url.split(',')[1], 'base64'));
  console.log('ice texture saved');
}
if (evalExpr) console.log('EVAL:', JSON.stringify(await page.evaluate(evalExpr), null, 1));
console.log(logs.length ? logs.join('\n') : '[no console errors]');
await browser.close();
await server.close();
