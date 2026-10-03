#!/usr/bin/env node
// Fullscreen toggle through the real page (headless): F and double-click enter
// and leave fullscreen, entering doesn't trip the leave-the-game auto-pause,
// the picture re-fits, and the pause screen shows the switch.
//
//   node tools/integ-fullscreen.mjs [--out tools/out/fullscreen]

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'tools/out/fullscreen';
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/?test=1&mute=1`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};
const fsOn = () => page.evaluate(() => !!document.fullscreenElement);
const snap = () =>
  page.evaluate(() => ({ phase: window.__airfriend.state.phase, paused: window.__airfriend.state.paused }));

await page.goto(url);
await page.waitForFunction(() => window.__airfriend?.state.phase === 'play', null, { timeout: 60000 });

await page.keyboard.press('KeyF');
await page.waitForTimeout(400);
check(await fsOn(), 'F enters fullscreen');
const s1 = await snap();
check(!s1.paused, `entering fullscreen does not auto-pause (phase ${s1.phase})`);

// pause screen shows the switch; capture() is the native 256x224 frame
await page.keyboard.press('KeyP');
await page.waitForTimeout(400);
const png = await page.evaluate(() => window.__airfriend.capture());
fs.writeFileSync(path.join(out, 'pause-fullscreen.png'), Buffer.from(png.split(',')[1], 'base64'));
check((await snap()).paused, 'P pauses while fullscreen');
await page.keyboard.press('KeyP');

await page.keyboard.press('KeyF');
await page.waitForTimeout(400);
check(!(await fsOn()), 'F leaves fullscreen');

await page.mouse.dblclick(512, 384);
await page.waitForTimeout(400);
check(await fsOn(), 'double-click enters fullscreen');
await page.mouse.dblclick(512, 384);
await page.waitForTimeout(400);
check(!(await fsOn()), 'double-click leaves fullscreen');

// Ctrl+F is the browser's find, never ours
await page.keyboard.press('Control+KeyF');
await page.waitForTimeout(200);
check(!(await fsOn()), 'Ctrl+F is left to the browser');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
console.log(`pause screen: ${path.join(out, 'pause-fullscreen.png')}`);
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
