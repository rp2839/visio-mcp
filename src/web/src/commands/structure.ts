import type {
  AddLayerOp, AddPageOp, AssignLayerOp, ConnectorElement, CreateOp, DeleteAssetOp, DeleteLayerOp, DeleteOp, DeletePageOp,
  DuplicateOp, DuplicatePageOp, Element, ElementInput, ElementPatch, Endpoint, EndpointInput, Layer, Page, RegisterAssetOp,
  ReorderPageOp, ReplaceAssetGlobalOp, SetAssetOp, SetLayerOp, SetOp, SetPageOp, ShapeStyle, LineStyle, TextBlock, TextPatch,
  StylePatch, Point,
} from '../model/types';
import { fail } from '../model/result';
import { defaultLineStyle, defaultShapeStyle, defaultText, noneShapeStyle, newPage, DEFAULT_PORTS } from '../model/defaults';
import { boundsOfPoints, centre, portPoint, descendants } from '../model/geometry';
import { canonicalSerialize } from '../model/canonical';
import type { Draft } from './draft';
import { isUuid } from './draft';

const SHAPE_STYLE_KEYS = ['fill', 'fillOpacity', 'stroke', 'strokeWidthPt', 'dash', 'lineCap', 'lineJoin'] as const;
const LINE_STYLE_KEYS = ['stroke', 'strokeWidthPt', 'dash', 'startArrow', 'endArrow'] as const;

function mergeShapeStyle(base: ShapeStyle, patch: StylePatch | undefined): ShapeStyle {
  if (!patch) return base;
  for (const k of Object.keys(patch)) if (!(SHAPE_STYLE_KEYS as readonly string[]).includes(k)) fail('invalid_request', `style.${k} is not a shape style property`);
  return { ...base, ...(patch as Partial<ShapeStyle>) };
}

function mergeLineStyle(base: LineStyle, patch: StylePatch | undefined): LineStyle {
  if (!patch) return base;
  for (const k of Object.keys(patch)) if (!(LINE_STYLE_KEYS as readonly string[]).includes(k)) fail('invalid_request', `style.${k} is not a connector style property`);
  if (patch.stroke === 'none') fail('invalid_request', 'connector stroke cannot be none');
  return { ...base, ...(patch as Partial<LineStyle>) };
}

const mergeText = (base: TextBlock | undefined, patch: TextPatch): TextBlock => ({ ...(base ?? defaultText()), ...patch });

/** Current page position of an endpoint (port/perimeter centre or free point); used for fallback bounds and detaching. */
export function endpointPosition(d: Draft, end: Endpoint): Point {
  if (!end.elementId) return end.point ?? { x: 0, y: 0 };
  const t = d.get(end.elementId);
  if (t.kind === 'group' || t.kind === 'connector') return centre(t.bounds);
  if (end.port) {
    const custom = t.kind === 'shape' ? t.ports?.find((p) => p.name === end.port) : undefined;
    const local = custom ?? DEFAULT_PORTS[end.port];
    if (local) return portPoint(t.bounds, t.rotationDeg, local);
  }
  return centre(t.bounds);
}

function toEndpoint(d: Draft, input: EndpointInput): Endpoint {
  if (input.target !== undefined && input.point !== undefined) fail('invalid_request', 'endpoint needs target or point, not both');
  if (input.target !== undefined) {
    const elementId = d.resolve(input.target);
    const glue = input.glue ?? (input.port && input.port !== 'auto' ? 'static' : 'dynamic');
    if (glue === 'none') fail('invalid_request', 'glue "none" endpoint needs a point');
    const e: Endpoint = { elementId, glue };
    if (input.port && input.port !== 'auto') e.port = input.port;
    return e;
  }
  if (!input.point) fail('invalid_request', 'endpoint needs target or point');
  if (input.glue && input.glue !== 'none') fail('invalid_request', 'a free point endpoint has glue "none"');
  return { point: { x: input.point.x, y: input.point.y }, glue: 'none' };
}

function connectorFallbackBounds(d: Draft, c: Pick<ConnectorElement, 'from' | 'to' | 'waypoints'>) {
  return boundsOfPoints([endpointPosition(d, c.from), endpointPosition(d, c.to), ...c.waypoints]);
}

