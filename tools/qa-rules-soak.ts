// QA (rules lens): long AI-vs-AI soak with per-tick invariants.
//   ./node_modules/.bin/tsx tools/qa-rules-soak.ts [games=100] [seed=1] [humanBot=0]
import { createGame, stepGame, STUCK_PUCK_TIME } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { RINK, GOAL, RULES, SIM_DT } from '../src/config';
import { mulberry32, setRandom } from '../src/sim/util';
import { defenderOfGoal, depthPastLine, netBox, ownGoalZ } from '../src/sim/rink';
import type { GameEvent, GameState } from '../src/types';
import { botPad, configureBot, newBot } from './ai-bot-lib';
const humanBot = process.argv[4] === '1';
if (humanBot) configureBot(Number(process.argv[3] ?? 1), Number(process.argv[5] ?? 1));

const games = Number(process.argv[2] ?? 100);
setRandom(mulberry32(Number(process.argv[3] ?? 1)));

const issues: Record<string, { n: number; ex: string[] }> = {};
function issue(k: string, ex: string) {
  const r = (issues[k] ??= { n: 0, ex: [] });
  r.n++;
  if (r.ex.length < 4) r.ex.push(ex);
}
const stats: Record<string, number> = {};
const bump = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);

const where = (st: GameState, g: number) => `g${g} t=${st.time.toFixed(2)} p${st.period} clk=${st.clock.toFixed(2)} ph=${st.phase}`;

