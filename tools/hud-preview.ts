// HUD preview: builds mock GameStates for every interface scenario, feeds
// events through the real Hud (onEvents + per-frame draw, exactly like
// main.ts), and shows each result as a 256x224 frame over a fake rink.
//
//   node tools/playtest.mjs --page /tools/hud-preview.html --seconds 4 --shots 3 --out tools/out/hud
//   node tools/hud-shoot.mjs            (one x3 PNG per scenario)
//   /tools/hud-preview.html?only=goal   (filter by name substring)

import { RULES, SIM_DT } from '../src/config';
import { createGame } from '../src/sim/game';
import type { GameEvent, GameState, GoalInfo, Penalty, TeamId } from '../src/types';
import { Hud, type Projector } from '../src/ui/hud';

const W = 256;
const H = 224;

// --------------------------------------------------------- fake camera ----
// Looks along +z (period 1/3) or -z (period 2) like the real camera; world +x
// is screen-left when looking +z.
interface Cam {
  x: number;
  z: number;
}

function projector(state: GameState, cam: Cam): Projector {
  const d = state.period === 2 ? -1 : 1;
  return (x, y, z) => {
    const rz = (z - cam.z) * d;
    const k = 1 / (1 + rz * 0.012); // a hint of perspective
    const sx = W / 2 - (x - cam.x) * d * 13 * k;
    const sy = 128 - rz * 8.5 * k - y * 13 * k;
    return { x: sx, y: sy, onScreen: sx >= 0 && sx <= W && sy >= 0 && sy <= H };
  };
}

function drawRink(g: CanvasRenderingContext2D, state: GameState, p: Projector): void {
  g.fillStyle = '#101828';
  g.fillRect(0, 0, W, H);
  // ice as a set of projected rows
  for (let sy = 0; sy < H; sy++) {
    g.fillStyle = sy % 4 === 0 ? '#e0e8f8' : '#e8f0f8';
    g.fillRect(0, sy, W, 1);
  }
  const line = (z: number, color: string, w = 3) => {
    const a = p(-13, 0, z);
    g.fillStyle = color;
    g.fillRect(0, Math.round(a.y) - 1, W, w);
  };
  line(0, '#d82828', 4);
  line(7.6, '#2840d0');
  line(-7.6, '#2840d0');
  line(26.5, '#d82828', 1);
  line(-26.5, '#d82828', 1);
  // boards
  for (const x of [-13, 13]) {
    for (let z = -30; z <= 30; z += 0.5) {
      const a = p(x, 0, z);
      g.fillStyle = '#f8f8f8';
      g.fillRect(Math.round(a.x) - 2, Math.round(a.y) - 8, 4, 8);
      g.fillStyle = '#f8c800';
      g.fillRect(Math.round(a.x) - 2, Math.round(a.y) - 2, 4, 2);
    }
  }
  // skater blobs, far to near
  const order = [...state.skaters].sort((a, b) => b.pos.z - a.pos.z);
  for (const s of order) {
    if (s.state === 'box') continue;
    const a = p(s.pos.x, 0, s.pos.z);
    const x = Math.round(a.x);
    const y = Math.round(a.y);
    g.fillStyle = 'rgba(0,0,40,0.3)';
    g.fillRect(x - 6, y - 1, 12, 3);
    if (s.kind === 'dog') {
      g.fillStyle = '#f8f8f8';
      g.fillRect(x - 8, y - 14, 16, 12);
      g.fillStyle = '#d82828';
      g.fillRect(x - 5, y - 10, 10, 5);
      g.fillStyle = '#000';
      g.fillRect(x - 6, y - 12, 2, 2);
    } else {
      g.fillStyle = s.team === 0 ? '#d82828' : '#4830a8';
      g.fillRect(x - 5, y - 24, 10, 14);
      g.fillStyle = s.team === 0 ? '#d82828' : '#f8f8f8';
      g.fillRect(x - 4, y - 28, 8, 5);
      g.fillStyle = '#202040';
      g.fillRect(x - 5, y - 10, 10, 8);
    }
  }
  const pk = p(state.puck.pos.x, state.puck.y, state.puck.pos.z);
  g.fillStyle = '#000';
  g.fillRect(Math.round(pk.x) - 1, Math.round(pk.y) - 1, 3, 2);
  // the actor layer's marker over the controlled skater, at the real game's
  // geometry relative to the HUD's head point (top ~18 px above it), so a
  // marker hidden under the score bug shows up as hidden here too
  const ctl = state.skaters[state.controlledId];
  if (ctl && ctl.state !== 'box') {
    const hd = p(ctl.pos.x, (ctl.kind === 'dog' ? 1.3 : 2.0) + 0.3, ctl.pos.z);
    const mx = Math.round(hd.x);
    const my = Math.round(hd.y) - 17;
    for (let i = 0; i < 9; i++) {
      const half = Math.max(0, 4 - Math.floor(i / 2));
      g.fillStyle = '#101010';
      g.fillRect(mx - half - 1, my + i, half * 2 + 3, 1);
      g.fillStyle = '#f8e040';
      if (half > 0) g.fillRect(mx - half, my + i, half * 2 + 1, 1);
    }
  }
}

/**
 * The scored-on net where the REAL goal camera frames it (screen px, measured
 * with tools/hud-goalcheck.mjs: frame + crease + 1 m above the bar for the
 * lamp / sparkle, at its widest over the celebration). The camera sits behind
 * HOME's end, so a HOME goal is in the far net and an AWAY goal in the near one.
 */
