#!/usr/bin/env node
// Audio robustness in the real game page (headless Chromium, no window):
//
//   1. setHidden(true/false) suspends / resumes the AudioContext and holds the
//      music; a real background tab (another page brought to front) does the
//      same through main.ts's visibilitychange handler, and nothing is
//      scheduled while hidden.
//   2. ensureRunning() (main.ts calls it on every keydown/pointerdown) brings
//      back a context the browser suspended behind our back.
//   3. onEvents with malformed events and NaN params doesn't throw.
//   4. M is remembered across reloads (localStorage 'airfriend.muted'), and an
//      explicit ?mute=1 forces mute without touching the saved preference.
//
//   node tools/audio-focus.mjs [--out tools/out/audio-focus]
//
// Exits 1 on any failed check; writes focus.json and a muted-HUD capture.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const out = opt('out', 'tools/out/audio-focus');
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const results = [];
let failed = 0;
const check = (name, ok, info) => {
  results.push({ name, ok: !!ok, info });
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`);
};
const snap = () =>
  page.evaluate(() => {
    const a = window.__airfriendAudio;
    const c = a.core?.ctx;
    return {
      vis: document.visibilityState,
      ctx: c?.state ?? null,
      t: c ? +c.currentTime.toFixed(3) : null,
      held: a.musicHeld,
      hidden: a.hidden,
      muted: a.muted,
      master: a.core ? +a.core.master.gain.value.toFixed(3) : null,
      stored: localStorage.getItem('airfriend.muted'),
      starts: window.__starts ?? 0,
      faults: Object.keys(window.__airfriend.faults()).filter((k) => k !== 'simFailStreak'),
    };
  });
const waitCtx = (state) => page.waitForFunction((s) => window.__airfriendAudio.core?.ctx.state === s, state, { timeout: 5000 }).then(() => true, () => false);
/** press M and wait for the frame that handles it */
const pressM = async () => {
  const m0 = await page.evaluate(() => window.__airfriendAudio.muted);
  await page.keyboard.press('KeyM');
  await page.waitForFunction((m) => window.__airfriendAudio.muted !== m, m0, { timeout: 5000 }).catch(() => {});
};
const load = async (params) => {
  await page.goto(base + (params ? `?${params}` : ''));
  await page.waitForFunction(() => !!window.__airfriend && !!window.__airfriendAudio);
};

// ---------------------------------------------------------------- focus ----
await page.addInitScript(() => {
  // emulated tab visibility (see the background-tab check)
  let hidden = null;
  const realHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;
  const realState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get;
  Object.defineProperty(document, 'hidden', { configurable: true, get() { return hidden ?? realHidden.call(this); } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return hidden === null ? realState.call(this) : hidden ? 'hidden' : 'visible'; } });
  window.setVisibility = (h) => {
    hidden = h ? true : null;
    document.dispatchEvent(new Event('visibilitychange'));
  };
});
await load('autoplay=1');
await page.keyboard.press('ShiftLeft'); // first input: unlock
check('first key: context running', await waitCtx('running'), await snap());
await page.evaluate(() => {
  window.__starts = 0;
  const o = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function (...a) {
    window.__starts++;
    return o.apply(this, a);
  };
});
// let a cue (intro theme) get going so there is music to hold
await page.waitForTimeout(800);

await page.evaluate(() => window.__airfriendAudio.setHidden(true));
const sus = await waitCtx('suspended');
let s = await snap();
check('setHidden(true): suspended, music held', sus && s.held === true, s);
await page.evaluate(() => window.__airfriendAudio.setHidden(false));
const run = await waitCtx('running');
await page.waitForTimeout(150); // a frame: update() releases the music
s = await snap();
check('setHidden(false): running, music released', run && s.held === false, s);

// a background tab: main.ts's visibilitychange -> setHidden(document.hidden).
// Headless Chromium doesn't always hide a page when another is brought to
// front; then the visibility flip is emulated (same event, same handler).
const other = await ctx.newPage();
await other.goto('about:blank');
await other.bringToFront();
const realHide = await page.waitForFunction(() => document.hidden, null, { timeout: 2000 }).then(() => true, () => false);
if (!realHide) await page.evaluate(() => setVisibility(true));
console.log(`     (tab hide: ${realHide ? 'real' : 'emulated visibilitychange'})`);
const susReal = await waitCtx('suspended');
const h0 = await snap();
await page.waitForTimeout(2500);
const h1 = await snap();
check('background tab: suspended', h0.vis === 'hidden' && susReal && h1.ctx === 'suspended', h1);
check('background tab: clock frozen, nothing scheduled', h1.t === h0.t && h1.starts === h0.starts, { dt: h1.t - h0.t, starts: h1.starts - h0.starts });
await other.close();
await page.bringToFront();
if (!realHide) await page.evaluate(() => setVisibility(false));
check('tab shown again: running', await waitCtx('running'), await snap());

// suspended behind our back, statechange auto-resume off: the next key resumes
await page.evaluate(async () => {
  const c = window.__airfriendAudio.core.ctx;
  window.__onsc = c.onstatechange;
  c.onstatechange = null;
  await c.suspend();
});
s = await snap();
await page.keyboard.press('ShiftLeft');
const back = await waitCtx('running');
check('foreign suspend: next key resumes (ensureRunning)', s.ctx === 'suspended' && back, { before: s.ctx, after: (await snap()).ctx });
// and with the statechange watcher on, it comes back by itself
await page.evaluate(async () => {
  const c = window.__airfriendAudio.core.ctx;
  c.onstatechange = window.__onsc;
  await c.suspend();
});
check('foreign suspend: statechange resumes', await waitCtx('running'), await snap());
check('focus API never throws', await page.evaluate(() => {
  const a = window.__airfriendAudio;
  try {
    a.setHidden(true);
    a.setHidden(true);
    a.ensureRunning(); // hidden: must not resume
    const stillSuspendedIntent = a.hidden;
    a.setHidden(false);
    a.ensureRunning();
    a.ensureRunning();
    return stillSuspendedIntent;
  } catch {
    return false;
  }
}));
await waitCtx('running');

// ------------------------------------------------------------ robustness ----
const robust = await page.evaluate(() => {
  const a = window.__airfriendAudio;
  const st = window.__airfriend.state;
  const before = a.stats.played.whistle ?? 0;
  try {
    a.onEvents([{ type: 'shot', shooter: 0, power: NaN }, { type: 'check', hitter: 7, victim: 99, force: Infinity, knockedDown: true }, { type: 'boards' }, null, { type: 'goal' }, { type: 'whistle', reason: 'offIce' }], st);
  } catch (e) {
    return { threw: String(e) };
  }
  return { threw: null, whistlePlayed: (a.stats.played.whistle ?? 0) - before, eventErrors: a.stats.eventErrors, last: a.stats.lastEventError };
});
check('onEvents(malformed) does not throw; valid whistle still plays', robust.threw === null && robust.whistlePlayed === 1, robust);

// ------------------------------------------------------------------ mute ----
await pressM();
s = await snap();
check('M mutes and saves', s.muted === true && s.stored === '1', s);
await load('autoplay=1');
s = await snap();
check('reload: still muted before any input', s.muted === true && s.ctx === null, s);
await page.keyboard.press('ShiftLeft');
await waitCtx('running');
await page.waitForTimeout(300);
s = await snap();
check('reload: context starts silent', s.master === 0, s);
fs.writeFileSync(path.join(out, 'muted-hud.png'), Buffer.from((await page.evaluate(() => window.__airfriend.capture())).split(',')[1], 'base64'));
await pressM();
s = await snap();
check('M unmutes and saves', s.muted === false && s.stored === '0', s);
await load('autoplay=1');
s = await snap();
check('reload: unmuted', s.muted === false, s);

// ?mute=1 forces mute and leaves the saved preference alone
await page.evaluate(() => localStorage.setItem('airfriend.muted', '1'));
await load('autoplay=1&mute=1');
s = await snap();
check('?mute=1 with saved mute: muted, saved value kept', s.muted === true && s.stored === '1', s);
await page.evaluate(() => localStorage.setItem('airfriend.muted', '0'));
await load('autoplay=1&mute=1');
s = await snap();
check('?mute=1 with saved unmute: muted, saved value kept', s.muted === true && s.stored === '0', s);
await pressM();
s = await snap();
check('?mute=1 session: M toggles, nothing saved', s.muted === false && s.stored === '0', s);

// storage that throws (blocked site data): defaults to unmuted, M still works
await page.addInitScript(() => {
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
});
await load('autoplay=1');
s = await page.evaluate(() => {
  const a = window.__airfriendAudio;
  const m0 = a.muted;
  let m1;
  try {
    m1 = a.toggleMute();
  } catch (e) {
    return { threw: String(e) };
  }
  return { m0, m1 };
});
check('storage blocked: no throw, M works', s.m0 === false && s.m1 === true, s);

const finalFaults = await page.evaluate(() => Object.keys(window.__airfriend.faults()).filter((k) => k !== 'simFailStreak'));
check('no audio faults, no page errors', !finalFaults.includes('audio') && errors.length === 0, { faults: finalFaults, errors });

fs.writeFileSync(path.join(out, 'focus.json'), JSON.stringify({ failed, results }, null, 1));
console.log(failed ? `${failed} FAILED` : 'all ok', '->', out);
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
