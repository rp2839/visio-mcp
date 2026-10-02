import type { CommandEngine } from '../commands/CommandEngine';
import { err, ok } from '../model/result';
import { SnapshotProjector } from '../canvas/SnapshotProjector';
import { renderSnapshot } from '../render/renderRegion';
import { inspectLayout } from '../layout/inspectLayout';
import { canvasMeasure } from '../render/text';
import type { AssetResolver } from '../editor/assets';
import type { MethodImpl } from './RequestRouter';

/** Render and layout methods operate on a queued snapshot, never on live canvas state. */
export function renderMethods(engine: CommandEngine, assets: AssetResolver): Record<string, MethodImpl> {
  const projector = new SnapshotProjector();
  return {
    'doc.render': async (scope, p) => {
      const snap = await engine.snapshot(scope);
      if (!snap.ok) return snap;
      const page = snap.value.document.pages.find((x) => x.id === p.pageId || x.name === p.pageId);
      if (!page) return err('not_found', `page ${p.pageId} not found`);
      const used = new Set(page.elements.flatMap((e) => (e.kind === 'image' ? [e.assetId] : [])));
      const data = new Map<string, string>();
      for (const a of snap.value.document.assets.filter((x) => used.has(x.id))) {
        const url = await assets.dataUrlFor(a);
        if (url) data.set(a.sha256, url);
      }
      const projection = projector.project(snap.value);
      if (!projection.ok) return projection;
      if (p.format && p.format !== 'png' && p.format !== 'jpeg') return err('invalid_request', 'format must be png or jpeg');
      if (p.mode && p.mode !== 'clean' && p.mode !== 'debug') return err('invalid_request', 'mode must be clean or debug');
      return renderSnapshot(snap.value, projection.value, data, {
        pageId: page.id, format: p.format, mode: p.mode, maxWidth: p.maxWidth, maxHeight: p.maxHeight,
        ...(p.region ? { region: { bounds: p.region.bounds ?? undefined, elementIds: p.region.elementIds ?? undefined, paddingPt: p.region.paddingPt } } : {}),
      });
    },
    'doc.inspectLayout': async (scope, p) => {
      const snap = await engine.snapshot(scope);
      if (!snap.ok) return snap;
      const projection = projector.project(snap.value);
      if (!projection.ok) return projection;
      const issues = inspectLayout(snap.value, projection.value, canvasMeasure(), p.pageId);
      return ok({ documentId: snap.value.documentId, sessionId: snap.value.sessionId, revision: snap.value.revision, issues });
    },
  };
}
