#!/usr/bin/env node
// Headless screenshots of the gameplay-lane AI tells (never opens a window):
//  - shield: a BLIZZARD carrier tucking the puck away from a stick reaching in (Intent.shield)
//  - saucer: a pass floating over a stick (puck in the air during a pass)
// Runs the real game (?autoplay=1), polls the state and presses START (pause) the moment
// the situation is on screen, then captures the playfield canvas (no HUD, no PAUSE box).
//   node tools/ai-shieldshot.mjs [--out tools/out/ai-shield] [--seconds 90]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const out = opt('out', 'tools/out/ai-shield');
const seconds = Number(opt('seconds', '90'));
fs.mkdirSync(out, { recursive: true });

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/?autoplay=1&speed=2&test=1`;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 896 } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 15000 });

const conds = {
  // a Blizzard carrier fully tucked, a home skater within 2 m of the puck
  shield: `(() => { const s = window.__airfriend.state; if (s.phase !== 'play' || s.puck.owner === null) return false;
    const c = s.skaters[s.puck.owner]; if (c.team !== 1 || Math.abs(c.intent.shield ?? 0) < 0.9) return false;
    return s.skaters.some((k) => k.team === 0 && k.kind !== 'goalie' && Math.hypot(k.pos.x - s.puck.pos.x, k.pos.z - s.puck.pos.z) < 2); })()`,
  saucer: `(() => { const s = window.__airfriend.state; return s.phase === 'play' && s.puck.owner === null && s.puck.y > 0.45 && s.puck.vy > -1 && Math.hypot(s.puck.vel.x, s.puck.vel.z) < 16; })()`,
};
const want = Object.keys(conds);
const got = {};
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000 && Object.keys(got).length < want.length) {
  for (const k of want) {
    if (got[k]) continue;
    if (!(await page.evaluate(conds[k]))) continue;
    await page.keyboard.press('Enter'); // START = pause
    await page.waitForTimeout(250);
    const info = await page.evaluate(() => {
      const s = window.__airfriend.state;
      const o = s.puck.owner;
      return { phase: s.phase, paused: s.paused, owner: o, shield: o !== null ? s.skaters[o].intent.shield : null, puckY: +s.puck.y.toFixed(2) };
    });
    // the playfield only: the PAUSE box lives on the HUD canvas, drawn over it
    const data = await page.evaluate(() => {
      const src = [...document.querySelectorAll('canvas')].find((c) => c.width === 256 && c.getContext('2d') === null);
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      return c.toDataURL('image/png');
    });
    fs.writeFileSync(path.join(out, `${k}.png`), Buffer.from(data.split(',')[1], 'base64'));
    got[k] = info;
    console.log(k, JSON.stringify(info));
    await page.keyboard.press('Enter'); // resume
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(15);
}
for (const k of want) if (!got[k]) console.log(`${k}: not seen in ${seconds} s`);
console.log(`OUT: ${out}`);
await browser.close();
await server.close();
