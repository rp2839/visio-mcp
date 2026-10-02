import type {
  ChangeSet, CommittedEvent, DiagramDocument, EntityChange, ExportSnapshot, MutationRequest, Operation, PreparedAssetRef,
  Projection, ResolvedDiff, Scope, ScriptRequest, Snapshot, TransactionResult, UndoRequest, Diagnostic,
} from '../model/types';
import type { Source } from '../model/types';
import { err, ok, type Result } from '../model/result';
import { canonicalSerialize } from '../model/canonical';
import { validateDocument } from '../model/validate';
import { DocumentStore } from '../model/store';
import { planOperations } from './planPatch';
import { applyChanges, invert } from './diff';
import { History, summarise } from './history';
import { checkInvariants } from '../model/validate';

export type CompiledScript = { operations: Operation[]; spans: { line: number; column: number; length: number }[] };
export type ScriptCompiler = (
  source: string,
  context: { snapshot: Snapshot; newUuid: () => string; preparedAssetRefs?: Record<string, PreparedAssetRef> },
) => Result<CompiledScript>;
export type Projector = (snapshot: Snapshot, diff: ResolvedDiff) => Result<void>;
export type SnapshotProjector = (snapshot: Snapshot) => Result<Projection>;
/** Host check of prepared asset refs (ownership/expiry), run only after a cache miss. */
export type PreparedRefVerifier = (refs: Record<string, PreparedAssetRef>) => Result<void>;

export const CACHE_ENTRY_LIMIT = 256;
export const CACHE_BYTE_LIMIT = 16 * 1024 * 1024;

type CacheEntry = { hash: string; result: TransactionResult; bytes: number };

export type EngineOptions = {
  document: DiagramDocument;
  newUuid?: () => string;
  now?: () => string;
  /** A new untitled document starts clean (nothing to save); opened or recovered content does not. */
  clean?: boolean;
};

export class CommandEngine {
  private store!: DocumentStore;
  private history!: History;
  private cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private projector: Projector | null = null;
  private snapshotProjector: SnapshotProjector | null = null;
  private refVerifier: PreparedRefVerifier | null = null;
  private listeners = new Set<(e: CommittedEvent) => void>();
  private lifecycleListeners = new Set<(s: Snapshot) => void>();
  private sequence = 0;
  private savedRevision: number | null = null;
  private savedPath: string | null = null;
  /** True when a committed-event listener failed; the host must take a fresh checkpoint. */
  recoveryDegraded = false;
  readonly newUuid: () => string;
  private readonly now: () => string;

