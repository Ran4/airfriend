// Is the faceoff drop audible? Plays the real game loop (autoplay, speed 1)
// headless and, at every puck drop, records what the music is doing:
//   - musicRms: RMS (dBFS) of the music bus at the drop instant, from an
//     AnalyserNode tapped onto it (fan-out only, the mix is untouched)
//   - playing: a cue still playing un-faded just before the drop
//   - gains: output gain of every music player (current + fading)
// A drop passes when no cue is playing and the music bus is below -45 dBFS.
//
//   node tools/audio-drop.mjs [seconds=200] [--out tools/out/audio-drop] [--random-drop]
//
// --random-drop rewrites state.faceoff.dropTime at each lineup to the
// gameplay contract's randomized range (0.8-1.6 s, 1.9-2.5 s on period
// openers), for runs before the sim randomizes it itself.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'tools/out/audio-drop';
const randomDrop = args.includes('--random-drop');
const seconds = Number(args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--out') ?? 200);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?autoplay=1`);
await page.waitForFunction(() => !!window.__airfriend);
await page.keyboard.press('ShiftLeft'); // unlocks audio
await page.waitForFunction(() => !!window.__airfriendAudio?.core);
await page.evaluate((randomDrop) => {
  const a = window.__airfriendAudio;
  const an = a.core.ctx.createAnalyser();
  an.fftSize = 1024; // ~21 ms at 48 kHz
  a.core.music.connect(an);
  const buf = new Float32Array(an.fftSize);
  const rmsDb = () => {
    an.getFloatTimeDomainData(buf);
    let e = 0;
    for (const v of buf) e += v * v;
    return +(10 * Math.log10(e / buf.length + 1e-12)).toFixed(1);
  };
  const snap = () => {
    const ps = [a.player, ...a.fading].filter(Boolean);
    return { cue: a.cue, playing: !!a.player && !a.player.stopped, gains: ps.map((p) => +p.out.gain.value.toFixed(2)) };
  };
  window.__drops = [];
  window.__musicPeak = -120; // proves the tap hears the music at all
  let prev = false;
  let pre = null;
  let lineup = null;
  let lastPhase = null;
  let fromPhase = null;
  setInterval(() => {
    const s = window.__airfriend.state;
    if (s.phase !== lastPhase) {
      fromPhase = lastPhase;
      lastPhase = s.phase;
    }
    if (randomDrop && s.phase === 'faceoff' && s.faceoff && !s.faceoff.dropped && lineup !== s.faceoff) {
      lineup = s.faceoff;
      const opener = fromPhase === null || fromPhase === 'intro' || fromPhase === 'intermission';
      s.faceoff.dropTime = opener ? 1.9 + Math.random() * 0.6 : 0.8 + Math.random() * 0.8;
    }
    window.__musicPeak = Math.max(window.__musicPeak, rmsDb());
    const d = s.phase === 'faceoff' && !!s.faceoff?.dropped;
    if (s.phase === 'faceoff' && !d) pre = { ...snap(), phaseTime: +s.phaseTime.toFixed(2) };
    if (d && !prev) {
      window.__drops.push({ time: +s.time.toFixed(1), period: s.period, from: fromPhase, dropTime: s.faceoff.dropTime, musicRms: rmsDb(), before: pre, at: snap() });
    }
    prev = d;
  }, 5);
}, randomDrop);
await page.waitForTimeout(seconds * 1000);
const drops = await page.evaluate(() => window.__drops);
const musicPeak = await page.evaluate(() => window.__musicPeak);
await browser.close();
await server.close();

const QUIET = -45;
for (const d of drops) d.ok = !d.before?.playing && d.musicRms < QUIET;
const ok = drops.filter((d) => d.ok).length;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'drops.json'), JSON.stringify(drops, null, 1));
for (const d of drops) {
  console.log(`${d.ok ? 'ok ' : 'BAD'} t=${d.time} P${d.period} (${d.from}) drop@${(+d.dropTime).toFixed(2)} music ${d.musicRms} dBFS  before: ${d.before?.cue ?? '-'} playing=${d.before?.playing} gains=[${d.before?.gains}] @${d.before?.phaseTime}`);
}
console.log(`loudest music seen during the run: ${musicPeak} dBFS RMS`);
console.log(`${ok}/${drops.length} drops with the music faded out${errors.length ? `\npage errors: ${errors.join(' | ')}` : ''}`);
