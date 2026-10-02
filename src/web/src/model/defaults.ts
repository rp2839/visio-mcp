import type { DiagramDocument, LineStyle, Page, ShapeStyle, TextBlock } from './types';

export const A4_LANDSCAPE = { widthPt: 297 * 72 / 25.4, heightPt: 210 * 72 / 25.4 } as const;

export const PAGE_PRESETS: Record<string, { widthPt: number; heightPt: number }> = {
  'A4 landscape': A4_LANDSCAPE,
  'A4 portrait': { widthPt: A4_LANDSCAPE.heightPt, heightPt: A4_LANDSCAPE.widthPt },
  'A3 landscape': { widthPt: 420 * 72 / 25.4, heightPt: 297 * 72 / 25.4 },
  'A3 portrait': { widthPt: 297 * 72 / 25.4, heightPt: 420 * 72 / 25.4 },
  Letter: { widthPt: 8.5 * 72, heightPt: 11 * 72 },
};

export const defaultText = (value = ''): TextBlock => ({
  value, fontFamily: 'Calibri', fontSizePt: 11, bold: false, italic: false, underline: false, colour: '#000000',
  horizontalAlign: 'center', verticalAlign: 'middle', wrap: true, paddingPt: 4,
});

export const defaultShapeStyle = (): ShapeStyle => ({
  fill: '#FFFFFF', fillOpacity: 1, stroke: '#333333', strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter',
});

export const noneShapeStyle = (): ShapeStyle => ({ ...defaultShapeStyle(), fill: 'none', stroke: 'none' });

export const defaultLineStyle = (): LineStyle => ({
  stroke: '#333333', strokeWidthPt: 1, dash: 'solid', startArrow: 'none', endArrow: 'triangle',
});

export function newPage(id: string, name = 'Page-1'): Page {
  return {
    id, name, ...A4_LANDSCAPE, background: '#FFFFFF',
    grid: { visible: true, spacingPt: 72 / 25.4 * 5, snap: true },
    guides: [], layers: [], elements: [],
  };
}

export function newDocument(id: string, pageId: string, title = 'Untitled'): DiagramDocument {
  return { schemaVersion: 1, id, title, revision: 0, pages: [newPage(pageId)], assets: [], metadata: {} };
}

/** Built-in ports always available on box elements (normalised local coordinates). */
export const DEFAULT_PORTS: Record<string, { x: number; y: number }> = {
  north: { x: 0.5, y: 0 }, east: { x: 1, y: 0.5 }, south: { x: 0.5, y: 1 }, west: { x: 0, y: 0.5 },
};