const NET_ZONE: Record<TeamId, { x: number; y: number; x2: number; y2: number }> = {
  0: { x: 105, y: 50, x2: 165, y2: 114 },
  1: { x: 102, y: 98, x2: 169, y2: 170 },
};

/** a stand-in net (crease, frame, mesh) inside its zone, plus the zone's outline */
function drawNetZone(g: CanvasRenderingContext2D, team: TeamId): void {
  const z = NET_ZONE[team];
  const cx = Math.round((z.x + z.x2) / 2);
  const far = team === 0;
  const w = far ? 34 : 42; // mouth width on screen
  const lineY = far ? z.y + 40 : z.y + 48; // goal line row
  g.fillStyle = '#d82828';
  g.fillRect(0, lineY, W, 2);
  // crease
  g.fillStyle = '#78b8f0';
  if (far) g.fillRect(cx - w / 2 - 4, lineY + 2, w + 8, 12);
  else g.fillRect(cx - w / 2 - 4, lineY - 14, w + 8, 14);
  // mesh + frame
  const top = far ? lineY - 22 : lineY - 24;
  const depth = far ? -8 : 18;
  for (let y = 0; y < 22; y += 2) {
    g.fillStyle = y % 4 ? '#b8c0d0' : '#d8e0f0';
    g.fillRect(cx - w / 2 + 2, top + y + (far ? 0 : depth / 2), w - 4, 1);
  }
  g.fillStyle = '#e03030';
  g.fillRect(cx - w / 2, top, 3, 24);
  g.fillRect(cx + w / 2 - 3, top, 3, 24);
  g.fillRect(cx - w / 2, top, w, 3);
  // the zone the HUD must keep clear (dashed)
  g.fillStyle = '#ff00ff';
  for (let x = z.x; x < z.x2; x += 4) {
    g.fillRect(x, z.y, 2, 1);
    g.fillRect(x, z.y2, 2, 1);
  }
  for (let y = z.y; y < z.y2; y += 4) {
    g.fillRect(z.x, y, 1, 2);
    g.fillRect(z.x2, y, 1, 2);
  }
}

// ------------------------------------------------------- mock harness ----
class Mock {
  state = createGame({});
  hudCanvas = document.createElement('canvas');
  hud = new Hud(this.hudCanvas);
  cam: Cam = { x: 0, z: 0 };
  /** draw the real goal camera's net zone for this scoring team */
  net: TeamId | null = null;

  constructor() {
    // a plausible mid-game: everyone spread out around center ice
    this.set((s) => {
      s.phase = 'play';
      s.time = 50;
    });
  }

  get p(): Projector {
    return projector(this.state, this.cam);
  }

  set(f: (s: GameState) => void): this {
    f(this.state);
    return this;
  }

  /** enter a phase the way the sim does (phaseTime restarts) */
  phase(ph: GameState['phase']): this {
    this.state.phase = ph;
    this.state.phaseTime = 0;
    return this;
  }

  emit(...events: GameEvent[]): this {
    this.state.events = events;
    this.hud.onEvents(events, this.state);
    this.state.events = [];
    return this;
  }

  /** run `sec` of sim time at 60 Hz, drawing every frame like main.ts */
  run(sec: number, f?: (s: GameState) => void): this {
    const n = Math.round(sec / SIM_DT);
    for (let i = 0; i < n; i++) {
      this.state.time += SIM_DT;
      this.state.phaseTime += SIM_DT;
      this.state.tick++;
      if (this.state.phase === 'play' && !this.state.paused) this.state.clock = Math.max(0, this.state.clock - SIM_DT);
      f?.(this.state);
      this.hud.draw(this.state, SIM_DT, this.p);
    }
    return this;
  }

  compose(): HTMLCanvasElement {
    this.hud.draw(this.state, 0, this.p);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    drawRink(g, this.state, this.p);
    if (this.net !== null) drawNetZone(g, this.net);
    g.drawImage(this.hudCanvas, 0, 0);
    return c;
  }
}

function goalInfo(team: TeamId, scorer: number, assists: number[], extra: Partial<GoalInfo> = {}): GoalInfo {
  return { team, scorer, assists, period: 1, clock: 72, powerPlay: false, shortHanded: false, ...extra };
}

function penalty(id: number, team: TeamId, infraction: string, major = false, remaining?: number): Penalty {
  const duration = major ? RULES.majorLength : RULES.minorLength;
  return { skaterId: id, team, infraction, duration, remaining: remaining ?? duration, major };
}

function addGoal(m: Mock, info: GoalInfo): void {
  const s = m.state;
  s.goals.push(info);
  s.score[info.team]++;
  while (s.periodGoals.length < info.period) s.periodGoals.push([0, 0]);
  s.periodGoals[info.period - 1][info.team]++;
  s.skaters[info.scorer].stats.goals++;
  for (const a of info.assists) s.skaters[a].stats.assists++;
}

