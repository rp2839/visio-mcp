import type { CommandEngine } from './CommandEngine';
import { applyChanges } from './diff';
import { canonicalSerialize } from '../model/canonical';
import { err, ok, type Result } from '../model/result';
import { validateDocument } from '../model/validate';
import type { CommittedEvent, DiagramDocument, Element, Snapshot } from '../model/types';

/** Host side of recovery (RecoveryJournal + CheckpointStore), reached over the bridge. */
export interface RecoverySink {
  append(event: CommittedEvent): Promise<Result<{ revision: number; sequence: number }>>;
  checkpoint(snapshot: Snapshot, sequence: number): Promise<Result<{ revision: number }>>;
}

export type RecoveryOptions = {
  /** Checkpoint after this many journalled commits (default 50). */
  everyCommits?: number;
  /** Checkpoint at most this often while commits are pending (default 60 s). */
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

/**
 * Forwards the engine's ordered resolved diffs to the host journal. The host never replays
 * commands; the frontend sends what was committed. A sequence/session gap, a refused append
 * or a degraded listener triggers a fresh checkpoint instead. Live MCP success is not a
 * durability acknowledgement: lastDurableRevision reports what the host has flushed.
 */
export class RecoveryForwarder {
  lastDurableRevision: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSequence = 0;
  private sessionId = '';
  private checkpointRevision = -1;
  private sinceCheckpoint = 0;
  private needsCheckpoint = true;
  private timer: unknown = null;
  private unsubscribe: (() => void)[] = [];
  private readonly every: number;

  constructor(private readonly engine: CommandEngine, private readonly sink: RecoverySink, private readonly opts: RecoveryOptions = {}) {
    this.every = opts.everyCommits ?? 50;
  }

  start(): Promise<unknown> {
    this.unsubscribe.push(this.engine.onCommitted((e) => this.enqueue(() => this.onEvent(e))));
    this.unsubscribe.push(this.engine.onLifecycle(() => { this.needsCheckpoint = true; this.enqueue(() => this.checkpoint()); }));
    const si = this.opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    // Checked inside the queue so commits forwarded before the tick are counted.
    this.timer = si(() => void this.enqueue(async () => { if (this.sinceCheckpoint > 0) await this.checkpoint(); }), this.opts.intervalMs ?? 60_000);
    return this.enqueue(() => this.checkpoint());
  }

  stop() {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    if (this.timer !== null) (this.opts.clearInterval ?? ((h) => clearInterval(h as any)))(this.timer);
  }

  /** Save and other lifecycle points request a checkpoint explicitly. */
  checkpointNow(): Promise<unknown> { return this.enqueue(() => this.checkpoint()); }

  /** Resolves once everything forwarded so far has been handled. */
  idle(): Promise<unknown> { return this.chain; }

  private enqueue(task: () => Promise<unknown>): Promise<unknown> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return this.chain;
  }

  private async onEvent(e: CommittedEvent) {
    if (e.sessionId === this.sessionId && e.revision <= this.checkpointRevision) { this.lastSequence = Math.max(this.lastSequence, e.sequence); return; }
    const gap = e.sessionId !== this.sessionId || e.sequence !== this.lastSequence + 1;
    this.lastSequence = e.sequence;
    if (gap || this.needsCheckpoint || this.engine.recoveryDegraded) { await this.checkpoint(); return; }
    const r = await this.sink.append(e);
    if (!r.ok) { this.needsCheckpoint = true; await this.checkpoint(); return; }
    this.lastDurableRevision = r.value.revision;
    if (++this.sinceCheckpoint >= this.every) await this.checkpoint();
  }

  private async checkpoint() {
    const snap = await this.engine.snapshot(this.engine.scope());
    if (!snap.ok) return;
    const r = await this.sink.checkpoint(snap.value, this.lastSequence);
    if (!r.ok) { this.needsCheckpoint = true; return; }
    this.engine.recoveryDegraded = false;
    this.needsCheckpoint = false;
    this.sessionId = snap.value.sessionId;
    this.checkpointRevision = snap.value.revision;
    this.sinceCheckpoint = 0;
    this.lastDurableRevision = Math.max(this.lastDurableRevision ?? -1, snap.value.revision);
  }
}

export type RecoveryCandidateDto = { base: Snapshot; tail: CommittedEvent[]; report?: unknown[] };

const entityBefore = (doc: DiagramDocument, entity: string, id: string): unknown => {
  if (entity === 'element') return doc.pages.flatMap((p) => p.elements).find((e: Element) => e.id === id) ?? null;
  if (entity === 'asset') return doc.assets.find((a) => a.id === id) ?? null;
  return undefined; // document/page headers are checked by the final validation
};

/**
 * Rebuilds the last durable document from a checkpoint and its journal tail. Every record must
 * extend the previous revision and its before-values must match the state it is applied to;
 * the result is schema/invariant-validated before anything is published.
 */
export function restoreRecovery(candidate: RecoveryCandidateDto): Result<DiagramDocument> {
  const base = candidate.base;
  if (!base?.document || base.document.revision !== base.revision) return err('invalid_request', 'recovery checkpoint is inconsistent');
  let doc: DiagramDocument = structuredClone(base.document);
  for (const ev of candidate.tail) {
    if (ev.documentId !== base.documentId) return err('invalid_request', `journal record for another document (${ev.documentId})`);
    if (ev.resolvedDiff.previousRevision !== doc.revision || ev.revision !== ev.resolvedDiff.revision) return err('invalid_request', `journal gap at revision ${doc.revision}`);
    for (const c of ev.resolvedDiff.changes) {
      const current = entityBefore(doc, c.entity, c.id);
      if (current !== undefined && canonicalSerialize(current) !== canonicalSerialize(c.before)) return err('invalid_request', `journal diverges at revision ${ev.revision} (${c.entity} ${c.id})`);
    }
    try { doc = applyChanges(doc, ev.resolvedDiff.changes, 'forward'); }
    catch (e) { return err('invalid_request', `journal record ${ev.revision} cannot be applied: ${(e as Error).message}`); }
    doc.revision = ev.revision;
  }
  return validateDocument(doc);
}
