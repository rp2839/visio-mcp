import type { Diagnostic, DiagramDocument, Element, Page, PreparedAssetRef } from '../model/types';
import { fail } from '../model/result';
import { indexPage, deriveGroupBounds, type PageIndex } from '../model/geometry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string) => UUID.test(s);

export type DraftContext = {
  /** Batch page context for alias/name targets ("page use" in scripts). */
  pageId?: string;
  newUuid: () => string;
  preparedAssetRefs?: Record<string, PreparedAssetRef>;
};

type Loc = { page: Page; element: Element };

/**
 * Mutable candidate state for one transaction. The committed document is deep-cloned once;
 * operations mutate the clone in order (earlier creates are visible to later operations);
 * the engine validates and diffs the final candidate before publishing it.
 */
export class Draft {
  readonly doc: DiagramDocument;
  readonly warnings: Diagnostic[] = [];
  /** alias → UUID for elements created in this batch (reported in the result). */
  readonly createdAliases: Record<string, string> = {};
  /** Element ids inserted, replaced or removed (diffing compares only these plus id-set changes). */
  readonly touched = new Set<string>();
  private locs = new Map<string, Loc>();
  private pageIndexes = new Map<string, PageIndex>();

  constructor(committed: DiagramDocument, readonly ctx: DraftContext) {
    this.doc = structuredClone(committed);
    this.reindex();
  }

  reindex() {
    this.locs.clear();
    this.pageIndexes.clear();
    for (const page of this.doc.pages) for (const element of page.elements) this.locs.set(element.id, { page, element });
  }

  invalidatePage(page: Page) {
    this.pageIndexes.delete(page.id);
  }

  pageIndex(page: Page): PageIndex {
    let idx = this.pageIndexes.get(page.id);
    if (!idx) {
      idx = indexPage(page);
      this.pageIndexes.set(page.id, idx);
    }
    return idx;
  }

  newUuid(): string {
    const id = this.ctx.newUuid();
    if (!isUuid(id)) fail('internal_error', `uuid factory produced ${id}`);
    return id;
  }

  // ---------- pages ----------
  findPage(ref: string): Page | undefined {
    return this.doc.pages.find((p) => p.id === ref) ?? this.doc.pages.find((p) => p.name === ref);
  }

  page(ref: string | undefined): Page {
    const r = ref ?? this.ctx.pageId;
    if (r === undefined) {
      if (this.doc.pages.length === 1) return this.doc.pages[0];
      fail('invalid_request', 'pageId is required when the document has several pages');
    }
    const named = this.doc.pages.filter((p) => p.id === r || p.name === r);
    if (named.length > 1) fail('ambiguous_target', `page name "${r}" is ambiguous`, { candidates: named.map((p) => p.id) });
    if (!named[0]) fail('not_found', `page ${r} not found`);
    return named[0];
  }

  contextPage(): Page | undefined {
    return this.ctx.pageId !== undefined ? this.page(this.ctx.pageId) : undefined;
  }

  // ---------- elements ----------
  has(id: string) {
    return this.locs.has(id);
  }

  loc(id: string): Loc {
    const l = this.locs.get(id);
    if (!l) fail('not_found', `element ${id} not found`);
    return l;
  }

  get(id: string): Element {
    return this.loc(id).element;
  }

