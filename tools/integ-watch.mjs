#!/usr/bin/env node
// Integration soak: plays a whole game in headless Chromium through the REAL
// main loop (rendered every frame, fast-forwarded with ?speed=N) and
// screenshots on sim events and phase changes, so every cross-module seam is
// seen in context: intro, faceoffs, goals, penalties + the box, big hits,
// periods 1/2/3, intermission, final, pause, and a keyboard rematch.
//
//   node tools/integ-watch.mjs [--out tools/out/integ/watch] [--speed 6]
//        [--params "autoplay=1"] [--max 300]   (max = wall seconds)
//        [--setup "js"]  runs in the page once the game exists (stage a state,
//                  e.g. a tied 3rd period about to end, to see overtime)
//        [--bot]   PAL is played through the PAD by tools/ai-bot-lib.ts (a
//                  scripted human) instead of autoplay; implies params=""
//
// Shots land in <out>/<sim-time>-<name>.png (+ -x3.png). Prints a timeline,
// event counts, console errors, and the audio engine status.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const out = opt('out', 'tools/out/integ/watch');
const speed = Number(opt('speed', '6'));
const bot = args.includes('--bot');
const extra = opt('params', bot ? 'mute=0' : 'autoplay=1');
const maxWall = Number(opt('max', '300'));
const setupJs = opt('setup', '');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } }); // hmr off: other edits must not reload the page mid-run
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(`http://127.0.0.1:${port}/?${extra}&speed=${speed}`);
await page.waitForFunction(() => !!window.__airfriend, null, { timeout: 20000 });
if (setupJs) await page.evaluate(setupJs);
// first key unlocks audio (an unmapped key so it doesn't touch the game)
await page.keyboard.press('KeyQ');
if (bot) {
  await page.evaluate(async () => {
    const m = await import('/tools/ai-bot-lib.ts');
    m.configureBot(7, 1);
    const b = m.newBot();
    window.__botOn = () => window.__airfriend.setPadOverride((st) => m.botPad(st, b));
    window.__botOff = () => window.__airfriend.setPadOverride(null);
    window.__botOn();
  });
}
const botOff = () => bot && page.evaluate(() => window.__botOff());
const botOn = () => bot && page.evaluate(() => window.__botOn());

