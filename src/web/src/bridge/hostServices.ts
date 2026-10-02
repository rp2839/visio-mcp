import type { CommandEngine } from '../commands/CommandEngine';
import type { DiagramDocument, Scope } from '../model/types';
import type { Result } from '../model/result';
import { err, ok } from '../model/result';
import type { AssetResolver } from '../editor/assets';
import { restoreRecovery, type RecoveryCandidateDto } from '../commands/recovery';
import { newDocument } from '../model/defaults';

type Json = Record<string, any>;
export type MethodHandler = (scope: Scope, params: Json, envelope?: unknown) => Promise<Result<unknown>>;

/**
 * Host lifecycle methods served by the frontend engine (GUI/host only; never MCP tools).
 * Each is a queued barrier on the engine, so host IO always sees a committed revision.
 */
export function lifecycleHandlers(engine: CommandEngine, hooks: { cancelGestures?: () => void; assets?: AssetResolver } = {}): Record<string, MethodHandler> {
  return {
    'doc.snapshot': (scope) => engine.snapshot(scope),
    'doc.exportSnapshot': (scope) => engine.exportSnapshot(scope),
    'doc.markSaved': (scope, p) => {
      if (typeof p.revision !== 'number' || typeof p.path !== 'string') return Promise.resolve(err('invalid_request', 'revision and path required'));
      return engine.markSaved(scope, p.revision, p.path);
    },
    // Dirty check for File → Close; the snapshot barrier orders it after queued commits.
    'doc.status': async (scope) => {
      const snap = await engine.snapshot(scope);
      return snap.ok ? ok({ revision: snap.value.revision, dirty: engine.isDirty() }) : snap;
    },
    // File → Close: publish a new, clean, untitled document under a new session.
    'doc.new': (scope, p) => {
      if (typeof p.baseRevision !== 'number') return Promise.resolve(err('invalid_request', 'baseRevision required'));
      hooks.cancelGestures?.();
      return engine.replaceDocument(newDocument(crypto.randomUUID(), crypto.randomUUID()), { ...scope, baseRevision: p.baseRevision }, { savedRevision: 0, path: null });
    },
    'doc.replace': (scope, p) => {
      // Lifecycle barriers cancel uncommitted gestures before replacing state.
      hooks.cancelGestures?.();
      return engine.replaceDocument(p.document as DiagramDocument, { ...scope, baseRevision: p.baseRevision }, { savedRevision: p.savedRevision ?? null, path: p.path ?? null });
    },
    // Restore the last durable state after a crash: validated replay, then a new dirty session.
    'recovery.restore': (scope, p) => {
      const restored = restoreRecovery(p.candidate as RecoveryCandidateDto);
      if (!restored.ok) return Promise.resolve(restored);
      hooks.cancelGestures?.();
      return engine.replaceDocument(restored.value, { ...scope, baseRevision: p.baseRevision }, { savedRevision: null, path: null });
    },
    // PNG derivative of an SVG asset for VSDX export (Visio pictures need raster bytes).
    'asset.rasterize': async (scope, p) => {
      if (!hooks.assets) return err('internal_error', 'no asset resolver');
      if (typeof p.sha256 !== 'string') return err('invalid_request', 'sha256 required');
      const snap = await engine.snapshot(scope);
      if (!snap.ok) return snap;
      const asset = snap.value.document.assets.find((a) => a.sha256 === p.sha256 && a.mimeType === 'image/svg+xml');
      if (!asset) return err('not_found', 'no SVG asset with that hash in this document');
      const url = await hooks.assets.dataUrlFor(asset);
      if (!url) return err('not_found', 'asset bytes unavailable');
      return rasterize(url, asset.widthPx ?? 512, asset.heightPx ?? 512);
    },
  };
}

const MAX_SIDE = 4096;

async function rasterize(dataUrl: string, w: number, h: number): Promise<Result<{ mimeType: 'image/png'; data: string; widthPx: number; heightPx: number }>> {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h)) * Math.min(4, Math.max(1, 1024 / Math.max(w, h)));
  const widthPx = Math.max(1, Math.round(w * scale)), heightPx = Math.max(1, Math.round(h * scale));
  const img = new Image();
  img.src = dataUrl;
  try { await img.decode(); } catch { return err('invalid_request', 'SVG could not be decoded'); }
  const canvas = document.createElement('canvas');
  canvas.width = widthPx; canvas.height = heightPx;
  canvas.getContext('2d')!.drawImage(img, 0, 0, widthPx, heightPx);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) return err('internal_error', 'encoding failed');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return ok({ mimeType: 'image/png', data: btoa(bin), widthPx, heightPx });
}