  constructor(opts: EngineOptions) {
    this.newUuid = opts.newUuid ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => new Date().toISOString());
    const v = validateDocument(opts.document);
    if (!v.ok) throw new Error(`initial document invalid: ${v.error.message}`);
    this.startSession(opts.document);
    if (opts.clean) this.savedRevision = opts.document.revision;
  }

  private startSession(document: DiagramDocument) {
    // The engine alone creates session identity; history and cache never cross sessions.
    this.store = new DocumentStore(document, this.newUuid());
    this.history = new History();
    this.cache.clear();
    this.cacheBytes = 0;
    this.savedRevision = null;
  }

  // ---------- queue ----------
  /** Serial queue: every read, mutation and lifecycle barrier runs at the head in order. */
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private checkScope(scope: { documentId: string; sessionId: string }): Result<void> {
    if (scope.documentId !== this.store.documentId) return err('document_mismatch', 'request is for a different document', { documentId: this.store.documentId }, 'not_applied');
    if (scope.sessionId !== this.store.sessionId) return err('session_mismatch', 'request is for a different (stale) session; re-read the document', { sessionId: this.store.sessionId }, 'not_applied');
    return ok(undefined);
  }

  /** Current scope for local GUI callers (never used to fabricate agent identity). */
  scope(): Scope & { revision: number } {
    return { documentId: this.store.documentId, sessionId: this.store.sessionId, revision: this.store.revision };
  }

  current(): Snapshot { return this.store.snapshot(); }
  isDirty(): boolean { return this.savedRevision !== this.store.revision; }
  savedState() { return { revision: this.savedRevision, path: this.savedPath }; }
  canUndo(transactionId?: string) { return this.history.canUndo(transactionId); }
  canRedo() { return this.history.canRedo(); }
  /** True if this transaction identity has a retained committed/noChange result (admission hint only). */
  hasCachedTransaction(sessionId: string, documentId: string, transactionId: string) {
    return this.cache.has(this.cacheKey(sessionId, documentId, transactionId));
  }
  cacheStats() { return { entries: this.cache.size, bytes: this.cacheBytes, entryLimit: CACHE_ENTRY_LIMIT, byteLimit: CACHE_BYTE_LIMIT }; }

  // ---------- configuration ----------
  setProjector(p: Projector | null) { this.projector = p; }
  setSnapshotProjector(p: SnapshotProjector | null) { this.snapshotProjector = p; }
  setPreparedRefVerifier(v: PreparedRefVerifier | null) { this.refVerifier = v; }
  onCommitted(listener: (event: CommittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onLifecycle(listener: (snapshot: Snapshot) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  // ---------- cache ----------
  private cacheKey(sessionId: string, documentId: string, transactionId: string) {
    return `${sessionId}|${documentId}|${transactionId}`;
  }

  /** Scope → cache → (caller) revision. Returns a cached result, a conflict, or null on miss. */
  private cacheLookup(key: string, hash: string): Result<TransactionResult> | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.hash !== hash) return err('transaction_id_conflict', 'transactionId was already used with a different payload', undefined, 'not_applied');
    return ok(structuredClone(hit.result));
  }

  private cacheStore(key: string, hash: string, result: TransactionResult) {
    const bytes = 2 * (hash.length + JSON.stringify(result).length);
    this.cache.set(key, { hash, result: structuredClone(result), bytes });
    this.cacheBytes += bytes;
    for (const [k, v] of this.cache) {
      if (this.cache.size <= CACHE_ENTRY_LIMIT && this.cacheBytes <= CACHE_BYTE_LIMIT) break;
      this.cache.delete(k);
      this.cacheBytes -= v.bytes;
    }
  }

  private revisionConflict(baseRevision: number): Result<never> {
    const since = this.history.summaries().filter((s) => s.revision > baseRevision);
    return err('revision_conflict', `document is at revision ${this.store.revision}, request was based on ${baseRevision}`,
      { expected: baseRevision, actual: this.store.revision, changesSinceExpected: since.slice(-50) }, 'not_applied');
  }

  // ---------- mutations ----------
  execute(req: MutationRequest, source: Source): Promise<Result<TransactionResult>> {
    return this.enqueue(() => {
      const scope = this.checkScope(req);
      if (!scope.ok) return scope;
      if ((req as { atomic?: unknown }).atomic !== undefined && req.atomic !== true)
        return err('invalid_request', 'only atomic batches are supported (atomic:false is rejected)', undefined, 'not_applied');
      const key = this.cacheKey(req.sessionId, req.documentId, req.transactionId);
      const hash = canonicalSerialize({
        method: 'doc.apply', documentId: req.documentId, sessionId: req.sessionId, pageId: req.pageId ?? null,
        baseRevision: req.baseRevision, operations: req.operations, description: req.description ?? null,
      });
      const cached = this.cacheLookup(key, hash);
      if (cached) return cached;
      if (req.baseRevision !== this.store.revision) return this.revisionConflict(req.baseRevision);
      const planned = planOperations(this.store.document, req.operations, { pageId: req.pageId, newUuid: this.newUuid });
      if (!planned.ok) return planned;
      return this.commit(req.transactionId, source, req.description ?? describe(req.operations), planned.value.changes, planned.value.candidate,
        { key, hash, aliases: planned.value.aliases, warnings: planned.value.warnings });
    });
  }

  executeScript(req: ScriptRequest, compile: ScriptCompiler): Promise<Result<TransactionResult>> {
    return this.enqueue(() => {
      const scope = this.checkScope(req);
      if (!scope.ok) return scope;
      if ((req as { atomic?: unknown }).atomic !== undefined && req.atomic !== true)
        return err('invalid_request', 'only atomic batches are supported', undefined, 'not_applied');
      if (new TextEncoder().encode(req.script).length > 1024 * 1024) return err('limit_exceeded', 'script exceeds 1 MiB', undefined, 'not_applied');
      const key = this.cacheKey(req.sessionId, req.documentId, req.transactionId);
      // Hash the caller's source and prepared refs, never the compiled (UUID-bearing) operations.
      const hash = canonicalSerialize({
        method: 'doc.executeScript', documentId: req.documentId, sessionId: req.sessionId, pageId: req.pageId ?? null,
        baseRevision: req.baseRevision, script: req.script, preparedAssetRefs: req.preparedAssetRefs ?? null,
      });
      const cached = this.cacheLookup(key, hash);
      if (cached) return cached;
      if (req.baseRevision !== this.store.revision) return this.revisionConflict(req.baseRevision);
      if (req.preparedAssetRefs && this.refVerifier) {
        const v = this.refVerifier(req.preparedAssetRefs);
        if (!v.ok) return v;
      }
      const compiled = compile(req.script, { snapshot: this.store.snapshot(req.pageId), newUuid: this.newUuid, preparedAssetRefs: req.preparedAssetRefs });
      if (!compiled.ok) return { ok: false, error: { ...compiled.error, outcome: 'not_applied' } };
      const planned = planOperations(this.store.document, compiled.value.operations, { pageId: req.pageId, newUuid: this.newUuid });
      if (!planned.ok) {
        const i = planned.error.details?.operationIndex as number | undefined;
        const span = i !== undefined ? compiled.value.spans[i] : undefined;
        return span ? { ok: false, error: { ...planned.error, details: { ...planned.error.details, line: span.line, column: span.column } } } : planned;
      }
      return this.commit(req.transactionId, 'script', 'DrawScript', planned.value.changes, planned.value.candidate,
        { key, hash, aliases: planned.value.aliases, warnings: planned.value.warnings, operations: compiled.value.operations });
    });
  }

  undo(req: UndoRequest): Promise<Result<TransactionResult>> { return this.undoRedo(req, 'undo'); }
  redo(req: UndoRequest): Promise<Result<TransactionResult>> { return this.undoRedo(req, 'redo'); }

  private undoRedo(req: UndoRequest, kind: 'undo' | 'redo'): Promise<Result<TransactionResult>> {
    return this.enqueue(() => {
      const scope = this.checkScope(req);
      if (!scope.ok) return scope;
      const key = this.cacheKey(req.sessionId, req.documentId, req.transactionId);
      const hash = canonicalSerialize({ method: `doc.${kind}`, documentId: req.documentId, sessionId: req.sessionId, baseRevision: req.baseRevision });
      const cached = this.cacheLookup(key, hash);
      if (cached) return cached;
      if (req.baseRevision !== this.store.revision) return this.revisionConflict(req.baseRevision);
      const head = kind === 'undo' ? this.history.undoHead() : this.history.redoHead();
      if (!head) return err('history_unavailable', `nothing to ${kind}`, undefined, 'not_applied');
      if (!head.changes) return err('history_unavailable', `${kind} record for revision ${head.revision} is no longer retained`, { earliestRetainedRevision: this.history.earliestRetainedRevision(this.store.revision) }, 'not_applied');
      const changes = kind === 'undo' ? invert(head.changes) : head.changes;
      const candidate = applyChanges(this.store.document, changes, 'forward');
      const problems = checkInvariants(candidate);
      if (problems.length) return err('dependency_conflict', `cannot ${kind}: ${problems[0].message}`, undefined, 'not_applied');
      return this.commit(req.transactionId, kind, `${kind === 'undo' ? 'Undo' : 'Redo'}: ${head.description}`, changes, candidate, { key, hash, aliases: {}, warnings: [] });
    });
  }

  private commit(
    transactionId: string, source: Source, description: string, changes: EntityChange[], candidate: DiagramDocument,
    extra: { key: string; hash: string; aliases: Record<string, string>; warnings: Diagnostic[]; operations?: Operation[] },
  ): Result<TransactionResult> {
    const previousRevision = this.store.revision;
    const base = resultFromChanges(transactionId, previousRevision, changes, this.store.document, candidate, extra.warnings);
    if (changes.length === 0) {
      const result: TransactionResult = { ...base, revision: previousRevision, noChange: true, projectionStatus: 'applied', ...(Object.keys(extra.aliases).length ? { aliases: extra.aliases } : {}), ...(extra.operations ? { operations: extra.operations } : {}) };
      this.cacheStore(extra.key, extra.hash, result);
      return ok(result);
    }
    const revision = previousRevision + 1;
    this.store.publish({ ...candidate, revision });
    const timestamp = this.now();
    this.history.push({ transactionId, source, description, previousRevision, revision, changes, summary: summarise(transactionId, source, revision, description, changes, timestamp) });
    const diff: ResolvedDiff = { source, transactionId, previousRevision, revision, changes };
    this.emit(diff);
    let projectionStatus: 'applied' | 'failed' = 'applied';
    if (this.projector) {
      try {
        const r = this.projector(this.store.snapshot(), diff);
        if (!r.ok) projectionStatus = 'failed';
      } catch {
        projectionStatus = 'failed'; // committed state stays; the adapter rebuilds from snapshot
      }
    }
    const result: TransactionResult = {
      ...base, revision, noChange: false, projectionStatus,
      ...(Object.keys(extra.aliases).length ? { aliases: extra.aliases } : {}),
      ...(extra.operations ? { operations: extra.operations } : {}),
    };
    this.cacheStore(extra.key, extra.hash, result);
    return ok(result);
  }

  private emit(resolvedDiff: ResolvedDiff) {
    const event: CommittedEvent = { sequence: ++this.sequence, documentId: this.store.documentId, sessionId: this.store.sessionId, revision: resolvedDiff.revision, resolvedDiff };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A durability listener failure cannot roll back a commit; flag for a checkpoint.
        this.recoveryDegraded = true;
      }
    }
  }

  // ---------- reads and barriers ----------
  snapshot(scope: Scope): Promise<Result<Snapshot>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      return s.ok ? ok(this.store.snapshot(scope.pageId)) : s;
    });
  }

  exportSnapshot(scope: Scope): Promise<Result<ExportSnapshot>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      if (!s.ok) return s;
      if (!this.snapshotProjector) return err('projection_failed', 'no snapshot projector registered');
      const snap = this.store.snapshot(scope.pageId);
      const projection = this.snapshotProjector(snap);
      if (!projection.ok) return projection;
      const p = projection.value;
      if (p.revision !== snap.revision || p.sessionId !== snap.sessionId || p.documentId !== snap.documentId)
        return err('projection_failed', 'projection sidecar does not match the snapshot revision/scope');
      return ok({ ...snap, projection: p });
    });
  }

  getChanges(scope: Scope, sinceRevision: number): Promise<Result<ChangeSet>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      if (!s.ok) return s;
      const earliest = this.history.earliestRetainedRevision(this.store.revision);
      if (sinceRevision < earliest)
        return err('history_unavailable', `history before revision ${earliest} is not retained; call get_document_summary for full state`, { earliestRetainedRevision: earliest });
      return ok({
        documentId: this.store.documentId, sessionId: this.store.sessionId, revision: this.store.revision,
        earliestRetainedRevision: earliest, transactions: this.history.summaries().filter((t) => t.revision > sinceRevision),
      });
    });
  }

  /** Lifecycle barrier: publish an opened/imported/recovered document under a new session. */
  replaceDocument(doc: DiagramDocument, expected: Scope & { baseRevision: number }, opts: { savedRevision?: number | null; path?: string | null } = {}): Promise<Result<Snapshot>> {
    return this.enqueue(() => {
      const s = this.checkScope(expected);
      if (!s.ok) return s;
      if (expected.baseRevision !== this.store.revision) return this.revisionConflict(expected.baseRevision);
      const v = validateDocument(doc);
      if (!v.ok) return v;
      this.startSession(doc);
      this.savedRevision = opts.savedRevision === undefined ? doc.revision : opts.savedRevision;
      this.savedPath = opts.path ?? null;
      const snap = this.store.snapshot();
      for (const l of this.lifecycleListeners) try { l(snap); } catch { this.recoveryDegraded = true; }
      return ok(snap);
    });
  }

  markSaved(scope: Scope, revision: number, path: string): Promise<Result<void>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      if (!s.ok) return s;
      if (revision > this.store.revision) return err('invalid_request', 'cannot mark a future revision saved');
      this.savedRevision = revision;
      this.savedPath = path;
      return ok(undefined);
    });
  }
}

