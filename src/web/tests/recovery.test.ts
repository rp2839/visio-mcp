import { describe, expect, it } from 'vitest';
import { RecoveryForwarder, restoreRecovery, type RecoverySink } from '../src/commands/recovery';
import { canonicalSerialize } from '../src/model/canonical';
import { ok, err } from '../src/model/result';
import type { CommittedEvent, Snapshot } from '../src/model/types';
import { createTestEngine, ids } from './support/engine';

/** In-memory host with the same contiguity rules as RecoveryJournal/CheckpointStore. */
class MemoryHost implements RecoverySink {
  checkpoints: { snapshot: Snapshot; sequence: number }[] = [];
  journal: CommittedEvent[] = [];
  head: { session: string; revision: number; sequence: number } | null = null;
  refuseNext = 0;
  async append(e: CommittedEvent) {
    if (this.refuseNext > 0) { this.refuseNext--; return err('io_error', 'disk busy', { retryable: true }) as any; }
    if (!this.head || this.head.session !== e.sessionId) return err('checkpoint_required', 'no checkpoint') as any;
    if (e.resolvedDiff.previousRevision !== this.head.revision || e.sequence <= this.head.sequence) return err('checkpoint_required', 'gap') as any;
    this.journal.push(structuredClone(e));
    this.head = { session: e.sessionId, revision: e.revision, sequence: e.sequence };
    return ok({ revision: e.revision, sequence: e.sequence });
  }
  async checkpoint(snapshot: Snapshot, sequence: number) {
    this.checkpoints.push({ snapshot: structuredClone(snapshot), sequence });
    if (!this.head || this.head.session !== snapshot.sessionId || this.head.revision < snapshot.revision) this.head = { session: snapshot.sessionId, revision: snapshot.revision, sequence };
    this.journal = this.journal.filter((r) => r.sessionId === snapshot.sessionId && r.revision > snapshot.revision);
    return ok({ revision: snapshot.revision });
  }
  candidate() {
    const base = this.checkpoints[this.checkpoints.length - 1].snapshot;
    return { base, tail: this.journal.filter((r) => r.sessionId === base.sessionId && r.revision > base.revision) };
  }
}

const manualTimers = () => {
  let fn: (() => void) | null = null;
  return { setInterval: (f: () => void) => { fn = f; return 1; }, clearInterval: () => { fn = null; }, tick: () => fn?.() };
};

async function setup(opts: { everyCommits?: number } = {}) {
  const t = createTestEngine();
  const host = new MemoryHost();
  const timers = manualTimers();
  const fwd = new RecoveryForwarder(t.engine, host, { ...opts, ...timers });
  await fwd.start();
  return { ...t, host, fwd, timers };
}

describe('recovery', () => {
  it('UndoReplayExact: edits + undo/redo replay to the exact canonical document', async () => {
    const { engine, request, host, fwd } = await setup();
    await engine.execute(request([{ op: 'move', target: ids.shapes[0], delta: { xPt: 10, yPt: 5 } }]), 'gui');
    await engine.execute(request([{ op: 'set', target: ids.shapes[1], patch: { style: { fill: '#FF0000' } } }]), 'mcp');
    const s = engine.scope();
    await engine.undo({ ...s, transactionId: crypto.randomUUID(), baseRevision: s.revision });
    const s2 = engine.scope();
    await engine.redo({ ...s2, transactionId: crypto.randomUUID(), baseRevision: s2.revision });
    await fwd.idle();
    const restored = restoreRecovery(host.candidate());
    expect(restored.ok).toBe(true);
    expect(restored.ok && canonicalSerialize(restored.value)).toBe(canonicalSerialize(engine.current().document));
    expect(fwd.lastDurableRevision).toBe(engine.current().revision);
  });

  it('GeneratedIdReplayExact: created UUIDs come from the journal, never regenerated', async () => {
    const { engine, request, host, fwd } = await setup();
    const r = await engine.execute(request([{ op: 'create', element: { kind: 'shape', bounds: { x: 10, y: 10, width: 50, height: 30 } } }]), 'mcp');
    const created = r.ok ? r.value.created[0] : '';
    await fwd.idle();
    const restored = restoreRecovery(host.candidate());
    expect(restored.ok && restored.value.pages[0].elements.some((e) => e.id === created)).toBe(true);
    expect(restored.ok && canonicalSerialize(restored.value)).toBe(canonicalSerialize(engine.current().document));
  });

  it('checkpoints every N commits, on the interval, and on a refused append', async () => {
    const { engine, request, host, fwd, timers } = await setup({ everyCommits: 3 });
    const move = () => engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui');
    for (let i = 0; i < 3; i++) await move();
    await fwd.idle();
    expect(host.checkpoints.map((c) => c.snapshot.revision)).toEqual([0, 3]);
    await move();
    timers.tick();
    await fwd.idle();
    expect(host.checkpoints.at(-1)!.snapshot.revision).toBe(4);
    host.refuseNext = 1;
    await move();
    await fwd.idle();
    expect(host.checkpoints.at(-1)!.snapshot.revision).toBe(5); // refused append → checkpoint, nothing lost
    await move();
    await fwd.idle();
    expect(restoreRecovery(host.candidate()).ok && fwd.lastDurableRevision).toBe(6);
  });

  it('NewSessionStartsOwnCheckpoint after a lifecycle replace', async () => {
    const { engine, host, fwd } = await setup();
    const s = engine.scope();
    await engine.replaceDocument(structuredClone(engine.current().document), { ...s, baseRevision: s.revision });
    await fwd.idle();
    expect(host.checkpoints.at(-1)!.snapshot.sessionId).toBe(engine.scope().sessionId);
    expect(host.checkpoints.at(-1)!.snapshot.sessionId).not.toBe(s.sessionId);
  });

  it('degraded listener forces a checkpoint', async () => {
    const { engine, request, host, fwd } = await setup();
    engine.recoveryDegraded = true;
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }]), 'gui');
    await fwd.idle();
    expect(host.checkpoints.at(-1)!.snapshot.revision).toBe(1);
    expect(engine.recoveryDegraded).toBe(false);
  });

  it('restore validates before publishing: divergence, gaps and foreign records reject', async () => {
    const { engine, request, host, fwd } = await setup();
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 7, yPt: 0 } }]), 'gui');
    await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 7, yPt: 0 } }]), 'gui');
    await fwd.idle();
    const c = host.candidate();
    const tampered = structuredClone(c);
    (tampered.tail[1].resolvedDiff.changes[0].before as any).bounds.x += 1;
    expect(restoreRecovery(tampered)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(restoreRecovery({ base: c.base, tail: [c.tail[1]] })).toMatchObject({ ok: false });
    const foreign = structuredClone(c); foreign.tail[0].documentId = ids.page;
    expect(restoreRecovery(foreign).ok).toBe(false);
    const broken = structuredClone(c); (broken.tail[1].resolvedDiff.changes[0].after as any).bounds.width = -5;
    expect(restoreRecovery(broken).ok).toBe(false);
  });
});
