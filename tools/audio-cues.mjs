#!/usr/bin/env node
// The input-feedback cues in the real game (headless Chromium, no window),
// driven by the real keyboard through the real loop:
//
//   1. PASS (X) while a teammate carries -> 'callFor' event -> PAL's yip;
//      mashing X stays at <= 1 yip per 0.6 s while every press still calls.
//   2. A kid calling -> HEY!. The sim gives control to a home carrier at once
//      (and back to PAL while he's on the ice), so the human can't produce a
//      kid's call from the pad; the event goes through the live engine's
//      onEvents instead.
//   3. SHOOT held with the puck -> the charge pulse sounds and rises; releasing
//      (the shot) stops it, and so does a real control switch mid wind-up
//      (PAL sent to the box: updateControl hands the pad to a kid). After
//      10 wind-ups every charge voice has ended (no leaked nodes).
//   4. X before the puck drops at a faceoff -> 'falseStart' -> ref tweet.
//
//   node tools/audio-cues.mjs [--out tools/out/audio-cues]
//
// Reads window.__airfriendAudio.stats / .charge. Exits 1 on any failed check;
// writes cues.json.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const out = opt('out', 'tools/out/audio-cues');
fs.mkdirSync(out, { recursive: true });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const results = [];
let failed = 0;
const check = (name, ok, info) => {
  results.push({ name, ok: !!ok, info });
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`);
};
const played = (name) => page.evaluate((n) => window.__airfriendAudio.stats.played[n] ?? 0, name);
const cueEvents = (type) => page.evaluate((t) => window.__cueEvents.filter((e) => e.type === t).length, type);
/** wait n sim ticks of the real loop (wall clock drifts under SwiftShader) */
const ticks = async (n) => {
  const t0 = await page.evaluate(() => window.__airfriend.state.tick);
  await page.waitForFunction((t) => window.__airfriend.state.tick >= t, t0 + n, { timeout: 20000 });
};
/** stage: PAL (or `ctl`) controlled, skating, teammate `carrier` holds the puck nearby */
const stage = (ctl, carrier) =>
  page.evaluate(
    ({ ctl, carrier }) => {
      const st = window.__airfriend.state;
      st.controlledId = ctl;
      for (const s of st.skaters) if (s.state !== 'box' && s.kind !== 'goalie') s.state = 'skate';
      const c = st.skaters[carrier];
      c.pos.x = 3;
      c.pos.z = 0;
      c.vel.x = c.vel.z = 0;
      const me = st.skaters[ctl];
      me.pos.x = -3;
      me.pos.z = 0;
      me.vel.x = me.vel.z = 0;
      if (me.sim) me.sim.actionCd = 0;
      // opponents out of the way: nobody steals mid-test
      for (const s of st.skaters) if (s.team === 1 && s.kind !== 'goalie') { s.pos.x = -11; s.pos.z = -20 + s.id; s.vel.x = s.vel.z = 0; }
      st.puck.owner = carrier;
      st.puck.pos.x = c.pos.x;
      st.puck.pos.z = c.pos.z;
    },
    { ctl, carrier },
  );

await page.goto(base);
await page.waitForFunction(() => !!window.__airfriend && !!window.__airfriendAudio);
// record the cue events the engine sees (and keep the engine's own handling)
await page.evaluate(() => {
  const a = window.__airfriendAudio;
  window.__cueEvents = [];
  const orig = a.onEvents.bind(a);
  a.onEvents = (events, state) => {
    for (const e of events) if (e && (e.type === 'callFor' || e.type === 'falseStart' || e.type === 'shot' || e.type === 'controlSwitch')) window.__cueEvents.push({ ...e, tick: state.tick });
    return orig(events, state);
  };
});
// a key press unlocks the AudioContext (autoplay policy)
await page.keyboard.press('ArrowLeft');
await page.waitForFunction(() => window.__airfriendAudio.core?.ctx.state === 'running', null, { timeout: 10000 }).catch(() => {});
check('audio unlocked by a key press', await page.evaluate(() => window.__airfriendAudio.core?.ctx.state === 'running'));

// ------------------------------------------------- 4. false start (opener) --
// the opening faceoff: X before the drop is a false start
await page.waitForFunction(() => {
  const st = window.__airfriend.state;
  return st.phase === 'faceoff' && st.faceoff && !st.faceoff.dropped && st.phaseTime > 0.2;
}, null, { timeout: 30000 });
const fs0 = await played('falseStart');
await page.keyboard.press('KeyX');
await ticks(6);
const fsEv = await cueEvents('falseStart');
const fs1 = await played('falseStart');
check('X before the drop: falseStart event -> tweet', fsEv >= 1 && fs1 === fs0 + 1, { events: fsEv, tweets: fs1 - fs0 });

// fast-forward to live play
await page.evaluate(() => window.__airfriend.setSpeed(6));
await page.waitForFunction(() => window.__airfriend.state.phase === 'play' && !window.__airfriend.state.paused, null, { timeout: 60000 });
await page.evaluate(() => window.__airfriend.setSpeed(1));

// --------------------------------------------------------- 1. PAL calls ----
const y0 = await played('yip');
const c0 = await cueEvents('callFor');
for (let i = 0; i < 3; i++) {
  await stage(0, 1);
  await ticks(2);
  await page.keyboard.press('KeyX');
  await ticks(45); // > 0.6 s of sim time between calls
}
const y1 = await played('yip');
const c1 = await cueEvents('callFor');
const palCalls = await page.evaluate((n) => window.__cueEvents.filter((e) => e.type === 'callFor').slice(n), c0);
check('X while a teammate carries: callFor from PAL -> yip each time', c1 - c0 === 3 && y1 - y0 === 3 && palCalls.every((e) => e.skaterId === 0), { calls: c1 - c0, yips: y1 - y0, palCalls });

// mashed: 4 presses within ~0.3 s -> 4 calls, 1 yip
await stage(0, 1);
await ticks(2);
const y2 = await played('yip');
const c2 = await cueEvents('callFor');
for (let i = 0; i < 4; i++) {
  await stage(0, 1);
  await page.keyboard.press('KeyX');
  await ticks(4);
}
const y3 = await played('yip');
const c3 = await cueEvents('callFor');
check('mashed X: every press calls, one yip per 0.6 s', c3 - c2 >= 3 && y3 - y2 === 1, { calls: c3 - c2, yips: y3 - y2 });
await ticks(45);

// --------------------------------------------------------- 2. kid calls ----
const h0 = await played('hey');
const y4 = await played('yip');
await page.evaluate(() => window.__airfriendAudio.onEvents([{ type: 'callFor', kind: 'pass', skaterId: 2, carrier: 1 }], window.__airfriend.state));
const h1 = await played('hey');
const y5 = await played('yip');
check('a kid calls (engine onEvents): HEY!, not a yip', h1 === h0 + 1 && y5 === y4, { heys: h1 - h0, yips: y5 - y4 });

// ------------------------------------------------------- 3. the wind-up ----
const charge = () =>
  page.evaluate(() => {
    const a = window.__airfriendAudio;
    const st = window.__airfriend.state;
    return { active: a.charge.active, freq: Math.round(a.charge.freq), started: a.charge.started, ended: a.charge.ended, state: st.skaters[st.controlledId].state, windup: +st.skaters[st.controlledId].windup.toFixed(2), ctl: st.controlledId };
  });
const base0 = await charge();
const winds = [];
for (let i = 0; i < 10; i++) {
  await stage(0, 0); // PAL carries
  await ticks(2);
  await page.keyboard.down('KeyZ');
  await ticks(8);
  const early = await charge();
  await ticks(22);
  const late = await charge();
  const viaSwitch = i % 3 === 2;
  let sw0 = 0;
  if (viaSwitch) {
    // control switch mid wind-up: PAL goes to the box, the sim hands the
    // pad to a kid (controlSwitch) and the tone must stop with it
    sw0 = await cueEvents('controlSwitch');
    await page.evaluate(() => {
      const st = window.__airfriend.state;
      const d = st.skaters[0];
      d.state = 'box';
      d.pos.x = 14.6;
      d.pos.z = -4.6;
      d.vel.x = d.vel.z = 0;
      st.puck.owner = null;
      st.penalties.push({ skaterId: 0, team: 0, infraction: 'ROUGHING', duration: 30, remaining: 30, major: false });
    });
    await ticks(2);
  } else await page.keyboard.up('KeyZ');
  await ticks(3);
  const after = await charge();
  if (viaSwitch) {
    after.switched = (await cueEvents('controlSwitch')) > sw0;
    await page.keyboard.up('KeyZ');
    await page.evaluate(() => {
      const st = window.__airfriend.state;
      st.penalties = st.penalties.filter((p) => p.skaterId !== 0);
      st.skaters[0].state = 'skate';
      st.skaters[0].pos.x = 0;
      st.skaters[0].pos.z = 0;
    });
    await page.waitForFunction(() => window.__airfriend.state.controlledId === 0, null, { timeout: 10000 }).catch(() => {});
  }
  winds.push({ i, how: viaSwitch ? 'controlSwitch' : 'shot', early, late, after });
  await ticks(20);
}
await ticks(30);
const endC = await charge();
const sounding = winds.every((w) => w.early.active && w.late.active && w.late.freq > w.early.freq && w.early.freq >= 300 && w.late.freq <= 900);
check('SHOOT held with the puck: charge pulse on, pitch rises with the charge', sounding, winds.map((w) => `${w.early.freq}->${w.late.freq}Hz`));
check('the pulse stops on the shot', winds.filter((w) => w.how === 'shot').every((w) => !w.after.active), winds.filter((w) => w.how === 'shot').map((w) => w.after));
check('the pulse stops on a control switch (PAL boxed mid wind-up)', winds.filter((w) => w.how === 'controlSwitch').every((w) => !w.after.active && w.after.switched && w.after.ctl !== 0), winds.filter((w) => w.how === 'controlSwitch').map((w) => w.after));
check('10 wind-ups: every charge voice ended (no leaked nodes)', endC.started - base0.started === 10 && endC.ended === endC.started && !endC.active, { before: base0, after: endC });
const shots = await cueEvents('shot');
check('releases were real shots', shots >= 6, { shots });

const faults = await page.evaluate(() => Object.keys(window.__airfriend.faults()).filter((k) => k !== 'simFailStreak'));
check('no loop faults', faults.length === 0, faults);
check('no page errors', errors.length === 0, errors.slice(0, 5));

fs.writeFileSync(path.join(out, 'cues.json'), JSON.stringify({ results, winds, errors }, null, 1));
console.log(`${results.length - failed}/${results.length} ok -> ${path.join(out, 'cues.json')}`);
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
