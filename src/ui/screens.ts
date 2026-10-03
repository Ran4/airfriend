// Full-screen and large interface pieces: intro logo, controls card,
// intermission summary, the two-page final screen (result + three stars,
// box score), pause window.

import { RULES, SCREEN, TEAMS } from '../config';
import type { GameState, Penalty, Skater, TeamId } from '../types';
import { banner, bannerChars, bannerStyle, cycle, pingPong } from './banners';
import { drawText, textWidth } from './font';
import { blink, clamp01, clockStr, jersey, pad, periodName, periodTitle, slide } from './format';
import { C, GRAD, snes, teamGrad } from './palette';
import { drawChip, drawIcon, drawKey, drawMeter, drawRule, drawWindow, ICONS, rect, type G } from './window';

const W = SCREEN.width;
const H = SCREEN.height;

/** whole-screen darkening, like dropping INIDISP brightness a few steps */
function dim(g: G, amount = 0.5): void {
  g.fillStyle = `rgba(0,4,16,${amount})`;
  g.fillRect(0, 0, W, H);
}

// --------------------------------------------------------------- intro ----
/**
 * The title card over the arena sweep. `t` = seconds into the intro,
 * `left` = seconds until the intro ends. The last 1.2 s become the
 * "1ST PERIOD / GET READY!" card.
 */
export function drawIntro(g: G, t: number, left: number, wall: number, period: number, logo = true): void {
  if (logo && left > 1.2) drawLogo(g, t, wall);
  else drawPeriodCard(g, periodTitle(period), logo ? 1.2 - left : t, wall, 'GET READY!');
}

function drawLogo(g: G, t: number, wall: number): void {
  // "AIR FRIEND" slides in from the left, "HOCKEY" from the right, they lock
  // together with a 2-frame white flash, then the dog pops up and the
  // matchup window rises from the bottom.
  const flash = t > 0.32 && t < 0.4;
  const shimmer = Math.floor(wall * 16) % 24; // highlight band sweeps every 1.5 s
  const sweep = (base: readonly string[]) =>
    flash ? GRAD.white : base.map((c, i) => (Math.abs(i - (shimmer - 8)) < 1 ? C.white : c));

  // dog face, dropping in with a little bounce (and blinking now and then)
  if (t > 0.3) {
    const dt = t - 0.3;
    const bounce = dt < 0.18 ? slide(dt, 0.18, -48, 4) : dt < 0.3 ? slide(dt - 0.18, 0.12, 4, 0) : 0;
    const dog = ICONS.dog;
    const dx = Math.floor(W / 2 - dog.rows[0].length / 2);
    const dy = 3 + bounce;
    // blink now and then by swapping the glint to ink
    drawIcon(g, dog, dx, dy, 1, wall % 3.2 > 3.05 ? { g: C.ink } : undefined);
  }

  const x1 = slide(t, 0.32, -140, W / 2);
  const x2 = slide(t, 0.32, W + 140, W / 2);
  banner(g, 'AIR FRIEND', x1, 42, sweep(GRAD.ice), 1);
  banner(g, 'HOCKEY', x2, 60, sweep(GRAD.fire), 2);
  if (t > 0.4) {
    // sparkles twinkling on the logo corners
    const k = Math.floor(wall * 6) % 4;
    const spots: [number, number][] = [[42, 40], [210, 60], [52, 90], [196, 38]];
    const [sx, sy] = spots[k];
    drawIcon(g, ICONS.sparkle, sx, sy);
  }

  // matchup window
  if (t > 0.5) {
    const y = slide(t - 0.5, 0.25, H + 10, 104);
    drawWindow(g, 24, y, 208, 54);
    const home = TEAMS[0];
    const away = TEAMS[1];
    drawChip(g, 32, y + 7, 0, home.abbr);
    drawText(g, `${home.city} ${home.name}`, 70, y + 9, { color: C.white });
    if (t > 0.65) drawText(g, 'VS', W / 2, y + 22, { color: C.yellow, align: 'center' });
    if (t > 0.8) {
      drawChip(g, 32, y + 34, 1, away.abbr);
      drawText(g, away.city, 70, y + 32, { color: C.white });
      drawText(g, away.name, 70, y + 41, { color: C.white });
    }
  }
  if (t > 0.9) drawText(g, '©1994 PUPWORKS', W / 2, 165, { color: C.white, align: 'center' });
}

