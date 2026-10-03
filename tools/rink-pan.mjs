// RINK agent: capture consecutive frames of a slow camera pan (pixel-snap check).
//   node tools/rink-pan.mjs <outdir>
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/tools/rink-preview.html`);
await page.waitForFunction(() => window.__rinkReady);
const frames = await page.evaluate(() => {
  window.__rink.show({ puck: { x: -3, z: 0 }, bare: true, snap: true, dog: { x: -3, z: 0 } });
  window.__rink.run(60, { x: 1.3, z: 0.4 });
  const out = [];
  for (let i = 0; i < 12; i++) {
    window.__rink.run(1, { x: 1.3, z: 0.4 });
    out.push(window.__rink.capture());
  }
  return out;
});
fs.mkdirSync(process.argv[2], { recursive: true });
frames.forEach((f, i) => fs.writeFileSync(`${process.argv[2]}/f${i}.png`, Buffer.from(f.split(',')[1], 'base64')));
await browser.close();
await server.close();
