#!/usr/bin/env node
// Saves every HUD preview scenario as its own PNG (native + 3x nearest).
//   node tools/hud-shoot.mjs [--only goal] [--out tools/out/hud]
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
const out = opt('out', 'tools/out/hud');
const only = opt('only', '');
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
page.on('pageerror', (e) => logs.push(`${e.message}\n${e.stack}`));
await page.goto(`http://127.0.0.1:${port}/tools/hud-preview.html${only ? `?only=${encodeURIComponent(only)}` : ''}`);
await page.waitForFunction(() => !!window.__hudShots, null, { timeout: 20000 }).catch(() => logs.push('no __hudShots'));
const shots = await page.evaluate(async () => {
  const res = [];
  for (const s of window.__hudShots ?? []) {
    const img = new Image();
    await new Promise((r) => ((img.onload = r), (img.src = s.url)));
    const c = document.createElement('canvas');
    c.width = 768;
    c.height = 672;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, 768, 672);
    res.push({ name: s.name, native: s.url, x3: c.toDataURL('image/png') });
  }
  return res;
});
for (const s of shots) {
  const slug = s.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  fs.writeFileSync(path.join(out, `${slug}.png`), Buffer.from(s.native.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(out, `${slug}-x3.png`), Buffer.from(s.x3.split(',')[1], 'base64'));
}
console.log(`${shots.length} scenarios -> ${out}`);
console.log(logs.length ? logs.join('\n') : '[no errors]');
await browser.close();
await server.close();