await page.evaluate(() => {
  const A = window.__airfriend;
  const W = (window.__watch = { shots: [], pending: [], count: {}, timeline: [], lastPhase: '', done: false });
  const st = () => A.state;
  // sim seconds after the trigger at which to capture
  const T = {
    introStart: [0.4, 1.6, 2.8],
    faceoffDrop: [0.05],
    goal: [0.1, 0.9, 2.2, 3.4],
    penalty: [0.4, 2.2],
    check: [0.15],
    post: [0.1],
    save: [0.1],
    bark: [0.1],
    hardStop: [0.08],
    periodEnd: [0.5],
    intermissionStart: [0.5, 4],
    gameOver: [0.5, 3],
    clockWarning: [0.2],
    controlSwitch: [0.2],
    falseStart: [0.2],
    penaltyExpired: [0.2],
    fumble: [0.1],
  };
  const LIMIT = { goal: 4, check: 2, save: 2, bark: 2, hardStop: 1, clockWarning: 1, faceoffDrop: 3, penalty: 3, controlSwitch: 2, penaltyExpired: 2, post: 2, fumble: 1 };
  const want = (name, at) => W.pending.push({ name, at });
  const hook = (s) => {
    let cur = s.events;
    Object.defineProperty(s, 'events', {
      configurable: true,
      get: () => cur,
      // stepGame assigns a fresh array and then pushes into it, so each set
      // hands us the PREVIOUS tick's complete list
      set: (v) => {
        const done = cur;
        cur = v;
        for (const e of done) {
          W.count[e.type] = (W.count[e.type] ?? 0) + 1;
          if (e.type === 'check' && !e.knockedDown) continue;
          if (e.type === 'shot' && e.power > 0.7 && (W.count.bigShot = (W.count.bigShot ?? 0) + 1) <= 2) want(`shot-p${e.power.toFixed(2)}`, s.time + 0.06);
          const d = T[e.type];
          if (!d) continue;
          const n = (W.count['_' + e.type] = (W.count['_' + e.type] ?? 0) + 1);
          if (n > (LIMIT[e.type] ?? 9)) continue;
          if (e.type === 'penalty') W.boxWatch = { id: e.penalty.skaterId, n };
          for (const dd of d) want(`${e.type}${n}-${dd}`, s.time + dd);
          W.timeline.push(`${s.time.toFixed(1)} p${s.period} ${e.type}${e.type === 'goal' ? ` team${e.info.team} #${s.skaters[e.info.scorer].name}` : ''}${e.type === 'penalty' ? ` ${s.skaters[e.penalty.skaterId].name} ${e.penalty.infraction}` : ''}`);
        }
      },
    });
  };
  hook(st());
  let lastPlayShot = 0;
  const loop = () => {
    const s = st();
    if (s.phase !== W.lastPhase) {
      W.timeline.push(`${s.time.toFixed(1)} p${s.period} phase ${W.lastPhase} -> ${s.phase}`);
      // first live play of each period, and the first faceoff of periods 2+
      if (s.phase === 'faceoff' && (W.count['_fo' + s.period] = (W.count['_fo' + s.period] ?? 0) + 1) === 1) want(`p${s.period}-faceoff`, s.time + 0.6);
      W.lastPhase = s.phase;
    }
    // a boxed skater: capture once play resumes with them in the box
    if (W.boxWatch && s.phase === 'play' && s.skaters[W.boxWatch.id].state === 'box') {
      want(`box${W.boxWatch.n}`, s.time + 1.5);
      W.boxWatch = null;
    }
    if (s.phase === 'play' && s.time - lastPlayShot > 25) {
      lastPlayShot = s.time;
      want(`play-p${s.period}`, s.time);
    }
    const due = W.pending.filter((p) => s.time >= p.at);
    for (const p of due) {
      W.pending.splice(W.pending.indexOf(p), 1);
      W.shots.push({ name: p.name, t: s.time, phase: s.phase, url: A.capture() });
    }
    requestAnimationFrame(loop);
  };
  // registered after main.ts's own rAF, so we capture right after it renders
  requestAnimationFrame(loop);
});

const t0 = Date.now();
const flush = async () => {
  const shots = await page.evaluate(() => window.__watch.shots.splice(0));
  for (const s of shots) {
    const tag = `${s.t.toFixed(1).padStart(6, '0')}-${s.name}`.replace(/[^a-z0-9.\-]+/gi, '_');
    const buf = Buffer.from(s.url.split(',')[1], 'base64');
    fs.writeFileSync(path.join(out, `${tag}.png`), buf);
  }
  return shots.length;
};
const S = (fn, a) => page.evaluate(fn, a);
let paused = false;
let rematched = false;
let audioInfo = null;
for (;;) {
  await page.waitForTimeout(400);
  await flush();
  const s = await S(() => {
    const st = window.__airfriend.state;
    return { phase: st.phase, time: st.time, period: st.period, paused: st.paused, phaseTime: st.phaseTime };
  });
  // pause once with a real key press, mid-play in period 1
  if (!paused && s.phase === 'play' && s.time > 30) {
    paused = true;
    await botOff();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await S(() => window.__watch.shots.push({ name: 'pause', t: window.__airfriend.state.time, phase: 'pause', url: window.__airfriend.capture() }));
    audioInfo = await S(() => {
      const a = window.__airfriendAudio;
      return a ? { ctx: a.core?.ctx?.state, played: Object.keys(a.stats?.played ?? {}).length, cues: a.stats?.cues?.slice(-5) } : 'no __airfriendAudio';
    });
    await page.keyboard.press('Enter');
    // let main.ts poll the keyboard once before the bot's pad replaces it
    await page.waitForTimeout(200);
    await botOn();
  }
  if (s.phase === 'gameOver' && s.phaseTime > 4 && !rematched) {
    rematched = true;
    await botOff();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    await S(() => window.__watch.shots.push({ name: 'rematch-0_2s', t: window.__airfriend.state.time, phase: window.__airfriend.state.phase, url: window.__airfriend.capture() }));
    await page.waitForTimeout(2500);
    await S(() => window.__watch.shots.push({ name: 'rematch-2_7s', t: window.__airfriend.state.time, phase: window.__airfriend.state.phase, url: window.__airfriend.capture() }));
    await flush();
    break;
  }
  if ((Date.now() - t0) / 1000 > maxWall) {
    logs.push(`[harness] wall limit reached in phase ${s.phase} p${s.period}`);
    break;
  }
}
await flush();
const W = await S(() => ({ timeline: window.__watch.timeline, count: window.__watch.count }));
const fin = await S(() => {
  const s = window.__airfriend.state;
  const a = window.__airfriendAudio;
  return { phase: s.phase, period: s.period, score: s.score, time: +s.time.toFixed(1), audio: a ? { ctx: a.core?.ctx?.state, dropped: a.stats?.dropped, cues: a.stats?.cues } : null };
});
// 3x upscales for viewing
await page.close();
const up = await browser.newPage();
for (const f of fs.readdirSync(out).filter((f) => f.endsWith('.png') && !f.endsWith('-x3.png'))) {
  const b64 = fs.readFileSync(path.join(out, f)).toString('base64');
  const x3 = await up.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width * 3;
    c.height = img.height * 3;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }, b64);
  fs.writeFileSync(path.join(out, f.replace('.png', '-x3.png')), Buffer.from(x3.split(',')[1], 'base64'));
}
console.log(W.timeline.join('\n'));
console.log('COUNTS', JSON.stringify(Object.fromEntries(Object.entries(W.count).filter(([k]) => !k.startsWith('_')))));
console.log('AUDIO@pause', JSON.stringify(audioInfo));
console.log('FINAL', JSON.stringify(fin));
console.log(logs.length ? logs.slice(0, 30).join('\n') : '[no console errors]');
console.log(`wall ${((Date.now() - t0) / 1000).toFixed(0)} s, shots in ${out}`);
await browser.close();
await server.close();
