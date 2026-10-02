import { describe, expect, it } from 'vitest';
import { createTestEngine, element, exactElementHashes, hashesExcept, ids, uuid } from './support/engine';
import { richScene } from './support/scenes';

describe('target resolution', () => {
  it('page_aliases_do_not_collide: the same alias resolves per page scope', async () => {
    const { engine, store, request, page2 } = await richScene();
    const r1 = await engine.execute(request([{ op: 'set', target: 's0', patch: { name: 'on page 1' } }], { pageId: ids.page }), 'mcp');
    const r2 = await engine.execute(request([{ op: 'set', target: 's0', patch: { name: 'on page 2' } }], { pageId: page2 }), 'mcp');
    expect(r1.ok && r1.value.changed).toEqual([ids.shapes[0]]);
    expect(r2.ok && r2.value.changed).toEqual([uuid(0x300)]);
    expect(element(store.snapshot(), ids.shapes[0]).name).toBe('on page 1');
  });

  it('alias/name targets require page scope; UUIDs do not', async () => {
    const { engine, request } = await richScene();
    const r = await engine.execute(request([{ op: 'set', target: 's1', patch: { name: 'x' } }]), 'mcp');
    expect(!r.ok && r.error.code).toBe('invalid_request');
    const u = await engine.execute(request([{ op: 'set', target: ids.shapes[1], patch: { name: 'x' } }]), 'mcp');
    expect(u.ok).toBe(true);
  });

  it('ambiguous_name_has_candidates and never guesses', async () => {
    const { engine, store, request } = createTestEngine();
    const before = exactElementHashes(store.snapshot());
    const r = await engine.execute(request([{ op: 'delete', target: 'Box' }], { pageId: ids.page }), 'mcp');
    expect(!r.ok && r.error.code).toBe('ambiguous_target');
    if (!r.ok) expect((r.error.details!.candidates as string[]).sort()).toEqual([ids.shapes[0], ids.shapes[1]].sort());
    expect(exactElementHashes(store.snapshot())).toEqual(before);
  });

  it('alias is preferred over a display name', async () => {
    const { engine, request } = createTestEngine();
    await engine.execute(request([{ op: 'set', target: ids.shapes[2], patch: { name: 's3' } }]), 'gui');
    const r = await engine.execute(request([{ op: 'move', target: 's3', delta: { xPt: 1, yPt: 0 } }], { pageId: ids.page }), 'mcp');
    expect(r.ok && r.value.changed).toEqual([ids.shapes[3]]);
  });

  it('locked_target_rejects geometry/style but allows unlocking', async () => {
    const { engine, store, request } = createTestEngine();
    await engine.execute(request([{ op: 'set', target: ids.shape, patch: { locked: true } }]), 'gui');
    for (const op of [
      { op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } },
      { op: 'set', target: ids.shape, patch: { style: { fill: '#000000' } } },
      { op: 'resize', target: ids.shape, widthPt: 10 },
      { op: 'delete', target: ids.shape },
      { op: 'align', targets: [ids.shape, ids.shapes[1]], edge: 'right' }, // the locked shape must move
    ] as const) {
      const r = await engine.execute(request([op as any]), 'mcp');
      expect(!r.ok && r.error.code, op.op).toBe('locked_target');
    }
    const unlock = await engine.execute(request([{ op: 'set', target: ids.shape, patch: { locked: false } }]), 'gui');
    expect(unlock.ok).toBe(true);
    expect(element(store.snapshot(), ids.shape).locked).toBe(false);
  });

  it('locked layer locks its members', async () => {
    const { engine, request } = createTestEngine();
    await engine.execute(request([{ op: 'addLayer', layer: { id: uuid(0x400), name: 'L' } }, { op: 'assignLayer', targets: [ids.shape], layers: ['L'] }, { op: 'setLayer', layer: 'L', patch: { locked: true } }], { pageId: ids.page }), 'gui');
    const r = await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'mcp');
    expect(!r.ok && r.error.code).toBe('locked_target');
  });
});

