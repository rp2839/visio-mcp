import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEnvelope, ResponseEnvelope } from '../src/contracts/generated';
import { AdmissionGate } from '../src/bridge/AdmissionGate';
import { createRequestRouter } from '../src/bridge/RequestRouter';
import { GestureController } from '../src/canvas/GestureController';
import { createTestEngine } from './support/engine';

const SCOPE = { documentId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002' };
const advanceMs = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function envelope(method: string, requestId: string, extra: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return { protocolVersion: 1, kind: 'request', requestId, method, ...SCOPE, params: {}, ...extra };
}
const ok = (id: string): ResponseEnvelope => ({ protocolVersion: 1, kind: 'response', requestId: id, result: { ok: true } });

function makeGate(opts: { scope?: () => typeof SCOPE | null; maxPending?: number } = {}) {
  const dispatched: string[] = [];
  const gate = new AdmissionGate(async env => { dispatched.push(`${env.requestId}:${env.method}`); return ok(env.requestId); }, { scope: opts.scope ?? (() => SCOPE), ...(opts.maxPending ? { maxPending: opts.maxPending } : {}) });
  return { gate, dispatched };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('admission gate', () => {
  it('same connection cannot overtake a held mutation; expiry is busy_user_editing and releases the read', async () => {
    const { gate, dispatched } = makeGate();
    gate.setGestureActive(true);
    const mutation = gate.accept('c1', envelope('doc.apply', 'm1'));
    const laterRead = gate.accept('c1', envelope('doc.summary', 'r1'));
    await advanceMs(2900);
    expect(dispatched).toEqual([]); // the read waits behind the held mutation
    await advanceMs(200);
    const m = await mutation;
    expect(m.error).toMatchObject({ code: 'busy_user_editing', retryable: true, outcome: 'none' }); // definitely not applied
    expect((await laterRead).error).toBeUndefined();
    expect(dispatched).toEqual(['r1:doc.summary']);
  });

  it('other_connection_reads_committed_state', async () => {
    const { gate, dispatched } = makeGate();
    gate.setGestureActive(true);
    const held = gate.accept('c1', envelope('doc.apply', 'm1'));
    const read = await gate.accept('c2', envelope('doc.summary', 'r2'));
    expect(read.error).toBeUndefined();
    expect(dispatched).toEqual(['r2:doc.summary']); // another connection is not held up
    await advanceMs(3100);
    expect((await held).error?.code).toBe('busy_user_editing');
  });

  it('gesture_end_releases_fifo_in_order', async () => {
    const { gate, dispatched } = makeGate();
    gate.setGestureActive(true);
    const m = gate.accept('c1', envelope('doc.apply', 'm1'));
    const r = gate.accept('c1', envelope('doc.summary', 'r1'));
    await advanceMs(1000);
    gate.setGestureActive(false);
    await Promise.all([m, r]);
    expect(dispatched).toEqual(['m1:doc.apply', 'r1:doc.summary']);
    expect((await m).error).toBeUndefined();
  });

  it('a request that arrives while no gesture is active goes straight through', async () => {
    const { gate, dispatched } = makeGate();
    await gate.accept('c1', envelope('doc.apply', 'm1'));
    expect(dispatched).toEqual(['m1:doc.apply']);
  });

  it('gesture_restart_does_not_extend_beyond_deadline', async () => {
    const { gate, dispatched } = makeGate();
    gate.setGestureActive(true);
    const m = gate.accept('c1', envelope('doc.apply', 'm1'));
    await advanceMs(2000);
    gate.setGestureActive(false); // a gesture ends...
    gate.setGestureActive(true); // ...and the next one starts at once
    // the first release let the mutation go: it must not be held again by the new gesture
    await advanceMs(0);
    expect((await m).error).toBeUndefined();
    expect(dispatched).toEqual(['m1:doc.apply']);

    const late = gate.accept('c1', envelope('doc.apply', 'm2'));
    await advanceMs(1500);
    gate.setGestureActive(true); // restarting changes nothing about the deadline
    await advanceMs(1600);
    expect((await late).error?.code).toBe('busy_user_editing'); // 3 s after arrival, not 3 s after the restart
  });

  it('held_cached_retry_not_rejected_at_admission', async () => {
    // Admission checks scope only. A retry of a committed transaction carries an old baseRevision; it must reach the engine, which answers from its cache.
    const t = createTestEngine();
    const router = createRequestRouter(t.engine);
    const req = t.request([{ op: 'move', target: t.ids.shape, delta: { xPt: 1, yPt: 0 } }]);
    const send = (id: string) => router.dispatch({
      protocolVersion: 1, kind: 'request', requestId: id, method: 'doc.apply', documentId: req.documentId, sessionId: req.sessionId,
      params: { transactionId: req.transactionId, baseRevision: req.baseRevision, atomic: true, operations: req.operations }, origin: { source: 'mcp', connectionId: 'c1' },
    });
    const first = await send('a');
    router.setGestureActive(true);
    const retry = send('b'); // held behind the gesture
    router.setGestureActive(false);
    const second = await retry;
    expect(first.error).toBeUndefined();
    expect(second.result).toEqual(first.result); // identical transaction result, not a revision conflict
    expect(t.engine.revision).toBe(1);
  });

  it('gesture_commit_bypasses_gate', async () => {
    const t = createTestEngine();
    const router = createRequestRouter(t.engine);
    const controller = new GestureController(t.engine);
    controller.onGestureState = a => router.setGestureActive(a);
    const token = controller.begin('move', t.scope(), [t.ids.shape]);
    expect(router.gate).toBeDefined();
    const held = router.dispatch({
      protocolVersion: 1, kind: 'request', requestId: 'x', method: 'doc.apply', ...t.scope(), origin: { source: 'mcp', connectionId: 'c1' },
      params: { transactionId: '00000000-0000-4000-8000-000000000999', baseRevision: 0, atomic: true, operations: [{ op: 'move', target: t.ids.shape, delta: { xPt: 5, yPt: 0 } }] },
    });
    controller.preview(token, [{ op: 'move', target: t.ids.shape, delta: { xPt: 9, yPt: 0 } }]);
    const committed = await controller.commit(token); // the human commit enters the engine at once, behind nothing
    expect(committed.ok).toBe(true);
    expect(t.engine.revision).toBe(1);
    const late = await held;
    // the gesture ended, so the held mutation was admitted; it is stale because the human committed first and is not rebased
    expect(late.error?.code).toBe('revision_conflict');
  });

  it('lifecycle_cancels_gesture', async () => {
    const { gate, dispatched } = makeGate();
    gate.setGestureActive(true);
    const m = gate.accept('c1', envelope('doc.apply', 'm1'));
    await advanceMs(500);
    gate.cancelGesture();
    expect((await m).error).toBeUndefined();
    expect(dispatched).toEqual(['m1:doc.apply']);
  });

  it('no_document_or_session_cannot_cross_gate', async () => {
    const closed = makeGate({ scope: () => null });
    expect((await closed.gate.accept('c1', envelope('doc.summary', 'r1'))).error?.code).toBe('no_document');
    const open = makeGate();
    const noIds = await open.gate.accept('c1', { ...envelope('doc.apply', 'm1'), documentId: undefined, sessionId: undefined });
    expect(noIds.error?.code).toBe('invalid_request');
    expect((await open.gate.accept('c1', envelope('doc.apply', 'm2', { documentId: '00000000-0000-4000-8000-0000000000ff' }))).error?.code).toBe('document_mismatch');
    expect((await open.gate.accept('c1', envelope('doc.apply', 'm3', { sessionId: '00000000-0000-4000-8000-0000000000ff' }))).error?.code).toBe('session_mismatch');
    expect(open.dispatched).toEqual([]);
    expect(closed.dispatched).toEqual([]);
  });

  it('a connection cannot queue more than its pending limit', async () => {
    const { gate, dispatched } = makeGate({ maxPending: 3 });
    gate.setGestureActive(true);
    const held = [1, 2, 3].map(i => gate.accept('c1', envelope('doc.apply', `m${i}`)));
    const over = await gate.accept('c1', envelope('doc.apply', 'm4'));
    expect(over.error).toMatchObject({ code: 'busy', retryable: true, outcome: 'none' });
    expect((await gate.accept('c2', envelope('doc.summary', 'other'))).error).toBeUndefined();
    await advanceMs(3100);
    await Promise.all(held);
    expect(dispatched).toEqual(['other:doc.summary']);
  });

  it('a host request without an origin bypasses the gate', async () => {
    const t = createTestEngine();
    const router = createRequestRouter(t.engine);
    router.setGestureActive(true);
    const status = await router.dispatch({ protocolVersion: 1, kind: 'request', requestId: 's', method: 'doc.status', ...t.scope(), params: {} });
    expect(status.error).toBeUndefined();
  });
});

describe('admission gate with element locks', () => {
  it('lets an edit to other elements through at once, and holds one that changes the person\'s element until the gesture ends', async () => {
    const t = createTestEngine();
    const router = createRequestRouter(t.engine);
    const controller = new GestureController(t.engine);
    controller.onGestureState = a => router.setGestureActive(a);
    const [mine, other] = t.ids.shapes as [string, string];
    const send = (id: string, target: string, base: number) => router.dispatch({
      protocolVersion: 1, kind: 'request', requestId: id, method: 'doc.apply', ...t.scope(), origin: { source: 'mcp', connectionId: 'c1' },
      params: { transactionId: crypto.randomUUID(), baseRevision: base, atomic: true, operations: [{ op: 'move', target, delta: { xPt: 5, yPt: 0 } }] },
    });
    const token = controller.begin('move', t.scope(), [mine]);
    expect((await send('free', other, 0)).error).toBeUndefined(); // no 3 s wait
    let settled = false;
    const blocked = send('held', mine, 1).then(r => { settled = true; return r; });
    await advanceMs(500);
    expect(settled).toBe(false);
    controller.preview(token, []);
    await controller.commit(token); // gesture ends: the held edit is tried again
    expect((await blocked).error).toBeUndefined();
  });

  it('refuses with busy_user_editing and the locked ids once the deadline passes', async () => {
    const t = createTestEngine();
    const router = createRequestRouter(t.engine);
    const controller = new GestureController(t.engine);
    controller.onGestureState = a => router.setGestureActive(a);
    const mine = t.ids.shape;
    controller.begin('text', t.scope(), [mine]);
    const held = router.dispatch({
      protocolVersion: 1, kind: 'request', requestId: 'x', method: 'doc.apply', ...t.scope(), origin: { source: 'mcp', connectionId: 'c1' },
      params: { transactionId: crypto.randomUUID(), baseRevision: 0, atomic: true, operations: [{ op: 'set', target: mine, patch: { text: { value: 'x' } } }] },
    });
    await advanceMs(3100);
    expect((await held).error).toMatchObject({ code: 'busy_user_editing', retryable: true, details: { lockedIds: [mine] } });
  });
});
