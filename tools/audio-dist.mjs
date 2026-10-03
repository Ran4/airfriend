#!/usr/bin/env node
// Production build: the window.__airfriendAudio debug handle exists only when
// gated (?test=1; a build has no import.meta.env.DEV). Serves dist/ with
// `vite preview` headless, presses a key (that creates the audio engine's
// context, where the handle used to be set unconditionally) and checks both
// page loads. Exits non-zero on a failed check.
//   npm run build && node tools/audio-dist.mjs
import { preview } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
  console.error('dist/ missing: run `npm run build` first');
  process.exit(1);
}
const server = await preview({ root, logLevel: 'error', preview: { port: 0, host: '127.0.0.1' } });
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};
async function probe(query) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const logs = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/${query}`);
  await page.waitForTimeout(1500);
  await page.keyboard.press('KeyQ'); // first keydown unlocks audio
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ handle: typeof window.__airfriendAudio, api: typeof window.__airfriend, ctx: window.__airfriendAudio?.core?.ctx.state ?? null }));
  await page.close();
  return { ...r, logs };
}
const t = await probe('?test=1');
check('?test=1: __airfriendAudio set after unlock', t.handle === 'object', JSON.stringify(t));
check('?test=1: no console errors', t.logs.length === 0, t.logs.join(' | '));
const p = await probe('');
check('player page: no __airfriendAudio', p.handle === 'undefined', JSON.stringify(p));
check('player page: no __airfriend', p.api === 'undefined');
check('player page: no console errors', p.logs.length === 0, p.logs.join(' | '));
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