for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: !humanBot });
  const bot = newBot();
  let ticks = 0;
  let prevPhase = st.phase;
  let lastStop: { reason: string; team?: number; puck: { x: number; z: number }; freezeTeam?: number } | null = null;
  let lastPen: { team: number } | null = null;
  let playLen = 0; // continuous play without stoppage
  let looseSlow = 0; // puck loose & nearly still
  let ownerHeld = 0;
  let phaseStart = 0;
  while (st.phase !== 'gameOver' && ticks < 60 * 60 * 40) {
    const prevClock = st.clock;
    const prevPen = st.penalties.map((p) => p.remaining);
    const prevOwner = st.puck.owner;
    const prevPuck = { ...st.puck.pos };
    const ph0 = st.phase;
    const frozenGoalie = prevOwner !== null && st.skaters[prevOwner].state === 'gHold' ? st.skaters[prevOwner] : null;
    stepGame(st, humanBot ? botPad(st, bot) : emptyPad());
    ticks++;
    const evs = st.events as GameEvent[];
    // clock only in play
    if (st.clock < prevClock && ph0 !== 'play') issue('clock ran outside play', where(st, g) + ' from ' + ph0);
    if (st.clock > prevClock && !evs.some((e) => e.type === 'periodStart' || e.type === 'rematch')) issue('clock went up', where(st, g));
    // penalties only count in play
    st.penalties.forEach((p, i) => {
      if (prevPen[i] !== undefined && p.remaining < prevPen[i] - 1e-9 && ph0 !== 'play') issue('penalty clock outside play', where(st, g));
    });
    // finite
    const nums = [st.puck.pos.x, st.puck.pos.z, st.puck.y, st.puck.vel.x, st.puck.vel.z, st.puck.vy, st.clock];
    for (const s of st.skaters) nums.push(s.pos.x, s.pos.z, s.vel.x, s.vel.z, s.facing, s.stamina);
    if (!nums.every(Number.isFinite)) {
      issue('NaN', where(st, g));
      break;
    }
    // puck containment
    const p = st.puck;
    if (Math.abs(p.pos.x) > RINK.halfWidth + 0.05 || Math.abs(p.pos.z) > RINK.halfLength + 0.05) issue('puck outside rink', where(st, g) + ` (${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)})`);
    // puck inside a net without a goal phase
    for (const sign of [1, -1]) {
      const d = depthPastLine(p.pos.z, sign);
      if (d > 0.05 && d < GOAL.depth - 0.05 && Math.abs(p.pos.x) < GOAL.halfWidth - 0.05 && p.y < GOAL.height - 0.1 && st.phase === 'play' && p.owner === null)
        issue('puck inside net during play (no goal)', where(st, g) + ` (${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)},y=${p.y.toFixed(2)}) prev=(${prevPuck.x.toFixed(2)},${prevPuck.z.toFixed(2)})`);
    }
    // skaters inside nets / rink
    for (const s of st.skaters) {
      if (s.state === 'box') continue;
      if (Math.abs(s.pos.x) > RINK.halfWidth || Math.abs(s.pos.z) > RINK.halfLength) issue('skater outside rink', where(st, g) + ` id${s.id}`);
      for (const sign of [1, -1]) {
        const n = netBox(sign);
        if (s.pos.x > n.x0 + 0.05 && s.pos.x < n.x1 - 0.05 && s.pos.z > n.z0 + 0.05 && s.pos.z < n.z1 - 0.05) issue('skater center inside net', where(st, g) + ` id${s.id}`);
      }
    }
    // owner sanity
    if (p.owner !== null) {
      const o = st.skaters[p.owner];
      if (o.state === 'box' || o.state === 'fallen') issue('puck owned by boxed/fallen', where(st, g) + ` id${o.id} ${o.state}`);
    }
    // box bookkeeping
    for (const team of [0, 1]) {
      const n = st.penalties.filter((q) => q.team === team).length;
      if (n > 2) issue('more than 2 boxed', where(st, g));
      const boxed = st.skaters.filter((s) => s.team === team && s.state === 'box').length;
      const bx = st.skaters.filter((s) => s.team === team && s.state === 'box');
      if (bx.length === 2 && Math.hypot(bx[0].pos.x - bx[1].pos.x, bx[0].pos.z - bx[1].pos.z) < 0.3) bump('ticksTwoBoxedSameSeat');
      if (boxed !== n) issue('boxed count != active penalties', where(st, g) + ` team${team} boxed=${boxed} pens=${n}`);
    }
    if ((st.penaltyQueue?.length ?? 0) > 0) bump('ticksWithQueue');
    for (const q of st.penaltyQueue ?? []) {
      // a queued penalty whose skater isn't boxed while the team has a free slot
      const n = st.penalties.filter((x) => x.team === q.team).length;
      if (n < 2 && !st.penalties.some((x) => x.skaterId === q.skaterId)) issue('queued penalty with free slot', where(st, g));
    }
    // events
    for (const e of evs) {
      if (e.type === 'whistle') {
        if (e.reason === 'freeze') {
          const stuck = st.puck.owner === null || !frozenGoalie;
          lastStop = { reason: stuck ? 'stuck' : 'goalieFreeze', puck: { ...st.puck.pos }, freezeTeam: frozenGoalie?.team };
          bump(stuck ? 'stuckWhistles' : 'goalieFreezes');
          if (stuck && prevOwner !== null) issue('stuck whistle right after puck came loose from a carrier', where(st, g) + ` prevOwner=${prevOwner} noTouch=${st.sim!.noTouchTime.toFixed(1)}`);
          if (stuck) issue('stuck-puck whistle (12 s no touch)', where(st, g) + ` puck (${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}) y=${p.y.toFixed(2)}`);
        } else if (e.reason === 'offIce') {
          lastStop = { reason: 'offIce', puck: { ...st.puck.pos } };
          bump('offIce');
        } else if (e.reason === 'goal') lastStop = { reason: 'goal', puck: { ...st.puck.pos } };
        playLen = 0;
      }
      if (e.type === 'penalty') {
        lastPen = { team: e.penalty.team };
        lastStop = { reason: 'penalty', team: e.penalty.team, puck: { ...st.puck.pos } };
        bump('penalties');
        if (e.penalty.major) bump('majors');
        if ((st.penaltyQueue?.length ?? 0) > 0) bump('queuedPenalties');
        if (e.penalty.skaterId === 0) bump('dogPenalties');
        if (prevOwner !== null && st.skaters[prevOwner].team !== e.penalty.team) {
          bump('penaltiesWhileOtherTeamHadPuck');
          const t = st.skaters[prevOwner].team;
          const along = prevPuck.z * (st.period % 2 === 1 || st.period > 3 ? 1 : -1) * (t === 0 ? 1 : -1);
          if (along > RINK.blueLineZ) bump('  ...inTheirOffensiveZone');
          if (prevOwner === 0) bump('  ...PALhadPuck');
          const chk = evs.find((x) => x.type === 'check') as { victim: number } | undefined;
          if (chk && chk.victim !== prevOwner) {
            bump('  ...carrierWasNotTheVictim(delayed-penalty case)');
            if (along > RINK.blueLineZ) bump('  ...notVictim+offZone');
            if (prevOwner === 0) bump('  ...notVictim+PALcarrying');
          }
        }
      }
      if (e.type === 'goal') {
        bump('goals');
        if (e.info.powerPlay) bump('ppGoals');
        if (e.info.shortHanded) bump('shGoals');
        // where did the puck go in
        const sign = Math.sign(p.pos.z);
        const def = defenderOfGoal(sign, st.period);
        if (def === e.info.team) issue('goal credited to the defending team', where(st, g));
        const sc = st.skaters[e.info.scorer];
        if (sc.team !== e.info.team) bump('ownGoalScorerMismatch');
        if (e.info.scorer === 4 || e.info.scorer === 9) bump('goalieScorer');
        if (e.info.clock < 0.5) bump('goalsLast0.5s');
      }
      if (e.type === 'faceoffSetup') {
        const spot = e.spot;
        const prev = lastStop;
        if (prev) {
          if (prev.reason === 'goal' && (spot.x !== 0 || spot.z !== 0)) issue('faceoff after goal not at center', where(st, g));
          if (prev.reason === 'penalty') {
            const gz = ownGoalZ(prev.team as 0 | 1, st.period);
            if (Math.sign(spot.z) !== Math.sign(gz) || Math.abs(spot.z) < 15) issue('penalty faceoff not in offender zone', where(st, g) + ` spot=${JSON.stringify(spot)} team=${prev.team}`);
          }
          if (prev.reason === 'goalieFreeze' && prev.freezeTeam !== undefined) {
            const gz = ownGoalZ(prev.freezeTeam as 0 | 1, st.period);
            if (Math.sign(spot.z) !== Math.sign(gz)) issue('freeze faceoff not in goalie zone', where(st, g));
          }
        }
        if (evs.some((x) => x.type === 'periodStart')) {
          if (spot.x !== 0 || spot.z !== 0) issue('period start not at center', where(st, g));
        }
        lastStop = null;
      }
      if (e.type === 'gameOver') {
        const w = st.score[0] > st.score[1] ? 0 : st.score[1] > st.score[0] ? 1 : 'tie';
        if (w !== e.winner) issue('winner mismatch', where(st, g));
        if (e.winner === 'tie' && st.period <= RULES.periods) issue('tie before OT', where(st, g));
        if (st.period > RULES.periods && e.winner !== 'tie' && st.goals.length && st.goals[st.goals.length - 1].period !== st.period)
          issue('OT won without OT goal', where(st, g));
      }
    }
    // phase durations
    if (st.phase !== prevPhase) {
      const dur = st.time - phaseStart;
      bump(`phase_${prevPhase}_n`);
      stats[`phase_${prevPhase}_max`] = Math.max(stats[`phase_${prevPhase}_max`] ?? 0, dur);
      phaseStart = st.time;
      prevPhase = st.phase;
    }
    if (st.phase === 'faceoff' && st.phaseTime > RULES.faceoffDropDelay + 1.5) issue('faceoff too long', where(st, g));
    if (st.phase === 'play') {
      playLen += SIM_DT;
      stats.maxPlayLen = Math.max(stats.maxPlayLen ?? 0, playLen);
      if (p.owner === null && Math.hypot(p.vel.x, p.vel.z) < 0.3) looseSlow += SIM_DT;
      else looseSlow = 0;
      stats.maxLooseSlow = Math.max(stats.maxLooseSlow ?? 0, looseSlow);
      if (p.owner !== null && p.owner === prevOwner) ownerHeld += SIM_DT;
      else ownerHeld = 0;
      stats.maxOwnerHeld = Math.max(stats.maxOwnerHeld ?? 0, ownerHeld);
      if (p.owner !== null && (p.owner === 4 || p.owner === 9) && ownerHeld > 3) issue('goalie owns puck > 3 s in play', where(st, g));
    }
  }
  if (st.phase !== 'gameOver') issue('game did not finish', `g${g} ${st.phase} p${st.period}`);
  bump('games');
  bump(`winner_${st.winner}`);
  if (st.period > 3) bump('OT');
  if (st.winner === 'tie') bump('ties');
  stats.totalMinutes = (stats.totalMinutes ?? 0) + st.time / 60;
}
console.log('STATS', JSON.stringify(stats, null, 1));
console.log('ISSUES');
for (const [k, v] of Object.entries(issues)) console.log(`  ${k}: ${v.n}\n     ${v.ex.join('\n     ')}`);
void STUCK_PUCK_TIME;
