/**
 * Frontend half of the WebView2 probe bridge. Message-only: no host objects, no eval.
 * The frontend store owns scope, transaction dedup and revision checks.
 */
type Json = Record<string, any>;
export type BridgeStore = {
  documentId: string;
  sessionId: string;
  revision: () => number;
  applyMove: (target: string, dx: number, dy: number) => string[]; // returns changed ids, commits one revision
  has: (id: string) => boolean;
};
type WebView = { postMessage(m: unknown): void; addEventListener(t: 'message', fn: (e: { data: unknown }) => void): void };

export function installBridge(webview: WebView, store: BridgeStore) {
  const cache = new Map<string, { hash: string; result: Json }>();
  const reply = (requestId: string, body: Json) => webview.postMessage({ protocolVersion: 1, kind: 'response', requestId, ...body });
  const fail = (requestId: string, code: string, message: string, extra: Json = {}) =>
    reply(requestId, { error: { code, message, retryable: code === 'revision_conflict', ...extra } });

  webview.addEventListener('message', ({ data }) => {
    const m = data as Json;
    if (!m || m.kind !== 'request' || m.protocolVersion !== 1 || typeof m.requestId !== 'string') return;
    const { requestId, method, params = {} } = m;
    // Queue head order: scope, then transaction cache, then revision.
    if (m.documentId !== store.documentId) return fail(requestId, 'document_mismatch', 'unknown document');
    if (m.sessionId !== store.sessionId) return fail(requestId, 'session_mismatch', 'stale or unknown session');
    if (method === 'doc.summary') return reply(requestId, { result: { documentId: store.documentId, sessionId: store.sessionId, revision: store.revision() } });
    if (method !== 'doc.apply') return fail(requestId, 'method_not_found', String(method));
    if (params.atomic !== true || typeof params.transactionId !== 'string') return fail(requestId, 'invalid_request', 'atomic transaction required');
    const hash = JSON.stringify([method, store.documentId, store.sessionId, params.baseRevision, params.operations]);
    const cached = cache.get(params.transactionId);
    if (cached) {
      if (cached.hash !== hash) return fail(requestId, 'transaction_id_conflict', 'transactionId reused with a different payload');
      return reply(requestId, { result: cached.result });
    }
    if (params.baseRevision !== store.revision()) return fail(requestId, 'revision_conflict', 'stale baseRevision', { currentRevision: store.revision(), outcome: 'not_applied' });
    const ops = params.operations as Json[];
    if (!Array.isArray(ops) || ops.some((o) => o.op !== 'move' || !store.has(o.target) || !Number.isFinite(o.dx) || !Number.isFinite(o.dy)))
      return fail(requestId, 'invalid_request', 'unsupported operation');
    const previousRevision = store.revision();
    const changed = [...new Set(ops.flatMap((o) => store.applyMove(o.target, o.dx, o.dy)))];
    const result = { transactionId: params.transactionId, previousRevision, revision: store.revision(), changed };
    cache.set(params.transactionId, { hash, result });
    reply(requestId, { result });
  });

  webview.postMessage({ protocolVersion: 1, kind: 'event', method: 'editor.ready', documentId: store.documentId, sessionId: store.sessionId, revision: store.revision() });
}
