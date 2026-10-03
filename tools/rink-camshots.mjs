#!/usr/bin/env node
// RINK: camera screenshots through the real main loop (headless, never shows a window).
//   node tools/rink-camshots.mjs [--out tools/out/rink-camshots]
// 1. Post-goal faceoff: a forced HOME goal at the far net, then frames of the
//    next faceoff at phaseTime 0.04 / 0.12 / 0.25 / 0.6 s (the whip-pan lands
//    on center ice by 0.22 s). Each frame is captured inside the rAF right
//    after the game drew it, so it shows exactly the state it is labeled with.
// 2. Offensive-zone rush: PAL is handed the puck just outside the blue line and
//    turbos straight up (pad override, no AI for PAL); frames as he crosses the blue
//    line and goes deep, with the net keep engaged.
// Saves <name>.png (256x224) and <name>-x3.png, and prints the camera-relevant state.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const out = opt('out', 'tools/out/rink-camshots');
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } }); // no reloads while other work edits src/
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://127.0.0.1:${port}/?test=1&mute=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__airfriend?.state?.phase === 'faceoff', null, { timeout: 120000, polling: 100 });

// In-page frame hook: after every drawn frame, run the pending capture rules.
await page.evaluate(() => {
  const api = window.__airfriend;
  window.__shots = [];
  window.__rules = [];
  const loop = () => {
    const st = api.state;
    for (const r of window.__rules) {
      if (r.done) continue;
      if (eval(r.when)) {
        r.done = true;
        const d = st.period % 2 === 1 || st.period > 3 ? 1 : -1;
        const dog = st.skaters[0];
        window.__shots.push({
          name: r.name,
          png: api.capture(),
          info: `${st.phase} t=${st.phaseTime.toFixed(2)} puck(${st.puck.pos.x.toFixed(1)},${(st.puck.pos.z * d).toFixed(1)} up-ice) PAL(${dog.pos.x.toFixed(1)},${(dog.pos.z * d).toFixed(1)} up-ice)`,
        });
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const rule = (name, when) => page.evaluate(([name, when]) => window.__rules.push({ name, when }), [name, when]);
const waitShots = (n, timeout = 180000) => page.waitForFunction((n) => window.__shots.length >= n, n, { timeout, polling: 100 });

// --- 1. post-goal faceoff -----------------------------------------------
// skip the opening faceoff: a coin flip happens after 1.2 s with nobody pressing
await page.waitForFunction(() => window.__airfriend.state.phase === 'play', null, { timeout: 120000, polling: 100 });
await page.evaluate(() => {
  const api = window.__airfriend;
  // a loose puck sliding into the far (AWAY) net
  api.setPadOverride((st) => {
    if (st.phase === 'play' && !window.__goalForced) {
      window.__goalForced = true;
      const d = st.period % 2 === 1 || st.period > 3 ? 1 : -1;
      st.puck.owner = null;
      st.puck.y = 0;
      st.puck.pos.x = 0.4;
      st.puck.pos.z = 25.9 * d;
      st.puck.vel.x = 0;
      st.puck.vel.z = 14 * d;
    }
    return api.emptyPad();
  });
});
await rule('1-goal-celebration', `st.phase === 'goal' && st.phaseTime > 1.2`);
await rule('2-faceoff-t0.04', `st.phase === 'faceoff' && window.__shots.length >= 1 && st.phaseTime >= 0.04`);
await rule('3-faceoff-t0.12', `st.phase === 'faceoff' && window.__shots.length >= 2 && st.phaseTime >= 0.12`);
await rule('4-faceoff-t0.25', `st.phase === 'faceoff' && window.__shots.length >= 3 && st.phaseTime >= 0.25`);
await rule('5-faceoff-t0.6', `st.phase === 'faceoff' && window.__shots.length >= 4 && st.phaseTime >= 0.6`);
await waitShots(5);

// --- 2. offensive-zone rush ----------------------------------------------
await page.waitForFunction(() => window.__airfriend.state.phase === 'play', null, { timeout: 120000, polling: 100 });
await page.evaluate(() => {
  const api = window.__airfriend;
  window.__rushT = 0;
  api.setPadOverride((st) => {
    const pad = api.emptyPad();
    if (st.phase !== 'play') return pad;
    const d = st.period % 2 === 1 || st.period > 3 ? 1 : -1;
    const dog = st.skaters[0];
    if (window.__rushT++ === 0) {
      dog.pos.x = 3;
      dog.pos.z = 6 * d;
      st.puck.owner = 0;
      st.puck.pos.x = dog.pos.x;
      st.puck.pos.z = dog.pos.z;
    }
    if (dog.pos.z * d < 22) {
      pad.up = true;
      pad.turbo = { held: true, pressed: window.__rushT === 2, released: false };
    }
    return pad;
  });
});
await rule('6-rush-blueline', `st.phase === 'play' && window.__rushT > 1 && st.skaters[0].pos.z * (st.period % 2 === 1 ? 1 : -1) >= 9`);
await rule('7-rush-slot', `st.phase === 'play' && window.__rushT > 1 && window.__shots.length >= 6 && st.puck.pos.z * (st.period % 2 === 1 ? 1 : -1) >= 15`);
await rule('8-rush-deep', `st.phase === 'play' && window.__rushT > 1 && window.__shots.length >= 7 && st.puck.pos.z * (st.period % 2 === 1 ? 1 : -1) >= 19`);
await waitShots(8, 60000).catch(() => console.log('rush: deep frame not reached (puck lost?)'));

const shots = await page.evaluate(() => window.__shots);
for (const s of shots) {
  const buf = Buffer.from(s.png.split(',')[1], 'base64');
  fs.writeFileSync(path.join(out, `${s.name}.png`), buf);
  console.log(`${s.name.padEnd(20)} ${s.info}`);
}
// 3x nearest-neighbor copies for inspection
for (const s of shots) {
  const x3 = await page.evaluate(async (png) => {
    const img = new Image();
    img.src = png;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width * 3;
    c.height = img.height * 3;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }, s.png);
  fs.writeFileSync(path.join(out, `${s.name}-x3.png`), Buffer.from(x3.split(',')[1], 'base64'));
}
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
await server.close();
