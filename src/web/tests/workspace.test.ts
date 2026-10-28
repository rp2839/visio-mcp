import { describe, expect, it } from 'vitest';
import type { RequestEnvelope, ResponseEnvelope } from '../src/contracts/generated';
import type { WebViewLike } from '../src/bridge/BridgeClient';
import { startApp } from '../src/bridge/bootstrap';
import { newDocument } from '../src/model/newDocument';

function fakeWebView() {
  const toHost: any[] = [];
  const listeners: Array<(e: { data: unknown }) => void> = [];
  const wv: WebViewLike = { postMessage: m => { toHost.push(JSON.parse(JSON.stringify(m))); }, addEventListener: (_t, l) => { listeners.push(l); } };
  const fromHost = (m: unknown) => listeners.forEach(l => l({ data: JSON.parse(JSON.stringify(m)) }));
  return { wv, toHost, fromHost };
}
const events = (toHost: any[], name: string) => toHost.filter(m => m.kind === 'event' && m.method === name).map(m => m.params);
const call = (app: ReturnType<typeof startApp>, method: string, scope: { documentId: string; sessionId: string }, params: object = {}, origin = true): Promise<ResponseEnvelope> =>
  app.router.dispatch({ protocolVersion: 1, kind: 'request', requestId: crypto.randomUUID(), method, ...scope, params, ...(origin ? { origin: { source: 'mcp', connectionId: 'agent' } } : {}) } as RequestEnvelope);

describe('workspace: several documents in one page', () => {
  it('announces the first document as ready and later ones as opened, in the background when asked', () => {
    const { wv, toHost } = fakeWebView();
    const app = startApp(wv, null);
    const second = app.openDocument({ activate: false });
    const third = app.openDocument();
    expect(events(toHost, 'editor.ready')).toEqual([expect.objectContaining({ documentId: app.engine.scope().documentId, active: true })]);
    expect(events(toHost, 'editor.document.opened')).toEqual([
      expect.objectContaining({ documentId: second.engine.scope().documentId, sessionId: second.engine.scope().sessionId, active: false }),
      expect.objectContaining({ documentId: third.engine.scope().documentId, active: true }),
    ]);
    expect(app.workspace.documents).toHaveLength(3);
    expect(app.workspace.active).toBe(third);
  });

  it('delivers each request to the document it names, whichever tab is active', async () => {
    const app = startApp(fakeWebView().wv, null);
    const background = app.openDocument({ activate: false });
    const bg = background.engine.scope();
    const r = await call(app, 'doc.snapshot', bg);
    expect((r.result as { documentId: string }).documentId).toBe(bg.documentId);
    const wrongSession = await call(app, 'doc.snapshot', { documentId: bg.documentId, sessionId: app.engine.scope().sessionId });
    expect(wrongSession.error?.code).toBe('session_mismatch');
    const unknown = await call(app, 'doc.snapshot', { documentId: crypto.randomUUID(), sessionId: bg.sessionId });
    expect(unknown.error?.code).toBe('document_mismatch');
    const host = await call(app, 'doc.snapshot', bg, {}, false); // the host's own traffic reaches it the same way
    expect((host.result as { documentId: string }).documentId).toBe(bg.documentId);
  });

  it('an edit for a background document commits there and leaves the active one alone', async () => {
    const { wv, toHost } = fakeWebView();
    const app = startApp(wv, null);
    const background = app.openDocument({ activate: false });
    const bg = background.engine.scope();
    const before = app.engine.revision;
    const r = await call(app, 'doc.apply', bg, { transactionId: crypto.randomUUID(), baseRevision: 0, atomic: true, operations: [{ op: 'createShape', alias: 'bg', bounds: { x: 10, y: 10, width: 40, height: 20 } }] });
    expect(r.error).toBeUndefined();
    expect(background.engine.revision).toBe(1);
    expect(app.engine.revision).toBe(before);
    expect(events(toHost, 'editor.committed').map(e => e.documentId)).toEqual([bg.documentId]); // journalled under its own document
  });

  it('a person dragging a shape holds agent edits to that shape only, and not edits to a background document', async () => {
    const app = startApp(fakeWebView().wv, null);
    const background = app.openDocument({ activate: false });
    const edit = (scope: { documentId: string; sessionId: string }, base: number, operations: object[]) =>
      call(app, 'doc.apply', scope, { transactionId: crypto.randomUUID(), baseRevision: base, atomic: true, operations });
    const create = (alias: string) => ({ op: 'createShape', alias, bounds: { x: 10, y: 10, width: 40, height: 20 } });
    const made = await edit(app.engine.scope(), 0, [create('mine'), create('other')]);
    expect(made.error).toBeUndefined();
    const mine = app.engine.store.snapshot().document.pages[0]!.elements.find(e => e.alias === 'mine')!.id;
    app.router.setGestureActive(true);
    app.engine.holdElements(1, 'move', [mine]);
    expect((await edit(background.engine.scope(), 0, [create('bg')])).error).toBeUndefined(); // another document: not held
    expect((await edit(app.engine.scope(), 1, [{ op: 'move', target: 'other', delta: { xPt: 5, yPt: 0 } }])).error).toBeUndefined(); // another shape: not held
    let settled = false;
    const held = edit(app.engine.scope(), 2, [{ op: 'move', target: 'mine', delta: { xPt: 5, yPt: 0 } }]).then(r => { settled = true; return r; });
    await new Promise(r => setTimeout(r, 30));
    expect(settled).toBe(false); // the shape being dragged waits for the gesture to end
    app.engine.releaseElements(1);
    app.router.setGestureActive(false);
    expect((await held).error).toBeUndefined();
  });

  it('closing and activating are announced, and a closed document can no longer be addressed', async () => {
    const { wv, toHost } = fakeWebView();
    const app = startApp(wv, null);
    const second = app.openDocument();
    const firstId = app.engine.scope().documentId;
    const secondScope = second.engine.scope();
    expect(app.closeDocument(secondScope.documentId)).toBe(true);
    expect(events(toHost, 'editor.document.closed')).toEqual([expect.objectContaining({ documentId: secondScope.documentId })]);
    expect(events(toHost, 'editor.document.activated').at(-1)).toEqual(expect.objectContaining({ documentId: firstId })); // the neighbour takes over
    expect((await call(app, 'doc.snapshot', secondScope)).error?.code).toBe('document_mismatch');
    expect(app.activateDocument(secondScope.documentId)).toBe(false);
  });

  it('a restarted document says which one it replaced', async () => {
    const { wv, toHost } = fakeWebView();
    const app = startApp(wv, null);
    const other = app.openDocument({ activate: false });
    const old = other.engine.scope();
    const fresh = newDocument();
    const r = await app.router.dispatch({ protocolVersion: 1, kind: 'request', requestId: 'rep', method: 'doc.replace', ...old, params: { baseRevision: 0, document: fresh } } as RequestEnvelope);
    expect(r.error).toBeUndefined();
    const session = events(toHost, 'editor.session').at(-1);
    expect(session).toMatchObject({ documentId: fresh.id, replaces: old.documentId, active: false }); // the background tab was restarted, not the active one
    expect(app.workspace.find(old.documentId)).toBeNull();
    expect(app.workspace.find(fresh.id)).toBe(other);
  });
});