/** big period name sliding in, with a blinking subtitle */
export function drawPeriodCard(g: G, title: string, t: number, wall: number, sub: string | null, y = 52): void {
  const x = slide(t, 0.18, W + 120, W / 2);
  const flash = t > 0.18 && t < 0.24;
  banner(g, title, x, y, flash ? GRAD.white : GRAD.gold, 1);
  if (sub && t > 0.2 && blink(wall, 3)) {
    drawText(g, sub, W / 2, y + 22, { grad: GRAD.white, outline: C.ink, shadow: null, scale: 2, align: 'center' });
  }
}

// ------------------------------------------------------------ controls ----
export function drawControls(g: G, y: number): void {
  drawWindow(g, 12, y, 232, 34);
  const row1 = y + 6;
  const row2 = y + 19;
  const pair = (px: number, py: number, a: string, b: string, label: string) => {
    let q = px;
    q += drawKey(g, q, py, a) + 1;
    drawText(g, '/', q, py + 2, { color: C.gray });
    q += 8;
    q += drawKey(g, q, py, b) + 3;
    drawText(g, label, q, py + 2, { color: C.white });
  };
  pair(20, row1, 'Z', 'J', 'SHOOT');
  // PASS/CHECK: without the puck X/K is the body check, and this card is all a first-timer reads
  pair(120, row1, 'X', 'K', 'PASS/CHECK');
  pair(20, row2, 'C', 'L', 'TURBO/BARK');
  // arrow cluster
  ['↑', '↓', '←', '→'].forEach((k, i) => drawKey(g, 142 + i * 12, row2, k));
  drawText(g, 'SKATE', 193, row2 + 2, { color: C.white });
}

// -------------------------------------------------------- intermission ----
interface SummaryInfo {
  endedPeriod: number;
  nextPeriod: number;
  t: number; // seconds since the screen opened
  left: number; // seconds until play resumes (NaN if unknown)
  wall: number;
  /** every penalty called this game (for PIM; see teamPim) */
  penalties?: readonly Penalty[];
}

// ---------------------------------------------------- penalty minutes ----
// The sim plays scaled-down penalties (a minor is RULES.minorLength seconds of
// game clock, a major RULES.majorLength) and adds those seconds to stats.pim.
// Stat screens print what a real scoresheet would: 2 minutes per minor, 5 per
// major.

/** scoresheet minutes for one call: 5 for a major, 2 for a minor */
function penaltyMinutes(p: Pick<Penalty, 'duration' | 'major'>): number {
  return p.major || p.duration > RULES.minorLength + 0.5 ? 5 : 2;
}

/**
 * Minutes for `sec` of penalty time whose calls we never saw. A major and two
 * minors can last the same, so this reads as minors where it can (majors are
 * the rare, flattening hits).
 */
function minutesFromSeconds(sec: number): number {
  if (sec < 0.5) return 0;
  for (let majors = 0; majors * RULES.majorLength <= sec + 0.5; majors++) {
    const rest = (sec - majors * RULES.majorLength) / RULES.minorLength;
    if (Math.abs(rest - Math.round(rest)) < 0.02) return Math.round(rest) * 2 + majors * 5;
  }
  return Math.max(1, Math.round(sec / RULES.minorLength)) * 2;
}

/**
 * Penalty minutes per team. `log` = every call the HUD saw this game; the
 * calls still on the state (in the box, queued, the last one whistled) count
 * too. Each skater's known calls are checked against his stats.pim seconds,
 * and any time not accounted for is converted by duration.
 */
function teamPim(state: GameState, log: readonly Penalty[] = []): [number, number] {
  const known = new Set<Penalty>([...log, ...state.penalties, ...(state.penaltyQueue ?? [])]);
  if (state.lastPenaltyCall) known.add(state.lastPenaltyCall);
  const out: [number, number] = [0, 0];
  for (const s of state.skaters) {
    const sec = s.stats.pim;
    if (sec <= 0) continue;
    let seen = 0;
    let min = 0;
    for (const p of known) {
      if (p.skaterId !== s.id) continue;
      seen += p.duration;
      min += penaltyMinutes(p);
    }
    // a log that over-counts is stale: trust the seconds alone
    out[s.team] += seen > sec + 0.5 ? minutesFromSeconds(sec) : min + minutesFromSeconds(sec - seen);
  }
  return out;
}

