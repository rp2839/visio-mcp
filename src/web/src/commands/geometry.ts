import type { Bounds, ConnectorElement, Element, MoveOp, Point, ResizeOp, RotateOp } from '../model/types';
import { fail } from '../model/result';
import { authoredExtent, centre, descendants, rotatePoint } from '../model/geometry';
import type { Draft } from './draft';

/** Leaf elements moved by a transform of `id` (a group expands to its non-group descendants). */
export function transformLeaves(d: Draft, id: string): Element[] {
  const { page, element } = d.loc(id);
  if (element.kind !== 'group') return [element];
  return descendants(d.pageIndex(page), id).map((c) => d.get(c)).filter((e) => e.kind !== 'group');
}

/** Current canonical extent used as the transform frame (groups: derived tight bounds). */
export function frameOf(d: Draft, id: string): Bounds {
  const { page, element } = d.loc(id);
  if (element.kind === 'group') return { ...element.bounds };
  return authoredExtent(d.pageIndex(page), element) ?? { ...element.bounds };
}

function mapConnectorPoints(c: ConnectorElement, f: (p: Point) => Point): ConnectorElement {
  const next = structuredClone(c);
  next.waypoints = c.waypoints.map(f);
  for (const end of ['from', 'to'] as const) if (!c[end].elementId && c[end].point) next[end].point = f(c[end].point!);
  const a = f({ x: c.bounds.x, y: c.bounds.y });
  const b = f({ x: c.bounds.x + c.bounds.width, y: c.bounds.y + c.bounds.height });
  next.bounds = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  return next;
}

export function translate(d: Draft, id: string, dx: number, dy: number) {
  if (dx === 0 && dy === 0) return;
  const leaves = transformLeaves(d, id);
  d.assertUnlocked([id, ...leaves.map((e) => e.id)]);
  for (const e of leaves) {
    if (e.kind === 'connector') d.replaceElement(mapConnectorPoints(e, (p) => ({ x: p.x + dx, y: p.y + dy })));
    else d.replaceElement({ ...e, bounds: { ...e.bounds, x: e.bounds.x + dx, y: e.bounds.y + dy } } as Element);
  }
  // Glued endpoints keep their references; auto-routes are derived by the projection.
  d.normaliseGroups();
}

export function planMove(d: Draft, op: MoveOp) {
  const id = d.resolve(op.target);
  const frame = frameOf(d, id);
  if (op.to) translate(d, id, op.to.xPt - frame.x, op.to.yPt - frame.y);
  else if (op.delta) translate(d, id, op.delta.xPt, op.delta.yPt);
}

const isRightAngle = (deg: number) => Math.abs(((deg % 90) + 90) % 90) < 1e-9;
const quarterTurns = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 90) % 2;

export function planResize(d: Draft, op: ResizeOp) {
  const id = d.resolve(op.target);
  const e = d.get(id);
  if (e.kind === 'connector') fail('invalid_request', 'connectors are sized by their endpoints and waypoints');
  if (e.kind !== 'group') {
    d.assertUnlocked([id]);
    // Top-left anchored in unrotated local frame; fonts and strokes never scale.
    d.replaceElement({ ...e, bounds: { ...e.bounds, width: op.widthPt ?? e.bounds.width, height: op.heightPt ?? e.bounds.height } } as Element);
    d.normaliseGroups();
    return;
  }
  const frame = frameOf(d, id);
  const sx = (op.widthPt ?? frame.width) / (frame.width || 1);
  const sy = (op.heightPt ?? frame.height) / (frame.height || 1);
  const leaves = transformLeaves(d, id);
  d.assertUnlocked([id, ...leaves.map((x) => x.id)]);
  const uniform = Math.abs(sx - sy) < 1e-12;
  if (!uniform && leaves.some((x) => x.kind !== 'connector' && !isRightAngle(x.rotationDeg)))
    fail('invalid_request', 'non-uniform group scale needs axis-aligned descendants', { reason: 'nonuniform_group_scale' });
  const map = (p: Point): Point => ({ x: frame.x + (p.x - frame.x) * sx, y: frame.y + (p.y - frame.y) * sy });
  for (const leaf of leaves) {
    if (leaf.kind === 'connector') { d.replaceElement(mapConnectorPoints(leaf, map)); continue; }
    const c = map(centre(leaf.bounds));
    // At 90/270 degrees the local axes swap relative to the page axes.
    const [lx, ly] = quarterTurns(leaf.rotationDeg) === 1 ? [sy, sx] : [sx, sy];
    const w = leaf.bounds.width * lx, h = leaf.bounds.height * ly;
    d.replaceElement({ ...leaf, bounds: { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h } } as Element);
  }
  d.normaliseGroups();
}

const normaliseAngle = (deg: number) => {
  const r = deg % 360;
  return Object.is(r, -0) ? 0 : r;
};

export function planRotate(d: Draft, op: RotateOp) {
  const id = d.resolve(op.target);
  const e = d.get(id);
  if (e.kind === 'connector') fail('invalid_request', 'connectors cannot be rotated');
  if (op.pivot && e.kind !== 'group') fail('invalid_request', 'pivot is only valid for groups; other elements rotate about their own centre');
  if (e.kind !== 'group') {
    d.assertUnlocked([id]);
    const angle = op.angleDeg !== undefined ? op.angleDeg : e.rotationDeg + op.deltaDeg!;
    d.replaceElement({ ...e, rotationDeg: normaliseAngle(angle) } as Element);
    d.normaliseGroups();
    return;
  }
  if (op.angleDeg !== undefined) fail('invalid_request', 'groups rotate by deltaDeg; their own rotation stays 0', { reason: 'group_rotation_requires_delta' });
  const delta = op.deltaDeg!;
  const pivot = op.pivot ? { x: op.pivot.xPt, y: op.pivot.yPt } : centre(frameOf(d, id));
  const leaves = transformLeaves(d, id);
  d.assertUnlocked([id, ...leaves.map((x) => x.id)]);
  for (const leaf of leaves) {
    if (leaf.kind === 'connector') { d.replaceElement(mapConnectorPoints(leaf, (p) => rotatePoint(p, pivot, delta))); continue; }
    const c = rotatePoint(centre(leaf.bounds), pivot, delta);
    d.replaceElement({
      ...leaf, rotationDeg: normaliseAngle(leaf.rotationDeg + delta),
      bounds: { ...leaf.bounds, x: c.x - leaf.bounds.width / 2, y: c.y - leaf.bounds.height / 2 },
    } as Element);
  }
  d.normaliseGroups();
}
