import type { Bounds, ConnectorElement, Element, Endpoint, Page, Point } from '../model/types';
import { DEFAULT_PORTS } from '../model/defaults';
import { boundsOfPoints, centre, portPoint, rotatePoint } from '../model/geometry';

/**
 * Deterministic connector routing used for the export sidecar and offscreen render.
 * Derived only from the committed snapshot; never written back to canonical state.
 */
function perimeterPoint(e: Exclude<Element, { kind: 'connector' }>, toward: Point): Point {
  const b = e.bounds;
  const c = centre(b);
  // Work in the element's unrotated local frame.
  const t = rotatePoint(toward, c, -e.rotationDeg);
  const dx = t.x - c.x, dy = t.y - c.y;
  if (dx === 0 && dy === 0) return c;
  let p: Point;
  const preset = e.kind === 'shape' ? e.geometry.preset : undefined;
  if (preset === 'ellipse') {
    const a = b.width / 2, bb = b.height / 2;
    const k = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (bb * bb));
    p = { x: c.x + dx * k, y: c.y + dy * k };
  } else {
    const sx = dx === 0 ? Infinity : b.width / 2 / Math.abs(dx);
    const sy = dy === 0 ? Infinity : b.height / 2 / Math.abs(dy);
    const k = Math.min(sx, sy);
    p = { x: c.x + dx * k, y: c.y + dy * k };
  }
  return rotatePoint(p, c, e.rotationDeg);
}

export function endpointPoint(byId: Map<string, Element>, end: Endpoint, other: Point): Point {
  if (!end.elementId) return end.point ?? { x: 0, y: 0 };
  const t = byId.get(end.elementId);
  if (!t || t.kind === 'connector') return end.point ?? other;
  if (t.kind === 'group') return centre(t.bounds);
  if (end.glue === 'static' && end.port) {
    const custom = t.kind === 'shape' ? t.ports?.find((p) => p.name === end.port) : undefined;
    const local = custom ?? DEFAULT_PORTS[end.port];
    if (local) return portPoint(t.bounds, t.rotationDeg, local);
  }
  return perimeterPoint(t, other);
}

const reference = (byId: Map<string, Element>, end: Endpoint): Point => {
  if (!end.elementId) return end.point ?? { x: 0, y: 0 };
  const t = byId.get(end.elementId);
  return t ? centre(t.bounds) : end.point ?? { x: 0, y: 0 };
};

export function routeConnector(byId: Map<string, Element>, c: ConnectorElement): Point[] {
  const fromRef = c.waypoints[0] ?? reference(byId, c.to);
  const toRef = c.waypoints[c.waypoints.length - 1] ?? reference(byId, c.from);
  const start = endpointPoint(byId, c.from, fromRef);
  const end = endpointPoint(byId, c.to, toRef);
  const pts = [start, ...c.waypoints.map((p) => ({ x: p.x, y: p.y })), end];
  if (c.route !== 'orthogonal') return pts;
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    if (a.x !== b.x && a.y !== b.y) {
      if (pts.length === 2) {
        // Single elbow pair through the midpoint along the dominant axis.
        if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) {
          const mx = (a.x + b.x) / 2;
          out.push({ x: mx, y: a.y }, { x: mx, y: b.y });
        } else {
          const my = (a.y + b.y) / 2;
          out.push({ x: a.x, y: my }, { x: b.x, y: my });
        }
      } else out.push({ x: b.x, y: a.y });
    }
    out.push(b);
  }
  return out;
}

export function pageElementMap(page: Page): Map<string, Element> {
  return new Map(page.elements.map((e) => [e.id, e]));
}

export function routeBounds(points: Point[], strokeWidth = 0): Bounds {
  const b = boundsOfPoints(points);
  const pad = strokeWidth / 2;
  return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
}