function goalLines(state: GameState): string[] {
  return state.goals.map((gl) => {
    const s = state.skaters[gl.scorer];
    const tag = gl.powerPlay ? 'PP' : gl.shortHanded ? 'SH' : '';
    return `${pad(periodName(gl.period), 3)} ${TEAMS[gl.team].abbr} ${pad(`${jersey(s)} ${s.name}`, 10)} ${clockStr(gl.clock)} ${tag}`;
  });
}

/** an extra team column on the period table (SOG, PIM ...) */
interface TableCol {
  label: string;
  values: [string, string];
}

/**
 * Shared summary table: goals by period + totals. With `extra` columns it
 * goes broadcast-compact (1 2 3 OT headers) to make room. Returns next y.
 */
function drawPeriodTable(g: G, state: GameState, x: number, y: number, through: number, extra: TableCol[] = []): number {
  const nPer = Math.max(3, Math.min(4, Math.max(through, state.periodGoals.length)));
  const compact = extra.length > 0;
  const colW = compact ? (nPer > 3 ? 20 : 22) : nPer > 3 ? 28 : 32;
  const col0 = x + 40;
  for (let p = 1; p <= nPer; p++) {
    const head = compact ? (p >= 4 ? 'OT' : String(p)) : periodName(p);
    drawText(g, head, col0 + (p - 1) * colW + colW / 2, y, { color: C.yellow, align: 'center' });
  }
  const totX = col0 + nPer * colW + (compact ? 8 : 12);
  const extraX = (i: number) => totX + 32 * (i + 1);
  drawText(g, 'T', totX, y, { color: C.yellow, align: 'center' });
  extra.forEach((col, i) => drawText(g, col.label, extraX(i), y, { color: C.yellow, align: 'center' }));
  for (const team of [0, 1] as TeamId[]) {
    const ry = y + 12 + team * 14;
    drawChip(g, x, ry - 2, team, TEAMS[team].abbr);
    for (let p = 1; p <= nPer; p++) {
      const played = p <= through;
      const v = played ? String(state.periodGoals[p - 1]?.[team] ?? 0) : '-';
      drawText(g, v, col0 + (p - 1) * colW + colW / 2, ry, { color: played ? C.white : C.dgray, align: 'center' });
    }
    drawText(g, String(state.score[team]), totX, ry, { color: C.yellow, align: 'center' });
    extra.forEach((col, i) => drawText(g, col.values[team], extraX(i), ry, { color: C.white, align: 'center' }));
  }
  return y + 40;
}

/** the SCORING list: newest `max` goals from y, a '+N MORE' note on the header row above */
function drawScoring(g: G, state: GameState, x: number, y: number, max: number): void {
  drawText(g, 'SCORING', x + 4, y, { color: C.yellow });
  y += 11;
  const lines = goalLines(state);
  if (!lines.length) drawText(g, 'NO SCORING', W / 2, y + 12, { color: C.gray, align: 'center' });
  const shown = lines.slice(-max);
  if (lines.length > max) drawText(g, `+${lines.length - max} MORE`, x + 208, y - 11, { color: C.gray, align: 'right' });
  shown.forEach((ln, i) => {
    const gl = state.goals[lines.length - shown.length + i];
    drawText(g, ln, x + 4, y + i * 10, { color: gl.team === 0 ? C.white : snes('#c8c8f0') });
  });
}

