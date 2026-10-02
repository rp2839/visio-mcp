import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdmissionGate } from '../src/bridge/AdmissionGate';
import { RequestRouter, type Envelope } from '../src/bridge/RequestRouter';
import { compile } from '../src/script/compiler';
import { createTestEngine, ids, uuid } from './support/engine';

function setup() {
  const t = createTestEngine();
  const router = new RequestRouter(t.engine, compile);
  const dispatchedMethods: string[] = [];
  const gate = new AdmissionGate(async (e) => { dispatchedMethods.push(e.method); return router.dispatch(e); }, {
    checkScope: (e) => {
      const s = t.engine.scope();
      if (e.documentId !== s.documentId) return { code: 'document_mismatch', message: 'doc', retryable: false };
      if (e.sessionId !== s.sessionId) return { code: 'session_mismatch', message: 'session', retryable: false };
      return null;
    },
    isCachedRetry: (e) => t.engine.hasCachedTransaction(e.sessionId!, e.documentId!, e.params.transactionId),
  });
  let n = 0;
  const env = (method: string, params: Record<string, unknown> = {}): Envelope => {
    const s = t.engine.scope();
    return { protocolVersion: 1, kind: 'request', requestId: `r${++n}`, method, documentId: s.documentId, sessionId: s.sessionId, params };
  };
  const apply = (dx = 1, tx = uuid(0xe000 + n)) => env('doc.apply', { transactionId: tx, baseRevision: t.engine.scope().revision, operations: [{ op: 'move', target: ids.shape, delta: { xPt: dx, yPt: 0 } }] });
  return { ...t, router, gate, dispatchedMethods, env, apply };
}

