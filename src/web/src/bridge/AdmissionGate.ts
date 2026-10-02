import type { AppError } from '../model/types';
import { MUTATION_METHODS, type Envelope, type Response } from './RequestRouter';

export type GateOptions = {
  holdMs?: number;           // max hold while a human gesture is active (3 s)
  mutationDeadlineMs?: number; // overall mutation deadline (15 s) the hold counts inside
  maxPendingPerConnection?: number;
  /** Admission-time scope recheck only (document/session); never a revision check. */
  checkScope: (e: Envelope) => AppError | null;
  /** A held request that is a retry of an already committed transaction is never rejected as busy. */
  isCachedRetry?: (e: Envelope) => boolean;
};

type Item = { envelope: Envelope; resolve: (r: Response) => void; arrival: number };

/**
 * Per-connection FIFO admission outside the engine queue (R3). While a human gesture is active,
 * an external mutation waits at most holdMs (from its arrival, not from gesture restarts); later
 * requests on the same connection queue behind it; other connections' reads proceed. Gesture
 * commits/cancels never pass through here, so the interlock cannot deadlock the gesture.
 */
export class AdmissionGate {
  private gestureActive = false;
  private queues = new Map<string, Item[]>();
  private draining = new Set<string>();
  private wakers = new Set<() => void>();
  private readonly holdMs: number;
  private readonly maxPending: number;

  constructor(private readonly dispatch: (e: Envelope) => Promise<Response>, private readonly opts: GateOptions) {
    this.holdMs = opts.holdMs ?? 3000;
    this.maxPending = opts.maxPendingPerConnection ?? 16;
  }

  setGestureActive(active: boolean) {
    this.gestureActive = active;
    if (!active) for (const w of [...this.wakers]) w();
  }

  accept(connectionId: string, envelope: Envelope): Promise<Response> {
    const base = { protocolVersion: 1 as const, kind: 'response' as const, requestId: envelope?.requestId ?? '' };
    if (typeof envelope?.method === 'string' && envelope.method.startsWith('doc.') && (!envelope.documentId || !envelope.sessionId))
      return Promise.resolve({ ...base, error: { code: 'invalid_request', message: 'document requests need documentId and sessionId', retryable: false, outcome: 'not_applied' } });
    const scopeError = envelope.method.startsWith('doc.') ? this.opts.checkScope(envelope) : null;
    if (scopeError) return Promise.resolve({ ...base, error: { ...scopeError, outcome: 'not_applied' } });
    const q = this.queues.get(connectionId) ?? [];
    if (q.length >= this.maxPending) return Promise.resolve({ ...base, error: { code: 'busy', message: 'too many pending requests on this connection', retryable: true, outcome: 'not_applied' } });
    return new Promise((resolve) => {
      q.push({ envelope, resolve, arrival: Date.now() });
      this.queues.set(connectionId, q);
      void this.drain(connectionId);
    });
  }

  private waitForGestureEnd(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (released: boolean) => { if (done) return; done = true; clearTimeout(timer); this.wakers.delete(wake); resolve(released); };
      const wake = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(0, ms));
      this.wakers.add(wake);
    });
  }

  private async drain(connectionId: string) {
    if (this.draining.has(connectionId)) return;
    this.draining.add(connectionId);
    try {
      const q = this.queues.get(connectionId)!;
      while (q.length) {
        const item = q[0];
        if (MUTATION_METHODS.has(item.envelope.method)) {
          while (this.gestureActive) {
            const remaining = item.arrival + this.holdMs - Date.now();
            if (remaining <= 0) break;
            await this.waitForGestureEnd(remaining);
          }
          if (this.gestureActive && !this.opts.isCachedRetry?.(item.envelope)) {
            q.shift();
            item.resolve({
              protocolVersion: 1, kind: 'response', requestId: item.envelope.requestId,
              error: { code: 'busy_user_editing', message: 'the user is editing; retry shortly', retryable: true, outcome: 'not_applied' },
            });
            continue;
          }
        }
        q.shift();
        // Dispatch in arrival order; the engine queue preserves that order without awaiting completion here.
        this.dispatch(item.envelope).then(item.resolve, () => item.resolve({
          protocolVersion: 1, kind: 'response', requestId: item.envelope.requestId,
          error: { code: 'internal_error', message: 'dispatch failed', retryable: false, outcome: 'unknown' },
        }));
      }
    } finally {
      this.draining.delete(connectionId);
      if (!this.queues.get(connectionId)?.length) this.queues.delete(connectionId);
    }
  }
}