export function drawIntermission(g: G, state: GameState, info: SummaryInfo): void {
  dim(g, 0.55);
  const y0 = slide(info.t, 0.3, -H, 10);
  drawWindow(g, 12, y0, 232, 204);
  const x = 22;
  let y = y0 + 8;
  drawText(g, `END OF ${periodTitle(info.endedPeriod)}`, W / 2, y, { color: C.yellow, align: 'center' });
  y += 14;
  y = drawPeriodTable(g, state, x, y, info.endedPeriod);
  drawRule(g, x, y - 4, 212);
  // team stat comparison
  const c1 = x + 132;
  const c2 = x + 180;
  drawText(g, TEAMS[0].abbr, c1, y, { color: snes('#f8a8a8'), align: 'center' });
  drawText(g, TEAMS[1].abbr, c2, y, { color: snes('#b8a8f8'), align: 'center' });
  const pim = teamPim(state, info.penalties);
  const rows: [string, string, string][] = [
    ['SHOTS', String(state.shots[0]), String(state.shots[1])],
    ['HITS', String(state.hits[0]), String(state.hits[1])],
    ['PIM', String(pim[0]), String(pim[1])],
  ];
  rows.forEach(([label, a, b], i) => {
    const ry = y + 11 + i * 10;
    drawText(g, label, x + 4, ry, { color: C.white });
    // dotted leader, the way old stat screens filled the gap
    for (let dx = x + 4 + label.length * 8 + 4; dx < c1 - 22; dx += 4) rect(g, dx, ry + 5, 1, 1, C.winMid);
    drawText(g, a, c1, ry, { color: C.white, align: 'center' });
    drawText(g, b, c2, ry, { color: C.white, align: 'center' });
  });
  y += 46;
  drawRule(g, x, y - 4, 212);
  drawScoring(g, state, x, y, 5);
  // footer: next period + countdown bar, then a blinking PRESS START
  const fy = y0 + 204 - 26;
  drawText(g, `NEXT: ${periodTitle(info.nextPeriod)}`, x + 4, fy, { color: C.sky });
  if (Number.isFinite(info.left)) {
    drawMeter(g, x + 148, fy + 1, 60, 6, clamp01(info.left / RULES.intermissionTime), [C.cyan, C.cyan, C.cyan]);
  }
  if (blink(info.wall, 2)) drawText(g, 'PRESS START', W / 2, fy + 12, { color: C.white, align: 'center' });
}

// --------------------------------------------------------------- final ----
interface Star {
  s: Skater;
  score: number;
  /** the stat line, most detailed first; the screen prints the first that fits */
  lines: string[];
}

/** what a skater's star score is made of, in scoresheet order (G A H S) */
const STAR_PARTS = [
  { key: 'goals', w: 3, short: 'G', long: (n: number) => `${n} GOAL${n === 1 ? '' : 'S'}` },
  { key: 'assists', w: 2, short: 'A', long: (n: number) => `${n} AST` },
  { key: 'hits', w: 0.6, short: 'H', long: (n: number) => `${n} HIT${n === 1 ? '' : 'S'}` },
  { key: 'shots', w: 0.25, short: 'S', long: (n: number) => `${n} SOG` },
] as const;

/**
 * Three stars from goals, assists, hits and shots (saves for goalies). The
 * line shows what actually put a skater there: his biggest contributions to
 * the star score, so a #44 with an assist and six hits reads '1A 6H' and can
 * sit above a '1G 1A' without looking like a mistake.
 */
function threeStars(state: GameState): Star[] {
  const stars: Star[] = state.skaters.map((s) => {
    const st = s.stats;
    if (s.kind === 'goalie') {
      const opp = (1 - s.team) as TeamId;
      const ga = state.score[opp];
      const sv = Math.max(0, state.shots[opp] - ga);
      const score = sv * 0.3 - ga * 0.6 + (ga === 0 && sv >= 5 ? 2.5 : 0) + st.goals * 3 + st.assists * 2;
      return { s, score, lines: [`${sv} SV`] };
    }
    const parts = STAR_PARTS.map((p, i) => ({ ...p, i, n: st[p.key], v: st[p.key] * p.w })).filter((p) => p.n > 0);
    const score = parts.reduce((sum, p) => sum + p.v, 0) - st.pim / 120 + (s.kind === 'dog' ? 0.05 : 0);
    // biggest contributions first (ties: scoresheet order); print them in scoresheet order
    const top = [...parts].sort((a, b) => b.v - a.v || a.i - b.i);
    const lines: string[] = [];
    for (let k = Math.min(3, top.length); k >= 1; k--) {
      const pick = top.slice(0, k).sort((a, b) => a.i - b.i);
      if (k === 1) lines.push(pick[0].long(pick[0].n));
      lines.push(pick.map((p) => `${p.n}${p.short}`).join(' '));
    }
    if (!lines.length) lines.push('0 SOG');
    return { s, score, lines };
  });
  return stars.sort((a, b) => b.score - a.score || a.s.id - b.s.id).slice(0, 3);
}