describe('create, delete and duplicate', () => {
  it('delete_glued_target_requires_detach_or_delete', async () => {
    const { engine, store, request, connector } = await richScene();
    const reject = await engine.execute(request([{ op: 'delete', target: ids.shapes[0] }]), 'mcp');
    expect(!reject.ok && reject.error.code).toBe('dependency_conflict');
    if (!reject.ok) expect(reject.error.details!.elementIds).toEqual([connector]);

    const sameBatch = await engine.execute(request([{ op: 'delete', target: ids.shapes[0] }, { op: 'delete', target: connector }]), 'mcp');
    expect(sameBatch.ok && sameBatch.value.deleted.sort()).toEqual([ids.shapes[0], connector].sort());
  });

  it('detach converts glued ends to free points; delete removes dependents', async () => {
    const a = await richScene();
    const before = a.store.snapshot();
    const d = await a.engine.execute(a.request([{ op: 'delete', target: ids.shapes[0], connectors: 'detach' }]), 'mcp');
    expect(d.ok && d.value.changed).toEqual([a.connector]);
    const c = element(a.store.snapshot(), a.connector) as any;
    expect(c.from.glue).toBe('none');
    expect(c.from.point).toBeDefined();
    expect(c.to.elementId).toBe(ids.shapes[1]);
    expect(hashesExcept(a.store.snapshot(), ids.shapes[0], a.connector)).toEqual(hashesExcept(before, ids.shapes[0], a.connector));

    const b = await richScene();
    const r = await b.engine.execute(b.request([{ op: 'delete', target: ids.shapes[1], connectors: 'delete' }]), 'mcp');
    expect(r.ok && r.value.deleted.sort()).toEqual([ids.shapes[1], b.connector].sort());
  });

  it('group deletion requires an explicit subtree choice', async () => {
    const { engine, store, request, inner, outer } = await richScene();
    const r = await engine.execute(request([{ op: 'delete', target: outer }]), 'mcp');
    expect(!r.ok && r.error.code).toBe('invalid_request');
    const keep = await engine.execute(request([{ op: 'delete', target: inner, subtree: false }]), 'mcp');
    expect(keep.ok && keep.value.deleted).toEqual([inner]);
    expect((element(store.snapshot(), outer) as any).childIds.sort()).toEqual([ids.shapes[5], ids.shapes[6], ids.shapes[7]].sort());
    const all = await engine.execute(request([{ op: 'delete', target: outer, subtree: true }]), 'mcp');
    expect(all.ok && all.value.deleted.sort()).toEqual([outer, ids.shapes[5], ids.shapes[6], ids.shapes[7]].sort());
  });

  it('duplicate_remaps_internal_links and detaches external glue', async () => {
    const { engine, store, request, connector } = await richScene();
    const before = store.snapshot();
    const r = await engine.execute(request([{ op: 'duplicate', targets: [ids.shapes[0], ids.shapes[1], connector], aliases: { [ids.shapes[0]]: 'copy0' } }]), 'mcp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created).toHaveLength(3);
    expect(r.value.changed).toEqual([]);
    const snap = store.snapshot();
    const copyConn = r.value.created.map((id) => element(snap, id)).find((e) => e.kind === 'connector') as any;
    expect(r.value.created).toContain(copyConn.from.elementId);
    expect(r.value.created).toContain(copyConn.to.elementId);
    expect(r.value.aliases!.copy0).toBe(copyConn.from.elementId);
    expect(exactElementHashes(before)).toEqual(hashesExcept(snap, ...r.value.created));

    const ext = await engine.execute(request([{ op: 'duplicate', targets: [connector] }]), 'mcp');
    const lone = ext.ok ? (element(store.snapshot(), ext.value.created[0]) as any) : null;
    expect(lone.from.glue).toBe('none');
    expect(lone.to.glue).toBe('none');
  });

  it('kind_and_id_immutable', async () => {
    const { engine, request } = createTestEngine();
    for (const patch of [{ kind: 'text' }, { id: uuid(9) }]) {
      const r = await engine.execute(request([{ op: 'set', target: ids.shape, patch: patch as any }]), 'mcp');
      expect(r.ok).toBe(false);
    }
  });

  it('cross-page connector references and duplicate explicit ids cannot commit', async () => {
    const { engine, request, page2 } = await richScene();
    const cross = await engine.execute(request([{ op: 'create', pageId: page2, element: { kind: 'connector', from: { target: ids.shapes[0] }, to: { target: uuid(0x300) } } }]), 'mcp');
    expect(!cross.ok && cross.error.code).toBe('dependency_conflict');
    const dup = await engine.execute(request([{ op: 'create', element: { kind: 'shape', id: ids.shape, bounds: { x: 0, y: 0, width: 1, height: 1 } } }], { pageId: ids.page }), 'mcp');
    expect(!dup.ok && dup.error.code).toBe('invalid_request');
  });
});