function describe(ops: Operation[]): string {
  const kinds = [...new Set(ops.map((o) => o.op))];
  return `${kinds.join(', ')} (${ops.length} operation${ops.length === 1 ? '' : 's'})`;
}

function resultFromChanges(
  transactionId: string, previousRevision: number, changes: EntityChange[], before: DiagramDocument, after: DiagramDocument, warnings: Diagnostic[],
): Omit<TransactionResult, 'revision' | 'noChange' | 'projectionStatus'> {
  const created: string[] = [], changed: string[] = [], deleted: string[] = [];
  const pages = new Set<string>(), layers = new Set<string>(), assets = new Set<string>();
  for (const c of changes) {
    if (c.entity === 'element') {
      (c.before === null ? created : c.after === null ? deleted : changed).push(c.id);
      if (c.pageId) pages.add(c.pageId);
    } else if (c.entity === 'page') {
      pages.add(c.id);
      const bl = new Map(((c.before as any)?.layers ?? []).map((l: any) => [l.id, canonicalSerialize(l)]));
      const al = new Map(((c.after as any)?.layers ?? []).map((l: any) => [l.id, canonicalSerialize(l)]));
      for (const id of new Set([...bl.keys(), ...al.keys()])) if (bl.get(id) !== al.get(id)) layers.add(id as string);
    } else if (c.entity === 'asset') assets.add(c.id);
  }
  // Visual side effects: connectors glued to changed elements reroute; images of changed assets redraw.
  const visual = new Set([...created, ...changed, ...deleted]);
  for (const doc of [before, after])
    for (const p of doc.pages)
      for (const e of p.elements) {
        if (e.kind === 'connector' && (visual.has(e.from.elementId ?? '') || visual.has(e.to.elementId ?? ''))) visual.add(e.id);
        if (e.kind === 'image' && assets.has(e.assetId)) visual.add(e.id);
      }
  return {
    transactionId, previousRevision, created, changed, deleted,
    changedPageIds: [...pages], changedLayerIds: [...layers], changedAssetIds: [...assets],
    visuallyAffectedIds: [...visual], warnings,
  };
}