function resolveLayerIds(d: Draft, page: Page, refs: string[] | undefined): string[] {
  return [...new Set((refs ?? []).map((r) => d.resolveLayer(page, r).id))];
}

function assertAliasFree(page: Page, alias: string, exceptId?: string) {
  if (page.elements.some((e) => e.alias === alias && e.id !== exceptId)) fail('invalid_request', `alias "${alias}" already exists on page ${page.name}`, { alias });
}

const KIND_FIELDS: Record<string, readonly string[]> = {
  shape: ['geometry', 'style', 'text', 'ports'],
  text: ['style', 'text'],
  image: ['assetId', 'fit', 'opacity', 'preserveAspectRatio'],
  connector: ['from', 'to', 'route', 'waypoints', 'style', 'label'],
  group: [],
};
const COMMON_FIELDS = ['kind', 'id', 'alias', 'name', 'layerIds', 'locked', 'hidden', 'metadata', 'bounds', 'rotationDeg'];

export function planCreate(d: Draft, op: CreateOp): string {
  const input: ElementInput = op.element;
  for (const k of Object.keys(input))
    if (!COMMON_FIELDS.includes(k) && !KIND_FIELDS[input.kind].includes(k)) fail('invalid_request', `${input.kind} has no property ${k}`);
  const page = d.page(op.pageId);
  const id = input.id ?? d.newUuid();
  if (d.has(id)) fail('invalid_request', `element id ${id} already exists`);
  if (input.alias !== undefined) assertAliasFree(page, input.alias);
  const base = {
    id, layerIds: resolveLayerIds(d, page, input.layerIds), zIndex: d.nextZ(page), locked: input.locked ?? false,
    hidden: input.hidden ?? false, rotationDeg: input.rotationDeg ?? 0, metadata: { ...(input.metadata ?? {}) },
    ...(input.alias !== undefined ? { alias: input.alias } : {}), ...(input.name !== undefined ? { name: input.name } : {}),
  };
  let element: Element;
  if (input.kind === 'connector') {
    if (!input.from || !input.to) fail('invalid_request', 'connector needs from and to');
    if (input.rotationDeg) fail('invalid_request', 'connectors cannot be rotated');
    const from = toEndpoint(d, input.from), to = toEndpoint(d, input.to);
    const waypoints = (input.waypoints ?? []).map((p) => ({ x: p.x, y: p.y }));
    element = {
      ...base, kind: 'connector', rotationDeg: 0, from, to, route: input.route ?? 'orthogonal', waypoints,
      style: mergeLineStyle(defaultLineStyle(), input.style), bounds: input.bounds ?? connectorFallbackBounds(d, { from, to, waypoints }),
      ...(input.label ? { label: mergeText(undefined, input.label) } : {}),
    };
  } else {
    if (!input.bounds) fail('invalid_request', `${input.kind} needs bounds`);
    const bounds = { ...input.bounds };
    if (input.kind === 'shape') {
      element = {
        ...base, kind: 'shape', bounds, geometry: { preset: 'rectangle', ...(input.geometry ?? {}) },
        style: mergeShapeStyle(defaultShapeStyle(), input.style),
        ...(input.text ? { text: mergeText(undefined, input.text) } : {}),
        ...(input.ports ? { ports: input.ports.map((p) => ({ ...p })) } : {}),
      };
    } else if (input.kind === 'text') {
      element = { ...base, kind: 'text', bounds, text: mergeText({ ...defaultText(), horizontalAlign: 'left' }, input.text ?? {}), style: mergeShapeStyle(noneShapeStyle(), input.style) };
    } else {
      if (!input.assetId) fail('invalid_request', 'image needs assetId');
      if (!d.doc.assets.some((a) => a.id === input.assetId)) fail('not_found', `asset ${input.assetId} is not registered in this document`, { assetId: input.assetId });
      element = { ...base, kind: 'image', bounds, assetId: input.assetId, fit: input.fit ?? 'contain', opacity: input.opacity ?? 1, preserveAspectRatio: input.preserveAspectRatio ?? true };
    }
  }
  d.insertElement(page, element);
  if (element.alias) d.createdAliases[element.alias] = id;
  return id;
}

