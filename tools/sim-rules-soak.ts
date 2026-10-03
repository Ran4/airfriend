// Rules soak with the delayed-penalty lens: full games through stepGame with
// per-tick invariants, plus how delayed calls play out (how long the fouled
// team keeps playing, what ends the delay, what it does with the time).
//
//   ./node_modules/.bin/tsx tools/sim-rules-soak.ts [games=40] [seed=5] [humanBot=0] [botSkill=1]
//
// Derived from tools/qa-rules-soak.ts, minus its known false positives (the
// fixed 1.1 s faceoff, the clock zeroed by the 0.5 s horn grace, and the
// penalty / freeze "faceoff" that is really the next period's opening one).
import { createGame, PERIOD_END_GRACE, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { GOAL, RINK, RULES, SIM_DT } from '../src/config';
import { DELAYED_PENALTY_MAX } from '../src/sim/penalties';
import { mulberry32, setRandom } from '../src/sim/util';
import { attackDir, depthPastLine, ownGoalZ } from '../src/sim/rink';
import type { GameEvent, GameState } from '../src/types';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const games = Number(process.argv[2] ?? 40);
const seed = Number(process.argv[3] ?? 5);
const humanBot = process.argv[4] === '1';
if (humanBot) configureBot(seed, Number(process.argv[5] ?? 1));
setRandom(mulberry32(seed));

const issues: Record<string, { n: number; ex: string[] }> = {};
function issue(k: string, ex: string) {
  const r = (issues[k] ??= { n: 0, ex: [] });
  r.n++;
  if (r.ex.length < 4) r.ex.push(ex);
}
const stats: Record<string, number> = {};
const bump = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);
const durations: number[] = [];
const where = (st: GameState, g: number) => `g${g} t=${st.time.toFixed(2)} p${st.period} clk=${st.clock.toFixed(2)} ph=${st.phase}`;