/** a full game's worth of stats for the summary screens */
function playedGame(m: Mock, finalScore: 'win' | 'loss' | 'tie'): void {
  const s = m.state;
  addGoal(m, goalInfo(0, 0, [1], { period: 1, clock: 72 }));
  addGoal(m, goalInfo(1, 5, [6, 7], { period: 1, clock: 31, powerPlay: true }));
  addGoal(m, goalInfo(0, 1, [0, 2], { period: 2, clock: 95 }));
  addGoal(m, goalInfo(1, 6, [], { period: 2, clock: 12 }));
  if (finalScore === 'win') addGoal(m, goalInfo(0, 0, [3], { period: 3, clock: 44, shortHanded: true }));
  if (finalScore === 'loss') addGoal(m, goalInfo(1, 5, [8], { period: 3, clock: 8 }));
  s.periodGoals.length = 3;
  for (let i = 0; i < 3; i++) s.periodGoals[i] ??= [0, 0];
  s.shots = [24, 19];
  s.hits = [7, 11];
  s.skaters[3].stats.hits = 4;
  s.skaters[7].stats.hits = 6;
  s.skaters[7].stats.pim = 30;
  s.skaters[2].stats.pim = 30;
  s.skaters[0].stats.shots = 9;
  s.skaters[5].stats.shots = 7;
}

// ------------------------------------------------------------ scenarios ----
type Build = () => Mock;
const scenarios: [string, Build][] = [];
const add = (name: string, b: Build) => scenarios.push([name, b]);

const intro = (t: number) => () => new Mock().set((s) => (s.time = 0, s.clock = RULES.periodLength)).phase('intro').emit({ type: 'introStart' }).run(t);
add('intro-0.2s', intro(0.2));
add('intro-0.5s', intro(0.5));
add('intro-1.4s', intro(1.4));
add('intro-2.6s period card', intro(2.6));

add('faceoff first (controls)', () =>
  intro(RULES.introTime)()
    .phase('faceoff')
    .set((s) => (s.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime: 1.1, earlyPress: [false, false] }))
    .emit({ type: 'periodStart', period: 1 }, { type: 'faceoffSetup', spot: { x: 0, z: 0 } })
    .run(0.7),
);
add('faceoff 2nd period', () =>
  new Mock()
    .set((s) => {
      s.period = 2;
      s.clock = RULES.periodLength;
      s.score = [1, 1];
      s.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime: 1.1, earlyPress: [false, false] };
    })
    .phase('faceoff')
    .emit({ type: 'periodStart', period: 2 }, { type: 'faceoffSetup', spot: { x: 0, z: 0 } })
    .run(0.8),
);
add('drop!', () =>
  new Mock()
    .set((s) => (s.clock = 88, s.faceoff = { spot: { x: 6.7, z: 20.5 }, dropped: false, dropTime: 1.1, earlyPress: [false, false] }))
    .phase('faceoff')
    .emit({ type: 'faceoffSetup', spot: { x: 6.7, z: 20.5 } })
    .run(1.1)
    .set((s) => (s.faceoff!.dropped = true))
    .emit({ type: 'faceoffDrop' })
    .run(0.2),
);
add('false start', () =>
  new Mock()
    .set((s) => (s.clock = 64, s.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime: 1.1, earlyPress: [false, false] }))
    .phase('faceoff')
    .emit({ type: 'faceoffSetup', spot: { x: 0, z: 0 } })
    .run(0.6)
    .set((s) => (s.faceoff!.earlyPress[1] = true))
    .run(0.2),
);
add('play 2ND 1:23', () =>
  new Mock().set((s) => {
    s.period = 2;
    s.clock = 83.4;
    s.score = [2, 1];
    s.skaters[0].stamina = 0.8;
  }).run(0.5),
);
add('power play + last 10s', () =>
  new Mock()
    .set((s) => {
      s.period = 3;
      s.clock = 9.3;
      s.score = [3, 3];
      s.penalties = [penalty(7, 1, 'BOARDING', false, 24)];
      s.skaters[7].state = 'box';
      s.skaters[0].stamina = 0.45;
      s.skaters[0].barkCooldown = 1.2;
    })
    .emit({ type: 'clockWarning' })
    .run(0.4),
);
add('windup meter, tired', () =>
  new Mock()
    .set((s) => {
      s.clock = 101;
      s.skaters[0].pos = { x: 1, z: 2 };
      s.skaters[0].state = 'windup';
      s.skaters[0].windup = 0.7;
      s.skaters[0].stamina = 0.12;
      s.puck.owner = 0;
      s.puck.pos = { x: 1, z: 2.6 };
    })
    .run(0.3),
);
add('windup full', () =>
  new Mock()
    .set((s) => {
      s.clock = 101;
      s.controlledId = 1;
      s.skaters[1].pos = { x: -3, z: 4 };
      s.skaters[1].state = 'windup';
      s.skaters[1].windup = 1;
      s.skaters[1].stamina = 0.9;
      s.skaters[1].turboActive = true;
    })
    .run(0.25),
);
add('dog off-screen left', () =>
  new Mock()
    .set((s) => {
      s.clock = 70;
      s.skaters[0].pos = { x: 12, z: 3 };
    })
    .run(0.3),
);
add('dog off-screen top + edge', () =>
  new Mock()
    .set((s) => {
      s.clock = 70;
      s.skaters[0].pos = { x: -4, z: 22 };
    })
    .run(0.3),
);
add('dog near edge tag', () =>
  new Mock()
    .set((s) => {
      s.clock = 70;
      s.skaters[0].pos = { x: -8.5, z: -2 };
    })
    .run(0.3),
);
const goal = (t: number, info: GoalInfo) => () => {
  const m = new Mock().set((s) => {
    s.clock = info.clock;
    s.score = [1, 0];
  });
  addGoal(m, info);
  return m.phase('goal').emit({ type: 'goal', info }, { type: 'whistle', reason: 'goal' }).run(t);
};
add('goal 0.45s slam', goal(0.45, goalInfo(0, 0, [1])));
add('goal 1.0s', goal(1.0, goalInfo(0, 0, [1])));
add('goal 2.4s PAL PP', goal(2.4, goalInfo(0, 0, [1, 2], { powerPlay: true })));
add('goal 2.4s away', goal(2.4, goalInfo(1, 6, [8], { shortHanded: true, period: 2 })));
add('goal 1.0s away', goal(1.0, goalInfo(1, 6, [8])));
add('penalty minor', () =>
  new Mock()
    .set((s) => {
      s.clock = 77;
      s.lastPenaltyCall = penalty(7, 1, 'BOARDING');
    })
    .phase('penalty')
    .emit({ type: 'whistle', reason: 'penalty' }, { type: 'penalty', penalty: penalty(7, 1, 'BOARDING') })
    .run(0.6),
);
add('penalty major long', () =>
  new Mock()
    .set((s) => (s.clock = 40))
    .phase('penalty')
    .emit({ type: 'penalty', penalty: penalty(6, 1, 'GOALIE INTERFERENCE', true) })
    .run(1.2),
);
add('penalty bad dog', () =>
  new Mock()
    .set((s) => (s.clock = 40))
    .phase('penalty')
    .emit({ type: 'penalty', penalty: penalty(0, 0, 'ROUGHING') })
    .run(1.0),
);
add('shorthanded + switch tag', () =>
  new Mock()
    .set((s) => {
      s.clock = 50;
      s.penalties = [penalty(0, 0, 'ROUGHING', false, 17)];
      s.skaters[0].state = 'box';
      s.controlledId = 1;
      s.skaters[1].pos = { x: 2, z: 1 };
    })
    .emit({ type: 'controlSwitch', skaterId: 1 })
    .run(0.5),
);
add('big hit + post', () =>
  new Mock()
    .set((s) => {
      s.clock = 33;
      s.skaters[6].pos = { x: -5, z: 4 };
      s.skaters[6].state = 'fallen';
    })
    .emit({ type: 'check', hitter: 2, victim: 6, force: 8, knockedDown: true })
    .run(0.3)
    .emit({ type: 'post', pos: { x: 0.9, z: 9 } })
    .run(0.15),
);
add('great save', () =>
  new Mock()
    .set((s) => {
      s.clock = 33;
      s.skaters[9].pos = { x: 0, z: 9 };
    })
    .emit({ type: 'shot', shooter: 0, power: 0.95, lifted: true })
    .run(0.2)
    .emit({ type: 'save', goalie: 9, caught: true })
    .run(0.25),
);
add('end of period', () =>
  new Mock()
    .set((s) => (s.clock = 0, s.score = [2, 1]))
    .phase('periodEnd')
    .emit({ type: 'periodEnd', period: 1 })
    .run(0.8),
);
add('overtime faceoff', () =>
  new Mock()
    .set((s) => {
      s.period = 4;
      s.clock = RULES.overtimeLength;
      s.score = [3, 3];
      s.periodGoals = [[1, 1], [1, 1], [1, 1], [0, 0]];
      s.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime: 1.1, earlyPress: [false, false] };
    })
    .phase('faceoff')
    .emit({ type: 'periodStart', period: 4 }, { type: 'faceoffSetup', spot: { x: 0, z: 0 } })
    .run(0.9),
);
// OT lineup at any moment: OVERTIME! + SUDDEN DEATH must be lit in every capture
// (period openers get a randomized 1.9-2.5 s lineup from the sim)
const otLineup = (dropTime = 2.3) =>
  new Mock()
    .set((s) => {
      s.period = 4;
      s.clock = RULES.overtimeLength;
      s.score = [3, 3];
      s.periodGoals = [[1, 1], [1, 1], [1, 1], [0, 0]];
      s.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime, earlyPress: [false, false] };
    })
    .phase('faceoff')
    .emit({ type: 'periodStart', period: 4 }, { type: 'faceoffSetup', spot: { x: 0, z: 0 } });
