import type { Bounds, Projection, Snapshot } from '../model/types';
import { err, ok, type Result } from '../model/result';
import { rotatedAabb, union } from '../model/geometry';
import { splitColour } from '../canvas/styleMap';
import { renderSvg } from './SnapshotRenderer';
import { canvasMeasure } from './text';

export type RenderOptions = {
  pageId: string;
  format?: 'png' | 'jpeg';
  mode?: 'clean' | 'debug';
  maxWidth?: number;
  maxHeight?: number;
  /** Exactly one of bounds or elementIds when rendering a region. */
  region?: { bounds?: Bounds; elementIds?: string[]; paddingPt?: number };
};

export type RenderResult = {
  mimeType: 'image/png' | 'image/jpeg';
  data: string; // base64
  documentId: string; sessionId: string; revision: number; pageId: string;
  cropPt: Bounds; widthPx: number; heightPx: number; scale: number;
};

export const MAX_PIXELS = 16 * 1024 * 1024;
export const MAX_BYTES = 16 * 1024 * 1024;

/** Region crop: rotated/group/connector visual bounds plus padding; never an ambiguous crop. */
export function regionCrop(snapshot: Snapshot, projection: Projection, pageId: string, region: NonNullable<RenderOptions['region']>): Result<Bounds> {
  const page = snapshot.document.pages.find((p) => p.id === pageId);
  if (!page) return err('not_found', `page ${pageId} not found`);
  const pad = region.paddingPt ?? 12;
  if (!!region.bounds === !!region.elementIds?.length) return err('invalid_request', 'region needs exactly one of bounds or elementIds');
  let box: Bounds | null = region.bounds ?? null;
  for (const id of region.elementIds ?? []) {
    const e = page.elements.find((x) => x.id === id || x.alias === id);
    if (!e) return err('not_found', `element ${id} is not on page ${page.name}`);
    const b = e.kind === 'connector' ? projection.connectors[e.id]?.visualBounds ?? e.bounds : e.kind === 'group' ? projection.groupVisualBounds[e.id] ?? e.bounds : rotatedAabb(e.bounds, e.rotationDeg);
    box = box ? union(box, b) : b;
  }
  if (!box || box.width <= 0 || box.height <= 0) return err('invalid_request', 'region is empty');
  return ok({ x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad });
}

/**
 * Rasterises the captured snapshot (not the live canvas): the result keeps the snapshot's
 * revision even if commits land while it renders. Waits for images and fonts; fails on
 * missing assets; enforces 16 Mpx / 16 MiB budgets; JPEG gets the page background colour.
 */
export async function renderSnapshot(snapshot: Snapshot, projection: Projection, assetData: Map<string, string>, options: RenderOptions): Promise<Result<RenderResult>> {
  const page = snapshot.document.pages.find((p) => p.id === options.pageId || p.name === options.pageId);
  if (!page) return err('not_found', `page ${options.pageId} not found`);
  const format = options.format ?? 'png';
  const maxW = options.maxWidth ?? 1600, maxH = options.maxHeight ?? 1200;
  if (!Number.isFinite(maxW) || !Number.isFinite(maxH) || maxW < 1 || maxH < 1) return err('invalid_request', 'maxWidth/maxHeight must be positive');
  if (maxW * maxH > MAX_PIXELS) return err('limit_exceeded', `${maxW}×${maxH} exceeds the 16 Mpx preview budget`);
  let crop: Bounds = { x: 0, y: 0, width: page.widthPt, height: page.heightPt };
  if (options.region) {
    const c = regionCrop(snapshot, projection, page.id, options.region);
    if (!c.ok) return c;
    crop = c.value;
  }
  if (typeof document !== 'undefined' && (document as any).fonts?.ready) await (document as any).fonts.ready;
  const svg = renderSvg(snapshot, projection, { pageId: page.id, mode: options.mode, crop, assetData, measure: canvasMeasure() });
  if (!svg.ok) return svg;
  const scale = Math.min(maxW / crop.width, maxH / crop.height);
  const widthPx = Math.max(1, Math.round(crop.width * scale)), heightPx = Math.max(1, Math.round(crop.height * scale));
  const url = URL.createObjectURL(new Blob([svg.value.svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { return err('internal_error', 'snapshot SVG could not be decoded'); }
    const canvas = document.createElement('canvas');
    canvas.width = widthPx; canvas.height = heightPx;
    const ctx = canvas.getContext('2d')!;
    if (format === 'jpeg') {
      const bg = page.background === 'none' ? '#FFFFFF' : splitColour(page.background).colour;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, widthPx, heightPx);
    }
    ctx.drawImage(img, 0, 0, widthPx, heightPx);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.92));
    if (!blob) return err('internal_error', 'encoding failed');
    if (blob.size > MAX_BYTES) return err('limit_exceeded', 'encoded preview exceeds 16 MiB');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return ok({
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png', data: btoa(bin),
      documentId: snapshot.documentId, sessionId: snapshot.sessionId, revision: snapshot.revision, pageId: page.id,
      cropPt: crop, widthPx, heightPx, scale: widthPx / crop.width,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
