import type { Element, Snapshot } from '../model/types';
import { err, ok, type Result } from '../model/result';
import { SnapshotProjector } from '../canvas/SnapshotProjector';
import { isVisible } from '../canvas/styleMap';

export type SummaryOptions = { pageId?: string; includeGeometry?: boolean; includeStyle?: boolean; includeHidden?: boolean };

/** Compact semantic summary (get_document_summary). Derived connector extents are labelled as visualBounds. */
export function readSummary(snapshot: Snapshot, options: SummaryOptions = {}) {
  const { includeGeometry = true, includeStyle = false, includeHidden = false } = options;
  const doc = snapshot.document;
  const projection = new SnapshotProjector().project(snapshot);
  const pages = options.pageId ? doc.pages.filter((p) => p.id === options.pageId || p.name === options.pageId) : doc.pages;
  const referenced = new Set<string>();
  const elements: Record<string, unknown>[] = [];
  for (const page of pages) {
    for (const e of page.elements) {
      if (!includeHidden && !isVisible(page, e)) continue;
      const o: Record<string, unknown> = { id: e.id, kind: e.kind, pageId: page.id, zIndex: e.zIndex };
      if (e.alias) o.alias = e.alias;
      if (e.name) o.name = e.name;
      if (e.layerIds.length) o.layerIds = e.layerIds;
      if (e.locked) o.locked = true;
      if (e.hidden) o.hidden = true;
      if (includeGeometry) {
        o.bounds = e.bounds;
        if (e.rotationDeg) o.rotationDeg = e.rotationDeg;
      }
      if (e.kind === 'shape') { o.preset = e.geometry.preset; if (e.text?.value) o.text = e.text.value; }
      if (e.kind === 'text') o.text = e.text.value;
      if (e.kind === 'image') { o.assetId = e.assetId; referenced.add(e.assetId); }
      if (e.kind === 'group') o.childIds = e.childIds;
      if (e.kind === 'connector') {
        o.from = e.from; o.to = e.to; o.route = e.route;
        if (e.label?.value) o.text = e.label.value;
        if (includeGeometry && projection.ok && projection.value.connectors[e.id]) o.visualBounds = projection.value.connectors[e.id].visualBounds;
      }
      if (includeStyle && 'style' in e) o.style = (e as any).style;
      elements.push(o);
    }
  }
  return {
    documentId: snapshot.documentId, sessionId: snapshot.sessionId, revision: snapshot.revision, title: doc.title,
    pages: doc.pages.map((p) => ({
      id: p.id, name: p.name, widthPt: p.widthPt, heightPt: p.heightPt, elementCount: p.elements.length,
      layers: p.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked, printable: l.printable })),
    })),
    elements,
    assetIds: [...referenced],
  };
}

export function readObjects(snapshot: Snapshot, ids: string[]): Result<Element[]> {
  const all = new Map(snapshot.document.pages.flatMap((p) => p.elements.map((e) => [e.id, e] as const)));
  const missing = ids.filter((id) => !all.has(id));
  if (missing.length) return err('not_found', `unknown element id(s): ${missing.join(', ')}`, { missing });
  return ok(ids.map((id) => all.get(id)!));
}
