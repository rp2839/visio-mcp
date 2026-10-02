import type { CommandEngine } from '../commands/CommandEngine';
import type { DiagramDocument, Scope } from '../model/types';
import type { Result } from '../model/result';
import { err } from '../model/result';

type Json = Record<string, any>;
export type MethodHandler = (scope: Scope, params: Json) => Promise<Result<unknown>>;

/**
 * Host lifecycle methods served by the frontend engine (GUI/host only; never MCP tools).
 * Each is a queued barrier on the engine, so host IO always sees a committed revision.
 */
export function lifecycleHandlers(engine: CommandEngine, hooks: { cancelGestures?: () => void } = {}): Record<string, MethodHandler> {
  return {
    'doc.snapshot': (scope) => engine.snapshot(scope),
    'doc.exportSnapshot': (scope) => engine.exportSnapshot(scope),
    'doc.markSaved': (scope, p) => {
      if (typeof p.revision !== 'number' || typeof p.path !== 'string') return Promise.resolve(err('invalid_request', 'revision and path required'));
      return engine.markSaved(scope, p.revision, p.path);
    },
    'doc.replace': (scope, p) => {
      // Lifecycle barriers cancel uncommitted gestures before replacing state.
      hooks.cancelGestures?.();
      return engine.replaceDocument(p.document as DiagramDocument, { ...scope, baseRevision: p.baseRevision }, { savedRevision: p.savedRevision ?? null, path: p.path ?? null });
    },
  };
}
