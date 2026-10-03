import type { GameState, Skater } from '../types';
import { isGoalie, onIce } from '../sim/query';
import { goalieAI } from './goalie';
import { aiMem, type Brain } from './memory';
import { skaterAI } from './skater';
import { isHuman, updateTeam } from './team';
import { setBtn } from './util';

/*
 * AI entry point. The sim calls updateAI(state, dt) once per tick in phases
 * 'play' and 'faceoff', before the human pad is applied. It writes the Intent
 * of every skater the human doesn't drive (all of them under autoplay),
 * goalies included.
 *
 *   team.ts    possession read, roles, formation spots
 *   skater.ts  carrier / chase / pressure / positional behavior
 *   ozone.ts   the offensive-zone game: protect, cycle, point play, crash, pinch
 *   goalie.ts  angle cutting and puck playing
 *   util.ts    geometry + shot quality + lanes
 *   memory.ts  per-game AI memory (outside GameState)
 */

export function updateAI(state: GameState, dt: number): void {
  const mem = aiMem(state);
  if (state.phase !== 'play') {
    // faceoffs: the sim ignores AI intents; just keep buttons released cleanly and forget plans
    for (const s of state.skaters) {
      if (isHuman(state, s)) continue;
      idle(s, mem.brains[s.id]);
    }
    for (const T of mem.teams) {
      T.chaser = null;
      T.presser = null;
      T.ozSince = -1;
    }
    return;
  }
  updateTeam(state, 0, mem);
  updateTeam(state, 1, mem);

  for (const s of state.skaters) {
    if (isHuman(state, s)) continue;
    const b = mem.brains[s.id];
    const it = s.intent;
    it.passTarget = undefined;
    it.aimAt = undefined;
    it.shield = undefined;
    if (!onIce(s)) {
      idle(s, b);
      continue;
    }
    if (isGoalie(s)) {
      const o = goalieAI(state, s, b, dt);
      it.move = o.move;
      it.passTarget = o.passTarget;
      setBtn(it.pass, o.pass);
      setBtn(it.shoot, false);
      setBtn(it.turbo, false);
      continue;
    }
    const a = mem.teams[s.team].assign.get(s.id);
    const o = skaterAI(state, s, b, a, dt);
    it.move = o.move;
    it.shield = o.shield;
    setBtn(it.shoot, o.shoot);
    setBtn(it.pass, o.pass);
    setBtn(it.turbo, turboButton(state, s, b, o.turbo));
  }
}

function idle(s: Skater, b: Brain): void {
  s.intent.move = { x: 0, z: 0 };
  s.intent.passTarget = undefined;
  s.intent.aimAt = undefined;
  s.intent.shield = undefined;
  setBtn(s.intent.shoot, false);
  setBtn(s.intent.pass, false);
  setBtn(s.intent.turbo, false);
  b.plan = 'carry';
  b.hadPuck = false;
  b.target = null;
  b.turboOn = false;
  b.bark = 0;
  b.oneTimerUntil = -1;
  b.lastKey = '';
  b.clearAt = -1;
  b.seen = { ...s.pos };
}

/** a sprint, once started, lasts at least this long (s) ... */
const SPRINT_MIN = 1.5;
/** ... and through lapses in the wish this short */
const SPRINT_GRACE = 1.0;
/** no new sprint this soon after one ends */
const SPRINT_REST = 4.5;
/** a new sprint needs this much stamina, so it can run a while (kids / the dog) */
const SPRINT_STAMINA = [0.7, 0.6] as const;

/**
 * Turbo is a held button, and every rising edge is a turboStart (a whoosh; for the
 * dog it may be a bark). So the AI sprints like a player: rarely, and then for a
 * while. A sprint starts only off a rest and with most of the stamina bar, runs at
 * least SPRINT_MIN and through brief lapses in the wish (the wishes in skater.ts have
 * their own start/keep hysteresis too), and ends when the stamina is spent or the
 * skater stops moving (holding turbo while standing would just restart the sprint
 * under the sim's "moving" rule).
 */
function turboButton(state: GameState, s: Skater, b: Brain, wish: boolean): boolean {
  if (b.bark === 1) {
    b.bark = 2;
    return false;
  }
  if (b.bark === 2) {
    b.bark = 0;
    b.turboOn = true;
    b.turboOffAt = state.time + 0.3;
    return true;
  }
  const now = state.time;
  const was = b.turboOn;
  const moving = Math.hypot(s.intent.move.x, s.intent.move.z) > 0.1;
  if (wish && moving) {
    if (!b.turboOn && now >= b.turboRestAt && s.stamina > SPRINT_STAMINA[s.kind === 'dog' ? 1 : 0]) {
      b.turboOn = true;
      b.turboOffAt = now + SPRINT_MIN;
    }
    if (b.turboOn) b.turboOffAt = Math.max(b.turboOffAt, now + SPRINT_GRACE);
  } else if (now > b.turboOffAt) b.turboOn = false;
  if (s.stamina < 0.06 || !moving) b.turboOn = false;
  if (was && !b.turboOn) b.turboRestAt = now + SPRINT_REST;
  return b.turboOn;
}
