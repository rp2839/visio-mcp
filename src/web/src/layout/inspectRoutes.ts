import type { Bounds, ConnectorElement, Element, Page, Point } from '../contracts/generated';
import { visualBounds } from '../commands/geometry';
import { HOP_SIZE_PT } from '../canvas/cellMapping';
import { compareHopOrder, hopCrossings } from '../canvas/hopShape';
import { planRoutes } from './routePlanner';
import { simplifyRoute } from './routeSegments';
import { passesBehind } from './routingPolicy';
import { BACKGROUND_SHARE } from './obstacleGeometry';
import { isLaneStructure } from './swimlane';
import type { RouteProvenance } from './routePlanner';
import type { Severity } from './inspectLayout';

/**
 * R26: the routing findings `inspect_layout` can report, as a stable list. Each is read-only and carries ids, bounds and evidence with a
 * `classification`, so an agent can tell a defect from something drawn on purpose.
 */
export const ROUTE_FINDING_CODES = [
  'CONNECTOR_CROSSES_SHAPE', 'CONNECTOR_CROSSES_CONTAINER', 'CONNECTOR_CROSSES_BACKGROUND', 'CONNECTOR_PASSES_OVER_SHAPE',
  'CONNECTORS_CROSS', 'CONNECTOR_JOIN', 'CONNECTOR_TOUCHES_CONNECTOR', 'CONNECTORS_OVERLAP', 'CONNECTORS_TOO_CLOSE',
  'ROUTE_SHORT_SEGMENT', 'ROUTE_REDUNDANT_VERTEX', 'ROUTE_EXCESS_BENDS', 'ROUTE_TOO_CLOSE_TO_SHAPE',
  'UNRESOLVED_ROUTE', 'ROUTING_AVOIDANCE_VIOLATION', 'ROUTE_SIDE_PREFERENCE_RELAXED',
  'UNGLUED_CONNECTOR_END', 'DANGLING_CONNECTOR',
] as const;

/** Runs on one line closer than this are printed on top of each other. */
export const OVERLAP_PT = 0.5;
/** Parallel runs, or a run beside a shape, closer than this look crowded (the router keeps 8 pt). */
export const NEAR_PT = 4;
/** A run must lie alongside the other thing for at least this long to count as running beside it. */
export const ALONGSIDE_PT = 10;
/** A run shorter than this is a kink, not a deliberate jog. */
export const SHORT_PT = 2;
/** A kept route with this many more bends than the router would now draw has gone stale. */
export const EXTRA_BENDS = 2;

type Add = (code: string, severity: Severity, ids: string[], bounds: Bounds, message: string, evidence?: Record<string, unknown>) => void;
export type RouteMode = 'automatic' | 'guided' | 'manual' | 'frozen' | 'straight' | 'curved';

export function routeModeOf(c: ConnectorElement): RouteMode {
  if (c.route !== 'orthogonal') return c.route;
  if (c.routing?.mode === 'frozen') return 'frozen';
  if (c.waypoints.length) return 'manual';
  return c.routing?.constraints?.length ? 'guided' : 'automatic';
}

interface Run { index: number; a: Point; b: Point; axis: 'h' | 'v' | 'd'; coord: number; lo: number; hi: number; length: number }

