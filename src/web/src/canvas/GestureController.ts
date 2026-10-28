import type { Operation, Scope, Snapshot, TransactionResult } from '../contracts/generated';
import type { CommandEngine } from '../commands/CommandEngine';
import { planPatch } from '../commands/planPatch';
import { fail, ok, type Result } from '../model/result';

export type GestureKind = 'guide' | 'move' | 'resize' | 'rotate' | 'bend' | 'text' | 'nudge' | 'inspector' | 'paste' | 'create' | 'arrange';

export interface GestureToken {
  readonly id: number;
  readonly kind: GestureKind;
  readonly scope: Scope;
  readonly ids: readonly string[];
  /** The committed snapshot the gesture started from. Previews and operations are planned against it, never against live preview cells. */
  readonly startSnapshot: Snapshot;
  readonly startRevision: number;
}

let tokenCounter = 0;
const ELEMENT_KINDS: ReadonlySet<GestureKind> = new Set(['move', 'resize', 'rotate', 'bend', 'text']);
const GESTURE_KINDS: ReadonlySet<GestureKind> = new Set(['guide', 'move', 'resize', 'rotate', 'bend', 'text']);

/**
 * One user gesture, one canonical transaction. `begin` captures the committed state, `preview` plans the gesture's operations
 * against that state, and `commit` submits them as a single batch against the revision the gesture started from. If anything
 * committed meanwhile, the engine reports a revision conflict and the preview is discarded rather than applied over newer state.
 * Selection and zoom never touch this class.
 */
export class GestureController {
  private current: { token: GestureToken; operations: Operation[]; previewSnapshot: Snapshot | null } | null = null;
  private seq = 0;

  /** Notifies the admission gate (I30) when a pointer or text gesture starts or ends. */
  onGestureState: (active: boolean) => void = () => {};
  /** Notifies the canvas that a preview was discarded and the committed state must be shown again. */
  onDiscard: (reason: string) => void = () => {};

  constructor(private readonly engine: CommandEngine, private readonly newTransactionId: () => string = () => crypto.randomUUID()) {}

  isActive(): boolean { return this.current !== null && GESTURE_KINDS.has(this.current.token.kind); }

  begin(kind: GestureKind, scope: Scope, ids: readonly string[]): GestureToken {
    if (this.current) this.cancel(this.current.token); // a new gesture replaces a stuck one
    const startSnapshot = this.engine.store.snapshot();
    const token: GestureToken = { id: ++tokenCounter, kind, scope, ids, startSnapshot, startRevision: startSnapshot.revision };
    const wasActive = this.isActive();
    this.current = { token, operations: [], previewSnapshot: null };
    if (GESTURE_KINDS.has(kind)) this.engine.holdElements(token.id, kind, ids); // an agent can still edit everything else
    if (!wasActive && this.isActive()) this.onGestureState(true);
    return token;
  }

  /** Plans `operations` against the start snapshot. Returns the preview state, or the error that would stop a commit. */
  preview(token: GestureToken, operations: Operation[]): Result<Snapshot> {
    const cur = this.owned(token);
    if (!cur) return fail('invalid_request', 'this gesture is no longer current');
    cur.operations = operations;
    if (!operations.length) { cur.previewSnapshot = token.startSnapshot; return ok(token.startSnapshot); }
    const planned = planPatch(token.startSnapshot.document, operations, { newId: () => crypto.randomUUID() });
    if (!planned.ok) return planned;
    cur.previewSnapshot = token.startSnapshot; // the planner proves the batch is valid; the canvas shows its own live preview
    return ok(token.startSnapshot);
  }

  async commit(token: GestureToken): Promise<Result<TransactionResult>> {
    const cur = this.owned(token);
    if (!cur) return fail('invalid_request', 'this gesture is no longer current');
    const operations = cur.operations;
    this.finish(token);
    const baseRevision = this.rebasedRevision(token);
    if (!operations.length) {
      const empty: TransactionResult = {
        transactionId: this.newTransactionId(), previousRevision: token.startRevision, revision: this.engine.revision, noChange: true,
        created: [], changed: [], deleted: [], changedPageIds: [], changedLayerIds: [], changedAssetIds: [], visuallyAffectedIds: [], warnings: [],
        projectionStatus: 'applied',
      };
      return ok(empty);
    }
    const result = await this.engine.execute({
      ...token.scope, transactionId: this.newTransactionId(), baseRevision, atomic: true, operations,
    }, 'gui');
    if (!result.ok) this.onDiscard(result.error.code === 'revision_conflict'
      ? 'The document changed while you were editing, so your change was discarded.'
      : result.error.message);
    return result;
  }

  /**
   * An agent may have edited other parts of the document while the person was dragging or typing. Their gesture was planned against the
   * revision it started from; it still applies if nothing committed since touched the elements it names. Otherwise the stale revision is
   * kept, so the engine reports the conflict and the change is discarded rather than applied over newer work.
   */
  private rebasedRevision(token: GestureToken): number {
    const now = this.engine.revision;
    if (now === token.startRevision) return now;
    if (!token.ids.length || !ELEMENT_KINDS.has(token.kind)) return token.startRevision; // not about named elements (a guide, say): no way to tell what overlaps
    const since = this.engine.changesSince(token.startRevision);
    if (!since) return token.startRevision;
    const mine = new Set(token.ids);
    const touched = since.some(s => [...s.changed, ...s.deleted].some(id => mine.has(id)));
    return touched ? token.startRevision : now;
  }

  cancel(token: GestureToken): void {
    if (!this.owned(token)) return;
    this.finish(token);
    this.onDiscard('');
  }

  private owned(token: GestureToken) { return this.current && this.current.token.id === token.id ? this.current : null; }

  private finish(token: GestureToken): void {
    if (!this.owned(token)) return;
    const wasActive = this.isActive();
    this.current = null;
    this.engine.releaseElements(token.id);
    if (wasActive) this.onGestureState(false);
  }

  /** The gesture currently in progress, if any (the canvas hooks use it to attach the operations they compute). */
  get active(): GestureToken | null { return this.current?.token ?? null; }

  nextTransactionId(): string { this.seq++; return this.newTransactionId(); }
}