  /**
   * D2 resolution: UUID first, then exact page-scoped alias, then exact display name.
   * Without batch page scope only UUIDs are accepted. Ambiguous names return candidates.
   */
  resolve(target: string): string {
    if (isUuid(target)) {
      if (!this.locs.has(target)) fail('not_found', `element ${target} not found`);
      return target;
    }
    const page = this.contextPage();
    if (!page) fail('invalid_request', `target "${target}" is not a UUID; alias/name targets need a batch pageId`, { target });
    const byAlias = page.elements.filter((e) => e.alias === target);
    if (byAlias.length === 1) return byAlias[0].id;
    const byName = page.elements.filter((e) => e.name === target);
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) fail('ambiguous_target', `name "${target}" matches ${byName.length} elements`, { target, candidates: byName.map((e) => e.id) });
    fail('not_found', `no element with alias or name "${target}" on page ${page.name}`, { target });
  }

  resolveAll(targets: string[]): string[] {
    const ids = targets.map((t) => this.resolve(t));
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) fail('invalid_request', `target ${id} listed twice`);
      seen.add(id);
    }
    return ids;
  }

  samePage(ids: string[]): Page {
    const page = this.loc(ids[0]).page;
    for (const id of ids) if (this.loc(id).page !== page) fail('invalid_request', 'selection spans several pages', { targets: ids });
    return page;
  }

  insertElement(page: Page, element: Element) {
    if (this.locs.has(element.id)) fail('invalid_request', `element id ${element.id} already exists`);
    page.elements.push(element);
    this.touched.add(element.id);
    this.locs.set(element.id, { page, element });
    this.invalidatePage(page);
  }

  replaceElement(next: Element) {
    const { page } = this.loc(next.id);
    const i = page.elements.findIndex((e) => e.id === next.id);
    page.elements[i] = next;
    this.touched.add(next.id);
    this.locs.set(next.id, { page, element: next });
    this.invalidatePage(page);
  }

  removeElement(id: string) {
    const { page } = this.loc(id);
    page.elements = page.elements.filter((e) => e.id !== id);
    this.touched.add(id);
    this.locs.delete(id);
    this.invalidatePage(page);
  }

  nextZ(page: Page): number {
    let max = -1;
    for (const e of page.elements) if (e.zIndex > max) max = e.zIndex;
    return max + 1;
  }

  /** Locked if the element or any assigned layer is locked (conservative multi-layer policy). */
  isLocked(id: string): boolean {
    const { page, element } = this.loc(id);
    if (element.locked) return true;
    return element.layerIds.some((l) => page.layers.find((x) => x.id === l)?.locked);
  }

  assertUnlocked(ids: Iterable<string>) {
    for (const id of ids) if (this.isLocked(id)) fail('locked_target', `element ${id} is locked`, { elementId: id });
  }

  resolveLayer(page: Page, ref: string) {
    const byId = page.layers.find((l) => l.id === ref);
    if (byId) return byId;
    const byName = page.layers.filter((l) => l.name === ref);
    if (byName.length > 1) fail('ambiguous_target', `layer name "${ref}" is ambiguous`, { candidates: byName.map((l) => l.id) });
    if (!byName[0]) fail('not_found', `layer ${ref} not found on page ${page.name}`);
    return byName[0];
  }

  parentOf(id: string): string | undefined {
    return this.pageIndex(this.loc(id).page).parentOf.get(id);
  }

  /** Recomputes every group's canonical bounds bottom-up (R4). */
  normaliseGroups() {
    for (const page of this.doc.pages) {
      if (!page.elements.some((e) => e.kind === 'group')) continue;
      this.invalidatePage(page);
      const idx = this.pageIndex(page);
      const done = new Set<string>();
      const visit = (id: string, stack: Set<string>) => {
        if (done.has(id) || stack.has(id)) return;
        const g = idx.byId.get(id);
        if (!g || g.kind !== 'group') return;
        stack.add(id);
        for (const c of g.childIds) visit(c, stack);
        const b = deriveGroupBounds(idx, id);
        if (b && (b.x !== g.bounds.x || b.y !== g.bounds.y || b.width !== g.bounds.width || b.height !== g.bounds.height)) {
          const next = { ...g, bounds: b };
          this.replaceElement(next);
          idx.byId.set(id, next);
        }
        done.add(id);
      };
      for (const e of page.elements) if (e.kind === 'group') visit(e.id, new Set());
    }
  }

  /** Canonical element order: ascending zIndex. */
  sortElements() {
    for (const page of this.doc.pages) page.elements.sort((a, b) => a.zIndex - b.zIndex);
  }
}