interface FinalInfo {
  t: number; // seconds since the screen opened
  wall: number;
  /** 0 = result + three stars, 1 = box score */
  page: number;
  /** seconds since this page came up */
  pageT: number;
  /** every penalty called this game (for PIM; see teamPim) */
  penalties?: readonly Penalty[];
}

/** pages on the final screen (the HUD flips them every few seconds, or on SHOOT) */
export const FINAL_PAGES = 2;

export function drawFinal(g: G, state: GameState, info: FinalInfo): void {
  const { t, wall } = info;
  dim(g, 0.55);
  const y0 = slide(t, 0.35, -H, 8);
  drawWindow(g, 12, y0, 232, 208);
  if (info.page === 1) drawBoxScore(g, state, y0, info);
  else drawResult(g, state, y0, info);
  if (t > 1.6) {
    drawRule(g, 22, y0 + 172, 212);
    if (blink(wall, 2)) drawText(g, 'PRESS START FOR REMATCH', W / 2, y0 + 182, { color: C.white, align: 'center' });
    // page indicator in the bottom corner, like a cartridge's stat book
    drawText(g, `${info.page + 1}/${FINAL_PAGES}`, 234, y0 + 195, { color: C.gray, align: 'right' });
  }
}

/** page 1: FINAL, the score, who won, team totals and the three stars */
function drawResult(g: G, state: GameState, y0: number, info: FinalInfo): void {
  const { t, wall } = info;
  const ot = state.period >= 4 || state.periodGoals.length >= 4;
  // FINAL with a shimmering gold cycle
  bannerChars(g, ot ? 'FINAL/OT' : 'FINAL', W / 2, y0 + 8, bannerStyle(GRAD.gold), (i) => ({
    grad: cycle(pingPong(GRAD.gold), wall * 10 + i),
  }));
  // score line
  const sy = y0 + 34;
  drawChip(g, 40, sy + 4, 0, TEAMS[0].abbr);
  drawChip(g, 188, sy + 4, 1, TEAMS[1].abbr);
  drawText(g, String(state.score[0]), 96, sy, { big: true, grad: teamGrad(0), outline: C.ink, scale: 1, align: 'center' });
  drawText(g, '-', W / 2, sy, { big: true, grad: GRAD.silver, outline: C.ink, align: 'center' });
  drawText(g, String(state.score[1]), 160, sy, { big: true, grad: teamGrad(1), outline: C.ink, align: 'center' });
  // winner text
  const winner = state.winner ?? (state.score[0] > state.score[1] ? 0 : state.score[1] > state.score[0] ? 1 : 'tie');
  const wy = sy + 24;
  if (t > 0.4) {
    if (winner === 'tie') banner(g, 'TIE GAME', W / 2, wy, GRAD.silver);
    else {
      // DESIGN.md 6: "PUPS WIN!" / "BLIZZARD WIN"
      const txt = `${TEAMS[winner].name} WIN${winner === 0 ? '!' : ''}`;
      const grad = winner === 0 ? GRAD.gold : teamGrad(1);
      // home win flashes, away win just sits there (sad trombone)
      banner(g, txt, W / 2, wy, winner === 0 && t < 2.5 && blink(wall, 4) ? GRAD.white : grad);
    }
  }
  // team stats line
  drawText(g, `SHOTS ${state.shots[0]}-${state.shots[1]}   HITS ${state.hits[0]}-${state.hits[1]}`, W / 2, wy + 22, {
    color: C.sky,
    align: 'center',
  });
  // three stars: they skate in one by one when the screen opens, and again
  // (a little sooner) each time the book flips back to this page
  const starT = info.pageT < t - 0.01 ? info.pageT + 0.5 : t;
  const ty = wy + 44;
  drawRule(g, 22, ty - 6, 212);
  drawText(g, 'THREE STARS', W / 2, ty, { color: C.yellow, align: 'center' });
  const stars = threeStars(state);
  stars.forEach((st, i) => {
    const appear = 0.8 + i * 0.35;
    if (starT < appear) return;
    const ry = ty + 16 + i * 16;
    const rx = slide(starT - appear, 0.2, W + 20, 24);
    const twinkle = Math.floor(wall * 8 + i * 3) % 8 === 0;
    for (let k = 0; k < 3 - i; k++) drawText(g, '★', rx + k * 7, ry, { color: twinkle ? C.white : C.gold });
    drawChip(g, rx + 26, ry - 2, st.s.team, TEAMS[st.s.team].abbr);
    const [who, line] = starRow(st);
    drawText(g, who, rx + 62, ry, { color: C.white });
    drawText(g, line, rx + 206, ry, { color: C.yellow, align: 'right' });
  });
}