for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: !humanBot });
  const bot = newBot();
  let ticks = 0;
  let lastStop: { reason: string; team?: number } | null = null;
  // the delay being watched
  let delay: { team: number; skaterId: number; t: number; fouledHadPuck: boolean; offZone: boolean; shots: number } | null = null;
  while (st.phase !== 'gameOver' && ticks < 60 * 60 * 40) {
    const G = st.sim!;
    const prevClock = st.clock;
    const prevPen = st.penalties.map((p) => p.remaining);
    const ph0 = st.phase;
    const pendBefore = G.pendingPenalties.length;
    const frozen0 = G.frozenBy;
    stepGame(st, humanBot ? botPad(st, bot) : emptyPad());
    ticks++;
    const evs = st.events as GameEvent[];
    const has = (t: GameEvent['type']) => evs.some((e) => e.type === t);

    // ---- clock and penalty clocks only in play (the horn grace may zero it on a whistle's end)
    const graceZero = st.clock === 0 && prevClock < PERIOD_END_GRACE && has('periodEnd');
    if (st.clock < prevClock && ph0 !== 'play' && !graceZero) issue('clock ran outside play', where(st, g) + ' from ' + ph0);
    st.penalties.forEach((p, i) => {
      if (prevPen[i] !== undefined && p.remaining < prevPen[i] - 1e-9 && ph0 !== 'play') issue('penalty clock outside play', where(st, g));
    });
    // ---- box bookkeeping
    for (const team of [0, 1]) {
      const n = st.penalties.filter((q) => q.team === team).length;
      if (n > 2) issue('more than 2 boxed', where(st, g));
      const boxed = st.skaters.filter((s) => s.team === team && s.state === 'box').length;
      if (boxed !== n) issue('boxed count != active penalties', where(st, g) + ` team${team} boxed=${boxed} pens=${n}`);
    }
    for (const q of st.penaltyQueue ?? []) {
      const n = st.penalties.filter((x) => x.team === q.team).length;
      if (n < 2 && !st.penalties.some((x) => x.skaterId === q.skaterId)) issue('queued penalty with free slot', where(st, g));
    }
    const p = st.puck;
    if (p.owner !== null && ['box', 'fallen'].includes(st.skaters[p.owner].state)) issue('puck owned by boxed/fallen', where(st, g));
    for (const sign of [1, -1]) {
      const d = depthPastLine(p.pos.z, sign);
      if (d > 0.05 && d < GOAL.depth - 0.05 && Math.abs(p.pos.x) < GOAL.halfWidth - 0.05 && p.y < GOAL.height - 0.1 && st.phase === 'play' && p.owner === null)
        issue('puck inside net during play (no goal)', where(st, g));
    }

    // ---- delayed penalty invariants
    const dp = st.delayedPenalty ?? null;
    const pend = G.pendingPenalties.length;
    if (st.phase !== 'play' && (dp || pend)) issue('delayed penalty outside play', where(st, g) + ` dp=${JSON.stringify(dp)} pend=${pend}`);
    if (st.phase === 'play' && !!dp !== pend > 0) issue('delayedPenalty / pending list disagree', where(st, g));
    if (dp) {
      if (st.time - dp.t > DELAYED_PENALTY_MAX + SIM_DT * 1.5) issue('delay longer than the max', where(st, g));
      if (p.owner !== null && G.pendingPenalties.some((q) => q.team === st.skaters[p.owner!].team)) issue('offender carries during a delay', where(st, g));
      if (st.referee.state !== 'point') issue('ref not pointing during a delay', where(st, g) + ` ref=${st.referee.state}`);
    }
    if (pendBefore && evs.some((e) => e.type === 'whistle' && (e.reason === 'freeze' || e.reason === 'offIce'))) issue('stoppage whistle while a call was pending', where(st, g));
    if (evs.some((e) => e.type === 'penalty') && pendBefore === 0 && !has('delayedPenalty') && ph0 === 'play') {
      // called at once: the offending team had the puck at the hit
      bump('callsImmediate');
    }

    // ---- delayed penalty stats
    for (const e of evs) {
      if (e.type !== 'delayedPenalty') continue;
      bump('delayedFouls');
      if (delay) {
        bump('secondFoulDuringDelay');
        continue;
      }
      // who had the puck at the foul (the victim's stick, or a teammate)
      const fouled = 1 - e.team;
      const lt = p.lastTouch !== null ? st.skaters[p.lastTouch] : null;
      const fouledHadPuck = (p.owner !== null && st.skaters[p.owner].team === fouled) || (p.owner === null && !!lt && lt.team === fouled);
      const along = p.pos.z * attackDir(fouled as 0 | 1, st.period);
      delay = { team: e.team, skaterId: e.skaterId, t: st.time, fouledHadPuck, offZone: along > RINK.blueLineZ, shots: 0 };
      bump('delays');
      if (fouledHadPuck) bump('delays_fouledHadPuck');
      if (delay.offZone) bump('delays_inFouledOffZone');
    }
    if (delay) for (const e of evs) if (e.type === 'shot' && st.skaters[e.shooter].team !== delay.team) delay.shots++;
    if (delay && !dp) {
      const dur = st.time - delay.t;
      durations.push(dur);
      let why: string;
      const goal = evs.find((e) => e.type === 'goal') as Extract<GameEvent, { type: 'goal' }> | undefined;
      const pickup = evs.find((e) => e.type === 'pickup' && st.skaters[e.skaterId].team === delay!.team) as { skaterId: number } | undefined;
      const save = evs.find((e) => e.type === 'save' && st.skaters[e.goalie].team === delay!.team);
      if (goal) {
        why = goal.info.team !== delay.team ? 'goalByFouled' : 'goalByOffender';
        if (!has('penalty')) bump('minorsCancelledByGoal');
      } else if (save) why = 'offenderGoalieSave';
      else if (pickup) why = pickup.skaterId === delay.skaterId ? 'pickupByOffender(self)' : 'pickupByOffenderTeam';
      else if (evs.some((e) => e.type === 'steal' && st.skaters[e.skaterId].team === delay!.team)) why = 'pokeStealByOffender';
      else if (dur >= DELAYED_PENALTY_MAX - 1e-6) why = 'timeout';
      else if (prevClock <= SIM_DT + 1e-9) why = 'horn';
      else if (frozen0 !== null) why = 'fouledGoalieFreeze';
      else if (Math.abs(p.pos.x) > RINK.halfWidth - 0.2 || Math.abs(p.pos.z) > RINK.halfLength - 0.2 || p.y > 1.2) why = 'puckOffIce';
      else why = 'otherOffenderTouch';
      bump(`end_${why}`);
      if (delay.fouledHadPuck) bump(`endFouledHadPuck_${why}`);
      bump('fouledShotsDuringDelay', delay.shots);
      if (dur < 0.1) bump('delays_under0.1s');
      if (dur >= 1) bump('delays_1s+');
      if (dur >= 3) bump('delays_3s+');
      if (st.phase !== 'penalty' && st.phase !== 'goal') issue('delay ended without a call or a goal', where(st, g));
      delay = null;
    }

    // ---- faceoff spots
    for (const e of evs) {
      if (e.type === 'whistle' && e.reason !== 'penalty') lastStop = { reason: e.reason };
      if (e.type === 'penalty') {
        bump('penalties');
        if (e.penalty.major) bump('majors');
        if (st.phase === 'penalty') lastStop = { reason: 'penalty', team: e.penalty.team };
      }
      if (e.type === 'goal') bump('goals');
      if (e.type === 'periodEnd') lastStop = null; // next faceoff is the period's opener
      if (e.type === 'faceoffSetup') {
        if (lastStop?.reason === 'penalty') {
          const gz = ownGoalZ(lastStop.team as 0 | 1, st.period);
          if (Math.sign(e.spot.z) !== Math.sign(gz) || Math.abs(e.spot.z) < 15) issue('penalty faceoff not in offender zone', where(st, g));
        }
        if (lastStop?.reason === 'goal' && (e.spot.x !== 0 || e.spot.z !== 0)) issue('faceoff after goal not at center', where(st, g));
        lastStop = null;
      }
    }
    if (st.phase === 'faceoff' && st.phaseTime > (st.faceoff?.dropTime ?? RULES.faceoffDropDelay) + 1.5) issue('faceoff too long', where(st, g));
  }
  if (st.phase !== 'gameOver') issue('game did not finish', `g${g} ${st.phase} p${st.period}`);
  bump('games');
  bump(`winner_${st.winner}`);
}
durations.sort((a, b) => a - b);
const q = (f: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(f * durations.length))].toFixed(2) : '-');
console.log('STATS', JSON.stringify(stats, null, 1));
console.log(`penalties/game ${((stats.penalties ?? 0) / games).toFixed(2)}   goals/game ${((stats.goals ?? 0) / games).toFixed(2)}`);
console.log(`delay length (s): n=${durations.length} p25=${q(0.25)} median=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} max=${q(1)}`);
console.log('ISSUES' + (Object.keys(issues).length ? '' : ' none'));
for (const [k, v] of Object.entries(issues)) console.log(`  ${k}: ${v.n}\n     ${v.ex.join('\n     ')}`);
if (Object.keys(issues).length) process.exitCode = 1;
