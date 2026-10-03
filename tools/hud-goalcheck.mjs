#!/usr/bin/env node
// Goal-celebration layout check through the REAL loop and the REAL camera:
// stages a HOME goal (far net) and an AWAY goal (near net), then samples the
// goal phase, projecting the scored-on net (frame + crease + room above the
// crossbar for the lamp / sparkle) with renderer.worldToScreen and comparing
// it with where the HUD drew the GOAL!! banner (hud.goalBox).
//
//   node tools/hud-goalcheck.mjs [--out tools/out/hud-goal] [--team 0|1|both]
//
// Shots: <out>/<team>-<t>.png (+ -x3.png, with the net box outlined in
// magenta and the banner box in green). Exits 1 on any overlap.
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
const out = opt('out', 'tools/out/hud-goal');
const teamOpt = opt('team', 'both');
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// no HMR / file watching: other edits in the tree must not reload the page mid-run
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const logs = [];
let bad = 0;

for (const team of teamOpt === 'both' ? [0, 1] : [Number(teamOpt)]) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/?autoplay=1&mute=1&speed=1`);
  await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 30000 });
  const res = await page.evaluate(async (team) => {
    const A = window.__airfriend;
    const { RINK, GOAL } = await import('/src/config.ts');
    const { attackDir } = await import('/src/sim/rink.ts');
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const wait = async (f, maxFrames = 4000) => {
      for (let i = 0; i < maxFrames && !f(); i++) await frame();
    };
    // skip the intro + opening faceoff quickly
    A.setSpeed(8);
    await wait(() => A.state.phase === 'play');
    A.setSpeed(1);
    const s0 = A.state;
    const dir = attackDir(team, s0.period);
    // PAL shoots the HOME goal (portrait + PAWSOME! handoff), a kid the AWAY one
    const shooter = team === 0 ? 0 : 6;
    const keeper = s0.skaters.find((k) => k.kind === 'goalie' && k.team === 1 - team).id;
    // hold the puck in the slot so the camera settles like on a real chance
    const slot = { x: 0.6, z: dir * (RINK.goalLineZ - 6) };
    for (let i = 0; i < 90; i++) {
      const s = A.state;
      Object.assign(s.puck, { owner: null, pos: { ...slot }, vel: { x: 0, z: 0 }, y: 0, vy: 0, lastTouch: shooter, prevTouch: null });
      s.skaters[shooter].pos = { x: slot.x, z: slot.z - dir * 1.2 };
      s.skaters[keeper].pos = { x: 4, z: dir * (RINK.goalLineZ - 0.6) };
      await frame();
    }
    // shoot
    Object.assign(A.state.puck, { owner: null, pos: { ...slot }, vel: { x: -0.4, z: dir * 24 }, y: 0.1, vy: 0, lastTouch: shooter, pickupBlock: 0.5, blockId: shooter });
    A.state.skaters[keeper].pos = { x: 5, z: dir * (RINK.goalLineZ - 0.6) };
    await wait(() => A.state.phase === 'goal', 600);
    if (A.state.phase !== 'goal') return { error: `no goal (phase ${A.state.phase})` };
    const scored = A.state.goals[A.state.goals.length - 1]?.team;
    // the scored-on net: frame, crease in front, 1 m above the bar for the lamp/sparkle
    const gz = dir * RINK.goalLineZ;
    const pts = [];
    for (const x of [-RINK.creaseR, -GOAL.halfWidth, GOAL.halfWidth, RINK.creaseR])
      for (const z of [gz - dir * RINK.creaseR, gz, gz + dir * GOAL.depth])
        for (const y of [0, GOAL.height + 1]) pts.push([x, y, z]);
    const samples = [];
    const marks = [0.15, 0.35, 0.5, 0.7, 1.0, 1.3, 1.6, 1.7, 1.9, 2.2, 2.6, 3.2];
    let k = 0;
    while (A.state.phase === 'goal' && k < marks.length) {
      await frame();
      const t = A.state.phaseTime;
      if (t < marks[k]) continue;
      while (k < marks.length && t >= marks[k]) k++;
      const ps = pts.map(([x, y, z]) => A.renderer.worldToScreen(x, y, z));
      const net = {
        x: Math.min(...ps.map((p) => p.x)),
        y: Math.min(...ps.map((p) => p.y)),
        x2: Math.max(...ps.map((p) => p.x)),
        y2: Math.max(...ps.map((p) => p.y)),
      };
      const gb = A.hud.goalBox;
      const overlap = !!gb && gb.x < net.x2 && gb.x + gb.w > net.x && gb.y < net.y2 && gb.y + gb.h > net.y;
      // annotated x3 copy
      const img = new Image();
      const raw = A.capture();
      await new Promise((r) => ((img.onload = r), (img.src = raw)));
      const c = document.createElement('canvas');
      c.width = 768;
      c.height = 672;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, 768, 672);
      g.lineWidth = 2;
      g.strokeStyle = '#ff00ff';
      g.strokeRect(net.x * 3, net.y * 3, (net.x2 - net.x) * 3, (net.y2 - net.y) * 3);
      if (gb) {
        g.strokeStyle = '#00ff40';
        g.strokeRect(gb.x * 3, gb.y * 3, gb.w * 3, gb.h * 3);
      }
      samples.push({ t: +t.toFixed(2), net, goalBox: gb, overlap, raw, x3: c.toDataURL('image/png') });
    }
    return { scored, samples };
  }, team);
  if (res.error) {
    console.log(`team ${team}: ${res.error}`);
    bad++;
    await page.close();
    continue;
  }
  console.log(`team ${team} goal (scored by ${res.scored === 0 ? 'HOME' : 'AWAY'}):`);
  for (const s of res.samples) {
    const n = s.net;
    const gb = s.goalBox;
    console.log(
      `  t=${s.t.toFixed(2)}  net x ${n.x.toFixed(0)}-${n.x2.toFixed(0)} y ${n.y.toFixed(0)}-${n.y2.toFixed(0)}` +
        `  banner ${gb ? `y ${gb.y}-${gb.y + gb.h}` : '-'}  ${s.overlap ? 'OVERLAP' : 'ok'}`,
    );
    if (s.overlap) bad++;
    const name = `${team === 0 ? 'home' : 'away'}-${s.t.toFixed(2)}`;
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(s.raw.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(out, `${name}-x3.png`), Buffer.from(s.x3.split(',')[1], 'base64'));
  }
  await page.close();
}
console.log(logs.length ? logs.join('\n') : '[no page errors]');
console.log(bad ? `FAIL: ${bad} problem(s)` : 'PASS: the GOAL!! banner never covered the net');
await browser.close();
await server.close();
process.exit(bad ? 1 : 0);
