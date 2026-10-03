// Builds the static arena (ice with every marking, boards + ads, glass, goals
// with nets and goal lights, penalty boxes, benches, stands with an animated
// pixel crowd) and animates the live bits: the crowd reacts to goals, big
// hits, posts and saves, and the goal light flashes behind the scored-on net.
import * as THREE from 'three';
import { RINK, RULES } from '../config';
import { attackDir } from '../sim/rink';
import type { GameEvent, GameState } from '../types';
import { buildBoards } from './arena/boards';
import { buildBooths } from './arena/booths';
import { buildGoals } from './arena/goals';
import { buildIce } from './arena/ice';
import { buildStands, type CheerKind } from './arena/stands';

export interface RinkView {
  /** per-frame animation (crowd bob, goal lights) */
  update(state: GameState, dt: number): void;
  onEvents(events: GameEvent[], state: GameState): void;
}

export function buildRink(scene: THREE.Scene): RinkView {
  const root = new THREE.Group();
  root.name = 'arena';
  const stands = buildStands();
  const goals = buildGoals();
  root.add(stands.group, buildIce(), buildBoards(), buildBooths(), goals.group);
  scene.add(root);

  // crowd state: the strongest current reaction wins until it runs out
  let cheer: CheerKind = 'idle';
  let cheerLeft = 0;
  let cheerRate = 8; // frame swaps per second while cheering
  let animT = 0;
  let idleT = 0;
  let cheerPhase: 0 | 1 = 0;
  let idlePhase: 0 | 1 = 0;
  const react = (kind: CheerKind, seconds: number, rate: number) => {
    if (seconds < cheerLeft && cheer !== 'idle') return;
    cheer = kind;
    cheerLeft = seconds;
    cheerRate = rate;
  };

  return {
    onEvents(events, state) {
      for (const e of events) {
        switch (e.type) {
          case 'goal': {
            const end = attackDir(e.info.team, state.period);
            goals.goal(end, RULES.goalCelebrateTime);
            react(e.info.team === 0 ? 'home' : 'away', RULES.goalCelebrateTime + 0.8, e.info.team === 0 ? 9 : 6);
            break;
          }
          case 'check':
            if (e.knockedDown) react('all', 1.4, 7);
            break;
          case 'post':
            react('all', 0.8, 6);
            break;
          case 'save': {
            const g = state.skaters[e.goalie];
            if (g) react(g.team === 0 ? 'home' : 'away', 0.9, 6);
            break;
          }
          case 'penalty':
            // the home crowd loves a call against the visitors
            if (e.penalty.team === 1) react('home', 1.6, 6);
            break;
          case 'gameOver':
            if (e.winner !== 'tie') react(e.winner === 0 ? 'home' : 'away', 30, e.winner === 0 ? 8 : 5);
            break;
          case 'periodStart':
          case 'rematch':
            if (e.type === 'rematch') cheerLeft = 0;
            react('all', 1.2, 6);
            break;
          case 'bark':
            react('home', 0.6, 7);
            break;
        }
      }
    },
    update(state, dt) {
      // the camera looks along HOME's attack direction (cameraHeading), so the
      // end behind the lens is HOME's own
      goals.update(dt, attackDir(0, state.period) === 1 ? -1 : 1);
      cheerLeft = Math.max(0, cheerLeft - dt);
      if (cheerLeft === 0) cheer = 'idle';
      animT += dt;
      if (animT >= 1 / cheerRate) {
        animT = 0;
        cheerPhase = cheerPhase ? 0 : 1;
      }
      // the idle crowd fidgets faster when HOME has the puck deep in the zone
      const d = attackDir(0, state.period);
      const hot = state.phase === 'play' && state.puck.pos.z * d > RINK.blueLineZ;
      idleT += dt;
      if (idleT >= (hot ? 0.28 : 0.6)) {
        idleT = 0;
        idlePhase = idlePhase ? 0 : 1;
      }
      stands.setCheer(cheer, cheerPhase, idlePhase);
    },
  };
}
