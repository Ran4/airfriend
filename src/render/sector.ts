// 8-way sprite facing with hysteresis and a minimum dwell, shared by the actor
// layer and node tools (no three.js, no DOM). A heading near a sector edge
// would otherwise flip the sprite to the neighbour and back several times a
// second as the AI steers.

const SECTOR = Math.PI / 4;
/**
 * Extra angle past a sector edge before the facing flips. 0.30 rad leaves a
 * 0.09 rad gap before the neighbour's centre (half a sector is 0.39), so a
 * heading that settles on a neighbour's centre always gets there.
 */
const SECTOR_HYST = 0.3;
/**
 * Minimum sim seconds in a sector before stepping to a NEIGHBOUR. Jumps of two
 * sectors or more (a real turn, a reversal) go through at once, so a snap
 * never lags; only the A-B-A wobble is held back.
 */
const SECTOR_DWELL = 0.12;

export interface SectorMemory {
  sector: number; // 0..7, -1 = unset
  since: number; // sim seconds spent in `sector`
}

function wrap(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/**
 * Quantize a screen-space heading (radians, 0 = away from the lens) into one of
 * the 8 sprite sectors, updating `m`. `dt` is the sim time since the last call.
 */
export function stepSector(m: SectorMemory, raw: number, dt: number): number {
  m.since += dt;
  const nearest = (Math.round(raw / SECTOR) + 8) % 8;
  if (m.sector >= 0) {
    if (Math.abs(wrap(raw - m.sector * SECTOR)) <= SECTOR / 2 + SECTOR_HYST) return m.sector;
    const steps = Math.min((nearest - m.sector + 8) % 8, (m.sector - nearest + 8) % 8);
    if (steps <= 1 && m.since < SECTOR_DWELL) return m.sector;
  }
  m.sector = nearest;
  m.since = 0;
  return m.sector;
}

/** A sector's center angle in (-PI, PI]: what the sprite library expects. */
export function sectorAngle(sector: number): number {
  return wrap(sector * SECTOR);
}
