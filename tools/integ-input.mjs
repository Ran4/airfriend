#!/usr/bin/env node
// Keyboard input check for src/core/input.ts, run through the real game loop
// in headless Chromium (never shows a window). Records every PadState the
// loop polls (window.__airfriend.input.poll is wrapped), then checks:
//   aliases  ArrowRight held + a KeyD tap keeps right held (move.x stays full);
//            Z held + J pressed/released makes no second shoot edge, and the
//            button is released only when the last of its keys goes up
//   chords   Ctrl/Meta/Alt + a mapped key or hotkey is not defaultPrevented,
//            fires no button and toggles nothing (Ctrl+L, Ctrl+S, Ctrl+V,
//            Meta+M, Alt+D...); a plain V still toggles CRT
//   sticky   a key let go while Ctrl is down is still released; a key first
//            pressed inside a chord is picked up once the chord ends (repeat)
//   blur     window blur drops every held key
// Exits non-zero if any check fails.
//
// Usage: node tools/integ-input.mjs

import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 640 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/?mute=1`);
await page.waitForFunction(() => !!window.__airfriend);

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
}

// record pads, PAL's barks and what the page did with each keydown
await page.evaluate(() => {
  const af = window.__airfriend;
  const log = (window.__log = []);
  const poll = af.input.poll.bind(af.input);
  af.input.poll = () => {
    const p = poll();
    log.push({ pad: JSON.parse(JSON.stringify(p)), tick: af.state.tick });
    return p;
  };
  const onEvents = af.audio.onEvents.bind(af.audio);
  window.__barks = 0;
  af.audio.onEvents = (events, state) => {
    for (const e of events) if (e.type === 'bark' && e.skaterId === state.controlledId) window.__barks++;
    return onEvents(events, state);
  };
  // registered after Input's listener, so it sees Input's verdict
  window.__keys = [];
  window.addEventListener('keydown', (e) => window.__keys.push({ code: e.code, prevented: e.defaultPrevented }));
  window.__mark = (m) => log.push({ mark: m });
});

await page.waitForFunction(() => window.__airfriend.state.phase === 'play', null, { timeout: 90000 });

const wait = (ms) => page.waitForTimeout(ms);
const mark = (m) => page.evaluate((m) => window.__mark(m), m);
/** wait until the loop has polled at least n more pads */
async function ticks(n = 4) {
  const start = await page.evaluate(() => window.__log.length);
  await page.waitForFunction((t) => window.__log.length >= t, start + n, { timeout: 30000 });
}
/** pads polled between two marks */
const pads = (from, to) =>
  page.evaluate(
    ({ from, to }) => {
      const l = window.__log;
      const a = l.findIndex((e) => e.mark === from);
      const b = to ? l.findIndex((e) => e.mark === to) : l.length;
      return l.slice(a + 1, b).filter((e) => e.pad).map((e) => e.pad);
    },
    { from, to },
  );
const moveX = () =>
  page.evaluate(() => {
    const s = window.__airfriend.state;
    return { phase: s.phase, x: s.skaters[s.controlledId].intent.move.x };
  });

// --- aliases: direction ---------------------------------------------------
await page.keyboard.down('ArrowRight');
await ticks(6);
const before = await moveX();
await mark('d0');
await page.keyboard.down('KeyD');
await ticks(3);
await page.keyboard.up('KeyD');
await ticks(6);
await mark('d1');
const after = await moveX();
await page.keyboard.up('ArrowRight');
await ticks(3);
await mark('d2');
{
  const held = await pads('d0', 'd1');
  check('ArrowRight held + KeyD tap: right stays held every tick', held.length > 0 && held.every((p) => p.right), `${held.filter((p) => !p.right).length}/${held.length} ticks dropped`);
  const live = (p) => p === 'play' || p === 'faceoff';
  check(
    'ArrowRight held + KeyD tap: move.x stays at full',
    !live(after.phase) || Math.abs(after.x) > 0.99,
    `before ${before.x.toFixed(2)} (${before.phase}), after ${after.x.toFixed(2)} (${after.phase})`,
  );
  const rel = await pads('d1', 'd2');
  check('right released once the last alias goes up', rel.length > 0 && !rel[rel.length - 1].right);
}

// --- aliases: buttons -----------------------------------------------------
await mark('s0');
await page.keyboard.down('KeyZ');
await ticks(4);
await page.keyboard.down('KeyJ');
await ticks(4);
await page.keyboard.up('KeyZ');
await ticks(4);
await mark('s1');
await page.keyboard.up('KeyJ');
await ticks(4);
await mark('s2');
{
  const p = await pads('s0', 's1');
  const presses = p.filter((x) => x.shoot.pressed).length;
  const releases = p.filter((x) => x.shoot.released).length;
  check('Z held, J pressed, Z released: exactly one shoot press edge', presses === 1, `presses ${presses}`);
  // from the press edge on: under load a tick can be polled between mark('s0') and the Z keydown arriving
  const fromPress = p.slice(Math.max(0, p.findIndex((x) => x.shoot.pressed)));
  check('...no release while J still holds it', releases === 0 && fromPress.length > 0 && fromPress.every((x) => x.shoot.held), `releases ${releases}, unheld ticks ${fromPress.filter((x) => !x.shoot.held).length}`);
  const q = await pads('s1', 's2');
  check('...released when J goes up', q.filter((x) => x.shoot.released).length === 1 && !q[q.length - 1].shoot.held);
}
// same for pass (X/K) and turbo (C/L)
for (const [a, b, btn] of [
  ['KeyX', 'KeyK', 'pass'],
  ['KeyC', 'KeyL', 'turbo'],
]) {
  await mark(`${btn}0`);
  await page.keyboard.down(a);
  await ticks(3);
  await page.keyboard.down(b);
  await ticks(3);
  await page.keyboard.up(a);
  await ticks(3);
  await page.keyboard.up(b);
  await ticks(3);
  await mark(`${btn}1`);
  const p = await pads(`${btn}0`, `${btn}1`);
  const presses = p.filter((x) => x[btn].pressed).length;
  const releases = p.filter((x) => x[btn].released).length;
  check(`${a} + ${b} overlapped: one ${btn} press, one release`, presses === 1 && releases === 1, `presses ${presses}, releases ${releases}`);
}
// a quick tap shorter than a tick still registers
await mark('t0');
await page.keyboard.press('KeyK');
await ticks(3);
await mark('t1');
{
  const p = await pads('t0', 't1');
  check('a quick KeyK tap still gives one pass press', p.filter((x) => x.pass.pressed).length === 1);
}

// --- chords ---------------------------------------------------------------
const chord = (code, key, mods) =>
  page.evaluate(
    ({ code, key, mods }) => {
      const init = { code, key, cancelable: true, bubbles: true, ...mods };
      const e = new KeyboardEvent('keydown', init);
      window.dispatchEvent(e);
      window.dispatchEvent(new KeyboardEvent('keyup', init));
      return e.defaultPrevented;
    },
    { code, key, mods },
  );
const crt = () => page.evaluate(() => document.getElementById('screen').classList.contains('crt'));
const muted = () => page.evaluate(() => window.__airfriend.audio.muted);
{
  const crt0 = await crt();
  const mute0 = await muted();
  const barks0 = await page.evaluate(() => window.__barks);
  await mark('c0');
  const cases = [
    ['KeyL', 'l', { ctrlKey: true }],
    ['KeyS', 's', { ctrlKey: true }],
    ['KeyD', 'd', { ctrlKey: true }],
    ['KeyP', 'p', { ctrlKey: true }],
    ['KeyJ', 'j', { ctrlKey: true }],
    ['KeyK', 'k', { ctrlKey: true }],
    ['KeyA', 'a', { ctrlKey: true }],
    ['KeyV', 'v', { ctrlKey: true }],
    ['KeyM', 'm', { metaKey: true }],
    ['KeyL', 'l', { metaKey: true }],
    ['KeyD', 'd', { altKey: true }],
    ['ArrowLeft', 'ArrowLeft', { altKey: true }],
    ['Enter', 'Enter', { altKey: true }],
  ];
  for (const [code, key, mods] of cases) {
    const prevented = await chord(code, key, mods);
    const m = Object.keys(mods)[0].replace('Key', '');
    check(`${m}+${code} is left to the browser`, !prevented);
  }
  await ticks(6);
  await mark('c1');
  const p = await pads('c0', 'c1');
  const any = (x) => x.up || x.down || x.left || x.right || ['shoot', 'pass', 'turbo', 'start'].some((b) => x[b].held || x[b].pressed);
  check('chords fire no pad input', p.length > 0 && !p.some(any), `${p.filter(any).length} pads with input`);
  check('Ctrl+L does not bark', (await page.evaluate(() => window.__barks)) === barks0);
  check('Ctrl+V does not toggle CRT, Meta+M does not toggle mute', (await crt()) === crt0 && (await muted()) === mute0);
  check('game is not paused by Alt+Enter', !(await page.evaluate(() => window.__airfriend.state.paused)));
  // plain hotkeys and mapped keys still work
  const prevV = await chord('KeyV', 'v', {});
  await ticks(2);
  check('plain V still toggles CRT', (await crt()) !== crt0);
  await chord('KeyV', 'v', {});
  await ticks(2);
  const prevArrow = await chord('ArrowUp', 'ArrowUp', {});
  check('plain ArrowUp is still defaultPrevented (no page scroll)', prevArrow && !prevV);
  // Shift is not a chord: Shift+Z still shoots
  await mark('sh0');
  await chord('KeyZ', 'Z', { shiftKey: true });
  await ticks(3);
  await mark('sh1');
  check('Shift+Z still shoots', (await pads('sh0', 'sh1')).filter((x) => x.shoot.pressed).length === 1);
}

// --- sticky keys ----------------------------------------------------------
await mark('k0');
await page.keyboard.down('ArrowLeft');
await ticks(3);
await page.keyboard.down('Control');
await page.keyboard.up('ArrowLeft'); // keyup arrives with ctrlKey set
await ticks(3);
await page.keyboard.up('Control');
await ticks(3);
await mark('k1');
{
  const p = await pads('k0', 'k1');
  check('a key released while Ctrl is down does not stick', p.some((x) => x.left) && !p[p.length - 1].left);
}
await mark('r0');
const repeat = await page.evaluate(() => {
  const ev = (type, init) => window.dispatchEvent(new KeyboardEvent(type, { code: 'ArrowUp', key: 'ArrowUp', cancelable: true, bubbles: true, ...init }));
  ev('keydown', { ctrlKey: true }); // Ctrl+ArrowUp: the browser's
  window.__mark('r1');
  ev('keydown', { repeat: true }); // Ctrl let go, ArrowUp still down
  return true;
});
await ticks(3);
await mark('r2');
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp', key: 'ArrowUp', bubbles: true })));
await ticks(3);
await mark('r3');
{
  const held = await pads('r1', 'r2');
  const rel = await pads('r2', 'r3');
  check('a key first pressed inside a chord is picked up when the chord ends', repeat && held.length > 0 && held[held.length - 1].up);
  check('...and released on keyup', rel.length > 0 && !rel[rel.length - 1].up);
}

// --- blur -----------------------------------------------------------------
await page.keyboard.down('KeyC');
await page.keyboard.down('ArrowDown');
await ticks(3);
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await mark('b0');
await ticks(3);
await mark('b1');
{
  const p = await pads('b0', 'b1');
  check('blur drops every held key', p.length > 0 && !p.some((x) => x.down || x.turbo.held));
}
await page.keyboard.up('KeyC');
await page.keyboard.up('ArrowDown');

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
await server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall input checks passed');
process.exit(failures.length ? 1 : 0);
