// Shot wind-up: while the player holds SHOOT with the puck, a quiet chip
// pulse whose pitch (300 -> 900 Hz) and pulse rate climb with the charge, so
// a full slap shot can be timed by ear. One voice at most, owned by the
// engine (audio.ts update): it starts on 'windup', follows s.windup, and is
// stopped on the shot, on any state change, a control switch, a pause or a
// hidden tab. Every node it makes is disconnected when the voice ends.

import type { AudioCore } from './core';

/** pitch of the pulse at charge 0 and 1 */
const F_LO = 300;
const F_HI = 900;
/** gate rate (Hz) at charge 0 and 1: the pulse gets more urgent */
const RATE_LO = 9;
const RATE_HI = 17;
/** peak level into the sfx bus (quiet: it sits under every stick sound) */
const VOL = 0.045;
/** fade in / out (s) */
const ATTACK = 0.015;
const RELEASE = 0.025;
/** voice-budget estimate claimed on start (a full charge plus a short hold) */
const BUDGET = 1.2;

const fin = (x: number) => typeof x === 'number' && Number.isFinite(x);
const clamp01 = (x: number) => (fin(x) ? Math.max(0, Math.min(1, x)) : 0);

interface Voice {
  osc: OscillatorNode;
  lfo: OscillatorNode;
  env: GainNode;
  nodes: AudioNode[];
  startAt: number;
  charge: number;
}

export class ChargeTone {
  private core: AudioCore;
  private v: Voice | null = null;
  /** voices started / fully ended (tests: started - ended = live voices) */
  started = 0;
  ended = 0;

  constructor(core: AudioCore) {
    this.core = core;
  }

  get active(): boolean {
    return this.v !== null;
  }

  /** current charge-driven frequency target (Hz), or 0 when silent */
  get freq(): number {
    return this.v ? F_LO + (F_HI - F_LO) * this.v.charge : 0;
  }

  /**
   * Start the pulse at `t` (no-op if already sounding). Returns false when
   * the sfx voice budget refuses it (the charge tone is the first to go).
   */
  start(t: number, charge: number): boolean {
    if (this.v) return true;
    if (!fin(t)) return false;
    const core = this.core;
    if (!core.claim('windup', t, 0, t + BUDGET, 1)) return false;
    const ctx = core.ctx;
    const c = clamp01(charge);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(core.waves.p25);
    osc.frequency.setValueAtTime(F_LO + (F_HI - F_LO) * c, t);
    // square LFO gates the tone on/off: gate = 0.5 + 0.5 * square
    const gate = ctx.createGain();
    gate.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(RATE_LO + (RATE_HI - RATE_LO) * c, t);
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(gate.gain);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(VOL, t + ATTACK);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    osc.connect(gate).connect(env).connect(lp).connect(core.sfx);
    const v: Voice = { osc, lfo, env, nodes: [osc, lfo, gate, depth, env, lp], startAt: t, charge: c };
    osc.onended = () => {
      for (const n of v.nodes) {
        try {
          n.disconnect();
        } catch {
          // already disconnected
        }
      }
      this.ended++;
    };
    osc.start(t);
    lfo.start(t);
    this.v = v;
    this.started++;
    return true;
  }

  /** follow the charge (0..1) */
  set(t: number, charge: number): void {
    const v = this.v;
    if (!v || !fin(t)) return;
    const c = clamp01(charge);
    if (Math.abs(c - v.charge) < 0.004) return;
    v.charge = c;
    const at = Math.max(t, v.startAt);
    v.osc.frequency.setTargetAtTime(F_LO + (F_HI - F_LO) * c, at, 0.012);
    v.lfo.frequency.setTargetAtTime(RATE_LO + (RATE_HI - RATE_LO) * c, at, 0.012);
  }

  /** fade out and release every node; safe to call when silent */
  stop(t: number): void {
    const v = this.v;
    if (!v) return;
    this.v = null;
    const at = Math.max(fin(t) ? t : this.core.now(), v.startAt);
    try {
      v.env.gain.cancelScheduledValues(at);
      v.env.gain.setTargetAtTime(0, at, RELEASE / 4);
      v.osc.stop(at + RELEASE + 0.01);
      v.lfo.stop(at + RELEASE + 0.01);
    } catch {
      // a stop that throws still must not leak: cut the voice at once
      try {
        v.osc.stop();
        v.lfo.stop();
      } catch {
        // ignore
      }
    }
  }
}
