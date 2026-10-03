// QA (audio): spectral flatness (noise-like 1 .. tonal 0) and top-peak share for crowd one-shots, bed and bark.
import { AudioEngine } from '../src/audio/audio';
import type { GameState, Skater } from '../src/types';
const SR = 32000;
function fakeState(): GameState {
  const skaters = Array.from({ length: 10 }, (_, id) => ({ id, team: id < 5 ? 0 : 1, kind: id ? 'kid' : 'dog', pos: { x: 0, z: 0 } })) as unknown as Skater[];
  return { phase: 'play', period: 1, skaters, puck: { pos: { x: 0, z: 0 }, owner: null }, referee: { pos: { x: 0, z: 0 } }, penalties: [], controlledId: 0, events: [] } as unknown as GameState;
}
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = (-2 * Math.PI) / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const wr = Math.cos(ang * k), wi = Math.sin(ang * k); const a = i + k + len / 2; const ar = re[a] * wr - im[a] * wi, ai = re[a] * wi + im[a] * wr; re[a] = re[i + k] - ar; im[a] = im[i + k] - ai; re[i + k] += ar; im[i + k] += ai; } }
}
function analyze(x: Float32Array, from: number, to: number) {
  const n = 4096; const acc = new Float64Array(n / 2); let frames = 0;
  for (let c = from * SR; c + n < to * SR; c += n / 2) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = x[c + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    fft(re, im); for (let i = 0; i < n / 2; i++) acc[i] += re[i] * re[i] + im[i] * im[i]; frames++;
  }
  const lo = Math.round((150 * n) / SR), hi = Math.round((3000 * n) / SR);
  let lg = 0, ar = 0; const p: number[] = [];
  for (let i = lo; i < hi; i++) { const v = acc[i] / frames + 1e-20; lg += Math.log(v); ar += v; p.push(v); }
  const m = hi - lo; const flat = Math.exp(lg / m) / (ar / m);
  p.sort((a, b) => b - a); let top = 0; for (let i = 0; i < Math.round(m * 0.02); i++) top += p[i];
  return { flatness: +flat.toFixed(3), top2pctShare: +(top / ar).toFixed(2) };
}
async function render(dur: number, f: (e: AudioEngine) => void, ambience = false) {
  const ctx = new OfflineAudioContext(1, SR * dur, SR);
  const e = new AudioEngine({ context: ctx, ambience, seed: 11 }); e.unlock(); f(e);
  return (await ctx.startRendering()).getChannelData(0);
}
async function main() {
  const out: Record<string, unknown> = {};
  for (const k of ['ooh', 'aww', 'boo', 'cheer', 'roar'] as const) out[k] = analyze(await render(4, (e) => (e.crowd as any)[k](0.3)), 0.4, k === 'cheer' ? 1.0 : 1.6);
  out['bed 0.5'] = analyze(await render(3, (e) => e.crowd!.setLevel(0.5, 0, 0.02), true), 0.5, 2.9);
  out['bark'] = analyze(await render(1, (e) => e.onEvents([{ type: 'bark', skaterId: 0, startled: [] } as any], fakeState())), 0.2, 0.42);
  out['theme (ref: pure music)'] = analyze(await render(6, (e) => { e.playCue('theme', 0.25); for (let t = 0.1; t < 6; t += 0.1) e.pump(); }), 0.5, 5.5);
  (window as any).__qa = out;
}
main().catch((e) => ((window as any).__qa = String(e.stack)));
