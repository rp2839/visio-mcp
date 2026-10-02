import { describe, expect, it } from 'vitest';
import { createTestEngine, element, exactElementHashes, hashesExcept, ids, uuid } from './support/engine';
import { richScene } from './support/scenes';
import { canonicalSerialize } from '../src/model/canonical';

describe('geometry', () => {
  it('move/resize/rotate change only the target', async () => {
    const { engine, store, request } = createTestEngine();
    const before = store.snapshot();
    const r = await engine.execute(request([
      { op: 'move', target: ids.shape, to: { xPt: 300, yPt: 300 } },
      { op: 'resize', target: ids.shape, widthPt: 150 },
      { op: 'rotate', target: ids.shape, angleDeg: 33 },
    ]), 'mcp');
    expect(r.ok && r.value.changed).toEqual([ids.shape]);
    const e = element(store.snapshot(), ids.shape);
    expect(e.bounds).toEqual({ x: 300, y: 300, width: 150, height: 60 });
    expect(e.rotationDeg).toBe(33);
    expect(hashesExcept(store.snapshot(), ids.shape)).toEqual(hashesExcept(before, ids.shape));
  });

  it('deltaDeg rotates relatively; pivot is rejected for non-groups', async () => {
    const { engine, store, request } = createTestEngine();
    await engine.execute(request([{ op: 'rotate', target: ids.shape, deltaDeg: 30 }, { op: 'rotate', target: ids.shape, deltaDeg: 30 }]), 'mcp');
    expect(element(store.snapshot(), ids.shape).rotationDeg).toBe(60);
    const p = await engine.execute(request([{ op: 'rotate', target: ids.shape, deltaDeg: 10, pivot: { xPt: 0, yPt: 0 } }]), 'mcp');
    expect(!p.ok && p.error.code).toBe('invalid_request');
  });

  it('schema rejects mixed angle/delta and mixed to/delta', async () => {
    const { engine, request } = createTestEngine();
    const r = await engine.execute(request([{ op: 'rotate', target: ids.shape, angleDeg: 10, deltaDeg: 5 } as any]), 'mcp');
    expect(!r.ok && r.error.code).toBe('invalid_request');
    const m = await engine.execute(request([{ op: 'move', target: ids.shape, to: { xPt: 1, yPt: 1 }, delta: { xPt: 1, yPt: 1 } } as any]), 'mcp');
    expect(!m.ok && m.error.code).toBe('invalid_request');
  });
});