for (const t of [0.1, 0.45, 1.3, 2.2]) add(`overtime faceoff ${t}s`, () => otLineup().run(t));
/** the faceoff flags + event exactly as sim/faceoff.ts raises them */
const falseStart = (team: TeamId) => (m: Mock) =>
  m.set((s) => (s.faceoff!.earlyPress[team] = true)).emit({ type: 'falseStart', team, skaterId: team === 0 ? m.state.controlledId : 6 });
const drop = (m: Mock) => m.set((s) => (s.faceoff!.dropped = true)).emit({ type: 'faceoffDrop' });
add('false start in OT', () => falseStart(0)(otLineup().run(0.6)).run(0.25));
add('false start in OT after drop', () => drop(falseStart(0)(otLineup(1.1).run(0.8)).run(0.3)).run(0.3));
add('false start P2 opener', () =>
  falseStart(1)(
    new Mock()
      .set((s) => {
        s.period = 2;
        s.clock = RULES.periodLength;
        s.score = [1, 1];
        s.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime: 2.0, earlyPress: [false, false] };
      })
      .phase('faceoff')
      .emit({ type: 'periodStart', period: 2 }, { type: 'faceoffSetup', spot: { x: 0, z: 0 } })
      .run(0.9),
  ).run(0.3),
);
add('false start survives drop', () =>
  drop(
    falseStart(1)(
      new Mock()
        .set((s) => (s.clock = 64, s.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime: 1.1, earlyPress: [false, false] }))
        .phase('faceoff')
        .emit({ type: 'faceoffSetup', spot: { x: 0, z: 0 } })
        .run(0.9),
    ).run(0.2),
  ).run(0.5),
);
// ---- HUD layout: nothing may sit under the score bug or the PP strip ----
const pp = (s: GameState) => {
  s.penalties = [penalty(7, 1, 'BOARDING', false, 41)];
  s.skaters[7].state = 'box';
};
add('PP + 2nd period card', () =>
  new Mock()
    .set((s) => {
      pp(s);
      s.period = 2;
      s.clock = RULES.periodLength;
      s.score = [1, 1];
      s.faceoff = { spot: { x: 0, z: 0 }, dropped: false, dropTime: 2.0, earlyPress: [false, false] };
    })
    .phase('faceoff')
    .emit({ type: 'periodStart', period: 2 }, { type: 'faceoffSetup', spot: { x: 0, z: 0 } })
    .run(0.9),
);
add('PP + OT false start', () =>
  falseStart(0)(
    otLineup()
      .set(pp)
      .run(0.6),
  ).run(0.25),
);
add('PP + end of period', () =>
  new Mock()
    .set((s) => (pp(s), s.clock = 0, s.score = [2, 1]))
    .phase('periodEnd')
    .emit({ type: 'periodEnd', period: 1 })
    .run(0.8),
);
add('PP notice + end of period', () =>
  new Mock()
    .set((s) => (s.clock = 0.4, s.score = [2, 1]))
    .emit({ type: 'penaltyExpired', skaterId: 7 })
    .run(0.3)
    .set((s) => (s.clock = 0))
    .phase('periodEnd')
    .emit({ type: 'periodEnd', period: 1 })
    .run(0.8),
);
add('PP + PAL off the top', () =>
  new Mock()
    .set((s) => {
      pp(s);
      s.clock = 70;
      s.skaters[0].pos = { x: -4, z: 13 };
    })
    .run(0.3),
);
add('PP + PAL under the strip', () =>
  new Mock()
    .set((s) => {
      pp(s);
      s.clock = 70;
      s.skaters[0].pos = { x: 1, z: 9 };
    })
    .run(0.3),
);
add('PAL just under the score bug', () =>
  new Mock()
    .set((s) => {
      s.clock = 70;
      s.skaters[0].pos = { x: 2, z: 10 };
    })
    .run(0.3),
);
add('PAL marker clears the score bug', () =>
  new Mock()
    .set((s) => {
      s.clock = 70;
      s.skaters[0].pos = { x: 2, z: 7.5 };
    })
    .run(0.3),
);
add('PP + big hit up top', () =>
  new Mock()
    .set((s) => {
      pp(s);
      s.clock = 33;
      s.skaters[6].pos = { x: -2, z: 10 };
      s.skaters[6].state = 'fallen';
    })
    .emit({ type: 'check', hitter: 2, victim: 6, force: 8, knockedDown: true })
    .run(0.3),
);
// ---- goal celebration vs the net the camera frames (NET_ZONE, dashed) ----
const goalAt = (t: number, info: GoalInfo) => () => {
  const m = goal(t, info)();
  m.net = info.team;
  return m;
};
add('goal home far', goalAt(1.0, goalInfo(0, 1, [2])));
add('goal home far 0.4s hop', goalAt(0.42, goalInfo(0, 1, [2])));
add('goal home far + window', goalAt(1.9, goalInfo(0, 3, [1, 2])));
add('goal away near', goalAt(1.0, goalInfo(1, 6, [8])));
add('goal away near + window', goalAt(2.0, goalInfo(1, 5, [6, 7], { powerPlay: true })));
add('goal away near PP strip', () => {
  const m = goalAt(1.0, goalInfo(1, 6, []))();
  return m.set(pp).run(0.1);
});
add('PAL goal', goalAt(1.0, goalInfo(0, 0, [1])));
add('PAL goal flavor handoff', goalAt(1.68, goalInfo(0, 0, [1])));
add('PAL goal window', goalAt(2.4, goalInfo(0, 0, [3, 2], { powerPlay: true })));
add('goal two long assists', goal(2.4, goalInfo(1, 5, [6, 7], { period: 2, clock: 41 })));
add('goal assists PP tag', goal(2.4, goalInfo(1, 8, [9, 6], { powerPlay: true })));
add('goal 1.3s turbo sliding', goal(1.3, goalInfo(0, 0, [1])));
add('goal 4.8s turbo back', goal(4.8, goalInfo(0, 0, [1])));
const tired = (t: number) => () =>
  new Mock()
    .set((s) => {
      s.clock = 88;
      s.skaters[0].stamina = 0.1;
      s.skaters[0].barkCooldown = 0;
    })
    .run(t);