function runsOf(points: readonly Point[]): Run[] {
  const out: Run[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const axis = Math.abs(a.y - b.y) <= 0.01 ? 'h' : Math.abs(a.x - b.x) <= 0.01 ? 'v' : 'd';
    const along = axis === 'v' ? [a.y, b.y] : [a.x, b.x];
    out.push({ index: i, a, b, axis, coord: axis === 'h' ? a.y : a.x, lo: Math.min(...along), hi: Math.max(...along), length: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  return out;
}

const boxOf = (pts: readonly Point[], pad = 0): Bounds => {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
};
const round = (v: number) => Math.round(v * 100) / 100;
const pt = (p: Point): Point => ({ x: round(p.x), y: round(p.y) });

/** Where segments a-b and c-d cross strictly inside both, clear of their ends by `margin`; null if they do not. */
function crossing(a: Point, b: Point, c: Point, d: Point, margin: number): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den, u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  const lr = Math.hypot(r.x, r.y), ls = Math.hypot(s.x, s.y);
  if (t * lr < margin || (1 - t) * lr < margin || u * ls < margin || (1 - u) * ls < margin) return null;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/** Distance from p to the segment a-b, and whether the nearest point is inside it (clear of both ends by `margin`). */
function onRun(p: Point, run: Run, margin: number): boolean {
  if (run.axis === 'd') return false;
  const across = run.axis === 'h' ? Math.abs(p.y - run.coord) : Math.abs(p.x - run.coord);
  const along = run.axis === 'h' ? p.x : p.y;
  return across <= OVERLAP_PT * 1.5 && along > run.lo + margin && along < run.hi - margin;
}

const contains = (outer: Bounds, inner: Bounds, tol = 0.5): boolean =>
  outer.x <= inner.x + tol && outer.y <= inner.y + tol && outer.x + outer.width >= inner.x + inner.width - tol && outer.y + outer.height >= inner.y + inner.height - tol;

/** Why a shape a connector passes through is not a defect, or undefined if it is one. The router ignores the same shapes. */
export function intendedCrossing(c: ConnectorElement, shape: Element, byId: ReadonlyMap<string, Element>, pageArea: number): 'container' | 'background' | undefined {
  const policy = 'routingPolicy' in shape ? shape.routingPolicy?.obstacle : undefined;
  if (policy === 'forbidden' || policy === 'avoid') return undefined; // the router was told to keep out
  const box = visualBounds(shape);
  if (box.width * box.height >= BACKGROUND_SHARE * pageArea) return 'background'; // size first: a page-size backdrop holds everything
  for (const id of [c.from.elementId, c.to.elementId]) {
    const end = id ? byId.get(id) : undefined;
    if (end && end.kind !== 'connector' && end.kind !== 'group' && end.id !== shape.id && contains(box, visualBounds(end))) return 'container';
  }
  return undefined;
}

interface Routed { el: ConnectorElement; points: Point[]; runs: Run[]; mode: RouteMode; provenance?: RouteProvenance }

/**
 * Connector-to-connector and route-shape findings for one page (R26). Needs resolved routes: without them a connector is only a straight
 * line between its ends, which says nothing about how it is drawn, so nothing is reported.
 */
export function inspectRoutes(page: Page, shown: readonly Element[], routes: ReadonlyMap<string, { points: Point[]; provenance?: RouteProvenance }>, add: Add): void {
  const byId = new Map(page.elements.map(e => [e.id, e] as const));
  const routed: Routed[] = [];
  for (const el of shown) {
    if (el.kind !== 'connector') continue;
    const r = routes.get(el.id);
    if (!r || r.points.length < 2) continue;
    const mode = routeModeOf(el);
    routed.push({ el, points: r.points, runs: runsOf(r.points), mode, ...(r.provenance ? { provenance: r.provenance } : {}) });
  }
  routed.sort((a, b) => (a.el.id < b.el.id ? -1 : a.el.id > b.el.id ? 1 : 0));
  const joined = (a: ConnectorElement, b: ConnectorElement) => [a.from, a.to].some(ep => ep.join?.connectorId === b.id) || [b.from, b.to].some(ep => ep.join?.connectorId === a.id);
  const shareEnd = (a: ConnectorElement, b: ConnectorElement) => {
    const ends = new Set([a.from.elementId, a.to.elementId].filter(Boolean));
    return [b.from.elementId, b.to.elementId].some(id => id && ends.has(id));
  };

  // ---- connector to connector
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      const A = routed[i]!, B = routed[j]!;
      if (A.mode === 'curved' || B.mode === 'curved') continue; // a curve is drawn by maxGraph from control points: its line is not known here
      const ids = [A.el.id, B.el.id];
      if (joined(A.el, B.el)) {
        for (const [branch, trunk] of [[A, B], [B, A]] as const) {
          for (const [side, ep] of [['from', branch.el.from], ['to', branch.el.to]] as const) {
            if (ep.join?.connectorId !== trunk.el.id) continue;
            const at = side === 'from' ? branch.points[0]! : branch.points[branch.points.length - 1]!;
            add('CONNECTOR_JOIN', 'info', [branch.el.id, trunk.el.id], boxOf([at], 2), 'The connector joins another connector here; this is a junction, not a crossing.',
              { classification: 't_join', intended: true, branchId: branch.el.id, trunkId: trunk.el.id, end: side, point: pt(at) });
          }
        }
        continue; // joined connectors meet on purpose; they are not judged against each other (hops ignore them too)
      }

      const points: Point[] = [], hopped: Point[] = [];
      const hopper = [A, B].filter(x => x.el.hops === 'arc').sort((x, y) => -compareHopOrder({ hopLevel: x.el.level ?? 0, hopOrder: x.el.zIndex }, { hopLevel: y.el.level ?? 0, hopOrder: y.el.zIndex }))[0];
      // the renderer's own rule decides which crossings get an arc (it reads only x and y, so plain points will do)
      const arcs = hopper ? hopCrossings(hopper.points as never, [(hopper === A ? B : A).points] as never, HOP_SIZE_PT).flat().map(c => c.point) : [];
      for (const ra of A.runs) for (const rb of B.runs) {
        const at = crossing(ra.a, ra.b, rb.a, rb.b, OVERLAP_PT);
        if (!at) continue;
        (arcs.some(h => Math.hypot(h.x - at.x, h.y - at.y) <= 0.5) ? hopped : points).push(pt(at));
      }
      if (points.length || hopped.length) {
        const all = [...points, ...hopped];
        add('CONNECTORS_CROSS', 'info', ids, boxOf(all, 2), points.length ? 'The connectors cross each other.' : 'The connectors cross, and a line hop shows which passes over.',
          { classification: points.length ? 'crossing' : 'hopped', intended: points.length === 0, crossings: all.length, hopped: hopped.length, points: all, ...(hopper ? { hopsOver: hopper.el.id } : {}) });
      }

      for (const [X, Y] of [[A, B], [B, A]] as const) {
        for (const [side, at] of [['from', X.points[0]!], ['to', X.points[X.points.length - 1]!]] as const) {
          const run = Y.runs.find(r => onRun(at, r, OVERLAP_PT));
          if (!run) continue;
          add('CONNECTOR_TOUCHES_CONNECTOR', 'warning', [X.el.id, Y.el.id], boxOf([at], 2), 'The end of one connector lies on another connector without being joined to it, so it looks like a junction that is not there.',
            { classification: 'endpoint_contact', intended: false, end: side, point: pt(at), touchedRun: run.index });
        }
      }

      let overlapPt = 0, nearPt = 0, gapPt = Infinity;
      const overlaps: Array<{ runA: number; runB: number; from: number; to: number; axis: 'h' | 'v'; at: number }> = [];
      let near: { runA: number; runB: number; axis: 'h' | 'v'; at: number; other: number } | undefined;
      for (const ra of A.runs) for (const rb of B.runs) {
        if (ra.axis === 'd' || ra.axis !== rb.axis) continue;
        const from = Math.max(ra.lo, rb.lo), to = Math.min(ra.hi, rb.hi), gap = Math.abs(ra.coord - rb.coord);
        if (gap <= OVERLAP_PT && to - from >= 1) { overlapPt += to - from; overlaps.push({ runA: ra.index, runB: rb.index, from: round(from), to: round(to), axis: ra.axis, at: round(ra.coord) }); }
        else if (gap > OVERLAP_PT && gap < NEAR_PT && to - from >= ALONGSIDE_PT) {
          nearPt += to - from;
          if (gap < gapPt) { gapPt = gap; near = { runA: ra.index, runB: rb.index, axis: ra.axis, at: round(ra.coord), other: round(rb.coord) }; }
        }
      }
      if (overlaps.length) {
        const shared = shareEnd(A.el, B.el);
        const spans = overlaps.flatMap(o => o.axis === 'h' ? [{ x: o.from, y: o.at }, { x: o.to, y: o.at }] : [{ x: o.at, y: o.from }, { x: o.at, y: o.to }]);
        add('CONNECTORS_OVERLAP', 'warning', ids, boxOf(spans, 2), shared ? 'The connectors share an end and are drawn on top of each other along the way, so they read as one line.' : 'The connectors are drawn on top of each other along the way, so they read as one line.',
          { classification: shared ? 'collinear_shared_end' : 'collinear_overlap', intended: false, overlapPt: round(overlapPt), overlaps });
      }
      if (near) {
        const mover = A.mode === 'automatic' || A.mode === 'guided' ? A : B;
        const run = mover === A ? near.runA : near.runB, from = mover === A ? near.at : near.other, to = mover === A ? near.other : near.at;
        add('CONNECTORS_TOO_CLOSE', 'info', ids, boxOf([A.runs[near.runA]!.a, A.runs[near.runA]!.b, B.runs[near.runB]!.a, B.runs[near.runB]!.b], 2), 'Two connectors run side by side very close together.',
          { classification: 'parallel_near_miss', intended: false, gapPt: round(gapPt), alongsidePt: round(nearPt), suggestion: { action: 'move_run', elementId: mover.el.id, segment: run, to: round(from + Math.sign(from - to || 1) * 8) } });
      }
    }
  }

  // ---- the shape of each route: automatic and guided routes only; a manual or frozen route was drawn that way on purpose
  const judged = routed.filter(r => r.mode === 'automatic' || r.mode === 'guided');
  if (!judged.length) return;
  const fresh = planRoutes({ elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt }).routes;
  const pageArea = page.widthPt * page.heightPt;
  const bends = (pts: readonly Point[]) => Math.max(0, simplifyRoute(pts).length - 2);
  for (const r of judged) {
    const base = { routeMode: r.mode, ...(r.provenance ? { provenance: r.provenance } : {}) };
    const box = boxOf(r.points);
    const short = r.runs.filter(run => run.length > 0.01 && run.length < SHORT_PT);
    if (short.length) add('ROUTE_SHORT_SEGMENT', 'warning', [r.el.id], boxOf(short.flatMap(s => [s.a, s.b]), 2), 'The route has a run so short it shows as a kink.',
      { ...base, classification: 'near_zero_segment', intended: false, segments: short.map(s => ({ index: s.index, lengthPt: round(s.length) })), suggestion: { action: 'straighten', elementId: r.el.id } });

    const simple = simplifyRoute(r.points);
    if (simple.length < r.points.length) {
      const kept = new Set(simple.map(p => `${p.x},${p.y}`)), redundant: number[] = [];
      r.points.forEach((p, i) => { if (i > 0 && i < r.points.length - 1 && (!kept.has(`${p.x},${p.y}`) || (p.x === r.points[i - 1]!.x && p.y === r.points[i - 1]!.y))) redundant.push(i); });
      if (redundant.length) add('ROUTE_REDUNDANT_VERTEX', 'info', [r.el.id], boxOf(redundant.map(i => r.points[i]!), 3), 'The route has corners that do not turn.',
        { ...base, classification: 'redundant_vertex', intended: false, vertexIndices: redundant, suggestion: { action: 'remove_vertices', elementId: r.el.id, vertexIndices: redundant } });
    }

    const now = fresh.get(r.el.id)?.points;
    if (now && bends(r.points) - bends(now) >= EXTRA_BENDS) add('ROUTE_EXCESS_BENDS', 'info', [r.el.id], box, 'The route has more bends than the router would draw now; re-routing it would simplify it.',
      { ...base, classification: 'excess_bends', intended: false, bends: bends(r.points), bendsIfRerouted: bends(now), suggestion: { action: 'reroute', elementId: r.el.id } });

    const ends = new Set([r.el.from.elementId, r.el.to.elementId].filter(Boolean));
    const level = r.el.level ?? 0;
    const close: Array<{ elementId: string; segment: number; gapPt: number }> = [];
    for (const other of shown) {
      if ((other.kind !== 'shape' && other.kind !== 'image') || ends.has(other.id)) continue;
      if (other.kind === 'shape' && (isLaneStructure(other) || other.routingPolicy?.obstacle === 'passThrough')) continue;
      if (passesBehind(other, level) || intendedCrossing(r.el, other, byId, pageArea)) continue;
      const b = visualBounds(other);
      let best: { segment: number; gapPt: number } | undefined;
      for (const run of r.runs) {
        if (run.axis === 'd') continue;
        const [lo, hi, near1, near2] = run.axis === 'h' ? [b.x, b.x + b.width, b.y, b.y + b.height] : [b.y, b.y + b.height, b.x, b.x + b.width];
        if (Math.min(run.hi, hi) - Math.max(run.lo, lo) < ALONGSIDE_PT) continue;
        const gap = run.coord <= near1 ? near1 - run.coord : run.coord >= near2 ? run.coord - near2 : -1; // -1: inside, which is a crossing
        if (gap >= 0 && gap < NEAR_PT && (!best || gap < best.gapPt)) best = { segment: run.index, gapPt: round(gap) };
      }
      if (best) close.push({ elementId: other.id, ...best });
    }
    if (close.length) {
      close.sort((a, b) => (a.elementId < b.elementId ? -1 : 1));
      const touching = close.some(c => c.gapPt <= 1);
      const runs = [...new Set(close.map(c => c.segment))].map(i => r.runs[i]!);
      add('ROUTE_TOO_CLOSE_TO_SHAPE', touching ? 'warning' : 'info', [r.el.id, ...close.map(c => c.elementId)], boxOf(runs.flatMap(s => [s.a, s.b]), 2), touching ? 'The route runs along the outline of a shape it is not attached to.' : 'The route runs very close beside a shape it is not attached to.',
        { ...base, classification: touching ? 'runs_on_outline' : 'tight_clearance', intended: false, shapes: close, suggestion: { action: 'move_run', elementId: r.el.id, segment: close[0]!.segment } });
    }
  }
}