/**
 * A star's name and stat line for the 144 px between the chip and the right
 * edge (x+62 .. x+206), with a 6 px gap: the most detailed stat line wins,
 * then the full name if it still fits, else the name cut to 6 letters.
 */
function starRow(st: Star): [string, string] {
  const room = 206 - 62 - 6;
  const names = [st.s.name, st.s.name.slice(0, 6)];
  for (const line of st.lines) {
    for (const name of names) {
      const who = `${pad(jersey(st.s), 3)} ${name}`;
      if (textWidth(who) + textWidth(line) <= room) return [who, line];
    }
  }
  return [`${pad(jersey(st.s), 3)} ${names[1]}`, st.lines[st.lines.length - 1]];
}

/** page 2: goals by period with SOG and PIM, and the full scoring summary */
function drawBoxScore(g: G, state: GameState, y0: number, info: FinalInfo): void {
  const x = 22;
  drawText(g, 'BOX SCORE', W / 2, y0 + 8, { color: C.yellow, align: 'center' });
  // the page's contents slide in from the right as the book flips over
  const ox = slide(info.pageT, 0.2, W, 0);
  const through = Math.min(4, Math.max(3, state.period, state.periodGoals.length));
  const pim = teamPim(state, info.penalties);
  const y = drawPeriodTable(g, state, x + ox, y0 + 24, through, [
    { label: 'SOG', values: [String(state.shots[0]), String(state.shots[1])] },
    { label: 'PIM', values: [String(pim[0]), String(pim[1])] },
  ]);
  drawRule(g, x, y - 4, 212);
  drawScoring(g, state, x + ox, y, 8);
}

// --------------------------------------------------------------- pause ----
/** switch states main.ts shows on the pause screen */
export interface PauseStatus {
  muted: boolean;
  crt: boolean;
  fullscreen: boolean;
}

export function drawPause(g: G, wall: number, status?: PauseStatus): void {
  dim(g, 0.5);
  const w = 200;
  const h = 142;
  const x = (W - w) / 2;
  // ends at 176: clear of the controls card (y 178) that can still be up
  const y = 34;
  drawWindow(g, x, y, w, h);
  banner(g, 'PAUSE', W / 2, y + 8, cycle(pingPong(GRAD.ice), wall * 8), 1);
  const lx = x + 12;
  const lines: [string, string][] = [
    ['←↑↓→/WASD', 'SKATE'],
    ['Z / J', 'SHOOT/POKE'],
    ['X / K', 'PASS/CHECK'],
    ['C / L', 'TURBO/BARK'],
    ['START', 'RESUME'],
  ];
  lines.forEach(([k, v], i) => {
    const ly = y + 34 + i * 12;
    drawText(g, k, lx, ly, { color: C.yellow });
    drawText(g, v, lx + 88, ly, { color: C.white });
  });
  drawRule(g, x + 8, y + h - 36, w - 16);
  // with a status from main.ts the toggles read as switches (MUTE OFF / CRT ON)
  const onOff = (v: boolean) => (v ? 'ON' : 'OFF');
  drawText(g, status ? `M MUTE ${onOff(status.muted)}` : 'M MUTE', lx, y + h - 28, { color: C.sky });
  drawText(g, status ? `V CRT ${onOff(status.crt)}` : 'V CRT', x + w - 12, y + h - 28, { color: C.sky, align: 'right' });
  drawText(g, status ? `F FULLSCREEN ${onOff(status.fullscreen)}` : 'F FULLSCREEN', lx, y + h - 16, { color: C.sky });
  // little blinking cursor on RESUME, like a menu that is waiting for you
  if (blink(wall, 2)) drawText(g, '▶', lx + 78, y + 34 + 4 * 12, { color: C.white });
}
