// Large-sample balance report for the offensive-zone game: shots, goals, win %, offensive-
// zone possession time, hits and penalties by team. Runs games in parallel worker processes.
//
//   npx tsx tools/ai-ozstats.ts bot [games=120] [seeds=12] [skill=1] [seed0=1]
//   npx tsx tools/ai-ozstats.ts ai  [games=60]  [seeds=12]           [seed0=1]
//
// bot = the pad-only scripted human (tools/ai-bot-lib.ts) plays PAL; ai = autoplay.
// The games are split evenly over `seeds` workers, worker i seeded seed0 + i.
//
// OZ possession: starts when a team's skater owns the puck 1 m (ENTRY_DEPTH) inside its offensive zone and ends at
// that team's shot, the other team touching the puck, a whistle/goal, or the puck leaving the
// zone. "oz" is the mean length (s), "ozT" the total zone time a game (s).
import { spawn } from 'node:child_process';
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';
import { isGoalie } from '../src/sim/query';
import { attackGoalZ } from '../src/sim/rink';
import { RINK } from '../src/config';
import { aiMem } from '../src/ai/memory';
import { botPad, configureBot, newBot } from './ai-bot-lib';
import type { Skater } from '../src/types';
const isDef = (s: Skater) => (s.position === 'LD' || s.position === 'RD' ? 1 : 0);

interface Agg {
  n: number;
  w: number;
  l: number;
  t: number;
  g: number[];
  s: number[];
  hits: number[];
  pen: number[];
  ozN: number[];
  ozT: number[];
  ozShot: number[];
  ozPass: number[];
  dShots: number[];
  kidHits: number[];
  carrierHits: number[];
  palHits: number;
  /** OZ possession endings, [team * END.length + reason] */
  ends: number[];
  /** sustained possessions (shots don't end them): count, time, shots in them */
  susN: number[];
  susT: number[];
  susShots: number[];
  /** sustained possession length histogram [team * HIST.length + bucket] */
  susHist: number[];
  /** sustained possession endings, [team * SUS_END.length + reason] */
  susEnds: number[];
  /** OZ passes by kind [team * 4 + (fromD * 2 + toD)], sent and received */
  pk: number[];
  pkOk: number[];
  /** carrier ticks in the OZ, and of those protecting (ai/ozone.ts) */
  carryTicks: number[];
  protTicks: number[];
}
const END = ['shot', 'poked', 'checked', 'intercepted', 'loose', 'whistle', 'exit'];
/** a possession starts once the puck is this far (m) inside the blue line (no blue-line hover blips) */
const ENTRY_DEPTH = 1;
const HIST = [0.5, 1, 2, 3, 5, 8, Infinity];
const SUS_END = ['goalie', 'defense after shot', 'poked', 'intercepted', 'defense loose', 'whistle', 'exit'];
const blank = (): Agg => ({ n: 0, w: 0, l: 0, t: 0, g: [0, 0], s: [0, 0], hits: [0, 0], pen: [0, 0], ozN: [0, 0], ozT: [0, 0], ozShot: [0, 0], ozPass: [0, 0], dShots: [0, 0], kidHits: [0, 0], carrierHits: [0, 0], palHits: 0, ends: new Array(END.length * 2).fill(0), susN: [0, 0], susT: [0, 0], susShots: [0, 0], susEnds: new Array(SUS_END.length * 2).fill(0), susHist: new Array(HIST.length * 2).fill(0), pk: new Array(8).fill(0), pkOk: new Array(8).fill(0), carryTicks: [0, 0], protTicks: [0, 0] });