add('tired PAL (TIRED)', tired(0.1));
add('tired PAL (meter)', tired(0.25));
add('tired kid', () =>
  new Mock()
    .set((s) => {
      s.clock = 88;
      s.controlledId = 2;
      s.skaters[2].stamina = 0.1;
    })
    .run(0.1),
);
// ---- turbo window: bark lamp, whose meter it is, where PAL is ----
const bark = (cd: number, f?: (s: GameState) => void) => () =>
  new Mock()
    .set((s) => {
      s.clock = 88;
      s.skaters[0].stamina = 0.85;
      s.skaters[0].barkCooldown = cd;
    })
    .run(0.3, f);
add('bark ready', bark(0));
add('bark cooling', bark(2.2));
add('bark cooling half', bark(1.2));
add('bark cooling almost', bark(0.4));
// the sim's countdown reaching 0 a moment ago: the balloon flashes white
add('bark recharge flash', () => bark(0.25, (s) => (s.skaters[0].barkCooldown = Math.max(0, s.skaters[0].barkCooldown - SIM_DT)))().run(0.016));
add('bark tired PAL', () => bark(1.6, (s) => (s.skaters[0].stamina = 0.1))().run(0.05));
const palBoxed = (ctl: number, remaining: number) => (s: GameState) => {
  s.clock = 50;
  s.penalties = [penalty(0, 0, 'ROUGHING', false, remaining)];
  s.skaters[0].state = 'box';
  s.controlledId = ctl;
  s.skaters[ctl].pos = { x: 2, z: 1 };
  s.skaters[ctl].stamina = 0.7;
};
add('kid while PAL boxed', () => new Mock().set(palBoxed(2, 23.4)).run(0.4));
add('kid #22 while PAL boxed', () => new Mock().set(palBoxed(3, 6.2)).run(0.4));
add('kid while PAL boxed (tired)', () => new Mock().set((s) => (palBoxed(1, 14)(s), s.skaters[1].stamina = 0.1)).run(0.1));
add('kid, PAL owes two minors', () =>
  new Mock()
    .set((s) => {
      palBoxed(1, 11)(s);
      s.penaltyQueue = [penalty(0, 0, 'TRIPPING')];
    })
    .run(0.4),
);
add('PAL READY (kid keeps puck)', () =>
  new Mock()
    .set((s) => {
      s.clock = 50;
      s.controlledId = 1;
      s.skaters[1].pos = { x: 2, z: 1 };
      s.skaters[0].pos = { x: -6, z: -2 };
      s.puck.owner = 1;
      s.puck.pos = { x: 2, z: 1.6 };
      s.dogReturnPending = true;
    })
    .emit({ type: 'penaltyExpired', skaterId: 0 })
    .run(0.5),
);
const shGoal = (t: number) => () => {
  const info = goalInfo(0, 2, [1], { shortHanded: true });
  const m = new Mock().set(palBoxed(2, 19)).run(0.5);
  addGoal(m, info);
  return m.phase('goal').emit({ type: 'goal', info }, { type: 'whistle', reason: 'goal' }).run(t);
};
add('SH goal, PAL boxed 0.3s', shGoal(0.3));
add('SH goal, PAL boxed 2.4s (tab hides)', shGoal(2.4));
add('SH goal, PAL boxed 4.9s (tab back)', shGoal(4.9));
add('kid controlled, no PAL tab', () => new Mock().set((s) => (s.clock = 50, s.controlledId = 1)).run(0.3));
/** PAL is called: the PENALTY window, then (after > 0) the lineup with the PAL IN THE BOX! callout */
const palPenalty = (inWindow: number, after = 0) => () => {
  const pen = penalty(0, 0, 'ROUGHING');
  const m = new Mock()
    .set((s) => {
      s.clock = 77;
      s.lastPenaltyCall = pen;
      s.penalties = [pen];
      s.skaters[0].state = 'box';
      s.controlledId = 1;
    })
    .phase('penalty')
    .emit({ type: 'whistle', reason: 'penalty' }, { type: 'penalty', penalty: pen })
    .run(inWindow);
  if (after <= 0) return m;
  return m
    .run(RULES.penaltyBannerTime - inWindow)
    .set((s) => (s.faceoff = { spot: { x: 6.7, z: -20.5 }, dropped: false, dropTime: 1.3, earlyPress: [false, false] }))
    .phase('faceoff')
    .emit({ type: 'faceoffSetup', spot: { x: 6.7, z: -20.5 } })
    .run(after);
};
add('PAL penalty window', palPenalty(1.2));
add('PAL in the box callout', palPenalty(0, 0.5));
add('PAL in the box callout + drop', () => palPenalty(0, 1.3)().set((s) => (s.faceoff!.dropped = true)).emit({ type: 'faceoffDrop' }).run(0.15));
add('intermission', () => {
  const m = new Mock();
  addGoal(m, goalInfo(0, 0, [1], { period: 1, clock: 72 }));
  addGoal(m, goalInfo(1, 5, [6, 7], { period: 1, clock: 31, powerPlay: true }));
  addGoal(m, goalInfo(0, 1, [0, 2], { period: 2, clock: 95 }));
  m.state.periodGoals.push([0, 0]);
  m.set((s) => {
    s.shots = [14, 9];
    s.hits = [5, 8];
    s.skaters[7].stats.pim = 30;
    s.clock = 0;
  });
  return m
    .phase('periodEnd')
    .emit({ type: 'periodEnd', period: 2 })
    .run(1)
    .phase('intermission')
    .set((s) => (s.period = 3, s.clock = RULES.periodLength))
    .emit({ type: 'intermissionStart', nextPeriod: 3 })
    .run(2.5);
});

