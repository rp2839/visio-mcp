import type { Asset, DiagramDocument, Element, EntityChange, Page } from '../model/types';
import { canonicalOf, canonicalSerialize } from '../model/canonical';

type PageHeader = Omit<Page, 'elements'>;
type DocHeader = { schemaVersion: 1; title: string; metadata: Record<string, string>; source?: DiagramDocument['source']; pageOrder: string[]; assetOrder: string[] };

const pageHeader = ({ elements: _e, ...rest }: Page): PageHeader => rest;
const docHeader = (d: DiagramDocument): DocHeader => ({
  schemaVersion: 1, title: d.title, metadata: d.metadata, ...(d.source ? { source: d.source } : {}),
  pageOrder: d.pages.map((p) => p.id), assetOrder: d.assets.map((a) => a.id),
});

const elementMaps = new WeakMap<DiagramDocument, Map<string, { pageId: string; element: Element }>>();
export function elementMap(doc: DiagramDocument) {
  let m = elementMaps.get(doc);
  if (!m) {
    m = new Map();
    for (const p of doc.pages) for (const e of p.elements) m.set(e.id, { pageId: p.id, element: e });
    elementMaps.set(doc, m);
  }
  return m;
}

const same = (a: object, b: object) => a === b || canonicalOf(a) === canonicalSerialize(b);

/**
 * Resolved entity-level diff. Only touched element ids (plus id-set differences) are
 * compared, so untouched elements are never reported even though the candidate is a clone.
 */
export function computeChanges(before: DiagramDocument, after: DiagramDocument, touched?: Set<string>): EntityChange[] {
  const changes: EntityChange[] = [];
  const bh = docHeader(before), ah = docHeader(after);
  if (canonicalSerialize(bh) !== canonicalSerialize(ah)) changes.push({ entity: 'document', id: before.id, before: bh, after: ah });

  const bPages = new Map(before.pages.map((p) => [p.id, p]));
  const aPages = new Map(after.pages.map((p) => [p.id, p]));
  for (const [id, p] of bPages) {
    const a = aPages.get(id);
    const bhh = pageHeader(p);
    if (!a) changes.push({ entity: 'page', id, before: bhh, after: null });
    else if (canonicalSerialize(bhh) !== canonicalSerialize(pageHeader(a))) changes.push({ entity: 'page', id, before: bhh, after: pageHeader(a) });
  }
  for (const [id, a] of aPages) if (!bPages.has(id)) changes.push({ entity: 'page', id, before: null, after: pageHeader(a) });

  const bEl = elementMap(before), aEl = elementMap(after);
  const ids = new Set<string>(touched ?? []);
  if (!touched) { for (const id of bEl.keys()) ids.add(id); for (const id of aEl.keys()) ids.add(id); }
  for (const id of bEl.keys()) if (!aEl.has(id)) ids.add(id);
  for (const id of aEl.keys()) if (!bEl.has(id)) ids.add(id);
  for (const id of ids) {
    const b = bEl.get(id), a = aEl.get(id);
    if (!b && !a) continue;
    if (b && a && b.pageId === a.pageId && same(b.element, a.element)) continue;
    changes.push({ entity: 'element', id, pageId: (a ?? b)!.pageId, before: (b?.element ?? null) as any, after: (a?.element ?? null) as any });
  }

  const bA = new Map(before.assets.map((x) => [x.id, x]));
  const aA = new Map(after.assets.map((x) => [x.id, x]));
  for (const [id, x] of bA) {
    const y = aA.get(id);
    if (!y || !same(x, y)) changes.push({ entity: 'asset', id, before: x as any, after: (y ?? null) as any });
  }
  for (const [id, y] of aA) if (!bA.has(id)) changes.push({ entity: 'asset', id, before: null, after: y as any });
  return changes;
}

/** Applies resolved changes deterministically (forward = after values, inverse = before values). */
export function applyChanges(doc: DiagramDocument, changes: EntityChange[], direction: 'forward' | 'inverse'): DiagramDocument {
  const val = (c: EntityChange) => (direction === 'forward' ? c.after : c.before) as any;
  const pages = new Map(doc.pages.map((p) => [p.id, { ...p, elements: [...p.elements] }]));
  let assets = [...doc.assets];
  let header: DocHeader | null = null;
  for (const c of changes) {
    const v = val(c);
    if (c.entity === 'document') header = v;
    else if (c.entity === 'page') {
      if (v === null) pages.delete(c.id);
      else pages.set(c.id, { ...v, elements: pages.get(c.id)?.elements ?? [] });
    }
  }
  for (const c of changes) {
    if (c.entity === 'element') {
      for (const p of pages.values()) {
        const i = p.elements.findIndex((e) => e.id === c.id);
        if (i >= 0) p.elements.splice(i, 1);
      }
      const v = val(c);
      if (v !== null) {
        const page = pages.get(c.pageId!);
        if (!page) throw new Error(`page ${c.pageId} missing while applying change`);
        page.elements.push(v);
      }
    } else if (c.entity === 'asset') {
      const v = val(c) as Asset | null;
      const i = assets.findIndex((a) => a.id === c.id);
      if (v === null) { if (i >= 0) assets.splice(i, 1); }
      else if (i >= 0) assets[i] = v;
      else assets.push(v);
    }
  }
  for (const p of pages.values()) p.elements.sort((a, b) => a.zIndex - b.zIndex);
  const order = header?.pageOrder ?? doc.pages.map((p) => p.id).filter((id) => pages.has(id));
  const extra = [...pages.keys()].filter((id) => !order.includes(id));
  const nextPages = [...order, ...extra].map((id) => pages.get(id)!).filter(Boolean);
  if (header) {
    const ao = header.assetOrder;
    assets = [...assets].sort((a, b) => ao.indexOf(a.id) - ao.indexOf(b.id));
  }
  const next: DiagramDocument = { ...doc, pages: nextPages, assets };
  if (header) {
    next.title = header.title;
    next.metadata = header.metadata;
    if (header.source) next.source = header.source; else delete next.source;
  }
  return next;
}

export function invert(changes: EntityChange[]): EntityChange[] {
  return changes.map((c) => ({ ...c, before: c.after, after: c.before }));
}
