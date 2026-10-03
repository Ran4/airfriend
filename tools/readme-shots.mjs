#!/usr/bin/env node
// README screenshots. Headless Chromium plays an autoplay game, fast-forwards
// the sim to each moment with __airfriend.step(), freezes it (pause) so the
// camera can settle, then captures the real 4:3 display canvas at 3x
// (896x672: 224 lines x 3, 8:7 pixels, exactly what a player sees).
//
//   node tools/readme-shots.mjs [--out screenshots] [--only 2-gameplay,5-final]

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'screenshots';
fs.mkdirSync(out, { recursive: true });
/** retake just these shots (names without .png); the others are left alone */
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/?test=1&mute=1&autoplay=1`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 896, height: 672 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(url);
await page.waitForFunction(() => !!window.__airfriend);
// Shots are taken with the sim paused (frozen moment, settled camera). The HUD
// would draw the PAUSE window over a paused game, so it draws as if unpaused
// here; its banners run on sim time, so they stay frozen with the moment.
await page.evaluate(() => {
  const hud = window.__airfriend.hud;
  const draw = hud.draw.bind(hud);
  hud.draw = (st, dt, project) => {
    const paused = st.paused;
    st.paused = false;
    try {
      draw(st, dt, project);
    } finally {
      st.paused = paused;
    }
  };
});

/**
 * Step the sim until `cond(state)` holds (a function body as a string, so it
 * runs in the page). Restarts the game when it ends without a match.
 */
async function jumpTo(cond, label, maxGames = 12) {
  if (only && !only.some((n) => n.endsWith(label))) return;
  const ok = await page.evaluate(
    ({ cond, maxGames }) => {
      const A = window.__airfriend;
      const f = new Function('s', `return (${cond});`);
      for (let games = 0; games < maxGames; ) {
        for (let i = 0; i < 400000; i++) {
          if (f(A.state)) return true;
          if (A.state.phase === 'gameOver' && A.state.phaseTime > 8) break;
          A.step(1);
        }
        games++;
        A.restart({ autoplay: true });
      }
      return false;
    },
    { cond, maxGames },
  );
  if (!ok) throw new Error(`never reached: ${label}`);
}

/** freeze, let the camera springs settle on the frozen scene, capture */
async function shot(name) {
  if (only && !only.includes(name)) return;
  await page.evaluate(() => (window.__airfriend.state.paused = true));
  await page.waitForTimeout(1500);
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  await page.evaluate(() => (window.__airfriend.state.paused = false));
  console.log('wrote', file);
}

// 1. title card over the arena
await jumpTo("s.phase === 'intro' && s.phaseTime >= 1.4", 'title');
await shot('1-title');

// 2. PAL carrying the puck up ice through traffic, side-on (stick in mouth shows)
await jumpTo(
  `s.phase === 'play' && s.puck.owner === 0 && s.period === 1 &&
   s.skaters[0].pos.z > 2 && s.skaters[0].pos.z < 18 && Math.abs(s.skaters[0].pos.x) < 8 &&
   Math.abs(Math.sin(s.skaters[0].facing)) > 0.6 &&
   s.skaters.filter(k => k.id !== 0 && k.kind !== 'goalie' && k.state !== 'box' &&
     Math.hypot(k.pos.x - s.skaters[0].pos.x, k.pos.z - s.skaters[0].pos.z) < 8).length >= 4`,
  'gameplay',
);
await shot('2-gameplay');

// 3. PAL scores: GOOD BOY! and the scorer window
await jumpTo("s.phase === 'goal' && s.goals.length && s.goals[s.goals.length - 1].scorer === 0 && s.phaseTime >= 2.4", 'goal');
await shot('3-goal');

// 4. a body check gets called
await jumpTo("s.phase === 'penalty' && s.phaseTime >= 1.8", 'penalty');
await shot('4-penalty');

// 5. final screen with the three stars, after a PUPS win
await jumpTo("s.phase === 'gameOver' && s.winner === 0 && s.skaters[0].stats.goals >= 2 && s.phaseTime >= 3.2", 'final');
await shot('5-final');

await browser.close();
await server.close();