/** penalties the way the sim calls them: the seconds in stats.pim, lastPenaltyCall and the 'penalty' event */
function callPenalties(m: Mock, calls: Penalty[]): void {
  for (const p of calls) {
    m.state.skaters[p.skaterId].stats.pim += p.duration;
    m.state.lastPenaltyCall = p;
    m.emit({ type: 'penalty', penalty: p });
  }
}

// a major and a minor: 60 s and 30 s of sim time, 5 + 2 = 7 scoresheet minutes
// (BLZ). PUP's #12 took two minors = 60 s too, which must read 4, not 5.
add('intermission major + minor', () => {
  const m = new Mock();
  addGoal(m, goalInfo(0, 0, [1], { period: 1, clock: 72 }));
  addGoal(m, goalInfo(1, 5, [6, 7], { period: 2, clock: 31, powerPlay: true }));
  m.set((s) => {
    s.period = 2;
    s.shots = [17, 12];
    s.hits = [6, 13];
  });
  callPenalties(m, [penalty(7, 1, 'BOARDING', true, 0), penalty(6, 1, 'ROUGHING', false, 0), penalty(1, 0, 'HOOKING', false, 0)]);
  m.run(0.2);
  callPenalties(m, [penalty(1, 0, 'TRIPPING', false, 0)]);
  return m
    .set((s) => (s.clock = 0, s.penalties = [], s.lastPenaltyCall = null))
    .phase('periodEnd')
    .emit({ type: 'periodEnd', period: 2 })
    .run(1)
    .phase('intermission')
    .set((s) => (s.period = 3, s.clock = RULES.periodLength))
    .emit({ type: 'intermissionStart', nextPeriod: 3 })
    .run(2.5);
});

