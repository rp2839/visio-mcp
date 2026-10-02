import type { Bounds, ConnectorElement, Element, Page, Point } from './types';

export const EPS = 1e-9;

export function centre(b: Bounds): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Rotates p clockwise (y-down page coordinates) by deg about c. */
export function rotatePoint(p: Point, c: Point, deg: number): Point {
  if (deg === 0) return { x: p.x, y: p.y };
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function corners(b: Bounds, rotationDeg: number): Point[] {
  const c = centre(b);
  return [
    { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height },
  ].map((p) => rotatePoint(p, c, rotationDeg));
}

export function boundsOfPoints(points: Point[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function union(a: Bounds, b: Bounds): Bounds {
  return boundsOfPoints([{ x: a.x, y: a.y }, { x: a.x + a.width, y: a.y + a.height }, { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }]);
}

/** Axis-aligned bounds of a rotated box element. */
export function rotatedAabb(b: Bounds, rotationDeg: number): Bounds {
  return rotationDeg % 360 === 0 ? { ...b } : boundsOfPoints(corners(b, rotationDeg));
}

/** Authored connector geometry: fallback bounds, waypoints and free endpoint points (never auto-routes). */
export function connectorAuthoredPoints(c: ConnectorElement): Point[] {
  const pts: Point[] = [{ x: c.bounds.x, y: c.bounds.y }, { x: c.bounds.x + c.bounds.width, y: c.bounds.y + c.bounds.height }];
  pts.push(...c.waypoints);
  if (c.from.point && !c.from.elementId) pts.push(c.from.point);
  if (c.to.point && !c.to.elementId) pts.push(c.to.point);
  return pts;
}

export type PageIndex = { byId: Map<string, Element>; parentOf: Map<string, string> };

export function indexPage(page: Page): PageIndex {
  const byId = new Map<string, Element>();
  const parentOf = new Map<string, string>();
  for (const e of page.elements) byId.set(e.id, e);
  for (const e of page.elements) if (e.kind === 'group') for (const c of e.childIds) parentOf.set(c, e.id);
  return { byId, parentOf };
}

/** All leaf and nested descendants of a group (depth-first, child order). */
export function descendants(index: PageIndex, groupId: string, out: string[] = [], seen = new Set<string>()): string[] {
  const g = index.byId.get(groupId);
  if (!g || g.kind !== 'group') return out;
  for (const c of g.childIds) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    descendants(index, c, out, seen);
  }
  return out;
}

export function ancestors(index: PageIndex, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let p = index.parentOf.get(id);
  while (p && !seen.has(p)) {
    out.push(p);
    seen.add(p);
    p = index.parentOf.get(p);
  }
  return out;
}

/** Canonical authored extent of an element (groups derive from descendants). */
export function authoredExtent(index: PageIndex, e: Element, seen = new Set<string>()): Bounds | null {
  if (e.kind === 'connector') return boundsOfPoints(connectorAuthoredPoints(e));
  if (e.kind !== 'group') return rotatedAabb(e.bounds, e.rotationDeg);
  if (seen.has(e.id)) return null;
  seen.add(e.id);
  let acc: Bounds | null = null;
  for (const c of e.childIds) {
    const child = index.byId.get(c);
    if (!child) continue;
    const b = authoredExtent(index, child, seen);
    if (b) acc = acc ? union(acc, b) : b;
  }
  return acc;
}

/** R4: deterministic tight union of descendants' canonical geometry; no auto-routes. */
export function deriveGroupBounds(index: PageIndex, groupId: string): Bounds | null {
  const g = index.byId.get(groupId);
  return g && g.kind === 'group' ? authoredExtent(index, g) : null;
}

/** Port position in page coordinates; static ports stay fixed in local coordinates under rotation. */
export function portPoint(b: Bounds, rotationDeg: number, local: { x: number; y: number }): Point {
  return rotatePoint({ x: b.x + local.x * b.width, y: b.y + local.y * b.height }, centre(b), rotationDeg);
}
