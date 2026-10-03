// Crowd-bed level during real play (headless Chromium, no window): samples
// window.__airfriendAudio.crowd.level every 200 ms from the node side, so a
// page reload (vite HMR while other files change) costs samples, not the run.
// Prints the live-play distribution (crowd.ts / audio.ts updateCrowd cap it at
// 0.65) and the engine's event-error counter, and writes levels.json.
//
//   node tools/audio-levels.mjs --seconds 90 [--speed 1] --out tools/out/audio-levels
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const seconds = Number(opt('seconds', 90));
const speed = Number(opt('speed', 1));
const out = opt('out', 'tools/out/audio-levels');
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/?autoplay=1&speed=${speed}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.__airfriend);
await page.keyboard.press('ShiftLeft'); // the gesture that unlocks audio

const samples = [];
let last = null;
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  await page.waitForTimeout(200);
  const s = await page
    .evaluate(() => {
      const a = window.__airfriendAudio;
      const st = window.__airfriend?.state;
      return a && st ? { phase: st.phase, level: a.crowd.level, time: st.time, eventErrors: a.stats.eventErrors, played: a.stats.played } : null;
    })
    .catch(() => null);
  if (!s) {
    // reloaded: unlock audio again
    await page.keyboard.press('ShiftLeft').catch(() => {});
    continue;
  }
  samples.push([s.phase, s.level]);
  last = s;
}
const play = samples.filter((x) => x[0] === 'play').map((x) => x[1]).sort((a, b) => a - b);
const q = (f) => (play.length ? +play[Math.floor(f * (play.length - 1))].toFixed(2) : null);
const r = {
  gameTime: last && +last.time.toFixed(1),
  samples: samples.length,
  playSamples: play.length,
  crowdInPlay: { p10: q(0.1), p50: q(0.5), p90: q(0.9), max: q(1), fracAbove06: play.length ? +(play.filter((x) => x >= 0.6).length / play.length).toFixed(2) : null },
  crowdAllPhasesMax: samples.length ? +Math.max(...samples.map((x) => x[1])).toFixed(2) : null,
  eventErrors: last?.eventErrors,
  played: last?.played,
  pageErrors: errors,
};
fs.writeFileSync(path.join(out, 'levels.json'), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await browser.close();
await server.close();