const final = (res: 'win' | 'loss' | 'tie', sec = 3.0, f?: (m: Mock) => void) => () => {
  const m = new Mock();
  playedGame(m, res);
  f?.(m);
  return m
    .set((s) => {
      s.period = Math.max(3, s.periodGoals.length);
      s.clock = 0;
      s.winner = res === 'win' ? 0 : res === 'loss' ? 1 : 'tie';
    })
    .phase('gameOver')
    .emit({ type: 'gameOver', winner: res === 'win' ? 0 : res === 'loss' ? 1 : 'tie' })
    .run(sec);
};
add('final win', final('win'));
add('final loss', final('loss'));
add('final tie', final('tie'));
// page 2 comes up on its own after 5 s (T.finalFirst)
add('final win page 2', final('win', 5.6));
add('final loss page 2', final('loss', 5.6));
// ... and the book flips back to the stars 4 s later, which skate in again
add('final win page 1 again 0.9s', final('win', 5.0 + 4.0 + 0.9));
// SHOOT flips at once (once main.ts forwards the pad)
const pad = (shoot: boolean) => {
  const b = (v: boolean) => ({ held: v, pressed: v, released: false });
  return { up: false, down: false, left: false, right: false, shoot: b(shoot), pass: b(false), turbo: b(false), start: b(false) };
};
add('final SHOOT flips 2.0s', () => {
  const m = final('win', 2.0)();
  m.hud.onPad(pad(true), m.state);
  return m.run(0.4);
});
// an overtime winner with a long scoring summary, a major, and BUTCH's
// hits-only star line
add('final OT page 2', () => {
  const m = new Mock();
  playedGame(m, 'tie');
  addGoal(m, goalInfo(0, 2, [0], { period: 2, clock: 40 }));
  addGoal(m, goalInfo(1, 7, [5], { period: 3, clock: 77 }));
  addGoal(m, goalInfo(1, 8, [], { period: 3, clock: 19, powerPlay: true }));
  addGoal(m, goalInfo(0, 3, [1, 0], { period: 3, clock: 2 }));
  addGoal(m, goalInfo(0, 0, [2], { period: 4, clock: 63 }));
  m.state.periodGoals[3] ??= [0, 0];
  m.state.skaters[7].stats.pim = 0;
  m.state.skaters[2].stats.pim = 0;
  callPenalties(m, [penalty(7, 1, 'CHARGING', true, 0), penalty(2, 0, 'SLASHING', false, 0)]);
  m.state.lastPenaltyCall = null;
  return m
    .set((s) => (s.period = 4, s.clock = 57, s.winner = 0, s.shots = [31, 26]))
    .phase('gameOver')
    .emit({ type: 'gameOver', winner: 0 })
    .run(5.6);
});
add('final stars: hits + shots only', final('loss', 3.0, (m) => {
  // a #44 with no points but 6 hits and 8 shots; a long-named kid with 12 hits
  const st = m.state.skaters;
  for (const s of st) s.stats = { goals: 0, assists: 0, shots: 0, hits: 0, pim: 0 };
  st[7].stats.hits = 6;
  st[7].stats.shots = 8;
  st[6].stats.hits = 12;
  st[6].stats.assists = 1;
  st[6].name = 'MCKENZIE';
  st[6].number = '12';
  st[2].stats.goals = 1;
  st[2].stats.shots = 3;
}));

// shots on goal while the puck is dead: under the score bug
const sogFaceoff = (period: number, clock: number, after: number) => () =>
  new Mock()
    .set((s) => {
      s.period = period;
      s.clock = clock;
      s.score = [2, 1];
      s.shots = [13, 9];
      s.faceoff = { spot: { x: 6.7, z: 20.5 }, dropped: false, dropTime: 1.4, earlyPress: [false, false] };
    })
    .phase('faceoff')
    .emit({ type: 'faceoffSetup', spot: { x: 6.7, z: 20.5 } })
    .run(after);
