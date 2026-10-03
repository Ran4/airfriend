#!/usr/bin/env node
// Headless screenshots of tools/actors-preview.html scenarios (no window is
// ever shown). Deterministic: the preview is stepped at a fixed 60 Hz.
//
//   node tools/actors-shots.mjs [--scenes facings,anims] [--times 0.2,1] [--out tools/out/actors] [--x 3]
//
// Saves <scene>-<t>.png (256x224) and <scene>-<t>-x<k>.png (nearest upscale).

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const scenes = opt('scenes', 'facings,facings2,anims,overlap,perspective,wide,effects').split(',');
const times = opt('times', '0.3').split(',').map(Number);
const out = opt('out', 'tools/out/actors');
const k = Number(opt('x', '3'));
const extra = opt('params', '');
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[console.${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

for (const scene of scenes) {
  await page.goto(`http://127.0.0.1:${port}/tools/actors-preview.html?scene=${scene}${extra ? '&' + extra : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__preview, null, { timeout: 15000 }).catch(() => logs.push(`[harness] ${scene}: __preview never appeared`));
  let t = 0;
  for (const at of [...times].sort((a, b) => a - b)) {
    const data = await page
      .evaluate(
        ([dt, k]) => {
          window.__preview.advance(dt);
          const src = new Image();
          return new Promise((res) => {
            src.onload = () => {
              const c = document.createElement('canvas');
              c.width = 256 * k;
              c.height = 224 * k;
              const g = c.getContext('2d');
              g.imageSmoothingEnabled = false;
              g.drawImage(src, 0, 0, c.width, c.height);
              res({ native: src.src, big: c.toDataURL('image/png') });
            };
            src.src = window.__preview.capture();
          });
        },
        [at - t, k],
      )
      .catch((e) => (logs.push(`[harness] ${scene}@${at}: ${e.message}`), null));
    t = at;
    if (!data) continue;
    const tag = `${scene}-${String(at).replace('.', '_')}`;
    fs.writeFileSync(path.join(out, `${tag}.png`), Buffer.from(data.native.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(out, `${tag}-x${k}.png`), Buffer.from(data.big.split(',')[1], 'base64'));
  }
}
console.log(`OUT: ${out}`);
console.log(logs.length ? logs.join('\n') : '[no console errors]');
await browser.close();
await server.close();