export function planSet(d: Draft, op: SetOp) {
  const id = d.resolve(op.target);
  const { page, element: cur } = d.loc(id);
  const patch: ElementPatch = op.patch;
  const keys = Object.keys(patch);
  const onlyLockChange = keys.every((k) => k === 'locked');
  if (!onlyLockChange) {
    const layerLocked = cur.layerIds.some((l) => page.layers.find((x) => x.id === l)?.locked);
    const unlocking = patch.locked === false && !layerLocked;
    if (layerLocked || (cur.locked && !unlocking)) fail('locked_target', `element ${id} is locked`, { elementId: id });
  }
  for (const k of keys) {
    if (k === 'kind' || k === 'id') fail('invalid_request', `${k} is immutable`);
    if (!COMMON_FIELDS.includes(k) && !KIND_FIELDS[cur.kind].includes(k) && !(k === 'text' && cur.kind === 'shape'))
      fail('invalid_request', `${cur.kind} has no property ${k}`);
  }
  const next: any = structuredClone(cur);
  if ('alias' in patch) {
    if (patch.alias === null) delete next.alias;
    else { assertAliasFree(page, patch.alias!, id); next.alias = patch.alias; }
  }
  if ('name' in patch) { if (patch.name === null) delete next.name; else next.name = patch.name; }
  if (patch.locked !== undefined) next.locked = patch.locked;
  if (patch.hidden !== undefined) next.hidden = patch.hidden;
  if (patch.metadata) for (const [k, v] of Object.entries(patch.metadata)) { if (v === null) delete next.metadata[k]; else next.metadata[k] = v; }
  if (patch.bounds) {
    if (cur.kind === 'group') fail('invalid_request', 'group bounds are derived; use move/resize', { reason: 'group_bounds_derived' });
    next.bounds = { ...cur.bounds, ...patch.bounds };
  }
  if (patch.rotationDeg !== undefined) {
    if (cur.kind === 'group') fail('invalid_request', 'group rotation is fixed at 0; rotate with deltaDeg', { reason: 'group_rotation_requires_delta' });
    if (cur.kind === 'connector') fail('invalid_request', 'connectors cannot be rotated');
    next.rotationDeg = patch.rotationDeg;
  }
  if (patch.style) next.style = cur.kind === 'connector' ? mergeLineStyle(cur.style, patch.style) : mergeShapeStyle((cur as any).style, patch.style);
  if ('text' in patch) {
    if (patch.text === null) {
      if (cur.kind === 'text') fail('invalid_request', 'a text element must keep its text block');
      delete next.text;
    } else next.text = mergeText((cur as any).text, patch.text!);
  }
  if ('label' in patch) { if (patch.label === null) delete next.label; else next.label = mergeText((cur as any).label, patch.label!); }
  if (patch.geometry) next.geometry = { ...(cur as any).geometry, ...patch.geometry };
  if (patch.ports) next.ports = patch.ports.map((p) => ({ ...p }));
  if (patch.assetId !== undefined) {
    if (!d.doc.assets.some((a) => a.id === patch.assetId)) fail('not_found', `asset ${patch.assetId} is not registered in this document`, { assetId: patch.assetId });
    next.assetId = patch.assetId;
  }
  if (patch.fit !== undefined) next.fit = patch.fit;
  if (patch.opacity !== undefined) next.opacity = patch.opacity;
  if (patch.preserveAspectRatio !== undefined) next.preserveAspectRatio = patch.preserveAspectRatio;
  if (patch.from) next.from = toEndpoint(d, patch.from);
  if (patch.to) next.to = toEndpoint(d, patch.to);
  if (patch.route) next.route = patch.route;
  if (patch.waypoints) next.waypoints = patch.waypoints.map((p) => ({ x: p.x, y: p.y }));
  d.replaceElement(next as Element);
}

/** Connectors on the page glued to any of ids. */
export function gluedConnectors(d: Draft, page: Page, ids: Set<string>): ConnectorElement[] {
  return page.elements.filter((e): e is ConnectorElement => e.kind === 'connector' && (ids.has(e.from.elementId ?? '') || ids.has(e.to.elementId ?? '')));
}

