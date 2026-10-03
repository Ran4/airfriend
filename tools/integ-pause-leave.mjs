#!/usr/bin/env node
// Pause-on-leave check for src/main.ts. Boots the real game in headless
// Chromium, steps it into each live phase, then "leaves" the game two ways:
//   blur:   window 'blur' (alt-tab with the browser still on screen)
//   hidden: emulated tab hide (document.hidden + visibilitychange, rAF frozen
//           like a background tab; headless never changes visibility itself)
// Checks that the game pauses, stays paused (tick frozen) after coming back,
// and that one START (Enter) resumes it. Also checks that intermission and
// the final screen are NOT paused, that audio.setHidden(document.hidden) is
// called on every visibilitychange, and audio.ensureRunning() on every
// keydown/pointerdown. When the real AudioEngine methods exist (audio lane),
// it also checks that the AudioContext is 'suspended' while hidden.
// Never shows a window.
//
// Usage: node tools/integ-pause-leave.mjs [--out tools/out/<dir>]
//   --out  also saves a screenshot of each paused phase there
// Exits non-zero if any check fails.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : null;
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 640 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.addInitScript(() => {
  // a background tab gets no animation frames: let the test freeze rAF
  const raf = window.requestAnimationFrame.bind(window);
  window.__frozen = false;
  window.__pending = [];
  window.requestAnimationFrame = (cb) => (window.__frozen ? (window.__pending.push(cb), 0) : raf(cb));
});
await page.goto(`http://127.0.0.1:${port}/?autoplay=1&speed=1`);
await page.waitForFunction(() => !!window.__airfriend);

// Count the audio focus calls. Wrap the real methods if the audio lane has
// landed them, otherwise install recording stubs (main.ts looks them up on
// every call, so a stub added now is what it calls).
const realAudioApi = await page.evaluate(() => {
  const a = window.__airfriend.audio;
  const real = typeof a.setHidden === 'function' && typeof a.ensureRunning === 'function';
  const calls = (window.__audioCalls = { setHidden: [], ensureRunning: 0 });
  const origHidden = a.setHidden?.bind(a);
  const origRun = a.ensureRunning?.bind(a);
  a.setHidden = (h) => {
    calls.setHidden.push(h);
    origHidden?.(h);
  };
  a.ensureRunning = () => {
    calls.ensureRunning++;
    origRun?.();
  };
  return real;
});
// a gesture that maps to nothing: unlocks audio, must call ensureRunning
await page.keyboard.press('KeyQ');
await page.mouse.click(400, 300);

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
}

const audioCalls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__audioCalls)));
const ctxState = () => page.evaluate(() => window.__airfriend.audio.core?.ctx.state ?? null);
const snap = () =>
  page.evaluate(() => {
    const s = window.__airfriend.state;
    return { phase: s.phase, paused: s.paused, tick: s.tick };
  });

{
  const c = await audioCalls();
  check('ensureRunning called on keydown and pointerdown', c.ensureRunning >= 2, `calls ${c.ensureRunning}`);
}

/** restart and step synchronously until `phase` (and `extra`) hold */
async function reach(phase, extra = 'true') {
  return page.evaluate(
    ({ phase, extra }) => {
      const af = window.__airfriend;
      af.restart({ autoplay: true });
      const pred = new Function('s', `return ${extra};`);
      for (let i = 0; i < 60 * 60 * 30; i++) {
        const s = af.state;
        if (s.phase === phase && pred(s)) return true;
        if (s.phase === 'gameOver' && phase !== 'gameOver') return false;
        af.step(1);
      }
      return false;
    },
    { phase, extra },
  );
}

async function blur() {
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
}
async function focus() {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function hide() {
  await page.evaluate(() => {
    window.__frozen = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
async function show() {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.__frozen = false;
    document.dispatchEvent(new Event('visibilitychange'));
    for (const cb of window.__pending.splice(0)) requestAnimationFrame(cb);
  });
}

async function shot(name) {
  if (!outDir) return;
  await page.locator('#screen').screenshot({ path: path.join(outDir, `${name}.png`) });
}

// Faceoff before the drop, a whistle, live play, plus the other live phases.
const PHASES = [
  ['faceoff', 's.faceoff && !s.faceoff.dropped && s.phaseTime > 0.3'],
  ['stoppage', 's.phaseTime > 0.2'],
  ['play', 's.phaseTime > 3'],
  ['goal', 's.phaseTime > 0.3'],
  ['penalty', 's.phaseTime > 0.3'],
  ['periodEnd', 's.phaseTime > 0.2'],
];
const MODES = ['blur', 'hidden'];

for (const [phase, extra] of PHASES) {
  for (const mode of MODES) {
    const label = `${phase} / ${mode}`;
    if (!(await reach(phase, extra))) {
      // goal/penalty/periodEnd depend on how the AI game goes; the core three must exist
      const required = ['faceoff', 'stoppage', 'play'].includes(phase);
      check(`${label}: reached phase`, !required, required ? 'never reached' : 'skipped, not reached');
      continue;
    }
    const before = await snap();
    const callsBefore = (await audioCalls()).setHidden.length;
    if (mode === 'blur') await blur();
    else await hide();
    const left = await snap();
    let hiddenCtx = null;
    if (mode === 'hidden') {
      await page.waitForTimeout(300);
      hiddenCtx = await ctxState();
    }
    await page.waitForTimeout(800);
    if (mode === 'blur') await focus();
    else await show();
    await page.waitForTimeout(700);
    const back = await snap();
    if (mode === 'blur') await shot(`paused-${phase}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const resumed = await snap();
    const calls = await audioCalls();

    const ok =
      left.paused &&
      back.paused &&
      back.phase === before.phase &&
      back.tick === left.tick &&
      !resumed.paused &&
      resumed.tick > back.tick;
    check(
      label,
      ok,
      `paused ${left.paused}, after return paused ${back.paused} tick ${left.tick}->${back.tick}, ` +
        `after START paused ${resumed.paused} tick ${resumed.tick}`,
    );
    if (mode === 'hidden') {
      const sent = calls.setHidden.slice(callsBefore);
      check(`${label}: setHidden(true) then setHidden(false)`, sent.join() === 'true,false', `got [${sent}]`);
      if (realAudioApi) check(`${label}: AudioContext suspended while hidden`, hiddenCtx === 'suspended', `ctx ${hiddenCtx}`);
    }
  }
}

// Intermission and the final screen have nothing at stake (and START there
// means skip / rematch), so leaving must not pause them. Audio still goes.
for (const phase of ['intermission', 'gameOver']) {
  if (!(await reach(phase, 's.phaseTime > 0.2'))) {
    check(`${phase}: reached phase`, false, 'never reached');
    continue;
  }
  const callsBefore = (await audioCalls()).setHidden.length;
  await blur();
  await hide();
  const s = await snap();
  await show();
  await focus();
  const sent = (await audioCalls()).setHidden.slice(callsBefore);
  check(`${phase}: blur/hide does not pause`, !s.paused, `paused ${s.paused}`);
  check(`${phase}: setHidden still called`, sent.join() === 'true,false', `got [${sent}]`);
}

console.log(`audio focus API: ${realAudioApi ? 'real AudioEngine methods' : 'stubs (audio lane not landed yet)'}`);
check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await server.close();
console.log(failures.length ? `${failures.length} check(s) FAILED` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
