import { describe, expect, it } from 'vitest';
import { createTestEngine, element, exactElementHashes, hashesExcept, ids, uuid } from './support/engine';
import type { Operation } from '../src/model/types';

describe('incremental commit and rollback', () => {
  it('one-logo patch changes only that image (20-object hash comparison)', async () => {
    const { engine, store, request } = createTestEngine();
    const before = store.snapshot();
    const r = await engine.execute(request([{ op: 'set', target: ids.image, patch: { assetId: 'asset:logo-v2' } }]), 'mcp');
    expect(r.ok && r.value.changed).toEqual([ids.image]);
    expect(store.snapshot().revision).toBe(before.revision + 1);
    expect(hashesExcept(store.snapshot(), ids.image)).toEqual(hashesExcept(before, ids.image));
    expect(Object.keys(exactElementHashes(before))).toHaveLength(20);
  });

  it('late_invalid_operation_rolls_back_all', async () => {
    const { engine, store, request } = createTestEngine();
    const before = store.snapshot();
    const r = await engine.execute(request([
      { op: 'move', target: ids.shapes[0], delta: { xPt: 10, yPt: 0 } },
      { op: 'set', target: ids.shapes[1], patch: { style: { fill: '#FF0000' } } },
      { op: 'set', target: uuid(0xdead), patch: { name: 'missing' } },
    ]), 'mcp');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('not_found');
      expect(r.error.outcome).toBe('not_applied');
      expect(r.error.details?.operationIndex).toBe(2);
    }
    expect(store.snapshot().document).toBe(before.document); // same committed object: nothing published
    expect(engine.canUndo()).toBe(false);
  });

  it('nested_stroke_patch_preserves_other_leaves', async () => {
    const { engine, store, request } = createTestEngine();
    const before = element(store.snapshot(), ids.shape) as any;
    await engine.execute(request([{ op: 'set', target: ids.shape, patch: { style: { stroke: '#333334' } } }]), 'mcp');
    const after = element(store.snapshot(), ids.shape) as any;
    expect(after.style).toEqual({ ...before.style, stroke: '#333334' });
    expect(after.text).toEqual(before.text);
    expect(after.bounds).toEqual(before.bounds);
    expect(after.zIndex).toBe(before.zIndex);
  });

  it('create_then_reference within one batch', async () => {
    const { engine, store, request } = createTestEngine();
    const r = await engine.execute(request([
      { op: 'create', element: { kind: 'shape', alias: 'a', bounds: { x: 10, y: 400, width: 80, height: 40 } } },
      { op: 'create', element: { kind: 'shape', alias: 'b', bounds: { x: 200, y: 400, width: 80, height: 40 } } },
      { op: 'create', element: { kind: 'connector', alias: 'ab', from: { target: 'a', port: 'east' }, to: { target: 'b' } } },
      { op: 'set', target: 'a', patch: { text: { value: 'A' } } },
    ], { pageId: ids.page }), 'mcp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created).toHaveLength(3);
    const conn = element(store.snapshot(), r.value.aliases!.ab) as any;
    expect(conn.from).toEqual({ elementId: r.value.aliases!.a, port: 'east', glue: 'static' });
    expect(conn.to).toEqual({ elementId: r.value.aliases!.b, glue: 'dynamic' });
    expect((element(store.snapshot(), r.value.aliases!.a) as any).text.value).toBe('A');
  });

  it('no_op_has_no_history', async () => {
    const { engine, store, request } = createTestEngine();
    const cur = element(store.snapshot(), ids.shape) as any;
    const r = await engine.execute(request([{ op: 'set', target: ids.shape, patch: { style: { fill: cur.style.fill } } }]), 'mcp');
    expect(r.ok && r.value.noChange).toBe(true);
    expect(store.snapshot().revision).toBe(0);
    expect(engine.canUndo()).toBe(false);
  });

  it('kind and id are immutable; unknown kind fields reject', async () => {
    const { engine, request } = createTestEngine();
    const r = await engine.execute(request([{ op: 'set', target: ids.image, patch: { geometry: { preset: 'ellipse' } } }]), 'mcp');
    expect(!r.ok && r.error.code).toBe('invalid_request');
  });

  it('projection failure keeps the commit and a retry does not recommit', async () => {
    const { engine, store, request } = createTestEngine();
    engine.setProjector(() => { throw new Error('canvas broke'); });
    const req = request([{ op: 'move', target: ids.shape, delta: { xPt: 5, yPt: 0 } }]);
    const first = await engine.execute(req, 'mcp');
    expect(first.ok && first.value.projectionStatus).toBe('failed');
    expect(store.snapshot().revision).toBe(1);
    const retry = await engine.execute(req, 'mcp');
    expect(retry).toEqual(first);
    expect(store.snapshot().revision).toBe(1);
  });
});

