import type { CommandEngine } from '../commands/CommandEngine';
import { BridgeClient, type WebViewLike } from './BridgeClient';
import type { MethodHandler } from './hostServices';
import { validateEnvelope } from '../model/validate';

type Json = Record<string, any>;

/**
 * Connects the engine to the WPF host over chrome.webview messages: answers host requests
 * through `dispatch`, forwards committed events with gap-detectable sequence numbers and
 * announces editor.ready with the current scope.
 */
export function connectHost(
  webview: WebViewLike,
  engine: CommandEngine,
  dispatch: (envelope: Json) => Promise<Json>,
): BridgeClient {
  const client = new BridgeClient(webview);
  let sequence = 0;
  const event = (method: string, payload: Json = {}, revision?: number) => {
    const s = engine.scope();
    webview.postMessage({ protocolVersion: 1, kind: 'event', method, sequence: ++sequence, documentId: s.documentId, sessionId: s.sessionId, revision: revision ?? s.revision, payload });
  };
  engine.onCommitted((e) => event('doc.committed', { committed: e }, e.revision));
  engine.onLifecycle(() => event('doc.opened'));
  webview.addEventListener('message', async ({ data }) => {
    const m = data as Json;
    if (!m || typeof m !== 'object' || m.protocolVersion !== 1) return;
    if (m.kind === 'response') { client.handleResponse(m); return; }
    if (m.kind !== 'request') return;
    const response = await dispatch(m);
    webview.postMessage(response);
  });
  event('editor.ready');
  return client;
}

/** Envelope-level dispatch over a handler table (scope is explicit; params never carry scope). */
export function tableDispatcher(handlers: Record<string, MethodHandler>) {
  return async (m: Json): Promise<Json> => {
    const base = { protocolVersion: 1, kind: 'response', requestId: m.requestId };
    const shape = validateEnvelope(m);
    if (!shape.ok) return { ...base, error: shape.error };
    const handler = handlers[m.method];
    if (!handler) return { ...base, error: { code: 'method_not_found', message: m.method, retryable: false } };
    try {
      const r = await handler({ documentId: m.documentId, sessionId: m.sessionId, ...(m.params?.pageId ? { pageId: m.params.pageId } : {}) }, m.params ?? {});
      return r.ok ? { ...base, documentId: m.documentId, sessionId: m.sessionId, result: r.value ?? {} } : { ...base, error: r.error };
    } catch (e) {
      return { ...base, error: { code: 'internal_error', message: 'handler failed', retryable: false, outcome: 'unknown' } };
    }
  };
}