function detach(d: Draft, c: ConnectorElement, gone: Set<string>) {
  const next = structuredClone(c);
  for (const end of ['from', 'to'] as const) {
    if (next[end].elementId && gone.has(next[end].elementId!)) next[end] = { point: endpointPosition(d, c[end]), glue: 'none' };
  }
  d.replaceElement(next);
}

export function planDelete(d: Draft, op: DeleteOp) {
  const id = d.resolve(op.target);
  const { page, element } = d.loc(id);
  let removed: string[];
  if (element.kind === 'group') {
    if (op.subtree === undefined) fail('invalid_request', 'deleting a group needs an explicit subtree choice (true deletes descendants, false ungroups)');
    removed = op.subtree ? [id, ...descendants(d.pageIndex(page), id)] : [id];
  } else removed = [id];
  d.assertUnlocked(removed);
  const gone = new Set(removed);
  const mode = op.connectors ?? 'reject';
  const dependents = gluedConnectors(d, page, gone).filter((c) => !gone.has(c.id));
  if (mode === 'detach') for (const c of dependents) detach(d, c, gone);
  if (mode === 'delete') { d.assertUnlocked(dependents.map((c) => c.id)); for (const c of dependents) gone.add(c.id); }
  // mode 'reject': leave references; final validation reports dependency_conflict unless a
  // later operation in the same batch deletes or detaches those connectors.
  const parent = d.parentOf(id);
  if (element.kind === 'group' && !op.subtree && parent) {
    const p = d.get(parent) as any;
    d.replaceElement({ ...p, childIds: p.childIds.flatMap((c: string) => (c === id ? element.childIds : [c])) });
  }
  for (const g of gone) {
    const par = d.parentOf(g);
    if (par && !gone.has(par)) {
      const p = d.get(par) as any;
      d.replaceElement({ ...p, childIds: p.childIds.filter((c: string) => c !== g) });
    }
  }
  for (const g of gone) d.removeElement(g);
}

/** Duplicates targets (groups include descendants); remaps internal links; external glue detaches. */
export function planDuplicate(d: Draft, op: DuplicateOp): string[] {
  const roots = d.resolveAll(op.targets);
  const page = d.samePage(roots);
  const idx = d.pageIndex(page);
  const set: string[] = [];
  for (const r of roots) for (const id of [r, ...descendants(idx, r)]) if (!set.includes(id)) set.push(id);
  const map = new Map<string, string>();
  for (const id of set) {
    const explicit = op.ids && Object.entries(op.ids).find(([k]) => { try { return d.resolve(k) === id; } catch { return false; } })?.[1];
    map.set(id, explicit ?? d.newUuid());
  }
  const off = op.offset ?? { xPt: 10, yPt: 10 };
  const shift = (p: Point) => ({ x: p.x + off.xPt, y: p.y + off.yPt });
  const ordered = page.elements.filter((e) => map.has(e.id));
  let z = d.nextZ(page);
  const created: string[] = [];
  for (const src of ordered) {
    const copy: any = structuredClone(src);
    copy.id = map.get(src.id);
    copy.zIndex = z++;
    delete copy.alias;
    copy.bounds = { ...src.bounds, x: src.bounds.x + off.xPt, y: src.bounds.y + off.yPt };
    if (copy.kind === 'group') copy.childIds = copy.childIds.map((c: string) => map.get(c));
    if (copy.kind === 'connector') {
      copy.waypoints = copy.waypoints.map(shift);
      for (const end of ['from', 'to'] as const) {
        const e: Endpoint = copy[end];
        if (e.elementId && map.has(e.elementId)) e.elementId = map.get(e.elementId);
        else if (e.elementId) copy[end] = { point: shift(endpointPosition(d, (src as ConnectorElement)[end])), glue: 'none' };
        else if (e.point) e.point = shift(e.point);
      }
    }
    d.insertElement(page, copy);
    created.push(copy.id);
  }
  for (const [srcTarget, alias] of Object.entries(op.aliases ?? {})) {
    const newId = map.get(d.resolve(srcTarget));
    if (!newId) fail('invalid_request', `alias given for ${srcTarget}, which is not duplicated`);
    assertAliasFree(page, alias);
    d.replaceElement({ ...d.get(newId), alias });
    d.createdAliases[alias] = newId;
  }
  return created;
}

