import type { AppError, RequestEnvelope, ResponseEnvelope, Scope } from '../contracts/generated';

export const HOLD_MS = 3000;
export const MAX_PENDING_PER_CONNECTION = 16;

export type Dispatch = (envelope: RequestEnvelope) => Promise<ResponseEnvelope>;

export interface GateOptions {
  /** The editor's current scope, or null when no document is open. */
  scope: () => Scope | null;
  /** The scope of the named open document, or null if there is none; without it only the editor's current scope can be addressed. */
  scopeOf?: (documentId: string) => Scope | null;
  /** Whether the named document is the one the person is working in. The user-gesture hold applies only to that one; default: yes. */
  isActive?: (documentId: string | undefined) => boolean;
  /**
   * Let `doc.apply` through while a gesture is in progress and rely on the engine to refuse only an edit that would change what the
   * gesture protects. Such a refusal is held and retried until the gesture ends or the deadline passes. Scripts, undo and redo cannot be
   * checked beforehand, so they are still held for any gesture. Default: off (every mutation is held).
   */
  granularApply?: boolean;
  holdMs?: number;
  maxPending?: number;
}

const MUTATIONS: ReadonlySet<string> = new Set(['doc.apply', 'doc.executeScript', 'doc.undo', 'doc.redo']);
export const isMutationMethod = (method: string): boolean => MUTATIONS.has(method);

const error = (id: string, e: Omit<AppError, 'retryable'> & { retryable?: boolean }): ResponseEnvelope =>
  ({ protocolVersion: 1, kind: 'response', requestId: id, error: { retryable: false, ...e } });

interface Held { release: () => void }

/**
 * Per-connection admission for requests from outside the page. It sits in front of the engine queue, never inside it, so a human
 * gesture committing can never wait on it. Within one connection requests are admitted in arrival order: a read behind a held
 * mutation waits too. Other connections are unaffected. Admission checks scope only; the engine still checks, in order, scope,
 * the duplicate-transaction cache and the base revision, so a post-commit retry is never rejected here for an old revision.
 */
export class AdmissionGate {
  private gestureActive = false;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingCount = new Map<string, number>();
  private readonly waiting = new Set<Held>();
  private readonly holdMs: number;
  private readonly maxPending: number;

  constructor(private readonly dispatch: Dispatch, private readonly opts: GateOptions) {
    this.holdMs = opts.holdMs ?? HOLD_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING_PER_CONNECTION;
  }

  get isGestureActive(): boolean { return this.gestureActive; }

  /** Fed by the editor's gesture events: pointer drags, resizes, rotations, bends and in-place text edits. */
  setGestureActive(active: boolean): void {
    this.gestureActive = active;
    if (!active) this.releaseAll();
  }

  /** Document open, close and recovery cancel any gesture, so nothing stays held across a lifecycle change. */
  cancelGesture(): void { this.setGestureActive(false); }

  private releaseAll(): void {
    for (const h of [...this.waiting]) h.release();
  }

  accept(connectionId: string, envelope: RequestEnvelope): Promise<ResponseEnvelope> {
    const id = envelope.requestId;
    const count = this.pendingCount.get(connectionId) ?? 0;
    if (count >= this.maxPending) {
      return Promise.resolve(error(id, { code: 'busy', message: `this connection already has ${count} requests waiting`, retryable: true, outcome: 'none' }));
    }
    this.pendingCount.set(connectionId, count + 1);
    const previous = this.tails.get(connectionId) ?? Promise.resolve();
    let admitted!: () => void;
    const gateDone = new Promise<void>(r => { admitted = r; });
    this.tails.set(connectionId, previous.then(() => gateDone));

    const mutation = isMutationMethod(envelope.method);
    // The hold deadline runs from arrival, so a gesture that restarts cannot stretch it.
    const arrival = Date.now();
    const run = previous.then(async (): Promise<ResponseEnvelope> => {
      try {
        const rejected = this.checkScope(envelope);
        if (rejected) return rejected;
        if (mutation && this.gestureActive && this.opts.granularApply && envelope.method === 'doc.apply' && (this.opts.isActive?.(envelope.documentId) ?? true)) {
          return await this.applyAroundGestures(envelope, arrival, admitted);
        }
        if (mutation && this.gestureActive && (this.opts.isActive?.(envelope.documentId) ?? true)) {
          const timedOut = await this.holdUntilFree(this.holdMs - (Date.now() - arrival));
          if (timedOut) return error(id, { code: 'busy_user_editing', message: 'the user is editing; try again in a moment', retryable: true, outcome: 'none' });
          const again = this.checkScope(envelope);
          if (again) return again;
        }
        const result = this.dispatch(envelope);
        admitted(); // later requests on this connection may now be admitted: the engine queue keeps their order
        return await result;
      } finally {
        admitted();
        const left = (this.pendingCount.get(connectionId) ?? 1) - 1;
        if (left <= 0) this.pendingCount.delete(connectionId); else this.pendingCount.set(connectionId, left);
      }
    });
    return run;
  }

  /** Dispatches an edit now. If the engine says it would change something the person is working on, wait for the gesture to end and try again, up to the deadline. */
  private async applyAroundGestures(envelope: RequestEnvelope, arrival: number, admitted: () => void): Promise<ResponseEnvelope> {
    for (;;) {
      const result = this.dispatch(envelope);
      admitted();
      const response = await result;
      if (response.error?.code !== 'busy_user_editing' || !this.gestureActive) return response;
      const timedOut = await this.holdUntilFree(this.holdMs - (Date.now() - arrival));
      if (timedOut) return response; // the answer names the locked ids, so the caller can work elsewhere
      const again = this.checkScope(envelope);
      if (again) return again;
    }
  }

  private checkScope(env: RequestEnvelope): ResponseEnvelope | null {
    const active = this.opts.scope();
    if (!active) return error(env.requestId, { code: 'no_document', message: 'no document is open', retryable: true, outcome: 'none' });
    if (!env.method.startsWith('doc.') && !env.method.startsWith('assets.')) return null;
    if (!env.documentId || !env.sessionId) return error(env.requestId, { code: 'invalid_request', message: 'document methods need documentId and sessionId', outcome: 'none' });
    const current = this.opts.scopeOf?.(env.documentId) ?? (env.documentId === active.documentId ? active : null);
    if (!current) return error(env.requestId, { code: 'document_mismatch', message: 'the document is not the open one', outcome: 'none' });
    if (env.sessionId !== current.sessionId) return error(env.requestId, { code: 'session_mismatch', message: 'the session is not the current one', outcome: 'none' });
    return null;
  }

  /** Resolves true if the deadline passed while the gesture was still active, false once the gesture ended. */
  private holdUntilFree(ms: number): Promise<boolean> {
    if (!this.gestureActive) return Promise.resolve(false);
    if (ms <= 0) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const held: Held = { release: () => { clearTimeout(timer); this.waiting.delete(held); resolve(false); } };
      const timer = setTimeout(() => { this.waiting.delete(held); resolve(true); }, ms);
      this.waiting.add(held);
    });
  }
}
