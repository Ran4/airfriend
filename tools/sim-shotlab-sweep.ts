// Parameter sweep for the human corner-shot tuning (SHOT in src/config.ts),
// e.g. GRID='{"cornerX":[0.64,0.68],"tapErr":[0.018,0.024]}':
// corner tap / half windup from the slot vs a set IGOR. Throwaway-ish helper
// kept next to sim-shotlab.ts.   ./node_modules/.bin/tsx tools/sim-shotlab-sweep.ts [trials]
import { SHOT } from '../src/config';
import { emptyPad } from '../src/core/input';
import { createGame, stepGame } from '../src/sim/game';
import { mulberry32, rand, setRandom } from '../src/sim/util';
import type { GameState, PadState } from '../src/types';
const N = Number(process.argv[2] ?? 300);
const GL = 26.5;
type Dir = { left?: boolean; right?: boolean };
const B = (h: boolean, prev: boolean) => ({ held: h, pressed: h && !prev, released: !h && prev });
function P(d: Dir, shoot?: [boolean, boolean]): PadState {
  const p = emptyPad();
  Object.assign(p, { left: !!d.left, right: !!d.right });
  if (shoot) p.shoot = B(shoot[0], shoot[1]);
  return p;
}
function freeze(st: GameState) {
  for (const s of st.skaters) if (s.kind !== 'goalie' && s.id !== 0) (s.pos = { x: s.team ? 12 : -12, z: -20 + s.id }), (s.vel = { x: 0, z: 0 });
}
function trial(seed: number, hold: number, far = false): string {
  setRandom(mulberry32(seed * 7919 + 13));
  const x = far ? 0 : (rand() * 2 - 1) * 1.0;
  const out = far ? 10 : 5 + rand() * 2;
  const side: Dir = rand() < 0.5 ? { left: true } : { right: true };
  setRandom(mulberry32(seed));
  const st = createGame({ autoplay: false, ai: true });
  st.phase = 'play'; st.tick = 100; st.referee.state = 'skate';
  const d = st.skaters[0];
  for (let i = 0; i < 42; i++) {
    freeze(st); d.pos = { x, z: GL - out }; d.vel = { x: 0, z: 0 }; d.facing = Math.atan2(-x, out); st.puck.owner = 0;
    stepGame(st, P({}));
  }
  let prev = false;
  for (let i = 0; i <= hold + 1; i++) { const h = i <= hold; freeze(st); stepGame(st, P(side, [h, prev])); prev = h; if (st.puck.owner !== 0 && h) break; }
  let post = false;
  for (let i = 0; i < 90; i++) {
    freeze(st); stepGame(st, P({}));
    for (const e of st.events) { if (e.type === 'goal') return 'goal'; if (e.type === 'save') return 'save'; if (e.type === 'post') post = true; }
    if (st.phase !== 'play') return 'dead';
  }
  return post ? 'post' : 'miss';
}
const S = SHOT as unknown as Record<string, number>;
const grid = JSON.parse(process.env.GRID ?? '{"cornerX":[0.64,0.68,0.72],"chargeErr":[0.035,0.039,0.045]}') as Record<string, number[]>;
const keys = Object.keys(grid);
const combos: Record<string, number>[] = [{}];
for (const k of keys) { const next: Record<string, number>[] = []; for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v }); combos.splice(0, combos.length, ...next); }
for (const c of combos) {
  Object.assign(S, c);
  const r: string[] = [];
  for (const [hold, far] of [[0, false], [27, false], [54, true]] as const) {
    const t: Record<string, number> = {};
    for (let i = 0; i < N; i++) { const o = trial(7000 + i, hold, far); t[o] = (t[o] ?? 0) + 1; }
    r.push(`${far ? 'full@10' : hold ? 'half' : 'tap '} ${(((t.goal ?? 0) / N) * 100).toFixed(1).padStart(5)}% (post ${t.post ?? 0} miss ${t.miss ?? 0})`);
  }
  console.log(JSON.stringify(c).padEnd(40), r.join('   '));
}
