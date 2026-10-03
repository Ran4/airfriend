// Skating-feel numbers from full games: AI turbo starts (by role), time on
// turbo, sprint lengths, kid facing snaps, PAL's barks and the fumbles they cause.
//
//   tsx tools/ai-turbodiag.ts [ai|bot] [games=10] [seed=5]
//
// ai: AI vs AI (autoplay). bot: the scripted pad-only human plays PAL (tools/ai-bot-lib.ts);
// PAL's own sprints are left out of the AI turbo numbers then.
// "Snaps" are counted like tools/qa-ai-diag2.ts: an 8-way sprite sector (with 0.14 rad of
// hysteresis) that jumps 3+ sectors (>= 135 degrees) in one tick, per kid skater-minute of play,
// except that the sector is forgotten across faceoffs and box trips (diag2 counts those teleports).
// "Raw snaps" are ticks where a kid's facing itself turned >= 135 degrees.
import { emptyPad } from '../src/core/input';
import { aiMem } from '../src/ai/memory';
import { createGame, stepGame } from '../src/sim/game';
import { isGoalie, onIce } from '../src/sim/query';
import { angleDiff, mulberry32, setRandom } from '../src/sim/util';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const mode = process.argv[2] ?? 'ai';
const games = Number(process.argv[3] ?? 10);
const seed = Number(process.argv[4] ?? 5);
setRandom(mulberry32(seed));
configureBot(seed, 1);

const SECTOR = Math.PI / 4;
const HYST = 0.14;
const C: Record<string, number> = {};
const add = (k: string, n = 1) => (C[k] = (C[k] ?? 0) + n);
const bursts: number[] = [];
let kidSec = 0;
let turboSec = 0;

for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: mode === 'ai' });
  const bot = newBot();
  const sector = new Array(10).fill(-1);
  const prevFacing = st.skaters.map((s) => s.facing);
  const burstStart = new Array(10).fill(-1);
  while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 25) {
    stepGame(st, mode === 'ai' ? emptyPad() : botPad(st, bot));
    const mem = aiMem(st);
    const human = (id: number) => mode === 'bot' && id === st.controlledId;
    for (const e of st.events) {
      if (e.type === 'turboStart' && !human(e.skaterId)) {
        const s = st.skaters[e.skaterId];
        const role = st.puck.owner === s.id ? 'carrier' : (mem.teams[s.team].assign.get(s.id)?.role ?? 'none');
        add('turbo');
        add(`turbo_${role}`);
      }
      if (e.type === 'bark') add('bark');
      if (e.type === 'fumble') add('fumble');
    }
    for (const s of st.skaters) {
      if (human(s.id) || isGoalie(s)) continue;
      // sprint lengths (AI skaters)
      if (s.turboActive && burstStart[s.id] < 0) burstStart[s.id] = st.time;
      if (!s.turboActive && burstStart[s.id] >= 0) {
        bursts.push(st.time - burstStart[s.id]);
        burstStart[s.id] = -1;
      }
      if (s.turboActive) turboSec += 1 / 60;
    }
    if (st.phase !== 'play') {
      // faceoff lineups and box trips place skaters (and their facing) outright: not a turn
      for (const s of st.skaters) {
        prevFacing[s.id] = s.facing;
        sector[s.id] = -1;
      }
      continue;
    }
    for (const s of st.skaters) {
      const pf = prevFacing[s.id];
      prevFacing[s.id] = s.facing;
      if (s.kind !== 'kid' || !onIce(s)) {
        sector[s.id] = -1;
        continue;
      }
      kidSec += 1 / 60;
      if (Math.abs(angleDiff(s.facing, pf)) >= (3 * Math.PI) / 4) add('rawSnap');
      const sec = sector[s.id];
      if (sec >= 0 && Math.abs(angleDiff(s.facing, sec * SECTOR)) <= SECTOR / 2 + HYST) continue;
      const ns = (Math.round(s.facing / SECTOR) + 8 * 4) % 8;
      if (sec >= 0) {
        const dd = Math.min((ns - sec + 8) % 8, (sec - ns + 8) % 8);
        if (dd >= 3) add('snap');
      }
      sector[s.id] = ns;
    }
  }
}

bursts.sort((a, b) => a - b);
const pct = (q: number) => (bursts.length ? bursts[Math.floor(bursts.length * q)].toFixed(2) : '-');
const perGame = (k: string) => ((C[k] ?? 0) / games).toFixed(1);
console.log(`MODE ${mode}  games ${games}  seed ${seed}`);
console.log(
  `AI turbo starts/game ${perGame('turbo')}  (${Object.keys(C)
    .filter((k) => k.startsWith('turbo_'))
    .sort()
    .map((k) => `${k.slice(6)} ${perGame(k)}`)
    .join(', ')})`,
);
console.log(`AI turbo skater-seconds/game ${(turboSec / games).toFixed(1)}  sprint length p25/median/p75 ${pct(0.25)}/${pct(0.5)}/${pct(0.75)} s`);
console.log(
  `kid snaps >=135deg per skater-minute: sector ${(((C.snap ?? 0) / kidSec) * 60).toFixed(2)}  raw ${(((C.rawSnap ?? 0) / kidSec) * 60).toFixed(2)}`,
);
console.log(`barks/game ${perGame('bark')}  fumbles/game ${perGame('fumble')}`);
