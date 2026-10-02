import { describe, expect, it } from 'vitest';
import { canonicalSerialize } from '../src/model/canonical';
import { createTestEngine, element, exactElementHashes, ids } from './support/engine';

describe('history, inverses and barriers', () => {
  it('undo restores exact element serialisation at a higher revision; redo re-applies', async () => {
    const { engine, store, request, scope, nextTx } = createTestEngine();
    const originalElementJson = canonicalSerialize(element(store.snapshot(), ids.shape));
    const beforeAll = exactElementHashes(store.snapshot());
    await engine.execute(request([{ op: 'set', target: ids.shape, patch: { style: { fill: '#123456' }, text: { value: 'changed' } } }, { op: 'delete', target: ids.shapes[3] }]), 'gui');
    const afterEdit = store.snapshot();
    const undo = await engine.undo({ ...scope(), transactionId: nextTx(), baseRevision: afterEdit.revision });
    expect(undo.ok).toBe(true);
    const afterUndo = store.snapshot();
    const restoredElementJson = canonicalSerialize(element(afterUndo, ids.shape));
    expect(restoredElementJson).toBe(originalElementJson);
    expect(exactElementHashes(afterUndo)).toEqual(beforeAll);
    expect(afterUndo.revision).toBe(afterEdit.revision + 1);
    const redo = await engine.redo({ ...scope(), transactionId: nextTx(), baseRevision: afterUndo.revision });
    expect(redo.ok).toBe(true);
    expect(exactElementHashes(store.snapshot())).toEqual(exactElementHashes(afterEdit));
  });

  it('a new edit clears redo', async () => {
    const { engine, request, scope, nextTx } = createTestEngine();
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui');
    await engine.undo({ ...scope(), transactionId: nextTx(), baseRevision: scope().revision });
    expect(engine.canRedo()).toBe(true);
    await engine.execute(request([{ op: 'move', target: ids.shapes[1], delta: { xPt: 1, yPt: 0 } }]), 'gui');
    expect(engine.canRedo()).toBe(false);
    const r = await engine.redo({ ...scope(), transactionId: nextTx(), baseRevision: scope().revision });
    expect(!r.ok && r.error.code).toBe('history_unavailable');
  });

  it('undo of a stale revision rejects rather than undoing a newer human edit', async () => {
    const { engine, request, scope, nextTx } = createTestEngine();
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'mcp');
    const agentBase = scope().revision;
    await engine.execute(request([{ op: 'move', target: ids.shapes[1], delta: { xPt: 1, yPt: 0 } }]), 'gui');
    const r = await engine.undo({ ...scope(), transactionId: nextTx(), baseRevision: agentBase });
    expect(!r.ok && r.error.code).toBe('revision_conflict');
    expect(engine.canUndo()).toBe(true);
  });

  it('retention eviction returns history_unavailable', async () => {
    const { engine, request, scope, nextTx } = createTestEngine();
    for (let i = 0; i < 1005; i++) await engine.execute(request([{ op: 'set', target: ids.shape, patch: { name: `n${i}` } }]), 'gui');
    const r = await engine.getChanges(scope(), 0);
    expect(!r.ok && r.error.code).toBe('history_unavailable');
    if (!r.ok) expect(r.error.details?.earliestRetainedRevision).toBe(5);
    const recent = await engine.getChanges(scope(), 1000);
    expect(recent.ok && recent.value.transactions.map((t) => t.revision)).toEqual([1001, 1002, 1003, 1004, 1005]);
    // Undo works for retained inverse records, then runs out.
    let undone = 0;
    for (;;) {
      const u = await engine.undo({ ...scope(), transactionId: nextTx(), baseRevision: scope().revision });
      if (!u.ok) { expect(u.error.code).toBe('history_unavailable'); break; }
      undone++;
    }
    expect(undone).toBeGreaterThan(0);
    expect(undone).toBeLessThan(1005);
  });

  it('get_changes includes transactionId and source', async () => {
    const { engine, request, scope } = createTestEngine();
    const req = request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]);
    await engine.execute(req, 'mcp');
    const r = await engine.getChanges(scope(), 0);
    expect(r.ok && r.value.transactions[0]).toMatchObject({ transactionId: req.transactionId, source: 'mcp', revision: 1, changed: [ids.shape] });
  });

  it('replaceDocument checks expected revision so a late import cannot discard edits', async () => {
    const { engine, store, request, scope } = createTestEngine();
    const s = scope();
    const imported = structuredClone(store.snapshot().document);
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui'); // edit during IO
    const late = await engine.replaceDocument(imported, { ...s, baseRevision: s.revision });
    expect(!late.ok && late.error.code).toBe('revision_conflict');
    expect(store.snapshot().revision).toBe(1);
  });

  it('markSaved respects session and dirty state tracks revision', async () => {
    const { engine, store, request, scope } = createTestEngine();
    const s = scope();
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui');
    const savedR = scope().revision;
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui');
    expect((await engine.markSaved(scope(), savedR, '/tmp/a.diagram.json')).ok).toBe(true);
    expect(engine.isDirty()).toBe(true); // R saved while R+1 exists
    await engine.replaceDocument(structuredClone(store.snapshot().document), { ...scope(), baseRevision: scope().revision });
    const markSavedForOldSession = await engine.markSaved(s, 2, '/tmp/a.diagram.json');
    expect(markSavedForOldSession.ok).toBe(false);
  });

  it('snapshot and exportSnapshot are queued barriers labelled with their revision', async () => {
    const { engine, request, scope } = createTestEngine();
    engine.setSnapshotProjector((snap) => ({ ok: true, value: { documentId: snap.documentId, sessionId: snap.sessionId, revision: snap.revision, connectors: {}, groupVisualBounds: {} } }));
    const s = scope();
    const write = engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui');
    const exp = engine.exportSnapshot(s);
    await write;
    const r = await exp;
    expect(r.ok && r.value.revision).toBe(1);
    expect(r.ok && r.value.projection.revision).toBe(1);
  });
});
