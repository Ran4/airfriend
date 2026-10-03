#!/usr/bin/env node
// Real-keyboard test of the human controls in headless Chromium (no window).
// Drives the actual Input class with key events and checks, in BOTH period 1
// and period 2 (camera flipped), that the dog skates screen-relative, and that
// Z shoots, X passes and C barks/turbos. Saves screenshots.
//
//   node tools/sim-keytest.mjs [--out tools/out/sim-keys]

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'tools/out/sim-keys';
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/?mute=1`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__airfriend);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};
const S = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

// log every tick's events: stepGame assigns a fresh array each tick, so a
// setter on `events` sees each one (no edits to main.ts needed)
const installRecorder = () =>
  S(() => {
    const st = window.__airfriend.state;
    let cur = st.events;
    window.__evlog = [];
    Object.defineProperty(st, 'events', {
      configurable: true,
      get: () => cur,
      set: (v) => {
        cur = v;
        window.__evlog.push(v);
      },
    });
  });
const takeEvents = () =>
  S(() => {
    const all = window.__evlog.flat();
    window.__evlog = [];
    return all;
  });
const dog = () => S(() => {
  const s = window.__airfriend.state;
  const d = s.skaters[0];
  return { x: d.pos.x, z: d.pos.z, state: d.state, period: s.period, phase: s.phase, owner: s.puck.owner, ctl: s.controlledId };
});
/** wait for one of the given phases; a timeout is reported as a failed check instead of a crash */
const waitPhase = async (ph, timeout = 25000) => {
  const want = Array.isArray(ph) ? ph : [ph];
  try {
    await page.waitForFunction((w) => w.includes(window.__airfriend.state.phase), want, { timeout, polling: 30 });
  } catch {
    check(`reached phase ${want.join('|')} (stuck in ${await S(() => window.__airfriend.state.phase)})`, false);
  }
};
const givePuckToDog = () =>
  S(() => {
    const s = window.__airfriend.state;
    const d = s.skaters[0];
    s.puck.owner = 0;
    s.puck.y = 0;
    s.puck.pos = { x: d.pos.x, z: d.pos.z };
  });
/** keep opponents off the dog for a clean test (they'd poke/check it) */
const parkOpponents = () =>
  S(() => {
    const s = window.__airfriend.state;
    for (const k of s.skaters) if (k.team === 1 && k.kind !== 'goalie') { k.pos = { x: 11, z: k.pos.z }; k.vel = { x: 0, z: 0 }; }
  });
const shot = async (tag) => {
  const png = await S(() => window.__airfriend.capture());
  fs.writeFileSync(path.join(out, `${tag}.png`), Buffer.from(png.split(',')[1], 'base64'));
};

async function controlsTest(period) {
  const d = period === 2 ? -1 : 1; // HOME attack direction on z
  await installRecorder();
  // center the dog in open ice so the boards don't stop it
  await S(() => {
    const s = window.__airfriend.state;
    const g = s.skaters[0];
    g.pos = { x: 0, z: 0 };
    g.vel = { x: 0, z: 0 };
    s.puck.owner = null;
    s.puck.pos = { x: 0, z: 20 * (s.period === 2 ? 1 : -1) };
  });
  await parkOpponents();
  let a = await dog();
  await page.keyboard.down('ArrowUp');
  await wait(700);
  await page.keyboard.up('ArrowUp');
  let b = await dog();
  check(`P${period}: ArrowUp skates toward the attack end (dz ${(b.z - a.z).toFixed(1)})`, (b.z - a.z) * d > 2);
  await shot(`p${period}-up`);

  await S(() => {
    const g = window.__airfriend.state.skaters[0];
    g.pos = { x: 0, z: 0 };
    g.vel = { x: 0, z: 0 };
  });
  a = await dog();
  await page.keyboard.down('KeyA'); // WASD too
  await wait(600);
  await page.keyboard.up('KeyA');
  b = await dog();
  // screen right = world -d on x, so screen left = world +d on x
  check(`P${period}: A (left) skates screen-left (dx ${(b.x - a.x).toFixed(1)})`, (b.x - a.x) * d > 1);

  // X with the puck = pass
  await parkOpponents();
  await givePuckToDog();
  await takeEvents();
  await page.keyboard.press('KeyX');
  await wait(300);
  let ev = await takeEvents();
  check(`P${period}: X passes`, ev.some((e) => e.type === 'pass' && e.from === 0), JSON.stringify(ev.find((e) => e.type === 'pass') ?? null));

  // Z hold + release with the puck = charged shot (ArrowUp held: aim high)
  await parkOpponents();
  await givePuckToDog();
  await takeEvents();
  await page.keyboard.down('KeyZ');
  await wait(450);
  const mid = await dog();
  await page.keyboard.up('KeyZ');
  await wait(150);
  ev = await takeEvents();
  const sh = ev.find((e) => e.type === 'shot');
  check(`P${period}: Z hold winds up and release shoots (power ${sh ? sh.power.toFixed(2) : '-'})`, mid.state === 'windup' && !!sh && sh.shooter === 0 && sh.power > 0.25);
  await shot(`p${period}-shot`);

  // J (alternate) tap = quick shot
  await parkOpponents();
  await givePuckToDog();
  await takeEvents();
  await page.keyboard.press('KeyJ');
  await wait(200);
  ev = await takeEvents();
  check(`P${period}: J tap = quick shot`, ev.some((e) => e.type === 'shot' && e.shooter === 0));

  // C tap = bark; C held while moving = turbo
  await S(() => (window.__airfriend.state.skaters[0].barkCooldown = 0));
  await takeEvents();
  await page.keyboard.press('KeyC');
  await wait(200);
  ev = await takeEvents();
  check(`P${period}: C barks`, ev.some((e) => e.type === 'bark' && e.skaterId === 0));
  await shot(`p${period}-bark`);
  await S(() => {
    const g = window.__airfriend.state.skaters[0];
    g.pos = { x: 0, z: -8 * (window.__airfriend.state.period === 2 ? -1 : 1) };
    g.vel = { x: 0, z: 0 };
    g.stamina = 1;
  });
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('KeyC');
  await wait(900);
  const tb = await S(() => {
    const g = window.__airfriend.state.skaters[0];
    return { turbo: g.turboActive, stamina: g.stamina, speed: Math.hypot(g.vel.x, g.vel.z) };
  });
  await page.keyboard.up('KeyC');
  await page.keyboard.up('ArrowUp');
  ev = await takeEvents();
  check(`P${period}: C held = turbo (speed ${tb.speed.toFixed(1)}, stamina ${tb.stamina.toFixed(2)})`, tb.turbo && tb.speed > 9.5 && tb.stamina < 1 && ev.some((e) => e.type === 'turboStart'));

  // K without the puck (nobody carrying) = body check lunge
  await S(() => {
    const s = window.__airfriend.state;
    s.puck.owner = null;
    s.skaters[0].sim.actionCd = 0;
  });
  await page.keyboard.press('KeyK');
  await wait(50);
  const lunge = await S(() => {
    const d = window.__airfriend.state.skaters[0];
    return { state: d.state, cd: d.sim.actionCd };
  });
  check(`P${period}: K without the puck = body check lunge`, lunge.state === 'check' || lunge.cd > 0.5, JSON.stringify(lunge));
}

// ---- period 1
await waitPhase('play');
check('starts straight into the game (intro -> faceoff -> play, no menu)', true);
await controlsTest(1);

// ---- force period 2: run the clock out, skip the intermission with Enter
await S(() => (window.__airfriend.state.clock = 0.05));
await waitPhase('intermission');
await shot('intermission');
await page.keyboard.press('Enter');
await waitPhase(['faceoff', 'play']);
check('Enter skips the intermission into period 2', (await dog()).period === 2);
await waitPhase('play');
await controlsTest(2);

// ---- pause
await page.keyboard.press('Enter');
await wait(150);
const paused = await S(() => window.__airfriend.state.paused);
const t0 = await S(() => window.__airfriend.state.tick);
await wait(300);
const t1 = await S(() => window.__airfriend.state.tick);
await shot('paused');
await page.keyboard.press('KeyP');
await wait(150);
check('Enter pauses (tick frozen), P resumes', paused && t0 === t1 && !(await S(() => window.__airfriend.state.paused)));

console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : '[no page errors]');
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed  (screenshots in ${out})`);
await browser.close();
await server.close();
process.exitCode = failed ? 1 : 0;