add('faceoff SOG', sogFaceoff(2, 64, 0.6));
add('faceoff SOG 3rd period card', sogFaceoff(3, RULES.periodLength, 0.6));
add('faceoff SOG gone at drop', () => sogFaceoff(2, 64, 1.4)().set((s) => (s.faceoff!.dropped = true)).emit({ type: 'faceoffDrop' }).run(0.15));
add('stoppage SOG', () =>
  new Mock()
    .set((s) => {
      s.clock = 51;
      s.score = [0, 0];
      s.shots = [4, 7];
    })
    .phase('stoppage')
    .run(0.5),
);
add('faceoff PP over SOG', () =>
  sogFaceoff(2, 64, 0.1)()
    .set((s) => {
      s.penalties = [penalty(7, 1, 'BOARDING', false, 22)];
      s.skaters[7].state = 'box';
    })
    .run(0.5),
);
// ---- DELAYED PENALTY chip (state.delayedPenalty is an additive gameplay
// field: written through a loose cast so this compiles before it exists) ----
const setDelayed = (s: GameState, d: { team: TeamId; skaterId: number } | null | undefined) => {
  (s as unknown as { delayedPenalty?: unknown }).delayedPenalty = d ? { ...d, t: s.time } : d;
};
const delayedEvent = (team: TeamId, skaterId: number) => ({ type: 'delayedPenalty', team, skaterId }) as unknown as GameEvent;
/** a call goes up mid-play: the field is set and the event fires, then `after` s pass */
const delayed = (team: TeamId, skaterId: number, after: number, setup?: (s: GameState) => void) => () =>
  new Mock()
    .set((s) => {
      s.clock = 77;
      s.score = [1, 1];
      s.shots = [8, 6];
      setup?.(s);
    })
    .run(0.5) // the score bug has slid in
    .set((s) => setDelayed(s, { team, skaterId }))
    .emit(delayedEvent(team, skaterId))
    .run(after);
add('delayed penalty pop 0.05s', delayed(1, 7, 0.05));
add('delayed penalty pop 0.12s', delayed(1, 7, 0.12));
add('delayed penalty BLZ 1.0s', delayed(1, 7, 1.0));
add('delayed penalty blink off 1.4s', delayed(1, 7, 1.4));
add('delayed penalty PUP (PAL)', delayed(0, 0, 1.0));
add('delayed penalty + PP strip', delayed(0, 2, 1.0, (s) => pp(s)));
add('delayed penalty + PP pop 0.1s', delayed(0, 2, 0.1, (s) => pp(s)));
add('delayed penalty + PP + PAL off top', delayed(1, 6, 1.0, (s) => {
  pp(s);
  s.skaters[0].pos = { x: -4, z: 13 };
}));
add('delayed penalty + PAL under the chip', delayed(1, 6, 1.0, (s) => (s.skaters[0].pos = { x: 1, z: 9 })));
add('delayed penalty + big hit up top', () =>
  delayed(1, 8, 0.2, (s) => {
    pp(s);
    s.skaters[6].pos = { x: -2, z: 10 };
    s.skaters[6].state = 'fallen';
  })()
    .emit({ type: 'check', hitter: 2, victim: 6, force: 8, knockedDown: true })
    .run(0.3),
);
add('delayed penalty PP ends (chip moves up)', () =>
  delayed(0, 3, 0.8, (s) => pp(s))()
    .set((s) => {
      s.penalties = [];
      s.skaters[7].state = 'skate';
    })
    .run(0.4),
);
add('delayed penalty stoppage (no SOG)', () => delayed(1, 7, 0.6)().phase('stoppage').run(0.4));
add('delayed penalty called', () => {
  const pen = penalty(7, 1, 'HOOKING');
  return delayed(1, 7, 1.5)()
    .set((s) => {
      setDelayed(s, null);
      s.penalties = [pen];
      s.lastPenaltyCall = pen;
      s.skaters[7].state = 'box';
    })
    .phase('penalty')
    .emit({ type: 'whistle', reason: 'penalty' }, { type: 'penalty', penalty: pen })
    .run(0.6);
});
add('delayed penalty never set (= play)', () =>
  new Mock()
    .set((s) => {
      s.clock = 77;
      s.score = [1, 1];
      s.shots = [8, 6];
    })
    .run(1.0),
);
add('delayed penalty field undefined', () => delayed(1, 7, 0.5)().set((s) => setDelayed(s, undefined)).run(0.5));
add('delayed penalty field null', () => delayed(1, 7, 0.5)().set((s) => setDelayed(s, null)).run(0.5));
add('delayed penalty during goal', () => {
  const info = goalInfo(0, 1, [2], { clock: 77 });
  const m = delayed(1, 7, 0.5)();
  addGoal(m, info);
  return m.phase('goal').emit({ type: 'goal', info }, { type: 'whistle', reason: 'goal' }).run(1.0);
});
add('pause', () =>
  new Mock()
    .set((s) => {
      s.clock = 61;
      s.score = [1, 2];
      s.paused = true;
    })
    .run(0.4),
);

// --------------------------------------------------------------- page ----
const only = new URLSearchParams(location.search).get('only');
const grid = document.getElementById('grid')!;
const shots: { name: string; url: string }[] = [];
for (const [name, build] of scenarios) {
  if (only && !name.includes(only)) continue;
  const cell = document.createElement('figure');
  let canvas: HTMLCanvasElement;
  try {
    canvas = build().compose();
  } catch (e) {
    console.error(`scenario "${name}" threw`, e);
    canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
  }
  cell.appendChild(canvas);
  const cap = document.createElement('figcaption');
  cap.textContent = name;
  cell.appendChild(cap);
  grid.appendChild(cell);
  shots.push({ name, url: canvas.toDataURL('image/png') });
}
(window as unknown as { __hudShots: typeof shots }).__hudShots = shots;
