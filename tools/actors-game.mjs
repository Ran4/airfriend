#!/usr/bin/env node
// Stage actors inside the REAL game (real arena, camera, post) headlessly.
// Modeled on tools/playtest.mjs. A scenario is JS that runs in the page:
//   setup(api)        once after load (api = window.__airfriend)
//   tick(state, t)    every sim tick, before stepGame (via setPadOverride);
//                     may mutate skaters and call emit(event)
// emit(e) injects a GameEvent so audio/HUD/renderer receive it after the tick.
//
//   node tools/actors-game.mjs --scenario tools/actors-scn-boards.js --shots 1,2 --out tools/out/actors-game

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const scenario = fs.readFileSync(opt('scenario'), 'utf8');
const shots = opt('shots', '1').split(',').map(Number);
const out = opt('out', 'tools/out/actors-game');
const params = opt('params', 'mute=1');
const evalExpr = opt('eval', '');
const glOnly = args.includes('--gl-only'); // capture the 3D canvas without the HUD
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[console.${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
await page.goto(`http://127.0.0.1:${port}/?${params}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 15000 });

await page.evaluate((src) => {
  const api = window.__airfriend;
  const scn = new Function(`${src}; return { setup: typeof setup === 'function' ? setup : null, tick: typeof tick === 'function' ? tick : null };`)();
  // event injection: queued events are appended to state.events after the
  // sim's own clear, whichever way the sim clears it
  const pending = [];
  window.emit = (e) => pending.push(e);
  const hook = (st) => {
    if (st.__actorsHooked) return;
    st.__actorsHooked = true;
    let inner = st.events;
    Object.defineProperty(st, 'events', {
      configurable: true,
      get() {
        if (pending.length) inner.push(...pending.splice(0));
        return inner;
      },
      set(v) {
        inner = v;
      },
    });
  };
  hook(api.state);
  scn.setup?.(api);
  const t0 = api.state.time;
  api.setPadOverride((st) => {
    hook(st);
    scn.tick?.(st, st.time - t0);
    return api.emptyPad();
  });
}, scenario);

const t0 = Date.now();
for (const t of shots) {
  const wait = t * 1000 - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  const data = await page.evaluate((glOnly) => {
    const src = new Image();
    return new Promise((res) => {
      src.onload = () => {
        const c = document.createElement('canvas');
        c.width = 768;
        c.height = 672;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(src, 0, 0, 768, 672);
        res({ native: src.src, x3: c.toDataURL('image/png') });
      };
      src.src = glOnly ? document.querySelector('#screen canvas').toDataURL('image/png') : window.__airfriend.capture();
    });
  }, glOnly);
  const tag = String(t).replace('.', '_');
  fs.writeFileSync(path.join(out, `shot-${tag}.png`), Buffer.from(data.native.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(out, `shot-${tag}-x3.png`), Buffer.from(data.x3.split(',')[1], 'base64'));
}
if (evalExpr) console.log('EVAL:', JSON.stringify(await page.evaluate(evalExpr).catch((e) => `eval error: ${e.message}`), null, 1));
console.log(`OUT: ${out}`);
console.log(logs.length ? logs.join('\n') : '[no console errors]');
await browser.close();
await server.close();