// ---------------- pages ----------------
export function planAddPage(d: Draft, op: AddPageOp): string {
  const input = op.page ?? {};
  const id = input.id ?? d.newUuid();
  if (d.doc.pages.some((p) => p.id === id)) fail('invalid_request', `page ${id} already exists`);
  let n = d.doc.pages.length + 1;
  while (d.doc.pages.some((p) => p.name === `Page-${n}`)) n++;
  const page = newPage(id, input.name ?? `Page-${n}`);
  applyPagePatch(page, input);
  const index = op.index ?? d.doc.pages.length;
  if (index > d.doc.pages.length) fail('invalid_request', `page index ${index} out of range`);
  d.doc.pages.splice(index, 0, page);
  return id;
}

function applyPagePatch(page: Page, patch: SetPageOp['patch']) {
  if (patch.id !== undefined && patch.id !== page.id) fail('invalid_request', 'page id is immutable');
  if (patch.name !== undefined) page.name = patch.name;
  if (patch.widthPt !== undefined) page.widthPt = patch.widthPt;
  if (patch.heightPt !== undefined) page.heightPt = patch.heightPt;
  if (patch.background !== undefined) page.background = patch.background;
  if (patch.grid) page.grid = { ...page.grid, ...patch.grid };
  if (patch.guides) page.guides = patch.guides.map((g) => ({ ...g }));
}

export function planSetPage(d: Draft, op: SetPageOp) {
  applyPagePatch(d.page(op.pageId), op.patch);
}

export function planReorderPage(d: Draft, op: ReorderPageOp) {
  const page = d.page(op.pageId);
  if (op.index >= d.doc.pages.length) fail('invalid_request', `page index ${op.index} out of range`);
  d.doc.pages = d.doc.pages.filter((p) => p !== page);
  d.doc.pages.splice(op.index, 0, page);
}

export function planDuplicatePage(d: Draft, op: DuplicatePageOp): string {
  const src = d.page(op.pageId);
  const copy: Page = structuredClone(src);
  copy.id = op.newPageId ?? d.newUuid();
  if (d.doc.pages.some((p) => p.id === copy.id)) fail('invalid_request', `page ${copy.id} already exists`);
  copy.name = op.name ?? `${src.name} (copy)`;
  const layerMap = new Map(copy.layers.map((l) => [l.id, d.newUuid()]));
  copy.layers = copy.layers.map((l) => ({ ...l, id: layerMap.get(l.id)! }));
  copy.guides = copy.guides.map((g) => ({ ...g, id: d.newUuid() }));
  const idMap = new Map(copy.elements.map((e) => [e.id, d.newUuid()]));
  copy.elements = copy.elements.map((e: any) => {
    const n = { ...e, id: idMap.get(e.id), layerIds: e.layerIds.map((l: string) => layerMap.get(l)) };
    if (n.kind === 'group') n.childIds = n.childIds.map((c: string) => idMap.get(c));
    if (n.kind === 'connector') for (const end of ['from', 'to']) if (n[end].elementId) n[end] = { ...n[end], elementId: idMap.get(n[end].elementId) };
    return n;
  });
  d.doc.pages.splice(d.doc.pages.indexOf(src) + 1, 0, copy);
  d.reindex();
  return copy.id;
}

export function planDeletePage(d: Draft, op: DeletePageOp) {
  const page = d.page(op.pageId);
  if (d.doc.pages.length === 1) fail('invalid_request', 'cannot delete the last page');
  d.assertUnlocked(page.elements.map((e) => e.id));
  d.doc.pages = d.doc.pages.filter((p) => p !== page);
  d.reindex();
}

// ---------------- layers ----------------
export function planAddLayer(d: Draft, op: AddLayerOp): string {
  const page = d.page(op.pageId);
  const input = op.layer;
  const id = input.id ?? d.newUuid();
  if (d.doc.pages.some((p) => p.layers.some((l) => l.id === id))) fail('invalid_request', `layer ${id} already exists`);
  let n = page.layers.length + 1;
  while (page.layers.some((l) => l.name === `Layer ${n}`)) n++;
  const layer: Layer = {
    id, name: input.name ?? `Layer ${n}`, visible: input.visible ?? true, locked: input.locked ?? false,
    printable: input.printable ?? true, snap: input.snap ?? true, glue: input.glue ?? true,
  };
  if (input.colourOverride) layer.colourOverride = input.colourOverride;
  page.layers.push(layer);
  return id;
}

