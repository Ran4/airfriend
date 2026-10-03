// QA throwaway: sprite-sector flicker, turbo starts by AI role, check force breakdown.
//   tsx tools/qa-ai-diag2.ts <ai|bot> [games] [seed]
import { createGame, stepGame } from '../src/sim/game';
import { emptyPad } from '../src/core/input';
import { mulberry32, setRandom } from '../src/sim/util';
import { onIce, isGoalie } from '../src/sim/query';
import { aiMem } from '../src/ai/memory';
import { botPad, configureBot, newBot } from './ai-bot-lib';

const mode = process.argv[2] ?? 'ai';
const games = Number(process.argv[3] ?? 10);
const seed = Number(process.argv[4] ?? 5);
setRandom(mulberry32(seed));
configureBot(seed, 1);
const SECTOR = Math.PI / 4;
const HYST = Number(process.env.HYST ?? 0.14);
const DWELL = Number(process.env.DWELL ?? 0);
const lastChange: number[] = new Array(10).fill(-9);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const C: Record<string, number> = {};
const add = (k: string, n = 1) => (C[k] = (C[k] ?? 0) + n);
const checks: { team: number; victimPAL: boolean; force: number; kd: boolean; pen: boolean; major: boolean; victimPuck: boolean; hitter: string }[] = [];
let skSec = 0;
for (let g = 0; g < games; g++) {
  const st = createGame({ autoplay: mode === 'ai' });
  const bot = newBot();
  const sector = new Array(10).fill(-1);
  const hist: { s: number; t: number }[][] = Array.from({ length: 10 }, () => []);
  let lastCheck: (typeof checks)[number] | null = null;
  while (st.phase !== 'gameOver' && st.tick < 60 * 60 * 25) {
    const hadPuck = st.puck.owner;
    stepGame(st, mode === 'ai' ? emptyPad() : botPad(st, bot));
    const mem = aiMem(st);
    for (const e of st.events) {
      if (e.type === 'turboStart') {
        const s = st.skaters[e.skaterId];
        if (mode === 'bot' && s.id === st.controlledId) continue;
        const role = st.puck.owner === s.id ? 'carrier' : mem.teams[s.team].assign.get(s.id)?.role ?? 'none';
        add(`turbo_${role}`);
      }
      if (e.type === 'check') {
        const h = st.skaters[e.hitter];
        lastCheck = { team: h.team, victimPAL: e.victim === 0, force: e.force, kd: e.knockedDown, pen: false, major: false, victimPuck: hadPuck === e.victim, hitter: mode === 'bot' && h.id === 0 ? 'PALbot' : h.name };
        checks.push(lastCheck);
      }
      if (e.type === 'penalty' && lastCheck) {
        lastCheck.pen = true;
        lastCheck.major = e.penalty.major;
      }
    }
    if (st.phase !== 'play') continue;
    for (const s of st.skaters) {
      if (!onIce(s) || isGoalie(s) || (mode === 'bot' && s.id === st.controlledId)) continue;
      skSec += 1 / 60;
      const raw = s.facing;
      let sec = sector[s.id];
      if (sec >= 0 && Math.abs(wrap(raw - sec * SECTOR)) <= SECTOR / 2 + HYST) continue;
      if (sec >= 0 && st.time - lastChange[s.id] < DWELL) continue;
      lastChange[s.id] = st.time;
      sec = (Math.round(raw / SECTOR) + 8) % 8;
      if (sector[s.id] >= 0) {
        add('sectorChanges');
        const h = hist[s.id];
        h.push({ s: sec, t: st.time });
        if (h.length > 3) h.shift();
        // A -> B -> A within 0.4 s
        if (h.length >= 2) {
          const prev = h[h.length - 2];
          const before = sector[s.id];
          if (st.time - prev.t < 0.4 && sec === (h.length >= 3 ? h[h.length - 3].s : -9)) {
            add('sectorFlickers');
            const sp = Math.hypot(s.vel.x, s.vel.z);
            const role = st.puck.owner === s.id ? 'carrier' : mem.teams[s.team].assign.get(s.id)?.role ?? 'none';
            add(`flk_sp_${sp < 1 ? 'a<1' : sp < 3 ? 'b1-3' : 'c3+'}`);
            add(`flk_role_${role}`);
            add(`flk_state_${s.state}`);
          }
          void before;
        }
        // big swings (>= 3 sectors) within one tick
        const dd = Math.min((sec - sector[s.id] + 8) % 8, (sector[s.id] - sec + 8) % 8);
        if (dd >= 3) add('sectorJump3+');
      }
      sector[s.id] = sec;
    }
  }
}
console.log(`MODE ${mode} games ${games}`);
console.log('flicker breakdown:', Object.entries(C).filter(([k]) => k.startsWith('flk_')).sort().map(([k, v]) => `${k.slice(4)}=${((v / (C.sectorFlickers ?? 1)) * 100).toFixed(0)}%`).join(' '));
console.log(`sprite sector changes per AI skater-min: ${((C.sectorChanges ?? 0) / skSec * 60).toFixed(1)}; A-B-A flickers (<0.4s) per skater-min: ${((C.sectorFlickers ?? 0) / skSec * 60).toFixed(2)}; >=135deg snaps per skater-min ${((C['sectorJump3+'] ?? 0) / skSec * 60).toFixed(2)}`);
const tot = Object.entries(C).filter(([k]) => k.startsWith('turbo_')).reduce((a, [, v]) => a + v, 0);
console.log(`turbo starts/game by role: ${Object.entries(C).filter(([k]) => k.startsWith('turbo_')).map(([k, v]) => `${k.slice(6)}=${(v / games).toFixed(1)} (${((v / tot) * 100).toFixed(0)}%)`).join(' ')}`);
for (const grp of ['home', 'away', 'away on PAL', 'PALbot']) {
  const cs = checks.filter((c) => (grp === 'home' ? c.team === 0 && c.hitter !== 'PALbot' : grp === 'away' ? c.team === 1 && !c.victimPAL : grp === 'away on PAL' ? c.team === 1 && c.victimPAL : c.hitter === 'PALbot'));
  if (!cs.length) continue;
  const f = cs.map((c) => c.force).sort((a, b) => a - b);
  console.log(`${grp.padEnd(12)} n/g=${(cs.length / games).toFixed(2)} force med ${f[Math.floor(f.length / 2)].toFixed(1)} p90 ${f[Math.floor(f.length * 0.9)].toFixed(1)} max ${f[f.length - 1].toFixed(1)}  KD ${cs.filter((c) => c.kd).length}  pen ${cs.filter((c) => c.pen).length} (${((cs.filter((c) => c.pen).length / cs.length) * 100).toFixed(0)}%) majors ${cs.filter((c) => c.major).length}  victim had puck ${((cs.filter((c) => c.victimPuck).length / cs.length) * 100).toFixed(0)}%`);
}
const byH: Record<string, [number, number, number]> = {};
for (const c of checks) {
  byH[c.hitter] ??= [0, 0, 0];
  byH[c.hitter][0]++;
  if (c.pen) byH[c.hitter][1]++;
  if (c.major) byH[c.hitter][2]++;
}
console.log('per hitter (checks/pens/majors):', Object.entries(byH).map(([k, v]) => `${k}:${v.join('/')}`).join(' '));