describe('session, cache and revision ordering', () => {
  const setName = (name: string): Operation[] => [{ op: 'set', target: ids.shape, patch: { name } }];

  it('missing_identity_rejects', async () => {
    const { engine, request } = createTestEngine();
    const r = await engine.execute({ ...request(setName('x')), sessionId: uuid(0xbad) }, 'mcp');
    expect(!r.ok && r.error.code).toBe('session_mismatch');
    const d = await engine.execute({ ...request(setName('x')), documentId: uuid(0xbad) }, 'mcp');
    expect(!d.ok && d.error.code).toBe('document_mismatch');
  });

  it('cached_retry_after_commit: baseRevision is stale, but the cache wins', async () => {
    const { engine, request } = createTestEngine();
    const req = request([{ op: 'set', target: ids.shape, patch: { name: 'New name' } }]);
    const original = await engine.execute(req, 'mcp');
    const retry = await engine.execute(req, 'mcp');
    expect(retry).toEqual(original);
  });

  it('same_id_changed_payload_conflicts', async () => {
    const { engine, request } = createTestEngine();
    const req = request(setName('one'));
    await engine.execute(req, 'mcp');
    const r = await engine.execute({ ...req, operations: setName('two') }, 'mcp');
    expect(!r.ok && r.error.code).toBe('transaction_id_conflict');
  });

  it('same_id_different_baseRevision_conflicts', async () => {
    const { engine, request } = createTestEngine();
    const req = request(setName('one'));
    await engine.execute(req, 'mcp');
    const r = await engine.execute({ ...req, baseRevision: 1 }, 'mcp');
    expect(!r.ok && r.error.code).toBe('transaction_id_conflict');
  });

  it('apply_vs_script_same_id_conflicts', async () => {
    const { engine, request } = createTestEngine();
    const req = request(setName('one'));
    await engine.execute(req, 'mcp');
    const compile = () => ({ ok: true as const, value: { operations: setName('one'), spans: [{ line: 1, column: 1, length: 1 }] } });
    const r = await engine.executeScript({ documentId: req.documentId, sessionId: req.sessionId, transactionId: req.transactionId, baseRevision: 0, script: 'set x name="one"' }, compile);
    expect(!r.ok && r.error.code).toBe('transaction_id_conflict');
  });

  it('queued_duplicate_commits_once', async () => {
    const { engine, store, request } = createTestEngine();
    const req = request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]);
    const [a, b, c] = await Promise.all([engine.execute(req, 'mcp'), engine.execute(req, 'mcp'), engine.execute(req, 'mcp')]);
    expect(store.snapshot().revision).toBe(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('reopen_same_revision_rejects_old_session', async () => {
    const { engine, store, scope, request } = createTestEngine();
    const old = request(setName('stale'));
    const s = scope();
    const doc = structuredClone(store.snapshot().document);
    const reopened = await engine.replaceDocument(doc, { ...s, baseRevision: s.revision });
    expect(reopened.ok).toBe(true);
    expect(engine.scope().revision).toBe(old.baseRevision); // coincident revision numbers
    const r = await engine.execute(old, 'mcp');
    expect(!r.ok && r.error.code).toBe('session_mismatch');
  });

  it('uncached_stale_revision_preserves_human_edit', async () => {
    const { engine, store, request } = createTestEngine();
    const agent = request([{ op: 'set', target: ids.shape, patch: { style: { fill: '#00FF00' } } }]);
    await engine.execute(request([{ op: 'set', target: ids.shape, patch: { style: { fill: '#FF0000' } } }]), 'gui');
    const r = await engine.execute(agent, 'mcp');
    expect(!r.ok && r.error.code).toBe('revision_conflict');
    if (!r.ok) {
      expect(r.error.details).toMatchObject({ expected: 0, actual: 1 });
      expect((r.error.details!.changesSinceExpected as any[])[0].changed).toEqual([ids.shape]);
    }
    expect((element(store.snapshot(), ids.shape) as any).style.fill).toBe('#FF0000');
  });

  it('cache holds at most 256 results', async () => {
    const { engine, request } = createTestEngine();
    for (let i = 0; i < 300; i++) await engine.execute(request(setName(`n${i}`)), 'mcp');
    expect(engine.cacheStats().entries).toBe(256);
  });

  it('atomic:false is rejected', async () => {
    const { engine, request } = createTestEngine();
    const r = await engine.execute({ ...request(setName('x')), atomic: false as unknown as true }, 'mcp');
    expect(!r.ok && r.error.code).toBe('invalid_request');
  });

  it('1001 operations are rejected', async () => {
    const { engine, request } = createTestEngine();
    const ops = Array.from({ length: 1001 }, () => ({ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }) as Operation);
    const r = await engine.execute(request(ops), 'mcp');
    expect(!r.ok && r.error.code).toBe('limit_exceeded');
  });
});

describe('committed events', () => {
  it('are ordered and delivered despite projector failure', async () => {
    const { engine, request } = createTestEngine();
    const events: any[] = [];
    engine.onCommitted((e) => events.push(e));
    engine.setProjector(() => ({ ok: false, error: { code: 'projection_failed', message: 'x', retryable: false } }));
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'mcp');
    await engine.execute(request([{ op: 'move', target: ids.shapes[1], delta: { xPt: 1, yPt: 0 } }]), 'gui');
    expect(events.map((e) => [e.sequence, e.revision, e.resolvedDiff.changes.map((c: any) => c.id)])).toEqual([[1, 1, [ids.shape]], [2, 2, [ids.shapes[1]]]]);
    expect(events[0].sessionId).toBe(engine.scope().sessionId);
  });

  it('a failing durability listener cannot roll back and flags recovery', async () => {
    const { engine, store, request } = createTestEngine();
    engine.onCommitted(() => { throw new Error('journal down'); });
    const r = await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'mcp');
    expect(r.ok).toBe(true);
    expect(store.snapshot().revision).toBe(1);
    expect(engine.recoveryDegraded).toBe(true);
  });
});
