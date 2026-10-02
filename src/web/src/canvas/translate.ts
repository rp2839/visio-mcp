import type { Element, Operation, Page } from '../model/types';
import type { CanvasChange, GestureKind } from './CanvasAdapter';

const snapTo = (v: number, step: number) => Math.round(v / step) * step;

/**
 * Pure translation of one completed canvas gesture into canonical operations against the
 * gesture-start snapshot page. Snap is computed here (the planner input), not by a second
 * canvas-only adjustment. Returns [] for a gesture with no effective change.
 */
export function gestureOperations(page: Page, kind: GestureKind, changes: CanvasChange[]): Operation[] {
  const byId = new Map(page.elements.map((e) => [e.id, e]));
  const step = page.grid.snap ? page.grid.spacingPt : 0;
  const ops: Operation[] = [];
  const get = (id: string): Element | undefined => byId.get(id);

  if (kind === 'move') {
    const moved = changes.filter((c): c is Extract<CanvasChange, { kind: 'geometry' }> => c.kind === 'geometry' && get(c.id)?.kind !== 'connector');
    let shared: { dx: number; dy: number } | null = null;
    for (const c of moved) {
      const e = get(c.id);
      if (!e) continue;
      let x = c.x, y = c.y;
      if (step) { x = snapTo(x, step); y = snapTo(y, step); }
      const dx = x - e.bounds.x, dy = y - e.bounds.y;
      shared ??= { dx, dy };
      if (dx !== 0 || dy !== 0) ops.push({ op: 'move', target: e.id, delta: { xPt: dx, yPt: dy } });
    }
    // Connectors dragged with the selection translate their authored points by the same delta.
    for (const c of changes) {
      if (c.kind !== 'points' && c.kind !== 'geometry') continue;
      const e = get(c.id);
      if (e?.kind !== 'connector' || !shared || (shared.dx === 0 && shared.dy === 0)) continue;
      if (e.waypoints.length || !e.from.elementId || !e.to.elementId)
        ops.push({ op: 'move', target: e.id, delta: { xPt: shared.dx, yPt: shared.dy } });
    }
    return ops;
  }

  if (kind === 'resize') {
    for (const c of changes) {
      if (c.kind !== 'geometry') continue;
      const e = get(c.id);
      if (!e || e.kind === 'connector') continue;
      let { x, y, width, height } = c;
      if (step) {
        const r = snapTo(x + width, step), b = snapTo(y + height, step);
        x = snapTo(x, step); y = snapTo(y, step);
        width = Math.max(step, r - x); height = Math.max(step, b - y);
      }
      if (width !== e.bounds.width || height !== e.bounds.height) ops.push({ op: 'resize', target: e.id, widthPt: width, heightPt: height });
      if (x !== e.bounds.x || y !== e.bounds.y) ops.push({ op: 'move', target: e.id, to: { xPt: x, yPt: y } });
    }
    return ops;
  }

  if (kind === 'rotate') {
    for (const c of changes) {
      if (c.kind !== 'rotation') continue;
      const e = get(c.id);
      if (!e || e.kind === 'connector') continue;
      const angle = ((Math.round(c.rotationDeg * 100) / 100) % 360);
      if (e.kind === 'group') { if (angle !== 0) ops.push({ op: 'rotate', target: e.id, deltaDeg: angle }); }
      else if (angle !== e.rotationDeg) ops.push({ op: 'rotate', target: e.id, angleDeg: angle });
    }
    return ops;
  }

  if (kind === 'bend') {
    for (const c of changes) {
      const e = get(c.id);
      if (e?.kind !== 'connector') continue;
      if (c.kind === 'points') ops.push({ op: 'set', target: e.id, patch: { waypoints: c.points.map((p) => ({ x: step ? snapTo(p.x, step) : p.x, y: step ? snapTo(p.y, step) : p.y })) } });
      if (c.kind === 'terminal') {
        const end = c.elementId ? { target: c.elementId, ...(c.port ? { port: c.port, glue: 'static' as const } : { glue: 'dynamic' as const }) } : { point: c.point ?? { x: 0, y: 0 }, glue: 'none' as const };
        ops.push({ op: 'set', target: e.id, patch: { [c.end]: end } });
      }
    }
    return ops;
  }

  // text: one coalesced set per edit session
  for (const c of changes) {
    if (c.kind !== 'text') continue;
    const e = get(c.id);
    if (!e) continue;
    if (e.kind === 'connector') { if ((e.label?.value ?? '') !== c.value) ops.push({ op: 'set', target: e.id, patch: { label: { value: c.value } } }); }
    else if (e.kind === 'shape' || e.kind === 'text') { if ((e.text?.value ?? '') !== c.value) ops.push({ op: 'set', target: e.id, patch: { text: { value: c.value } } }); }
  }
  return ops;
}
