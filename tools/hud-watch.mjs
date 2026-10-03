#!/usr/bin/env node
// Plays a full AI-vs-AI game headless and screenshots the HUD at interesting
// moments (first goal, penalty, big hit, period end, intermission, final...).
//   node tools/hud-watch.mjs [--out tools/out/hud-watch] [--max 40000]
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
const out = opt('out', 'tools/out/hud-watch');
const maxTicks = Number(opt('max', '40000'));
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(m.text()));
page.on('pageerror', (e) => logs.push(`${e.message}\n${e.stack}`));
await page.goto(`http://127.0.0.1:${port}/?autoplay=1&mute=1`);
await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 20000 });

const shots = await page.evaluate(async (maxTicks) => {
  const A = window.__airfriend;
  // trigger -> capture delays (sim seconds after the event)
  const triggers = {
    goal: [0.15, 0.6, 1.8, 2.6],
    penalty: [0.6, 2.0],
    check: [0.25],
    post: [0.15],
    save: [0.15],
    faceoffSetup: [0.5],
    faceoffDrop: [0.1],
    periodEnd: [0.6],
    intermissionStart: [0.6, 3],
    gameOver: [0.5, 3],
    clockWarning: [0.3],
    controlSwitch: [0.3],
  };
  const count = {};
  const pending = [];
  const res = [];
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  let windup = 0;
  for (let i = 0; i < maxTicks; i++) {
    A.step(1);
    const s = A.state;
    for (const e of s.events) {
      if (!(e.type in triggers)) continue;
      if (e.type === 'check' && !e.knockedDown) continue;
      // second faceoff onward (the first is covered by the intro run)
      const n = (count[e.type] = (count[e.type] ?? 0) + 1);
      if (e.type === 'faceoffSetup' && n !== 3) continue;
      if (e.type === 'clockWarning' && n !== 2) continue;
      if (e.type === 'goal' && n > 2) continue;
      if (n > 1 && !['faceoffSetup', 'clockWarning', 'goal'].includes(e.type)) continue;
      for (const d of triggers[e.type]) pending.push({ name: `${e.type}${n > 1 ? n : ''}-${d}s`, at: s.time + d });
    }
    if (s.skaters[s.controlledId].state === 'windup' && s.skaters[s.controlledId].windup > 0.5 && windup < 1) {
      windup++;
      pending.push({ name: 'windup', at: s.time });
    }
    const due = pending.filter((p) => s.time >= p.at);
    for (const p of due) {
      pending.splice(pending.indexOf(p), 1);
      // let the real rAF loop draw the HUD for this state (it may step a tick or two)
      await frame();
      await frame();
      res.push({ name: p.name, url: A.capture(), phase: s.phase, t: +s.time.toFixed(2) });
    }
    if (s.phase === 'gameOver' && !pending.length && count.gameOver) break;
    // pause once mid-play, like a player would
    if (!count.paused && s.phase === 'play' && s.time > 20) {
      count.paused = 1;
      const press = () => ({ ...A.emptyPad(), start: { held: true, pressed: true, released: false } });
      A.setPadOverride(press);
      A.step(1);
      A.setPadOverride(null);
      for (let k = 0; k < 20; k++) await frame();
      res.push({ name: 'pause', url: A.capture(), phase: s.phase, t: +s.time.toFixed(2) });
      A.setPadOverride(press);
      A.step(1);
      A.setPadOverride(null);
    }
  }
  // START on the final screen -> rematch with the short intro
  if (A.state.phase === 'gameOver') {
    A.setPadOverride(() => ({ ...A.emptyPad(), start: { held: true, pressed: true, released: false } }));
    A.step(1);
    A.setPadOverride(null);
    for (const [n, ticks] of [['rematch-0_3s', 18], ['rematch-1_0s', 42], ['rematch-faceoff', 40]]) {
      A.step(ticks);
      await frame();
      await frame();
      res.push({ name: n, url: A.capture(), phase: A.state.phase, t: +A.state.time.toFixed(2) });
    }
  }
  return res;
}, maxTicks);

for (const s of shots) {
  const slug = s.name.replace(/[^a-z0-9.]+/gi, '-').replace(/\./g, '_');
  fs.writeFileSync(path.join(out, `${slug}.png`), Buffer.from(s.url.split(',')[1], 'base64'));
  console.log(`${slug.padEnd(28)} phase=${s.phase} t=${s.t}`);
}
console.log(logs.length ? logs.slice(0, 20).join('\n') : '[no errors]');
await browser.close();
await server.close();
