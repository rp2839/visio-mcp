import type { CommandEngine } from '../commands/CommandEngine';
import type { Operation, Scope, TransactionResult } from '../model/types';
import { err, type Result } from '../model/result';
import type { GestureKind } from './CanvasAdapter';

export type GestureToken = { id: number; kind: GestureKind; scope: Scope; baseRevision: number; ids: string[] };

/**
 * Human gesture lifecycle: previews stay local; commit is exactly one canonical transaction
 * at the gesture-start revision. A gesture made stale by an already-admitted mutation is
 * discarded (backstop) instead of overwriting newer state. State changes feed the agent
 * admission gate (I30) through onGestureState.
 */
export class GestureController {
  private active: GestureToken | null = null;
  private pendingOps: Operation[] = [];
  private seq = 0;
  private stateListeners = new Set<(active: boolean) => void>();

  constructor(
    private readonly engine: CommandEngine,
    private readonly opts: { newTransactionId?: () => string; onStatus?: (message: string) => void } = {},
  ) {}

  onGestureState(listener: (active: boolean) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setActive(token: GestureToken | null) {
    const was = this.active !== null;
    this.active = token;
    if (was !== (token !== null)) for (const l of this.stateListeners) l(token !== null);
  }

  isActive() { return this.active !== null; }
  current() { return this.active; }

  begin(kind: GestureKind, scope: Scope & { revision: number }, ids: string[]): GestureToken {
    if (this.active) this.cancel(this.active);
    const token: GestureToken = { id: ++this.seq, kind, scope: { documentId: scope.documentId, sessionId: scope.sessionId, ...(scope.pageId ? { pageId: scope.pageId } : {}) }, baseRevision: scope.revision, ids };
    this.pendingOps = [];
    this.setActive(token);
    return token;
  }

  preview(token: GestureToken, operations: Operation[]) {
    if (this.active?.id !== token.id) return; // stale preview from an ended gesture
    this.pendingOps = operations;
  }

  async commit(token: GestureToken, operations?: Operation[]): Promise<Result<TransactionResult>> {
    if (this.active?.id !== token.id) return err('invalid_request', 'gesture is no longer active', undefined, 'not_applied');
    const ops = operations ?? this.pendingOps;
    this.pendingOps = [];
    this.setActive(null);
    if (ops.length === 0) return err('invalid_request', 'gesture made no change', { noChange: true }, 'not_applied');
    const r = await this.engine.execute({
      ...token.scope, transactionId: (this.opts.newTransactionId ?? (() => crypto.randomUUID()))(),
      baseRevision: token.baseRevision, atomic: true, operations: ops,
    }, 'gui');
    if (!r.ok && r.error.code === 'revision_conflict') this.opts.onStatus?.('Your edit was discarded because the document changed during the gesture.');
    else if (!r.ok) this.opts.onStatus?.(r.error.message);
    return r;
  }

  cancel(token: GestureToken) {
    if (this.active?.id !== token.id) return;
    this.pendingOps = [];
    this.setActive(null);
  }

  /** Lifecycle barrier (open/close/recovery): drop any uncommitted gesture. */
  cancelAll() {
    if (this.active) this.cancel(this.active);
  }
}
