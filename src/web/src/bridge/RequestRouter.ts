import type { CommandEngine, ScriptCompiler } from '../commands/CommandEngine';
import type { AppError, Scope } from '../model/types';
import { err, ok, type Result } from '../model/result';
import { validateEnvelope } from '../model/validate';
import { readObjects, readSummary } from './readTools';

type Json = Record<string, any>;
export type Envelope = { protocolVersion: 1; kind: 'request'; requestId: string; method: string; documentId?: string; sessionId?: string; params: Json; origin?: { source: string; clientLabel?: string; connectionId?: string } };
export type Response = { protocolVersion: 1; kind: 'response'; requestId: string; documentId?: string; sessionId?: string; result?: unknown; error?: AppError };
export type MethodImpl = (scope: Scope, params: Json, envelope: Envelope) => Promise<Result<unknown>>;

export const MUTATION_METHODS = new Set(['doc.apply', 'doc.executeScript']);
/** Host lifecycle methods are GUI/host only: never reachable from MCP. */
export const LIFECYCLE_METHODS = new Set(['doc.snapshot', 'doc.exportSnapshot', 'doc.markSaved', 'doc.replace']);

/**
 * Routes validated envelopes to the engine. Scope lives at the envelope top level; params
 * must not repeat it. Mutations go through engine.execute/executeScript (source "mcp"),
 * which applies the queue-head scope → cache → revision order.
 */
export class RequestRouter {
  private readonly methods = new Map<string, MethodImpl>();

  constructor(private readonly engine: CommandEngine, compile: ScriptCompiler, extra: Record<string, MethodImpl> = {}) {
    this.methods.set('app.current', async () => {
      const s = engine.current();
      return ok({ documentId: s.documentId, sessionId: s.sessionId, revision: s.revision, pages: s.document.pages.map((p) => ({ id: p.id, name: p.name })) });
    });
    this.methods.set('doc.summary', async (scope, p) => {
      const s = await engine.snapshot(scope);
      return s.ok ? ok(readSummary(s.value, { pageId: p.pageId, includeGeometry: p.includeGeometry, includeStyle: p.includeStyle, includeHidden: p.includeHidden })) : s;
    });
    this.methods.set('doc.getObjects', async (scope, p) => {
      if (!Array.isArray(p.ids) || p.ids.some((x: unknown) => typeof x !== 'string')) return err('invalid_request', 'ids must be a string array');
      const s = await engine.snapshot(scope);
      if (!s.ok) return s;
      const objects = readObjects(s.value, p.ids);
      return objects.ok ? ok({ documentId: s.value.documentId, sessionId: s.value.sessionId, revision: s.value.revision, objects: objects.value }) : objects;
    });
    this.methods.set('doc.apply', (scope, p) => engine.execute({
      ...scope, transactionId: p.transactionId, baseRevision: p.baseRevision, operations: p.operations,
      ...(p.atomic !== undefined ? { atomic: p.atomic } : {}), ...(p.description ? { description: p.description } : {}),
    }, 'mcp'));
    this.methods.set('doc.executeScript', (scope, p) => engine.executeScript({
      ...scope, transactionId: p.transactionId, baseRevision: p.baseRevision, script: p.script,
      ...(p.atomic !== undefined ? { atomic: p.atomic } : {}), ...(p.preparedAssetRefs ? { preparedAssetRefs: p.preparedAssetRefs } : {}),
    }, compile));
    this.methods.set('doc.getChanges', (scope, p) => {
      if (!Number.isInteger(p.sinceRevision) || p.sinceRevision < 0) return Promise.resolve(err('invalid_request', 'sinceRevision must be a non-negative integer'));
      return engine.getChanges(scope, p.sinceRevision);
    });
    for (const [k, v] of Object.entries(extra)) this.methods.set(k, v);
  }

  register(method: string, impl: MethodImpl) { this.methods.set(method, impl); }

  async dispatch(m: Envelope): Promise<Response> {
    const base = { protocolVersion: 1 as const, kind: 'response' as const, requestId: m?.requestId ?? '' };
    const shape = validateEnvelope(m);
    if (!shape.ok) return { ...base, error: { ...shape.error, outcome: 'not_applied' } };
    if (LIFECYCLE_METHODS.has(m.method) && m.origin?.source === 'mcp') return { ...base, error: { code: 'method_not_found', message: `${m.method} is not available to MCP clients`, retryable: false } };
    const impl = this.methods.get(m.method);
    if (!impl) return { ...base, error: { code: 'method_not_found', message: m.method, retryable: false } };
    const scope: Scope = { documentId: m.documentId!, sessionId: m.sessionId!, ...(m.params?.pageId ? { pageId: m.params.pageId } : {}) };
    try {
      const r = await impl(scope, m.params ?? {}, m);
      return r.ok ? { ...base, documentId: m.documentId, sessionId: m.sessionId, result: r.value } : { ...base, error: r.error };
    } catch {
      return { ...base, error: { code: 'internal_error', message: 'request failed', retryable: false, outcome: MUTATION_METHODS.has(m.method) ? 'unknown' : 'not_applied' } };
    }
  }
}
