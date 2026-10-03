// Master-chain transfer measurement: steady sines and short clicks at known
// levels through AudioCore's master chain (OfflineAudioContext). Prints
// input -> output peaks to window.__chainReport.
//   node tools/playtest.mjs --page /tools/audio-chain.html --seconds 8 --eval "window.__chainReport" --out tools/out/audio

import { AudioCore } from '../src/audio/core';

const SR = 32000;

async function run(kind: 'sine' | 'click', amp: number, at = 0.5): Promise<number> {
  const ctx = new OfflineAudioContext(2, SR * 1, SR);
  const core = new AudioCore(ctx, { safetyClip: false });
  const g = ctx.createGain();
  g.connect(core.master);
  if (kind === 'sine') {
    const o = ctx.createOscillator();
    o.frequency.value = 440;
    o.connect(g);
    g.gain.value = amp;
    o.start(0);
  } else {
    // 4 ms noise-ish click at 0.5 s, like a stick tap
    const b = ctx.createBuffer(1, 128, SR);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (i % 2 ? 1 : -1) * Math.exp(-i / 40);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(g);
    g.gain.value = amp;
    s.start(at);
  }
  const out = await ctx.startRendering();
  const L = out.getChannelData(0);
  let m = 0;
  for (let i = kind === 'sine' ? Math.floor(SR * 0.4) : 0; i < L.length; i++) m = Math.max(m, Math.abs(L[i]));
  return Math.round(m * 1000) / 1000;
}

async function main(): Promise<void> {
  const rows: string[] = [];
  for (const kind of ['sine', 'click'] as const) {
    for (const a of [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.2, 2]) rows.push(`${kind} in ${a} -> out ${await run(kind, a)}`);
  }
  // compressor start-up state: the same click on the very first render quantum
  for (const at of [0, 0.02, 0.05, 0.1, 0.2, 0.3]) rows.push(`click@t=${at} in 0.1 -> out ${await run('click', 0.1, at)}`);
  (window as unknown as { __chainReport: string[] }).__chainReport = rows;
}
void main();