function worker(mode: string, games: number, seed: number, skill: number): Agg {
  setRandom(mulberry32(seed));
  configureBot(seed, skill);
  const A = blank();
  for (let g = 0; g < games; g++) {
    const st = createGame({ autoplay: mode === 'ai' });
    const bot = newBot();
    let oz: { team: number; t: number; passAt: number } | null = null;
    const end = (why: string) => {
      if (!oz) return;
      A.ozN[oz.team]++;
      A.ozT[oz.team] += st.time - oz.t;
      if (why === 'shot') A.ozShot[oz.team]++;
      A.ends[oz.team * END.length + END.indexOf(why)]++;
      oz = null;
    };
    let sus: { team: number; t: number; shots: number; shotAt: number; passAt: number } | null = null;
    const endSus = (why: string) => {
      if (!sus) return;
      A.susEnds[sus.team * SUS_END.length + SUS_END.indexOf(why)]++;
      A.susHist[sus.team * HIST.length + HIST.findIndex((h) => st.time - sus!.t < h)]++;
      A.susN[sus.team]++;
      A.susT[sus.team] += st.time - sus.t;
      A.susShots[sus.team] += sus.shots;
      sus = null;
    };
    while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 25) {
      const lastOwner = st.puck.owner;
      stepGame(st, mode === 'ai' ? emptyPad() : botPad(st, bot));
      for (const e of st.events) {
        if (e.type === 'penalty') A.pen[e.penalty.team]++;
        if (e.type === 'check') {
          const h = st.skaters[e.hitter];
          if (h.kind === 'dog') A.palHits++;
          else A.kidHits[h.team]++;
          if (lastOwner === e.victim) A.carrierHits[h.team]++;
        }
        if (e.type === 'shot') {
          const sh = st.skaters[e.shooter];
          if (sh.position === 'LD' || sh.position === 'RD') A.dShots[sh.team]++;
        }
        if ((e.type === 'pass' || e.type === 'passReceived') && st.phase === 'play') {
          const fr = st.skaters[e.from];
          const to = e.to === null ? null : st.skaters[e.to];
          if (to && fr.team === to.team && !isGoalie(fr)) {
            const sign = Math.sign(attackGoalZ(fr.team, st.period));
            if (fr.pos.z * sign > RINK.blueLineZ && to.pos.z * sign > RINK.blueLineZ - 1) {
              const k = fr.team * 4 + isDef(fr) * 2 + isDef(to);
              if (e.type === 'pass') A.pk[k]++;
              else A.pkOk[k]++;
            }
          }
        }
        if (sus) {
          const u = sus as { team: number; t: number; shots: number; shotAt: number; passAt: number };
          if (e.type === 'shot' && st.skaters[e.shooter].team === u.team) {
            u.shots++;
            u.shotAt = st.time;
          } else if (e.type === 'pass' && st.skaters[e.from].team === u.team) u.passAt = st.time;
          else if (e.type === 'steal' && st.skaters[e.skaterId].team !== u.team) endSus('poked');
          else if (e.type === 'pickup' && st.skaters[e.skaterId].team !== u.team) {
            const p = st.skaters[e.skaterId];
            endSus(isGoalie(p) ? 'goalie' : st.time - u.shotAt < 2 ? 'defense after shot' : st.time - u.passAt < 1.2 ? 'intercepted' : 'defense loose');
          } else if (e.type === 'whistle' || e.type === 'goal') endSus('whistle');
        }
        if (!oz) continue;
        const o = oz as { team: number; t: number; passAt: number };
        if (e.type === 'pass' && st.skaters[e.from].team === o.team) {
          A.ozPass[o.team]++;
          o.passAt = st.time;
        }
        if (e.type === 'shot' && st.skaters[e.shooter].team === o.team) end('shot');
        else if (e.type === 'steal' && st.skaters[e.skaterId].team !== o.team) end('poked');
        else if (e.type === 'pickup' && st.skaters[e.skaterId].team !== o.team) end(st.time - o.passAt < 1.2 ? 'intercepted' : 'loose');
        else if (e.type === 'check' && st.skaters[e.hitter].team !== o.team && st.puck.owner === null) end('checked');
        else if (e.type === 'whistle' || e.type === 'goal') end('whistle');
      }
      if (sus && (st.phase !== 'play' || st.puck.pos.z * Math.sign(attackGoalZ((sus as { team: number }).team as 0 | 1, st.period)) < RINK.blueLineZ - 0.2)) endSus(st.phase !== 'play' ? 'whistle' : 'exit');
      if (oz && st.phase !== 'play') end('whistle');
      if (oz && st.puck.pos.z * Math.sign(attackGoalZ((oz as { team: number }).team as 0 | 1, st.period)) < RINK.blueLineZ - 0.2) end('exit');
      const ow = st.puck.owner;
      if (st.phase === 'play' && ow !== null && !isGoalie(st.skaters[ow])) {
        const c = st.skaters[ow];
        if (st.puck.pos.z * Math.sign(attackGoalZ(c.team, st.period)) > RINK.blueLineZ) {
          A.carryTicks[c.team]++;
          if (st.time < aiMem(st).brains[c.id].protectUntil) A.protTicks[c.team]++;
        }
      }
      if (st.phase === 'play' && ow !== null && !oz) {
        const c = st.skaters[ow];
        if (!isGoalie(c) && st.puck.pos.z * Math.sign(attackGoalZ(c.team, st.period)) > RINK.blueLineZ + ENTRY_DEPTH) oz = { team: c.team, t: st.time, passAt: -9 };
      }
      if (st.phase === 'play' && ow !== null && !sus) {
        const c = st.skaters[ow];
        if (!isGoalie(c) && st.puck.pos.z * Math.sign(attackGoalZ(c.team, st.period)) > RINK.blueLineZ + ENTRY_DEPTH) sus = { team: c.team, t: st.time, shots: 0, shotAt: -9, passAt: -9 };
      }
    }
    A.n++;
    if (st.winner === 0) A.w++;
    else if (st.winner === 1) A.l++;
    else A.t++;
    for (const k of [0, 1]) {
      A.g[k] += st.score[k];
      A.s[k] += st.shots[k];
      A.hits[k] += st.hits[k];
    }
  }
  return A;
}

function merge(a: Agg, b: Agg): Agg {
  const r = blank();
  for (const k of Object.keys(r) as (keyof Agg)[]) {
    if (Array.isArray(r[k]))
      (r[k] as number[]) = (a[k] as number[]).map((v, i) => v + (b[k] as number[])[i]);
    else (r[k] as number) = (a[k] as number) + (b[k] as number);
  }
  return r;
}

