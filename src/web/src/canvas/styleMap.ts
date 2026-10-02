import type { Element, Page } from '../model/types';

export const DASH_ARRAYS: Record<string, string> = { solid: '', dash: '6 4', dot: '1.5 3', dashDot: '6 3 1.5 3' };
export const MAX_ARROWS: Record<string, string> = { none: 'none', triangle: 'block', open: 'open', diamond: 'diamond', circle: 'oval' };

/** Colour without alpha plus separate opacity (0..1) from #RRGGBB[AA]/none. */
export function splitColour(c: string): { colour: string; opacity: number } {
  if (c === 'none') return { colour: 'none', opacity: 0 };
  if (c.length === 9) return { colour: c.slice(0, 7), opacity: parseInt(c.slice(7), 16) / 255 };
  return { colour: c, opacity: 1 };
}

/** D2 multi-layer policy: visible only if the element and every assigned layer are visible. */
export function isVisible(page: Page, e: Element): boolean {
  if (e.hidden) return false;
  return e.layerIds.every((l) => page.layers.find((x) => x.id === l)?.visible !== false);
}

export function isLocked(page: Page, e: Element): boolean {
  return e.locked || e.layerIds.some((l) => page.layers.find((x) => x.id === l)?.locked);
}

export function isPrintable(page: Page, e: Element): boolean {
  return e.layerIds.every((l) => page.layers.find((x) => x.id === l)?.printable !== false);
}

export function layerColourOverride(page: Page, e: Element): string | undefined {
  for (const l of e.layerIds) {
    const c = page.layers.find((x) => x.id === l)?.colourOverride;
    if (c) return c;
  }
  return undefined;
}