describe('groups (R4)', () => {
  it('rotationDeg_zero and canonical bounds equal the descendant union', async () => {
    const { store, outer } = await richScene();
    const g = element(store.snapshot(), outer);
    expect(g.rotationDeg).toBe(0);
    const leaves = [ids.shapes[5], ids.shapes[6], ids.shapes[7]].map((id) => element(store.snapshot(), id).bounds);
    const minX = Math.min(...leaves.map((b) => b.x)), maxX = Math.max(...leaves.map((b) => b.x + b.width));
    expect(g.bounds.x).toBe(minX);
    expect(g.bounds.width).toBe(maxX - minX);
  });

  it('reject_group_angleDeg and direct group bounds/rotation patches', async () => {
    const { engine, request, outer } = await richScene();
    const a = await engine.execute(request([{ op: 'rotate', target: outer, angleDeg: 30 }]), 'mcp');
    expect(!a.ok && a.error.details?.reason).toBe('group_rotation_requires_delta');
    const b = await engine.execute(request([{ op: 'set', target: outer, patch: { bounds: { x: 0 } } }]), 'mcp');
    expect(!b.ok && b.error.code).toBe('invalid_request');
  });

  it('fixed_pivot_rotate_and_inverse: rotation about an explicit pivot is exactly undoable', async () => {
    const { engine, store, request, scope, nextTx, outer } = await richScene();
    const before = exactElementHashes(store.snapshot());
    const r = await engine.execute(request([{ op: 'rotate', target: outer, deltaDeg: 90, pivot: { xPt: 0, yPt: 0 } }]), 'mcp');
    expect(r.ok).toBe(true);
    const after = store.snapshot();
    expect(element(after, outer).rotationDeg).toBe(0);
    const leaf = element(after, ids.shapes[5]);
    expect(leaf.rotationDeg).toBe(90);
    // centre (x,y) rotated +90° clockwise about the origin → (-y, x)
    const b0 = JSON.parse(before[ids.shapes[5]]).bounds;
    const c0 = { x: b0.x + b0.width / 2, y: b0.y + b0.height / 2 };
    expect(leaf.bounds.x + leaf.bounds.width / 2).toBeCloseTo(-c0.y, 9);
    expect(leaf.bounds.y + leaf.bounds.height / 2).toBeCloseTo(c0.x, 9);
    await engine.undo({ ...scope(), transactionId: nextTx(), baseRevision: scope().revision });
    expect(exactElementHashes(store.snapshot())).toEqual(before);
  });

  it('descendant_edit_reports_ancestors', async () => {
    const { engine, request, inner, outer } = await richScene();
    const r = await engine.execute(request([{ op: 'move', target: ids.shapes[5], delta: { xPt: 500, yPt: 0 } }]), 'mcp');
    expect(r.ok && r.value.changed).toEqual(expect.arrayContaining([ids.shapes[5], inner, outer]));
    expect(r.ok && r.value.changed).toHaveLength(3);
  });

  it('external_reroute_keeps_group_hash: moving a glued external shape changes no canonical group/connector', async () => {
    const t = await richScene();
    // connector inside the group glued to an external shape
    await t.engine.execute(t.request([
      { op: 'create', element: { kind: 'connector', id: uuid(0x210), from: { target: ids.shapes[7] }, to: { target: ids.shapes[10] } } },
      { op: 'ungroup', target: t.outer },
      { op: 'group', targets: [t.inner, ids.shapes[7], uuid(0x210)], id: t.outer },
    ], { pageId: ids.page }), 'gui');
    const groupHashBefore = canonicalSerialize(element(t.store.snapshot(), t.outer));
    const connBefore = canonicalSerialize(element(t.store.snapshot(), uuid(0x210)));
    const r = await t.engine.execute(t.request([{ op: 'move', target: ids.shapes[10], delta: { xPt: 200, yPt: 150 } }]), 'mcp');
    expect(r.ok && r.value.changed).toEqual([ids.shapes[10]]);
    expect(r.ok && r.value.visuallyAffectedIds).toContain(uuid(0x210));
    const groupHashAfterExternalReroute = canonicalSerialize(element(t.store.snapshot(), t.outer));
    expect(groupHashAfterExternalReroute).toBe(groupHashBefore);
    expect(canonicalSerialize(element(t.store.snapshot(), uuid(0x210)))).toBe(connBefore);
  });

  it('reject_nonuniform_scale_rotated_leaf; uniform scale is fine; fonts/strokes unscaled', async () => {
    const { engine, store, request, outer } = await richScene();
    await engine.execute(request([{ op: 'rotate', target: ids.shapes[6], angleDeg: 33 }]), 'gui');
    const g = element(store.snapshot(), outer);
    const bad = await engine.execute(request([{ op: 'resize', target: outer, widthPt: g.bounds.width * 2, heightPt: g.bounds.height }]), 'mcp');
    expect(!bad.ok && bad.error.details?.reason).toBe('nonuniform_group_scale');
    const okr = await engine.execute(request([{ op: 'resize', target: outer, widthPt: g.bounds.width * 2, heightPt: g.bounds.height * 2 }]), 'mcp');
    expect(okr.ok).toBe(true);
    const leaf = element(store.snapshot(), ids.shapes[5]) as any;
    expect(leaf.text.fontSizePt).toBe(11);
    expect(leaf.style.strokeWidthPt).toBe(1);
    expect(element(store.snapshot(), outer).bounds.width).toBeCloseTo(g.bounds.width * 2, 6);
  });

  it('reject_empty_group: removing the last child needs explicit ungroup/delete', async () => {
    const { engine, request } = createTestEngine();
    const g = await engine.execute(request([{ op: 'group', targets: [ids.shapes[2]], id: uuid(0x220) }]), 'gui');
    expect(g.ok).toBe(true);
    const r = await engine.execute(request([{ op: 'delete', target: ids.shapes[2] }]), 'mcp');
    expect(!r.ok && r.error.code).toBe('invalid_request');
    const both = await engine.execute(request([{ op: 'delete', target: uuid(0x220), subtree: true }]), 'mcp');
    expect(both.ok).toBe(true);
  });

  it('ancestor_and_descendant_selection_conflicts', async () => {
    const { engine, request, outer } = await richScene();
    for (const op of [
      { op: 'align', targets: [outer, ids.shapes[5]], edge: 'left' },
      { op: 'group', targets: [outer, ids.shapes[6]] },
    ]) {
      const r = await engine.execute(request([op as any]), 'mcp');
      expect(!r.ok && r.error.details?.reason, op.op).toBe('ancestor_descendant_conflict');
    }
  });

  it('group move translates descendants and free connector points; glued ends keep references', async () => {
    const { engine, store, request, outer, connector } = await richScene();
    const before = store.snapshot();
    const r = await engine.execute(request([{ op: 'move', target: outer, delta: { xPt: 10, yPt: 20 } }]), 'mcp');
    expect(r.ok).toBe(true);
    for (const id of [ids.shapes[5], ids.shapes[6], ids.shapes[7]]) {
      expect(element(store.snapshot(), id).bounds.x).toBe(element(before, id).bounds.x + 10);
    }
    expect(canonicalSerialize(element(store.snapshot(), connector))).toBe(canonicalSerialize(element(before, connector)));
  });
});
