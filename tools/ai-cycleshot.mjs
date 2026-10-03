#!/usr/bin/env node
// Screenshots of the AI offensive-zone game (ai/ozone.ts) in the real game, headless.
// Autoplay is fast-forwarded with the test API until a team has worked the puck in its
// offensive zone for a while with a defenseman at the point and its forwards down low,
// then the game runs on live for a moment (so the camera catches up) and a few frames
// are captured. Never opens a visible window.
//
//   node tools/ai-cycleshot.mjs [--scenes 4] [--team any|0|1] [--hold 2.5] [--out tools/out/ai-cycleshot]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const scenes = Number(opt('scenes', '4'));
const team = opt('team', 'any');
const hold = Number(opt('hold', '2.5'));
const out = opt('out', 'tools/out/ai-cycleshot');
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(`[console.error] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/?autoplay=1&mute=1&test=1`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 15000 });

const save = async (name) => {
  const url = await page.evaluate(() => window.__airfriend.capture());
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
};

for (let k = 0; k < scenes; k++) {
  // fast-forward until somebody is cycling: in the zone >= hold s, a D at the point, 2 forwards low
  const found = await page.evaluate(
    ({ team, hold }) => {
      const api = window.__airfriend;
      const since = [-1, -1];
      for (let i = 0; i < 60 * 60 * 6; i++) {
        api.step(1);
        const st = api.state;
        if (st.phase === 'gameOver') api.restart({ autoplay: true });
        if (st.phase !== 'play') {
          since[0] = since[1] = -1;
          continue;
        }
        const dir = (t) => (t === 0 ? 1 : -1) * (st.period === 2 ? -1 : 1);
        const lt = st.puck.lastTouch;
        const tt = lt === null ? -1 : st.skaters[lt].team;
        for (const t of [0, 1]) {
          const inZone = st.puck.pos.z * dir(t) > 7.6 && tt === t;
          since[t] = inZone ? (since[t] < 0 ? st.time : since[t]) : -1;
          if (team !== 'any' && Number(team) !== t) continue;
          if (since[t] < 0 || st.time - since[t] < hold || st.puck.owner === null) continue;
          const mates = st.skaters.filter((s) => s.team === t && s.state !== 'box' && s.kind !== 'goalie');
          const a = (s) => s.pos.z * dir(t);
          const point = mates.some((s) => (s.position === 'LD' || s.position === 'RD') && a(s) > 7.5 && a(s) < 15 && Math.abs(s.pos.x) < 10);
          const low = mates.filter((s) => (s.position === 'C' || s.position === 'W') && a(s) > 16).length;
          if (point && low >= 2) return { team: t, zt: st.time - since[t] };
        }
      }
      return null;
    },
    { team, hold },
  );
  if (!found) {
    console.log(`scene ${k}: nothing found`);
    continue;
  }
  // live for a beat so the camera settles on the play, then a few frames
  await page.waitForTimeout(700);
  for (let f = 0; f < 3; f++) {
    const info = await page.evaluate(() => {
      const st = window.__airfriend.state;
      const lt = st.puck.lastTouch;
      const t = lt === null ? 0 : st.skaters[lt].team;
      const dir = (t === 0 ? 1 : -1) * (st.period === 2 ? -1 : 1);
      return {
        team: t,
        carrier: st.puck.owner === null ? '-' : st.skaters[st.puck.owner].name,
        spots: st.skaters
          .filter((s) => s.team === t && s.kind !== 'goalie' && s.state !== 'box')
          .map((s) => `${s.name}/${s.position}(${s.pos.x.toFixed(1)},${(s.pos.z * dir).toFixed(1)})`)
          .join(' '),
      };
    });
    const name = `scene${k}-f${f}`;
    await save(name);
    console.log(`${name}: team ${info.team} carrier ${info.carrier}  ${info.spots}  (x, along; goal line 26.5, blue line 7.6)`);
    await page.waitForTimeout(350);
  }
}
console.log(`OUT: ${out}`);
console.log(logs.length ? logs.join('\n') : '[no console errors]');
await browser.close();
await server.close();
