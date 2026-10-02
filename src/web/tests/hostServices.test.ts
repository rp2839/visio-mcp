import { describe, expect, it } from 'vitest';
import { connectHost, tableDispatcher } from '../src/bridge/bootstrap';
import { lifecycleHandlers } from '../src/bridge/hostServices';
import { createTestEngine, ids } from './support/engine';

function fakeWebView() {
  const posted: any[] = [];
  const listeners: ((e: { data: unknown }) => void)[] = [];
  return {
    posted,
    webview: { postMessage: (m: unknown) => posted.push(m), addEventListener: (_: 'message', l: (e: { data: unknown }) => void) => listeners.push(l) },
    deliver: async (m: unknown) => { for (const l of listeners) await l({ data: m }); await new Promise((r) => setTimeout(r, 0)); },
  };
}

describe('host lifecycle bridge', () => {
  it('announces ready, serves snapshot/markSaved/replace and sequences committed events', async () => {
    const { engine, request, scope } = createTestEngine();
    const v = fakeWebView();
    connectHost(v.webview, engine, tableDispatcher(lifecycleHandlers(engine)));
    expect(v.posted[0]).toMatchObject({ kind: 'event', method: 'editor.ready', sequence: 1, documentId: ids.document, revision: 0 });
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui');
    expect(v.posted[1]).toMatchObject({ method: 'doc.committed', sequence: 2, revision: 1 });

    const s = scope();
    await v.deliver({ protocolVersion: 1, kind: 'request', requestId: 'h1', method: 'doc.snapshot', documentId: s.documentId, sessionId: s.sessionId, params: {} });
    expect(v.posted.at(-1)).toMatchObject({ kind: 'response', requestId: 'h1', result: { revision: 1 } });

    await v.deliver({ protocolVersion: 1, kind: 'request', requestId: 'h2', method: 'doc.markSaved', documentId: s.documentId, sessionId: s.sessionId, params: { revision: 1, path: 'x.diagram.json' } });
    expect(engine.isDirty()).toBe(false);

    const doc = structuredClone(engine.current().document);
    await v.deliver({ protocolVersion: 1, kind: 'request', requestId: 'h3', method: 'doc.replace', documentId: s.documentId, sessionId: s.sessionId, params: { baseRevision: 1, document: doc, savedRevision: 1, path: 'x.diagram.json' } });
    const replaced = v.posted.find((m) => m.requestId === 'h3');
    expect(replaced.result.sessionId).not.toBe(s.sessionId);
    expect(v.posted.some((m) => m.method === 'doc.opened')).toBe(true);

    await v.deliver({ protocolVersion: 1, kind: 'request', requestId: 'h4', method: 'doc.snapshot', documentId: s.documentId, sessionId: s.sessionId, params: {} });
    expect(v.posted.at(-1).error.code).toBe('session_mismatch');
  });

  it('rejects scope copies in params and unknown methods', async () => {
    const { engine, scope } = createTestEngine();
    const v = fakeWebView();
    connectHost(v.webview, engine, tableDispatcher(lifecycleHandlers(engine)));
    const s = scope();
    await v.deliver({ protocolVersion: 1, kind: 'request', requestId: 'x', method: 'doc.snapshot', documentId: s.documentId, sessionId: s.sessionId, params: { sessionId: s.sessionId } });
    expect(v.posted.at(-1).error.code).toBe('invalid_request');
    await v.deliver({ protocolVersion: 1, kind: 'request', requestId: 'y', method: 'shell.exec', params: {} });
    expect(v.posted.at(-1).error.code).toBe('method_not_found');
  });

  it('reports dirty state and closes to a new clean document in a new session', async () => {
    const { engine, request, scope } = createTestEngine();
    const h = lifecycleHandlers(engine);
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui');
    const s = scope();
    expect(await h['doc.status'](s, {})).toMatchObject({ ok: true, value: { dirty: true, revision: s.revision } });
    // A stale base revision is refused; nothing is discarded.
    expect(await h['doc.new'](s, { baseRevision: s.revision - 1 })).toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    const r = await h['doc.new'](s, { baseRevision: s.revision });
    expect(r.ok).toBe(true);
    const next = scope();
    expect(next.documentId).not.toBe(s.documentId);
    expect(next.sessionId).not.toBe(s.sessionId);
    expect(engine.current().document.pages[0].elements).toEqual([]);
    expect(await h['doc.status'](next, {})).toMatchObject({ ok: true, value: { dirty: false } });
  });
});

describe('new untitled document', () => {
  it('starts clean so Close does not ask to save an untouched diagram', async () => {
    const { EditorController } = await import('../src/editor/EditorController');
    const { MemoryAssetResolver } = await import('../src/editor/assets');
    const c = new EditorController(new MemoryAssetResolver());
    expect(await lifecycleHandlers(c.engine)['doc.status'](c.engine.scope(), {})).toMatchObject({ ok: true, value: { dirty: false } });
    expect(c.getState().dirty).toBe(false);
  });
});
