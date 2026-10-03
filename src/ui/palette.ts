// HUD palette. Every color is snapped to the SNES's 15-bit space (5 bits per
// channel) so the overlay sits in the same color world as the post-processed
// 3D frame underneath.

import { TEAMS } from '../config';
import type { TeamId } from '../types';

type RGB = [number, number, number];

/** snap an 8-bit channel to 5 bits and back (x & 0xf8, like the PPU sees it) */
const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v))) & 0xf8;

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return [q((n >> 16) & 255), q((n >> 8) & 255), q(n & 255)];
}

function rgbToHex([r, g, b]: RGB): string {
  return `#${((1 << 24) | (q(r) << 16) | (q(g) << 8) | q(b)).toString(16).slice(1)}`;
}

/** 15-bit snapped hex string */
export const snes = (hex: string): string => rgbToHex(hexToRgb(hex));

export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/** n quantized steps from a to b (inclusive), for banded gradients */
export function ramp(a: string, b: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(mix(a, b, n === 1 ? 0 : i / (n - 1)));
  return out;
}

export const C = {
  white: snes('#f8f8f8'),
  ink: snes('#000818'), // text shadow / outlines: a navy black, never pure black
  black: '#000000',
  gray: snes('#a8b0c8'),
  dgray: snes('#586078'),
  yellow: snes('#f8e030'),
  gold: snes('#f8b800'),
  orange: snes('#f87818'),
  red: snes('#f83828'),
  dred: snes('#a00818'),
  pink: snes('#f8a0c0'),
  green: snes('#48e048'),
  dgreen: snes('#108828'),
  cyan: snes('#60e8f8'),
  sky: snes('#98c8f8'),
  // window chrome
  winTop: snes('#4868e8'),
  winBot: snes('#101c78'),
  winEdge: snes('#000820'),
  winLight: snes('#f8f8f8'),
  winMid: snes('#a0a8d0'),
  winShade: snes('#283078'),
} as const;

interface TeamPal {
  main: string;
  dark: string;
  light: string;
  trim: string;
  /** readable text color on top of `main` */
  text: string;
}

function teamPal(t: TeamId): TeamPal {
  const c = TEAMS[t].colors;
  return {
    main: snes(c.jersey),
    dark: snes(c.jerseyDark),
    light: mix(c.jersey, '#ffffff', 0.35),
    trim: snes(c.trim),
    text: C.white,
  };
}

export const TEAM_PAL: [TeamPal, TeamPal] = [teamPal(0), teamPal(1)];

// Banner gradients, top row to bottom row of a glyph (8 entries for the 8x8
// font, the 16x16 banner font samples them in pairs => 2 px bands).
export const GRAD = {
  gold: ['#f8f8d0', '#f8f070', '#f8e030', '#f8c800', '#f8a800', '#f08800', '#d06000', '#a04000'].map(snes),
  fire: ['#f8f8a0', '#f8e040', '#f8b818', '#f88818', '#f85818', '#e03010', '#b01808', '#780800'].map(snes),
  ice: ['#f8f8f8', '#e0f0f8', '#c0e0f8', '#98c8f8', '#78a8f0', '#5888e0', '#3860c8', '#2040a0'].map(snes),
  cool: ['#f8f8f8', '#d0f8f8', '#a0e8f8', '#70c8f8', '#48a0f0', '#3070d8', '#2048b0', '#183088'].map(snes),
  silver: ['#f8f8f8', '#f0f0f8', '#d8e0f0', '#c0c8e0', '#a8b0d0', '#9098b8', '#7880a0', '#586078'].map(snes),
  white: ['#f8f8f8', '#f8f8f8', '#f8f8f8', '#f0f0f8', '#e8e8f8', '#d8d8f0', '#c8c8e8', '#b8b8d8'].map(snes),
  green: ['#e0f8d0', '#b0f898', '#80f070', '#58e050', '#38c838', '#20a828', '#108018', '#085810'].map(snes),
  red: ['#f8d0d0', '#f8a0a0', '#f87070', '#f84040', '#e02020', '#c01010', '#900808', '#600000'].map(snes),
} as const;

export function teamGrad(t: TeamId): string[] {
  const p = TEAM_PAL[t];
  // white-hot top falling into the jersey color: reads as "team colored"
  // while staying bright enough to pop over the ice
  return [
    C.white,
    mix(p.light, '#ffffff', 0.6),
    mix(p.light, '#ffffff', 0.3),
    p.light,
    mix(p.light, p.main, 0.5),
    p.main,
    mix(p.main, p.dark, 0.5),
    p.dark,
  ];
}
