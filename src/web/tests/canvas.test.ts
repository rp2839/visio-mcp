import { describe, expect, it } from 'vitest';
import { GestureController } from '../src/canvas/GestureController';
import { gestureOperations } from '../src/canvas/translate';
import { SnapshotProjector } from '../src/canvas/SnapshotProjector';
import type { CanvasAdapter, CanvasIntent } from '../src/canvas/CanvasAdapter';
import { createTestEngine, element, exactElementHashes, ids, sequence } from './support/engine';
import type { Snapshot } from '../src/model/types';

/** Projection-only fake: records what it is given, emits nothing unless told to. */
function fakeAdapter() {
  const intents: CanvasIntent[] = [];
  const listeners = new Set<(i: CanvasIntent) => void>();
  const projected: Snapshot[] = [];
  const adapter: Pick<CanvasAdapter, 'project' | 'onIntent'> = {
    project: (s) => { projected.push(s); return { ok: true, value: undefined }; },
    onIntent: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
  return { adapter, intents, projected, emit: (i: CanvasIntent) => { intents.push(i); listeners.forEach((l) => l(i)); } };
}

async function connectedScene() {
  const t = createTestEngine();
  const r = await t.engine.execute(t.request([{ op: 'create', element: { kind: 'connector', alias: 'c', from: { target: ids.shapes[0] }, to: { target: ids.shapes[1], port: 'west' } } }], { pageId: ids.page }), 'gui');
  if (!r.ok) throw new Error(r.error.message);
  return { ...t, connector: r.value.aliases!.c };
}

describe('canvas projection and gestures', () => {
  it('projection_does_not_emit_edits', async () => {
    const { engine, store, request } = createTestEngine();
    const f = fakeAdapter();
    const intentCalls: unknown[] = [];
    f.adapter.onIntent((i) => intentCalls.push(i));
    engine.setProjector((s) => f.adapter.project(s, ids.page));
    f.adapter.project(store.snapshot(), ids.page);
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 3, yPt: 0 } }]), 'mcp');
    expect(intentCalls).toHaveLength(0);
    expect(f.projected.map((s) => s.revision)).toEqual([0, 1]);
  });

  it('cell_types_do_not_escape: operations and projection carry only canonical DTOs', () => {
    const { store } = createTestEngine();
    const page = store.snapshot().document.pages[0];
    const ops = gestureOperations(page, 'move', [{ kind: 'geometry', id: ids.shape, x: 160, y: 100, width: 100, height: 60 }]);
    expect(JSON.parse(JSON.stringify(ops))).toEqual(ops);
    const proj = new SnapshotProjector().project(store.snapshot());
    expect(proj.ok && JSON.parse(JSON.stringify(proj.value))).toEqual(proj.ok && proj.value);
  });

  it('gesture_is_one_transaction (many previews, one commit)', async () => {
    const { engine, store, scope } = createTestEngine();
    const gestures = new GestureController(engine, { newTransactionId: sequence(0x7000) });
    const beforeGesture = store.snapshot();
    const token = gestures.begin('move', scope(), [ids.shape]);
    for (let i = 1; i <= 20; i++) gestures.preview(token, [{ op: 'move', target: ids.shape, delta: { xPt: i, yPt: 0 } }]);
    const r = await gestures.commit(token);
    expect(r.ok).toBe(true);
    const afterGesture = store.snapshot();
    expect(afterGesture.revision).toBe(beforeGesture.revision + 1);
    expect(element(afterGesture, ids.shape).bounds.x).toBe(element(beforeGesture, ids.shape).bounds.x + 20);
  });

  it('stale_preview_is_discarded when an admitted mutation lands mid-gesture', async () => {
    const { engine, store, scope, request } = createTestEngine();
    const statuses: string[] = [];
    const gestures = new GestureController(engine, { onStatus: (m) => statuses.push(m) });
    const token = gestures.begin('move', scope(), [ids.shape]);
    gestures.preview(token, [{ op: 'move', target: ids.shape, delta: { xPt: 50, yPt: 0 } }]);
    await engine.execute(request([{ op: 'set', target: ids.shape, patch: { style: { fill: '#ABCDEF' } } }]), 'mcp');
    const agentState = exactElementHashes(store.snapshot());
    const r = await gestures.commit(token);
    expect(!r.ok && r.error.code).toBe('revision_conflict');
    expect(exactElementHashes(store.snapshot())).toEqual(agentState);
    expect(statuses[0]).toMatch(/discarded/);
    expect(gestures.isActive()).toBe(false);
  });

  it('glue_survives_projection and moves: endpoint identity stays, route follows', async () => {
    const { engine, store, request, connector } = await connectedScene();
    const proj = new SnapshotProjector();
    const beforeGesture = store.snapshot();
    const routeBefore = proj.project(beforeGesture);
    const page = beforeGesture.document.pages[0];
    const ops = gestureOperations(page, 'move', [{ kind: 'geometry', id: ids.shapes[1], x: 400, y: 300, width: 100, height: 60 }]);
    await engine.execute(request(ops), 'gui');
    const afterGesture = store.snapshot();
    const c0 = element(beforeGesture, connector) as any, c1 = element(afterGesture, connector) as any;
    expect(c1.from.elementId).toBe(c0.from.elementId);
    expect(c1).toEqual(c0); // canonical connector unchanged; route is derived
    const routeAfter = proj.project(afterGesture);
    expect(routeAfter.ok && routeBefore.ok && routeAfter.value.connectors[connector].routePoints).not.toEqual(routeBefore.ok && routeBefore.value.connectors[connector].routePoints);
    // static west port of the moved (grid-snapped) target: left edge, vertical centre
    const b = element(afterGesture, ids.shapes[1]).bounds;
    const pts = routeAfter.ok ? routeAfter.value.connectors[connector].routePoints : [];
    expect(pts[pts.length - 1]).toEqual({ x: b.x, y: b.y + b.height / 2 });
    expect(Math.abs(b.x / page.grid.spacingPt - Math.round(b.x / page.grid.spacingPt))).toBeLessThan(1e-9);
  });

  it('ExportDuringActiveDragUsesCommittedGeometry', async () => {
    const { engine, store, scope } = createTestEngine();
    const proj = new SnapshotProjector();
    engine.setSnapshotProjector((s) => proj.project(s));
    const gestures = new GestureController(engine);
    const token = gestures.begin('move', scope(), [ids.shape]);
    gestures.preview(token, [{ op: 'move', target: ids.shape, delta: { xPt: 99, yPt: 0 } }]);
    const exp = await engine.exportSnapshot(scope());
    expect(exp.ok && element(exp.value, ids.shape).bounds.x).toBe(element(store.snapshot(), ids.shape).bounds.x);
    expect(exp.ok && exp.value.projection.revision).toBe(0);
    gestures.cancel(token);
  });

  it('snap is computed in the planner input (grid spacing multiples)', () => {
    const { store } = createTestEngine();
    const page = { ...store.snapshot().document.pages[0], grid: { visible: true, spacingPt: 10, snap: true } };
    const ops = gestureOperations(page, 'move', [{ kind: 'geometry', id: ids.shape, x: 163.7, y: 104.9, width: 100, height: 60 }]);
    expect(ops).toEqual([{ op: 'move', target: ids.shape, delta: { xPt: 10, yPt: 0 } }]); // 150,100 → 160,100
    const resize = gestureOperations(page, 'resize', [{ kind: 'geometry', id: ids.shape, x: 150, y: 100, width: 123, height: 61 }]);
    expect(resize).toEqual([{ op: 'resize', target: ids.shape, widthPt: 120, heightPt: 60 }]);
  });

  it('gesture state feeds the admission interlock', () => {
    const { engine, scope } = createTestEngine();
    const gestures = new GestureController(engine);
    const states: boolean[] = [];
    gestures.onGestureState((a) => states.push(a));
    const t = gestures.begin('text', scope(), [ids.shape]);
    gestures.cancel(t);
    expect(states).toEqual([true, false]);
  });
});
