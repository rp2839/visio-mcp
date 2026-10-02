import { fail } from './result';

export type Unit = 'pt' | 'mm' | 'cm' | 'in' | 'px';

/** Points per unit: mm = 72/25.4, cm = 72/2.54, in = 72, px = 1/96 in = 0.75 pt. */
export const POINTS_PER: Record<Unit, number> = { pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72, px: 0.75 };

export function toPoints(value: number, unit: Unit): number {
  if (!Number.isFinite(value)) fail('invalid_request', `dimension must be finite, got ${value}`);
  const k = POINTS_PER[unit];
  if (k === undefined) fail('invalid_request', `unknown unit ${unit}`);
  return value * k;
}

export function fromPoints(pt: number, unit: Unit): number {
  return pt / POINTS_PER[unit];
}

/** Parses "12.5mm" style dimension text. Units are mandatory. */
export function parseDimension(text: string): number {
  const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(pt|mm|cm|in|px)$/.exec(text.trim());
  if (!m) fail('invalid_request', `dimension "${text}" needs a unit (pt, mm, cm, in or px)`);
  return toPoints(Number(m[1]), m[2] as Unit);
}
