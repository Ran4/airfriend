// TURBO vs BARK through the real keyboard and the real main loop (headless):
//   A) C held with nobody near: PAL sprints, no bark, the bark stays ready
//   B) a quick C tap with nobody near: a bark
//   C) C pressed next to a Blizzard carrier: a bark at once
// Also saves a 3x screenshot of PAL mid-sprint (shot-sprint-x3.png) to look at.
//
//   node tools/sim-barkkeys.mjs [--out tools/out/barkkeys]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = oi >= 0 ? args[oi + 1] : 'tools/out/barkkeys';
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};

try {
  await page.goto(`http://127.0.0.1:${port}/?mute=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 15000 });
  // count bark events as the loop dispatches them
  await page.evaluate(() => {
    window.__barks = [];
    const a = window.__airfriend.audio;
    const orig = a.onEvents.bind(a);
    a.onEvents = (ev, st) => {
      for (const e of ev) if (e.type === 'bark') window.__barks.push(st.time);
      return orig(ev, st);
    };
  });
  await page.waitForFunction(() => window.__airfriend.state.phase === 'play', null, { timeout: 30000 });

  /** PAL at center ice heading up, every Blizzard skater >= 14 m away, the puck loose behind PAL */
  const clearIce = () =>
    page.evaluate(() => {
      const st = window.__airfriend.state;
      for (const s of st.skaters) {
        if (s.team === 1 && s.kind !== 'goalie') s.pos = { x: (s.id % 2 ? -1 : 1) * 10, z: 20 + s.id };
        s.vel = { x: 0, z: 0 };
      }
      const dog = st.skaters[0];
      dog.pos = { x: 0, z: -6 };
      dog.stamina = 1;
      dog.barkCooldown = 0;
      st.puck.owner = null;
      st.puck.pos = { x: 0, z: -20 };
      st.puck.vel = { x: 0, z: 0 };
      window.__barks.length = 0;
    });
  const barks = () => page.evaluate(() => window.__barks.length);

  // A) hold C (with UP) for 0.6 s
  await clearIce();
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('KeyC');
  let sprinted = false;
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(100);
    if (await page.evaluate(() => window.__airfriend.state.skaters[0].turboActive)) sprinted = true;
    if (i === 3) fs.writeFileSync(path.join(out, 'shot-sprint.png'), Buffer.from((await page.evaluate(() => window.__airfriend.capture())).split(',')[1], 'base64'));
  }
  await page.keyboard.up('KeyC');
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(150);
  const cdA = await page.evaluate(() => window.__airfriend.state.skaters[0].barkCooldown);
  check(sprinted, 'A: held TURBO sprints');
  check((await barks()) === 0 && cdA === 0, `A: no bark, bark still ready (barks ${await barks()}, cooldown ${cdA.toFixed(2)})`);

  // B) quick tap
  await clearIce();
  await page.keyboard.down('KeyC');
  await page.waitForTimeout(40);
  await page.keyboard.up('KeyC');
  await page.waitForTimeout(250);
  check((await barks()) === 1, `B: a quick tap barks (barks ${await barks()})`);

  // C) press next to a Blizzard carrier
  await clearIce();
  await page.evaluate(() => {
    const st = window.__airfriend.state;
    const brick = st.skaters[5];
    brick.pos = { x: 0, z: -3.6 };
    st.puck.owner = 5;
    st.puck.pos = { x: 0, z: -4.1 };
  });
  await page.keyboard.down('KeyC');
  await page.waitForTimeout(120);
  await page.keyboard.up('KeyC');
  await page.waitForTimeout(100);
  check((await barks()) === 1, `C: a press next to the carrier barks (barks ${await barks()})`);
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) console.log(errors.join('\n'));
console.log(fails ? `${fails} failed` : 'all ok');
process.exitCode = fails || errors.length ? 1 : 0;