function report(label: string, A: Agg): void {
  const n = A.n;
  const f = (v: number, d = 1) => (v / n).toFixed(d);
  const oz = (k: number) => (A.ozT[k] / Math.max(1, A.ozN[k])).toFixed(2);
  console.log(`${label}  n=${n}`);
  console.log(`  W-L-T ${A.w}-${A.l}-${A.t}  home win ${((A.w / n) * 100).toFixed(1)}%`);
  console.log(`  goals  ${f(A.g[0], 2)} - ${f(A.g[1], 2)}  (tot ${f(A.g[0] + A.g[1], 2)})`);
  console.log(`  shots  ${f(A.s[0])} - ${f(A.s[1])}  (tot ${f(A.s[0] + A.s[1])})   D shots ${f(A.dShots[0])} - ${f(A.dShots[1])}`);
  console.log(`  hits   ${f(A.hits[0])} - ${f(A.hits[1])}   by kids ${f(A.kidHits[0])} - ${f(A.kidHits[1])}   PAL ${f(A.palHits)}   on the carrier ${f(A.carrierHits[0])} - ${f(A.carrierHits[1])}`);
  console.log(`  pens   ${f(A.pen[0], 2)} - ${f(A.pen[1], 2)}  (tot ${f(A.pen[0] + A.pen[1], 2)})`);
  console.log(
    `  OZ poss mean ${oz(0)} s - ${oz(1)} s   per game ${f(A.ozN[0])} - ${f(A.ozN[1])}   zone time/game ${f(A.ozT[0])} - ${f(A.ozT[1])} s   ` +
      `ending in a shot ${((A.ozShot[0] / Math.max(1, A.ozN[0])) * 100).toFixed(0)}% - ${((A.ozShot[1] / Math.max(1, A.ozN[1])) * 100).toFixed(0)}%   OZ passes/poss ${(A.ozPass[0] / Math.max(1, A.ozN[0])).toFixed(2)} - ${(A.ozPass[1] / Math.max(1, A.ozN[1])).toFixed(2)}`,
  );
  const su = (k: number) => (A.susT[k] / Math.max(1, A.susN[k])).toFixed(2);
  console.log(
    `  sustained OZ poss (shots don't end it) mean ${su(0)} s - ${su(1)} s   per game ${f(A.susN[0])} - ${f(A.susN[1])}   shots/poss ${(A.susShots[0] / Math.max(1, A.susN[0])).toFixed(2)} - ${(A.susShots[1] / Math.max(1, A.susN[1])).toFixed(2)}`,
  );
  for (const k of [0, 1])
    console.log(
      `  sustained length ${k ? 'away' : 'home'}: ${HIST.map((h, i) => `<${h === Infinity ? 'inf' : h}s ${((A.susHist[k * HIST.length + i] / Math.max(1, A.susN[k])) * 100).toFixed(0)}%`).join('  ')}`,
    );
  for (const k of [0, 1])
    console.log(`  sustained endings ${k ? 'away' : 'home'}/game: ${SUS_END.map((e, i) => `${e} ${f(A.susEnds[k * SUS_END.length + i])}`).join('  ')}`);
  const kinds = ['F>F', 'F>D', 'D>F', 'D>D'];
  for (const k of [0, 1])
    console.log(
      `  OZ passes ${k ? 'away' : 'home'}/game (received): ${kinds.map((n, i) => `${n} ${f(A.pk[k * 4 + i])} (${f(A.pkOk[k * 4 + i])})`).join('  ')}   protecting ${((A.protTicks[k] / Math.max(1, A.carryTicks[k])) * 100).toFixed(0)}% of OZ carry time`,
    );
  for (const k of [0, 1])
    console.log(`  OZ endings ${k ? 'away' : 'home'}/game: ${END.map((e, i) => `${e} ${f(A.ends[k * END.length + i])}`).join('  ')}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'worker') {
  const [mode, games, seed, skill] = rest;
  process.stdout.write(JSON.stringify(worker(mode, Number(games), Number(seed), Number(skill))));
} else {
  const mode = cmd === 'ai' ? 'ai' : 'bot';
  const games = Number(rest[0] ?? (mode === 'ai' ? 60 : 120));
  const seeds = Number(rest[1] ?? 12);
  const skill = mode === 'ai' ? 1 : Number(rest[2] ?? 1);
  const seed0 = Number(rest[mode === 'ai' ? 2 : 3] ?? 1);
  const per = Math.ceil(games / seeds);
  const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const self = new URL(import.meta.url).pathname;
  const jobs = Array.from({ length: seeds }, (_, i) =>
    new Promise<Agg>((res, rej) => {
      const p = spawn(tsx, [self, 'worker', mode, String(per), String(seed0 + i), String(skill)]);
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => process.stderr.write(d));
      p.on('close', (code) => (code === 0 ? res(JSON.parse(out) as Agg) : rej(new Error(`worker ${i} exited ${code}`))));
    }),
  );
  Promise.all(jobs).then((all) => report(mode === 'ai' ? 'AI vs AI' : `HUMAN BOT skill ${skill}`, all.reduce(merge, blank())));
}