const advanceMs = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('admission gate (R3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('held mutation blocks later requests on the same connection, then expires busy_user_editing', async () => {
    const { gate, dispatchedMethods, env, apply } = setup();
    gate.setGestureActive(true);
    const mutation = gate.accept('c1', apply());
    const laterRead = gate.accept('c1', env('doc.summary'));
    await advanceMs(10);
    expect(dispatchedMethods).toEqual([]); // same connection cannot overtake
    await advanceMs(3000);
    const m = await mutation;
    expect(m.error?.code).toBe('busy_user_editing');
    expect(m.error?.outcome).toBe('not_applied');
    expect(m.error?.retryable).toBe(true);
    expect((await laterRead).error).toBeUndefined();
  });

  it('other_connection_reads_committed_state while c1 is held', async () => {
    const { gate, dispatchedMethods, env, apply } = setup();
    gate.setGestureActive(true);
    const held = gate.accept('c1', apply());
    const other = await gate.accept('c2', env('doc.summary'));
    expect(other.error).toBeUndefined();
    expect((other.result as any).revision).toBe(0);
    expect(dispatchedMethods).toEqual(['doc.summary']);
    gate.setGestureActive(false);
    await advanceMs(0);
    expect((await held).error).toBeUndefined();
  });

  it('gesture_end_releases_fifo_in_order', async () => {
    const { gate, dispatchedMethods, env, apply, engine } = setup();
    gate.setGestureActive(true);
    const m = gate.accept('c1', apply());
    const r = gate.accept('c1', env('doc.summary'));
    await advanceMs(1000);
    gate.setGestureActive(false);
    await advanceMs(0);
    const [mr, rr] = await Promise.all([m, r]);
    expect(dispatchedMethods).toEqual(['doc.apply', 'doc.summary']);
    expect((mr.result as any).revision).toBe(1);
    expect((rr.result as any).revision).toBe(1); // the read observes the admitted mutation
    expect(engine.scope().revision).toBe(1);
  });

  it('gesture_restart_does_not_extend_beyond_deadline', async () => {
    const { gate, apply } = setup();
    gate.setGestureActive(true);
    const m = gate.accept('c1', apply());
    await advanceMs(1000);
    gate.setGestureActive(false);
    gate.setGestureActive(true); // a new gesture starts immediately
    await advanceMs(1000);
    gate.setGestureActive(false);
    gate.setGestureActive(true);
    await advanceMs(1001);
    expect((await m).error?.code).toBe('busy_user_editing');
  });

  it('gesture_commit_bypasses_gate', async () => {
    const t = setup();
    t.gate.setGestureActive(true);
    const held = t.gate.accept('c1', t.apply(5));
    const human = await t.engine.execute(t.request([{ op: 'move', target: ids.shapes[1], delta: { xPt: 1, yPt: 0 } }]), 'gui');
    expect(human.ok).toBe(true);
    t.gate.setGestureActive(false);
    await advanceMs(0);
    expect((await held).error?.code).toBe('revision_conflict'); // stale after the human commit; not rebased
  });

  it('held_cached_retry_not_rejected_at_admission', async () => {
    const t = setup();
    const req = t.apply(2, uuid(0xf00d));
    const first = await t.gate.accept('c1', req);
    expect(first.error).toBeUndefined();
    t.gate.setGestureActive(true);
    const retry = t.gate.accept('c2', { ...req, requestId: 'retry' }); // reconnect, same transaction identity
    await advanceMs(3001);
    const r = await retry;
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual(first.result);
    expect(t.engine.scope().revision).toBe(1);
  });

  it('no_document_or_session_cannot_cross_gate; lifecycle methods are not reachable from MCP', async () => {
    const { gate, env, dispatchedMethods } = setup();
    const noScope = await gate.accept('c1', { ...env('doc.summary'), documentId: undefined, sessionId: undefined });
    expect(noScope.error?.code).toBe('invalid_request');
    const stale = await gate.accept('c1', { ...env('doc.summary'), sessionId: uuid(0xbad) });
    expect(stale.error?.code).toBe('session_mismatch');
    const life = await gate.accept('c1', { ...env('doc.replace', { baseRevision: 0, document: {} }), origin: { source: 'mcp' } });
    expect(life.error?.code).toBe('method_not_found');
    expect(dispatchedMethods).toEqual(['doc.replace']);
  });

  it('lifecycle_cancels_gesture: replacement releases the hold and old-session requests then fail', async () => {
    const t = setup();
    t.gate.setGestureActive(true);
    const held = t.gate.accept('c1', t.apply());
    await advanceMs(500);
    // Host lifecycle barrier: cancel gestures, publish a new session.
    t.gate.setGestureActive(false);
    const s = t.engine.scope();
    await t.engine.replaceDocument(structuredClone(t.engine.current().document), { ...s, baseRevision: s.revision });
    await advanceMs(0);
    expect((await held).error?.code).toBe('session_mismatch');
  });

  it('caps pending requests per connection', async () => {
    const { gate, apply } = setup();
    gate.setGestureActive(true);
    const all = Array.from({ length: 17 }, () => gate.accept('c1', apply()));
    expect((await all[16]).error?.code).toBe('busy');
    gate.setGestureActive(false);
    await advanceMs(0);
    await Promise.all(all.slice(0, 16));
  });
});

describe('request router', () => {
  it('serves app.current, summary, objects, apply, script and changes', async () => {
    const { router, env, engine } = setup();
    const cur = await router.dispatch({ protocolVersion: 1, kind: 'request', requestId: 'c', method: 'app.current', params: {} });
    expect((cur.result as any).sessionId).toBe(engine.scope().sessionId);
    const sum = await router.dispatch(env('doc.summary', { includeStyle: true }));
    expect((sum.result as any).elements).toHaveLength(20);
    expect((sum.result as any).assetIds).toEqual(['asset:logo']);
    const objs = await router.dispatch(env('doc.getObjects', { ids: [ids.image] }));
    expect((objs.result as any).objects[0].assetId).toBe('asset:logo');
    const missing = await router.dispatch(env('doc.getObjects', { ids: [uuid(1234)] }));
    expect(missing.error?.code).toBe('not_found');
    const s = await router.dispatch(env('doc.executeScript', { transactionId: uuid(0x777), baseRevision: 0, script: 'set "' + ids.shape + '" name="via script"' }));
    expect((s.result as any).changed).toEqual([ids.shape]);
    const ch = await router.dispatch(env('doc.getChanges', { sinceRevision: 0 }));
    expect((ch.result as any).transactions[0]).toMatchObject({ source: 'script', revision: 1 });
    const scoped = await router.dispatch({ ...env('doc.summary'), params: { sessionId: engine.scope().sessionId } });
    expect(scoped.error?.code).toBe('invalid_request');
  });
});
