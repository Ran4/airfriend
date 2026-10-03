// Headless full-game simulator (no browser, no rendering). Runs N complete
// games with the AI controlling everyone (autoplay) and prints rule/balance
// stats plus sanity checks (every game ends, no NaN, sane numbers).
//
//   npx tsx tools/simulate.ts [games=5] [maxMinutes=30] [seed]
//   (a seed makes the run reproducible)

import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { SIM_HZ } from '../src/config';
import { mulberry32, setRandom } from '../src/sim/util';
import type { GameEvent, GameState } from '../src/types';

const games = Number(process.argv[2] ?? 5);
const maxTicks = Number(process.argv[3] ?? 30) * 60 * SIM_HZ;
if (process.argv[4] !== undefined) setRandom(mulberry32(Number(process.argv[4])));
const verbose = process.env.VERBOSE === '1';

const totals: Record<string, number> = {};
const bump = (k: string, n = 1) => (totals[k] = (totals[k] ?? 0) + n);
const problems: string[] = [];
const infractions: Record<string, number> = {};

function finite(st: GameState): boolean {
  if (![st.puck.pos.x, st.puck.pos.z, st.puck.y, st.puck.vel.x, st.puck.vel.z, st.clock].every(Number.isFinite)) return false;
  return st.skaters.every((s) => [s.pos.x, s.pos.z, s.vel.x, s.vel.z, s.facing, s.stamina].every(Number.isFinite));
}

for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: true });
  const counts: Record<string, number> = {};
  const phases = new Set<string>();
  let ticks = 0;
  let nan = false;
  let maxSkaterSpeed = 0;
  let maxPuckSpeed = 0;
  let outside = 0;
  while (st.phase !== 'gameOver' && ticks < maxTicks) {
    stepGame(st, emptyPad());
    ticks++;
    phases.add(st.phase);
    for (const e of st.events as GameEvent[]) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === 'penalty') {
        const k = `${e.penalty.infraction}${e.penalty.major ? ' (MAJOR)' : ''}${e.penalty.team === 0 ? ' home' : ' away'}`;
        infractions[k] = (infractions[k] ?? 0) + 1;
      }
      if (verbose && ['goal', 'penalty', 'periodEnd', 'gameOver'].includes(e.type))
        console.log(`   t=${st.time.toFixed(1)} p${st.period} ${st.clock.toFixed(1)}`, JSON.stringify(e));
    }
    if (!finite(st)) {
      nan = true;
      break;
    }
    for (const s of st.skaters) {
      if (s.state === 'box') continue;
      maxSkaterSpeed = Math.max(maxSkaterSpeed, Math.hypot(s.vel.x, s.vel.z));
      if (Math.abs(s.pos.x) > 13.2 || Math.abs(s.pos.z) > 30.7) outside++;
    }
    maxPuckSpeed = Math.max(maxPuckSpeed, Math.hypot(st.puck.vel.x, st.puck.vel.z));
  }
  const mins = (ticks / SIM_HZ / 60).toFixed(1);
  console.log(
    `game ${g + 1}: ${st.phase} ${st.score[0]}-${st.score[1]} shots ${st.shots.join('-')} hits ${st.hits.join('-')} ` +
      `period ${st.period} winner=${st.winner} sim=${mins}min nan=${nan} vmax=${maxSkaterSpeed.toFixed(1)} puckmax=${maxPuckSpeed.toFixed(1)}`,
  );
  console.log('   events:', JSON.stringify(counts));
  console.log('   phases:', [...phases].join(','));
  if (nan) problems.push(`game ${g + 1}: NaN`);
  if (st.phase !== 'gameOver') problems.push(`game ${g + 1}: did not finish`);
  if (outside) problems.push(`game ${g + 1}: ${outside} skater-ticks outside the rink`);
  if (st.score[0] + st.score[1] !== st.goals.length) problems.push(`game ${g + 1}: score/goals mismatch`);
  if (st.shots[0] < st.score[0] || st.shots[1] < st.score[1]) problems.push(`game ${g + 1}: fewer shots than goals`);
  for (const [k, v] of Object.entries(counts)) bump(k, v);
  bump('goalsHome', st.score[0]);
  bump('goalsAway', st.score[1]);
  bump('shotsTotal', st.shots[0] + st.shots[1]);
  bump('goalsTotal', st.score[0] + st.score[1]);
  bump(`winner_${st.winner}`);
  if (st.period > 3) bump('overtimeGames');
}
console.log('TOTALS (per game):');
for (const [k, v] of Object.entries(totals).sort()) console.log(`  ${k}: ${(v / games).toFixed(2)}`);
console.log('INFRACTIONS (total):', JSON.stringify(infractions));
console.log(problems.length ? `PROBLEMS:\n  ${problems.join('\n  ')}` : 'OK: all games finished, no NaN, no escapes');
if (problems.length) process.exitCode = 1;
