import type { Bounds, Element, Page, Projection, Snapshot } from '../model/types';
import { ancestors, indexPage, rotatedAabb } from '../model/geometry';
import { isVisible } from '../canvas/styleMap';
import { heuristicMeasure, wrapLines, type MeasureText } from '../render/text';

export type LayoutIssue = {
  code: 'OUTSIDE_PAGE' | 'PARTLY_OUTSIDE_PAGE' | 'NEAR_ZERO_SIZE' | 'DANGLING_ENDPOINT' | 'GLUED_TO_HIDDEN' | 'IMAGE_DISTORTION' | 'TEXT_OVERFLOW'
    | 'OVERLAP' | 'CONNECTOR_CROSSES_SHAPE' | 'LOW_CONTRAST' | 'HIDDEN_ON_VISIBLE_LAYER';
  severity: 'info' | 'warning' | 'error';
  elementIds: string[];
  pageId: string;
  bounds: Bounds;
  evidence: Record<string, unknown>;
};

const area = (b: Bounds) => Math.max(0, b.width) * Math.max(0, b.height);
function intersect(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width), btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}
function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrastRatio(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function segmentHitsBox(p: { x: number; y: number }, q: { x: number; y: number }, b: Bounds): boolean {
  // Liang–Barsky clipping against the (slightly shrunk) box.
  const inset = 0.5;
  const minX = b.x + inset, minY = b.y + inset, maxX = b.x + b.width - inset, maxY = b.y + b.height - inset;
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  for (const [pp, qq] of [[-dx, p.x - minX], [dx, maxX - p.x], [-dy, p.y - minY], [dy, maxY - p.y]] as const) {
    if (pp === 0) { if (qq < 0) return false; continue; }
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 < t1;
}

/**
 * Diagnostic pass over one immutable snapshot (never mutates). Overlap, crossing and
 * contrast checks are heuristics; text overflow reports whether measurement was exact.
 */
export function inspectLayout(snapshot: Snapshot, projection: Projection, measureText: MeasureText = heuristicMeasure, pageId?: string): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const pages = snapshot.document.pages.filter((p) => !pageId || p.id === pageId);
  const assets = new Map(snapshot.document.assets.map((a) => [a.id, a]));
  for (const page of pages) inspectPage(page, projection, measureText, assets, issues);
  return issues;
}

function inspectPage(page: Page, projection: Projection, measureText: MeasureText, assets: Map<string, any>, issues: LayoutIssue[]) {
  const idx = indexPage(page);
  const pageBox: Bounds = { x: 0, y: 0, width: page.widthPt, height: page.heightPt };
  const add = (i: Omit<LayoutIssue, 'pageId'>) => issues.push({ ...i, pageId: page.id });
  const visual = (e: Element): Bounds => (e.kind === 'connector' ? projection.connectors[e.id]?.visualBounds ?? e.bounds : e.kind === 'group' ? projection.groupVisualBounds[e.id] ?? e.bounds : rotatedAabb(e.bounds, e.rotationDeg));
  const visible = page.elements.filter((e) => isVisible(page, e));
  for (const e of page.elements) {
    if (e.hidden && e.layerIds.every((l) => page.layers.find((x) => x.id === l)?.visible !== false) && e.layerIds.length)
      add({ code: 'HIDDEN_ON_VISIBLE_LAYER', severity: 'info', elementIds: [e.id], bounds: e.bounds, evidence: { layerIds: e.layerIds } });
  }
  for (const e of visible) {
    const v = visual(e);
    const inside = intersect(v, pageBox);
    if (!inside) add({ code: 'OUTSIDE_PAGE', severity: 'error', elementIds: [e.id], bounds: v, evidence: { page: pageBox } });
    else if (area(inside) + 1e-6 < area(v)) add({ code: 'PARTLY_OUTSIDE_PAGE', severity: 'warning', elementIds: [e.id], bounds: v, evidence: { visibleFraction: +(area(inside) / area(v)).toFixed(3) } });
    if (e.kind !== 'connector' && e.kind !== 'group' && (e.bounds.width < 1 || e.bounds.height < 1))
      add({ code: 'NEAR_ZERO_SIZE', severity: 'warning', elementIds: [e.id], bounds: e.bounds, evidence: { widthPt: e.bounds.width, heightPt: e.bounds.height } });
    if (e.kind === 'connector') {
      for (const end of ['from', 'to'] as const) {
        const ep = e[end];
        if (!ep.elementId) add({ code: 'DANGLING_ENDPOINT', severity: 'warning', elementIds: [e.id], bounds: v, evidence: { end, point: ep.point } });
        else {
          const t = idx.byId.get(ep.elementId);
          if (t && !isVisible(page, t)) add({ code: 'GLUED_TO_HIDDEN', severity: 'warning', elementIds: [e.id, t.id], bounds: v, evidence: { end } });
        }
      }
      const route = projection.connectors[e.id]?.routePoints ?? [];
      const exempt = new Set([e.from.elementId, e.to.elementId, ...ancestors(idx, e.from.elementId ?? ''), ...ancestors(idx, e.to.elementId ?? ''), ...ancestors(idx, e.id)].filter(Boolean) as string[]);
      for (const s of visible) {
        if (s.kind === 'connector' || s.kind === 'group' || exempt.has(s.id)) continue;
        const box = rotatedAabb(s.bounds, s.rotationDeg);
        if (route.some((p, i) => i > 0 && segmentHitsBox(route[i - 1], p, box)))
          add({ code: 'CONNECTOR_CROSSES_SHAPE', severity: 'warning', elementIds: [e.id, s.id], bounds: box, evidence: { heuristic: 'route segment intersects shape bounds' } });
      }
    }
    if (e.kind === 'image') {
      const a = assets.get(e.assetId);
      if (a?.widthPx && a?.heightPx && (e.fit === 'stretch' || !e.preserveAspectRatio)) {
        const want = a.widthPx / a.heightPx, have = e.bounds.width / e.bounds.height;
        if (Math.abs(have / want - 1) > 0.02) add({ code: 'IMAGE_DISTORTION', severity: 'warning', elementIds: [e.id], bounds: e.bounds, evidence: { assetAspect: +want.toFixed(4), boxAspect: +have.toFixed(4) } });
      }
    }
    const tb = e.kind === 'shape' || e.kind === 'text' ? e.text : e.kind === 'connector' ? undefined : undefined;
    if (tb && tb.value && (e.kind === 'shape' || e.kind === 'text')) {
      const font = { family: tb.fontFamily, sizePt: tb.fontSizePt, bold: tb.bold, italic: tb.italic };
      let exact = true;
      const measure = (s: string) => { const m = measureText(s, font); exact &&= m.exact; return m.width; };
      const innerW = e.bounds.width - 2 * tb.paddingPt, innerH = e.bounds.height - 2 * tb.paddingPt;
      const lines = wrapLines(tb.value, innerW, tb.wrap, measure);
      const width = Math.max(...lines.map(measure)), height = lines.length * tb.fontSizePt * 1.2;
      if (width > innerW + 0.5 || height > innerH + 0.5)
        add({ code: 'TEXT_OVERFLOW', severity: 'warning', elementIds: [e.id], bounds: e.bounds, evidence: { lines: lines.length, neededWidthPt: +width.toFixed(1), neededHeightPt: +height.toFixed(1), measurement: exact ? 'font metrics' : 'approximate (font fallback or heuristic)' } });
      const fill = e.style.fill;
      if (fill !== 'none' && /^#[0-9A-Fa-f]{6}/.test(tb.colour)) {
        const ratio = contrastRatio(tb.colour.slice(0, 7), fill.slice(0, 7));
        if (ratio < 3) add({ code: 'LOW_CONTRAST', severity: 'info', elementIds: [e.id], bounds: e.bounds, evidence: { ratio: +ratio.toFixed(2), heuristic: 'WCAG luminance ratio; not an accessibility certification' } });
      }
    }
  }
  // Overlaps between non-container box elements, excluding group containment.
  const boxes = visible.filter((e) => e.kind === 'shape' || e.kind === 'image' || e.kind === 'text');
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const hit = intersect(rotatedAabb(a.bounds, a.rotationDeg), rotatedAabb(b.bounds, b.rotationDeg));
      if (hit && area(hit) > 1) add({ code: 'OVERLAP', severity: 'warning', elementIds: [a.id, b.id], bounds: hit, evidence: { areaPt2: +area(hit).toFixed(1), heuristic: 'axis-aligned visual bounds' } });
    }
}
