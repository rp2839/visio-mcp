import type { AppError } from '../model/types';

export type WebViewLike = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
};

type Json = Record<string, any>;
export type HostResponse = { ok: true; result: unknown } | { ok: false; error: AppError };

/** Frontend → host requests (host services such as asset preparation). Message-only; no host objects. */
export class BridgeClient {
  private next = 0;
  private pending = new Map<string, (r: HostResponse) => void>();

  constructor(private readonly webview: WebViewLike) {}

  /** Called by bootstrap for every host message of kind "response" addressed to a frontend request. */
  handleResponse(m: Json): boolean {
    const resolve = this.pending.get(m.requestId);
    if (!resolve) return false;
    this.pending.delete(m.requestId);
    resolve(m.error ? { ok: false, error: m.error } : { ok: true, result: m.result });
    return true;
  }

  request(method: string, params: Json = {}, timeoutMs = 120_000): Promise<HostResponse> {
    const requestId = `f${++this.next}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) resolve({ ok: false, error: { code: 'timeout_unknown', message: `${method} timed out`, retryable: true, outcome: 'unknown' } });
      }, timeoutMs);
      this.pending.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
      this.webview.postMessage({ protocolVersion: 1, kind: 'request', requestId, method, params });
    });
  }
}