export function planSetLayer(d: Draft, op: SetLayerOp) {
  const page = d.page(op.pageId);
  const layer = d.resolveLayer(page, op.layer);
  const { id, colourOverride, ...rest } = op.patch;
  if (id !== undefined && id !== layer.id) fail('invalid_request', 'layer id is immutable');
  Object.assign(layer, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
  if (colourOverride === null) delete layer.colourOverride;
  else if (colourOverride !== undefined) layer.colourOverride = colourOverride;
}

export function planAssignLayer(d: Draft, op: AssignLayerOp) {
  const ids = d.resolveAll(op.targets);
  const page = d.samePage(ids);
  const layerIds = resolveLayerIds(d, page, op.layers);
  for (const id of ids) {
    const e = d.get(id);
    if (e.locked) fail('locked_target', `element ${id} is locked`, { elementId: id });
    const mode = op.mode ?? 'set';
    const next = mode === 'set' ? layerIds : mode === 'add' ? [...new Set([...e.layerIds, ...layerIds])] : e.layerIds.filter((l) => !layerIds.includes(l));
    d.replaceElement({ ...e, layerIds: next });
  }
}

export function planDeleteLayer(d: Draft, op: DeleteLayerOp) {
  const page = d.page(op.pageId);
  const layer = d.resolveLayer(page, op.layer);
  page.layers = page.layers.filter((l) => l !== layer);
  for (const e of page.elements) if (e.layerIds.includes(layer.id)) d.replaceElement({ ...e, layerIds: e.layerIds.filter((l) => l !== layer.id) });
}

// ---------------- assets ----------------
export function planRegisterAsset(d: Draft, op: RegisterAssetOp) {
  const existing = d.doc.assets.find((a) => a.id === op.asset.id);
  if (existing) {
    if (canonicalSerialize(existing) === canonicalSerialize(op.asset)) return;
    fail('invalid_request', `asset ${op.asset.id} already exists with a different descriptor; register a version id asset:<slug>~<sha256>`, { assetId: op.asset.id });
  }
  const versioned = /~([0-9a-f]{64})$/.exec(op.asset.id);
  if (versioned && versioned[1] !== op.asset.sha256) fail('invalid_request', 'versioned asset id must embed the asset sha256');
  d.doc.assets.push(structuredClone(op.asset));
}

export function planSetAsset(d: Draft, op: SetAssetOp) {
  const a = d.doc.assets.find((x) => x.id === op.assetId);
  if (!a) fail('not_found', `asset ${op.assetId} not found`);
  if (op.patch.name !== undefined) a.name = op.patch.name;
  if (op.patch.tags !== undefined) a.tags = [...op.patch.tags];
}

export function planReplaceAssetGlobal(d: Draft, op: ReplaceAssetGlobalOp): string[] {
  if (!d.doc.assets.some((a) => a.id === op.toAssetId)) fail('not_found', `asset ${op.toAssetId} not found`);
  if (!d.doc.assets.some((a) => a.id === op.fromAssetId)) fail('not_found', `asset ${op.fromAssetId} not found`);
  const affected: string[] = [];
  for (const page of d.doc.pages)
    for (const e of page.elements)
      if (e.kind === 'image' && e.assetId === op.fromAssetId) {
        d.assertUnlocked([e.id]);
        d.replaceElement({ ...e, assetId: op.toAssetId });
        affected.push(e.id);
      }
  return affected;
}

export function planDeleteAsset(d: Draft, op: DeleteAssetOp) {
  const users = d.doc.pages.flatMap((p) => p.elements).filter((e) => e.kind === 'image' && e.assetId === op.assetId).map((e) => e.id);
  if (users.length) fail('dependency_conflict', `asset ${op.assetId} is used by ${users.length} image(s)`, { elementIds: users });
  if (!d.doc.assets.some((a) => a.id === op.assetId)) fail('not_found', `asset ${op.assetId} not found`);
  d.doc.assets = d.doc.assets.filter((a) => a.id !== op.assetId);
}

export { isUuid };
