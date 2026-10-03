#!/usr/bin/env node
// Fault-isolation check for the main loop (src/main.ts). Boots the real game in
// headless Chromium and makes one subsystem method throw at a time, then checks
// that the sim keeps ticking, the other consumers still get events, and the
// frame keeps being drawn. Never shows a window.
//
// Usage: node tools/integ-robust-throw.mjs
// Exits non-zero if any scenario fails.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});

// Each scenario: which method on which subsystem throws, and how often.
// 'sim' is simulated with a throwing pad override (it runs inside the sim step).
const SCENARIOS = [
  { name: 'audio.onEvents once', sub: 'audio', method: 'onEvents', mode: 'once' },
  { name: 'audio.onEvents always', sub: 'audio', method: 'onEvents', mode: 'always' },
  { name: 'audio.update always', sub: 'audio', method: 'update', mode: 'always' },
  { name: 'hud.onEvents always', sub: 'hud', method: 'onEvents', mode: 'always' },
  { name: 'hud.draw always', sub: 'hud', method: 'draw', mode: 'always' },
  { name: 'renderer.onEvents always', sub: 'renderer', method: 'onEvents', mode: 'always' },
  { name: 'renderer.render always', sub: 'renderer', method: 'render', mode: 'always' },
  { name: 'sim step always (then recovers)', sub: 'sim', mode: 'always' },
];

let failed = 0;
for (const sc of SCENARIOS) {
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/?autoplay=1&speed=2&mute=1`);
  await page.waitForFunction(() => !!window.__airfriend);
  await page.waitForFunction(() => window.__airfriend.state.phase === 'play', null, { timeout: 90000 });

  // Count calls on every consumer (the patched one included) so we can tell
  // that HUD + renderer still receive events and frames are still drawn.
  const tickBefore = await page.evaluate((sc) => {
    const af = window.__airfriend;
    const calls = (window.__calls = {});
    for (const sub of ['audio', 'hud', 'renderer']) {
      const obj = af[sub];
      for (const m of ['onEvents', 'draw', 'render', 'update']) {
        if (typeof obj[m] !== 'function') continue;
        const orig = obj[m].bind(obj);
        const key = `${sub}.${m}`;
        calls[key] = 0;
        let once = true;
        obj[m] = (...a) => {
          calls[key]++;
          if (sc.sub === sub && sc.method === m && (sc.mode === 'always' || once)) {
            once = false;
            throw new Error(`simulated ${key} exception`);
          }
          return orig(...a);
        };
      }
    }
    if (sc.sub === 'sim') {
      af.setPadOverride(() => {
        throw new Error('simulated sim exception');
      });
    }
    return af.state.tick;
  }, sc);

  await page.waitForTimeout(3000);
  const mid = await page.evaluate(() => ({
    tick: window.__airfriend.state.tick,
    calls: { ...window.__calls },
    faults: window.__airfriend.faults(),
  }));

  let recoveredTick = null;
  if (sc.sub === 'sim') {
    // lift the fault: the sim must pick up again from the state it kept
    await page.evaluate(() => window.__airfriend.setPadOverride(null));
    await page.waitForTimeout(2000);
    recoveredTick = await page.evaluate(() => window.__airfriend.state.tick);
  }

  const checks = [];
  if (sc.sub === 'sim') {
    checks.push(['sim held still while throwing', mid.tick - tickBefore <= 2]);
    checks.push(['frames kept rendering', mid.calls['renderer.render'] > 20]);
    checks.push(['hud kept drawing', mid.calls['hud.draw'] > 20]);
    checks.push(['sim resumed after fault cleared', recoveredTick - mid.tick > 30]);
    checks.push(['streak tracked', mid.faults.simFailStreak > 20]);
  } else {
    checks.push(['tick advanced', mid.tick - tickBefore > 60]);
    for (const k of ['audio.onEvents', 'hud.onEvents', 'renderer.onEvents']) {
      checks.push([`${k} got events`, mid.calls[k] > 0]);
    }
    checks.push(['frames kept rendering', mid.calls['renderer.render'] > 20]);
    checks.push(['hud kept drawing', mid.calls['hud.draw'] > 20]);
  }
  const f = mid.faults[sc.sub];
  checks.push(['fault recorded', !!f && f.count >= 1]);
  if (sc.mode === 'once') checks.push(['counted exactly once', f?.count === 1]);
  const ours = consoleErrors.filter((t) => t.startsWith('[airfriend]'));
  checks.push(['logged once', ours.length === 1]);
  checks.push(['no uncaught page errors', pageErrors.length === 0]);

  const ok = checks.every(([, v]) => v);
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${sc.name}: tick ${tickBefore} -> ${mid.tick}` +
      (recoveredTick !== null ? ` -> ${recoveredTick} (recovered)` : '') +
      `, faults ${f?.count ?? 0}, calls ${JSON.stringify(mid.calls)}`,
  );
  for (const [label, v] of checks) if (!v) console.log(`      x ${label}`);
  if (pageErrors.length) console.log('      page errors:', pageErrors.slice(0, 3));
  await page.close();
}

await browser.close();
await server.close();
console.log(failed ? `${failed} scenario(s) FAILED` : 'all scenarios passed');
process.exit(failed ? 1 : 0);
