import type { Bounds, Element, Page, Projection, Snapshot, TextBlock } from '../model/types';
import { err, ok, type Result } from '../model/result';
import { centre } from '../model/geometry';
import { presetPath } from '../canvas/presets';
import { DASH_ARRAYS, isPrintable, isVisible, layerColourOverride, splitColour } from '../canvas/styleMap';
import { heuristicMeasure, wrapLines, type MeasureText } from './text';

export type SvgOptions = {
  pageId: string;
  mode?: 'clean' | 'debug';
  /** Crop in page points (defaults to the whole page). */
  crop?: Bounds;
  /** sha256 → data URL for every referenced asset; missing assets fail the render. */
  assetData: Map<string, string>;
  measure?: MeasureText;
  /** Print/export rendering omits non-printable layers. */
  printable?: boolean;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => +v.toFixed(3);

function paint(c: string) {
  const { colour, opacity } = splitColour(c);
  return colour === 'none' ? 'fill="none"' : `fill="${colour}"${opacity < 1 ? ` fill-opacity="${n(opacity)}"` : ''}`;
}

function textSvg(t: TextBlock, b: Bounds, measure: MeasureText): string {
  if (!t.value) return '';
  const font = { family: t.fontFamily, sizePt: t.fontSizePt, bold: t.bold, italic: t.italic };
  const lines = wrapLines(t.value, b.width - 2 * t.paddingPt, t.wrap, (s) => measure(s, font).width);
  const lh = t.fontSizePt * 1.2;
  const total = lines.length * lh;
  const top = t.verticalAlign === 'top' ? b.y + t.paddingPt : t.verticalAlign === 'bottom' ? b.y + b.height - t.paddingPt - total : b.y + (b.height - total) / 2;
  const x = t.horizontalAlign === 'left' ? b.x + t.paddingPt : t.horizontalAlign === 'right' ? b.x + b.width - t.paddingPt : b.x + b.width / 2;
  const anchor = t.horizontalAlign === 'left' ? 'start' : t.horizontalAlign === 'right' ? 'end' : 'middle';
  const { colour, opacity } = splitColour(t.colour);
  const attrs = `font-family="${esc(t.fontFamily)}, sans-serif" font-size="${n(t.fontSizePt)}" fill="${colour}"${opacity < 1 ? ` fill-opacity="${n(opacity)}"` : ''}${t.bold ? ' font-weight="bold"' : ''}${t.italic ? ' font-style="italic"' : ''}${t.underline ? ' text-decoration="underline"' : ''} text-anchor="${anchor}"`;
  return `<text ${attrs}>${lines.map((l, i) => `<tspan x="${n(x)}" y="${n(top + i * lh + t.fontSizePt * 0.95)}">${esc(l)}</tspan>`).join('')}</text>`;
}

const ARROW_PATH: Record<string, string> = {
  triangle: 'M0,0 L10,5 L0,10 Z', open: 'M0,0 L10,5 L0,10', diamond: 'M0,5 L5,0 L10,5 L5,10 Z', circle: 'M5,0 A5,5 0 1 1 5,10 A5,5 0 1 1 5,0 Z',
};

/**
 * Pure SVG rendering of one committed snapshot page, using the same preset geometry and style
 * mapping as the canvas. Clean mode has no editor chrome; debug mode overlays IDs/aliases and
 * bounds. Used for render_page/render_region and SVG/PNG/JPEG export.
 */
export function renderSvg(snapshot: Snapshot, projection: Projection, opts: SvgOptions): Result<{ svg: string; crop: Bounds }> {
  const page = snapshot.document.pages.find((p) => p.id === opts.pageId || p.name === opts.pageId);
  if (!page) return err('not_found', `page ${opts.pageId} not found`);
  const measure = opts.measure ?? heuristicMeasure;
  const crop = opts.crop ?? { x: 0, y: 0, width: page.widthPt, height: page.heightPt };
  const assets = new Map(snapshot.document.assets.map((a) => [a.id, a]));
  const defs = new Set<string>();
  const body: string[] = [];
  if (page.background !== 'none') body.push(`<rect x="0" y="0" width="${n(page.widthPt)}" height="${n(page.heightPt)}" ${paint(page.background)}/>`);
  for (const e of page.elements) {
    if (!isVisible(page, e) || (opts.printable && !isPrintable(page, e))) continue;
    const r = elementSvg(page, e, projection, assets, opts.assetData, measure, defs);
    if (!r.ok) return r;
    body.push(r.value);
  }
  if (opts.mode === 'debug') {
    for (const e of page.elements) {
      if (!isVisible(page, e)) continue;
      const b = e.kind === 'connector' ? projection.connectors[e.id]?.visualBounds ?? e.bounds : e.kind === 'group' ? projection.groupVisualBounds[e.id] ?? e.bounds : e.bounds;
      const label = e.alias ?? e.id.slice(0, 8);
      body.push(`<g data-debug="1"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" fill="none" stroke="#E0457B" stroke-width="0.6" stroke-dasharray="3 2"/>`
        + `<text x="${n(b.x + 1)}" y="${n(b.y - 1.5)}" font-family="monospace" font-size="6" fill="#B0005A">${esc(label)}</text></g>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(crop.x)} ${n(crop.y)} ${n(crop.width)} ${n(crop.height)}" width="${n(crop.width)}pt" height="${n(crop.height)}pt">`
    + (defs.size ? `<defs>${[...defs].join('')}</defs>` : '') + body.join('') + '</svg>';
  return ok({ svg, crop });
}

function elementSvg(page: Page, e: Element, projection: Projection, assets: Map<string, any>, assetData: Map<string, string>, measure: MeasureText, defs: Set<string>): Result<string> {
  const c = centre(e.bounds);
  const rot = e.rotationDeg ? ` transform="rotate(${n(e.rotationDeg)} ${n(c.x)} ${n(c.y)})"` : '';
  const id = ` data-id="${e.id}"`;
  const override = layerColourOverride(page, e);
  switch (e.kind) {
    case 'shape': case 'text': {
      const st = e.style;
      const stroke = splitColour(override && st.stroke !== 'none' ? override : st.stroke);
      const fill = splitColour(override ?? st.fill);
      const d = e.kind === 'shape' ? presetPath(e.geometry.preset, e.bounds.x, e.bounds.y, e.bounds.width, e.bounds.height, e.geometry.cornerRadiusPt, e.geometry.svgPath) : presetPath('rectangle', e.bounds.x, e.bounds.y, e.bounds.width, e.bounds.height);
      const shapeAttrs = `${fill.colour === 'none' ? 'fill="none"' : `fill="${fill.colour}" fill-opacity="${n(fill.opacity * st.fillOpacity)}"`} ${stroke.colour === 'none' || st.strokeWidthPt === 0 ? 'stroke="none"' : `stroke="${stroke.colour}" stroke-opacity="${n(stroke.opacity)}" stroke-width="${n(st.strokeWidthPt)}"`}${DASH_ARRAYS[st.dash] ? ` stroke-dasharray="${DASH_ARRAYS[st.dash]}"` : ''} stroke-linecap="${st.lineCap}" stroke-linejoin="${st.lineJoin}"`;
      const outline = e.kind === 'text' && fill.colour === 'none' && stroke.colour === 'none' ? '' : `<path d="${d}" ${shapeAttrs}/>`;
      return ok(`<g${id}${rot}>${outline}${e.text ? textSvg(e.text, e.bounds, measure) : ''}</g>`);
    }
    case 'image': {
      const asset = assets.get(e.assetId);
      const data = asset ? assetData.get(asset.sha256) : undefined;
      if (!data) return err('not_found', `asset ${e.assetId} bytes are unavailable; refusing to render a blank image`, { elementId: e.id, assetId: e.assetId });
      const par = e.fit === 'stretch' || !e.preserveAspectRatio ? 'none' : e.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
      const clip = e.fit === 'cover' ? (() => { const cid = `clip-${e.id}`; defs.add(`<clipPath id="${cid}"><rect x="${n(e.bounds.x)}" y="${n(e.bounds.y)}" width="${n(e.bounds.width)}" height="${n(e.bounds.height)}"/></clipPath>`); return ` clip-path="url(#${cid})"`; })() : '';
      return ok(`<g${id}${rot}${clip}><image href="${data}" x="${n(e.bounds.x)}" y="${n(e.bounds.y)}" width="${n(e.bounds.width)}" height="${n(e.bounds.height)}" preserveAspectRatio="${par}"${e.opacity < 1 ? ` opacity="${n(e.opacity)}"` : ''}/></g>`);
    }
    case 'connector': {
      const pts = projection.connectors[e.id]?.routePoints;
      if (!pts || pts.length < 2) return ok('');
      const s = e.style;
      const colour = splitColour(override ?? s.stroke).colour;
      const markers: string[] = [];
      for (const [end, kind] of [['start', s.startArrow], ['end', s.endArrow]] as const) {
        if (kind === 'none') continue;
        const mid = `arrow-${kind}-${colour.slice(1)}-${end}`;
        defs.add(`<marker id="${mid}" viewBox="0 0 10 10" refX="${end === 'end' ? 9 : 1}" refY="5" markerWidth="6" markerHeight="6" orient="${end === 'end' ? 'auto' : 'auto-start-reverse'}"><path d="${ARROW_PATH[kind]}" fill="${kind === 'open' ? 'none' : colour}" stroke="${colour}"/></marker>`);
        markers.push(` marker-${end}="url(#${mid})"`);
      }
      const d = e.route === 'curved' && pts.length >= 2 ? curvedPath(pts) : `M${pts.map((p) => `${n(p.x)},${n(p.y)}`).join(' L')}`;
      const label = e.label?.value ? (() => {
        const m = pts[Math.floor((pts.length - 1) / 2)], m2 = pts[Math.floor((pts.length - 1) / 2) + 1] ?? m;
        const lx = (m.x + m2.x) / 2, ly = (m.y + m2.y) / 2;
        return textSvg({ ...e.label!, horizontalAlign: 'center', verticalAlign: 'middle', wrap: false }, { x: lx - 60, y: ly - 10, width: 120, height: 20 }, measure);
      })() : '';
      return ok(`<g${id}><path d="${d}" fill="none" stroke="${colour}" stroke-width="${n(s.strokeWidthPt)}"${DASH_ARRAYS[s.dash] ? ` stroke-dasharray="${DASH_ARRAYS[s.dash]}"` : ''}${markers.join('')}/>${label}</g>`);
    }
    case 'group':
      return ok(''); // children render themselves; canonical group has no own drawing
  }
}

function curvedPath(pts: { x: number; y: number }[]) {
  let d = `M${n(pts[0].x)},${n(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const mx = (a.x + b.x) / 2;
    d += ` C${n(mx)},${n(a.y)} ${n(mx)},${n(b.y)} ${n(b.x)},${n(b.y)}`;
  }
  return d;
}
