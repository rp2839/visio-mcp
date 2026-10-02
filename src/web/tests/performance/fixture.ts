import { defaultLineStyle, defaultShapeStyle, defaultText, newDocument, newPage } from '../../src/model/defaults';
import type { DiagramDocument, Element } from '../../src/model/types';

export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * Reproducible benchmark document: `pages` pages, each with `perPage` visible elements
 * (90 % shapes in a grid, 10 % connectors gluing neighbours).
 */
export function benchmarkDocument(pages = 10, perPage = 500): DiagramDocument {
  const doc = newDocument(uuid(1), uuid(2), 'Benchmark');
  doc.pages = [];
  let n = 0x10000;
  for (let p = 0; p < pages; p++) {
    const page = newPage(p === 0 ? uuid(2) : uuid(0x100 + p), `Page-${p + 1}`);
    page.widthPt = 2400; page.heightPt = 1700;
    const shapes = Math.round(perPage * 0.9);
    const elements: Element[] = [];
    for (let i = 0; i < shapes; i++) {
      elements.push({
        id: uuid(n++), kind: 'shape', alias: `s${i}`, layerIds: [], zIndex: i, locked: false, hidden: false,
        bounds: { x: 20 + (i % 25) * 92, y: 20 + Math.floor(i / 25) * 80, width: 80, height: 50 }, rotationDeg: 0, metadata: {},
        geometry: { preset: i % 3 === 0 ? 'ellipse' : 'roundedRect', cornerRadiusPt: 4 }, style: defaultShapeStyle(), text: defaultText(`Node ${i}`),
      });
    }
    for (let i = 0; i < perPage - shapes; i++) {
      const a = elements[i * 2], b = elements[i * 2 + 1];
      const x = Math.min(a.bounds.x, b.bounds.x), y = Math.min(a.bounds.y, b.bounds.y);
      const bounds = { x, y, width: Math.max(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - x, height: Math.max(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) - y };
      elements.push({
        id: uuid(n++), kind: 'connector', layerIds: [], zIndex: shapes + i, locked: false, hidden: false, rotationDeg: 0, metadata: {}, bounds,
        from: { elementId: a.id, glue: 'dynamic' }, to: { elementId: b.id, glue: 'dynamic' }, waypoints: [], route: 'orthogonal', style: defaultLineStyle(),
      });
    }
    page.elements = elements;
    doc.pages.push(page);
  }
  return doc;
}
