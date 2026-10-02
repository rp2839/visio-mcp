import type { Bounds, Projection, Snapshot } from '../model/types';
import { ok, type Result } from '../model/result';
import { indexPage, rotatedAabb, union, descendants } from '../model/geometry';
import { pageElementMap, routeBounds, routeConnector } from './routing';

/**
 * Pure snapshot projector (I12): computes connector routes/visual bounds and group visual
 * frames from one immutable committed snapshot. Never reads live canvas preview cells, so an
 * export during an active drag still reports committed geometry. Registered via
 * engine.setSnapshotProjector and reused by the offscreen renderer.
 */
export class SnapshotProjector {
  project(snapshot: Snapshot): Result<Projection> {
    const connectors: Projection['connectors'] = {};
    const groupVisualBounds: Record<string, Bounds> = {};
    for (const page of snapshot.document.pages) {
      const byId = pageElementMap(page);
      for (const e of page.elements) {
        if (e.kind !== 'connector') continue;
        const routePoints = routeConnector(byId, e);
        connectors[e.id] = { routePoints, visualBounds: routeBounds(routePoints, e.style.strokeWidthPt) };
      }
      const idx = indexPage(page);
      for (const e of page.elements) {
        if (e.kind !== 'group') continue;
        let acc: Bounds | null = null;
        for (const d of descendants(idx, e.id)) {
          const el = idx.byId.get(d);
          if (!el || el.kind === 'group') continue;
          const b = el.kind === 'connector' ? connectors[el.id]?.visualBounds : rotatedAabb(el.bounds, el.rotationDeg);
          if (b) acc = acc ? union(acc, b) : b;
        }
        if (acc) groupVisualBounds[e.id] = acc;
      }
    }
    return ok({ documentId: snapshot.documentId, sessionId: snapshot.sessionId, revision: snapshot.revision, ...(snapshot.pageId ? { pageId: snapshot.pageId } : {}), connectors, groupVisualBounds });
  }
}
