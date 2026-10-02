import {
  Graph, InternalEvent, GeometryChange, StyleChange, ValueChange, TerminalChange, Point as MxPoint, ConnectionConstraint,
  VertexHandlerConfig, Geometry as MxGeometry, type Cell, type CellStyle, type CellState,
} from '@maxgraph/core';
import type { Asset, Element, Page, Point, ResolvedDiff, Snapshot } from '../model/types';
import { ok, err, type Result } from '../model/result';
import { DEFAULT_PORTS } from '../model/defaults';
import type { CanvasAdapter, CanvasChange, CanvasIntent, GestureKind, Viewport } from './CanvasAdapter';
import { presetCanvasStyle } from './presets';
import { DASH_ARRAYS, MAX_ARROWS, isLocked, isVisible, layerColourOverride, splitColour } from './styleMap';
import type { AssetResolver } from '../editor/assets';

VertexHandlerConfig.rotationEnabled = true;

const PX_PER_PT = 96 / 72;
const PORT_NAMES = Object.entries(DEFAULT_PORTS);

/**
 * maxGraph projection of the canonical snapshot. Cells are internal; a projection guard
 * stops programmatic updates becoming GUI edits; maxGraph's own undo is never an authority.
 * Completed gestures are reported as typed CanvasChange lists for the GestureController.
 */
export class MaxGraphAdapter implements CanvasAdapter {
  private graph!: Graph;
  private container!: HTMLElement;
  private projecting = false;
  private snapshot: Snapshot | null = null;
  private page: Page | null = null;
  private intents = new Set<(i: CanvasIntent) => void>();
  private viewportListeners = new Set<(v: Viewport) => void>();
  private gesture: GestureKind | null = null;
  private pending: { kind: GestureKind; x: number; y: number; ids: string[] } | null = null;
  private collected: CanvasChange[] = [];
  private tool: 'select' | 'shape' | 'text' | 'connector' = 'select';
  private createStart: Point | null = null;
  private zoomLevel = 1;
  private gridLayer: SVGGElement | null = null;
  private cleanup: (() => void)[] = [];

  constructor(private readonly assets: AssetResolver) {}

  mount(container: HTMLElement) {
    this.container = container;
    const g = (this.graph = new Graph(container));
    g.setHtmlLabels(false);
    g.setConnectable(false); // connectors come from the connector tool; centre drags move shapes
    g.setCellsDisconnectable(true);
    g.setAllowDanglingEdges(true);
    g.setDisconnectOnMove(false);
    g.setAllowNegativeCoordinates(true);
    g.setPanning(true);
    g.setTooltips(false);
    g.centerZoom = false;
    // Shift- or Ctrl-click adds to the selection, as in desktop drawing tools.
    g.isToggleEvent = (evt: MouseEvent) => !!evt && (evt.ctrlKey || evt.metaKey || evt.shiftKey);
    const sel = g.getPlugin('SelectionHandler') as any;
    if (sel) sel.guidesEnabled = true; // alignment guides while dragging
    const panning = g.getPlugin('PanningHandler') as any;
    if (panning) {
      panning.useLeftButtonForPanning = false;
      const base = panning.isPanningTrigger.bind(panning);
      panning.isPanningTrigger = (me: any) => me.getEvent()?.button === 1 || this.spaceDown || base(me);
    }
    // Default N/E/S/W ports (plus custom shape ports) become maxGraph connection constraints.
    g.getAllConnectionConstraints = (terminal: CellState | null) => {
      if (!terminal?.cell?.isVertex()) return null;
      const e = this.element(terminal.cell.id ?? '');
      const custom = e?.kind === 'shape' ? (e.ports ?? []).map((p) => [p.name, { x: p.x, y: p.y }] as const) : [];
      return [...PORT_NAMES, ...custom].map(([, p]) => new ConnectionConstraint(new MxPoint(p.x, p.y), true));
    };
    this.hookHandlers();
    const model = g.getDataModel();
    const onChange = (_s: unknown, evt: any) => this.onModelChange(evt.getProperty('edit').changes);
    model.addListener(InternalEvent.CHANGE, onChange);
    g.getSelectionModel().addListener(InternalEvent.CHANGE, () => {
      if (!this.projecting) this.emit({ type: 'selection', ids: this.getSelection() });
    });
    const connectionHandler = g.getPlugin('ConnectionHandler') as any;
    connectionHandler?.addListener(InternalEvent.CONNECT, (_s: unknown, evt: any) => this.onConnect(evt.getProperty('cell')));
    const view = g.getView();
    const onView = () => { this.drawPage(); this.emitViewport(); };
    for (const ev of [InternalEvent.SCALE, InternalEvent.TRANSLATE, InternalEvent.SCALE_AND_TRANSLATE]) view.addListener(ev, onView);
    g.addMouseListener({
      mouseDown: (_s: unknown, me: any) => this.onMouseDown(me),
      mouseMove: (_s: unknown, me: any) => this.onMouseMove(me),
      mouseUp: (_s: unknown, me: any) => this.onMouseUp(me),
    });
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = container.getBoundingClientRect();
        this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, this.clientToPage({ x: e.clientX - r.left + r.left, y: e.clientY }));
      } else {
        const t = view.translate, s = view.scale;
        view.setTranslate(t.x - e.deltaX / s, t.y - e.deltaY / s);
      }
    };
    container.addEventListener('wheel', wheel, { passive: false });
    const keyDown = (e: KeyboardEvent) => { if (e.code === 'Space' && e.target === document.body) this.spaceDown = true; };
    const keyUp = (e: KeyboardEvent) => { if (e.code === 'Space') this.spaceDown = false; };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    this.cleanup.push(() => container.removeEventListener('wheel', wheel), () => window.removeEventListener('keydown', keyDown), () => window.removeEventListener('keyup', keyUp));
    view.scale = PX_PER_PT;
  }

  private spaceDown = false;

  private emit(i: CanvasIntent) { for (const l of this.intents) l(i); }
  onIntent(listener: (i: CanvasIntent) => void) { this.intents.add(listener); return () => this.intents.delete(listener); }
  onViewport(listener: (v: Viewport) => void) { this.viewportListeners.add(listener); listener(this.viewport()); return () => this.viewportListeners.delete(listener); }
  private viewport(): Viewport {
    const v = this.graph.getView();
    return { scale: v.scale, translateX: v.translate.x, translateY: v.translate.y, zoom: v.scale / PX_PER_PT };
  }
  private emitViewport() { const v = this.viewport(); for (const l of this.viewportListeners) l(v); }

  private element(id: string): Element | undefined {
    return this.page?.elements.find((e) => e.id === id);
  }

  // ---------------- projection ----------------
  project(snapshot: Snapshot, pageId: string): Result<void> {
    const page = snapshot.document.pages.find((p) => p.id === pageId);
    if (!page) return err('not_found', `page ${pageId} not in snapshot`);
    const firstProjection = this.page === null || this.page.id !== page.id;
    this.snapshot = snapshot;
    this.page = page;
    const g = this.graph;
    const selected = this.getSelection();
    this.projecting = true;
    try {
      g.setGridSize(page.grid.spacingPt);
      g.setGridEnabled(page.grid.snap);
      const parent = g.getDefaultParent();
      g.batchUpdate(() => {
        g.removeCells(g.getChildCells(parent, true, true), true);
        const assets = new Map(snapshot.document.assets.map((a) => [a.id, a]));
        const cells = new Map<string, Cell>();
        for (const e of page.elements) {
          if (!isVisible(page, e) || e.kind === 'connector') continue;
          const cell = g.insertVertex({
            parent, id: e.id, value: e.kind === 'shape' || e.kind === 'text' ? e.text?.value ?? '' : '',
            position: [e.bounds.x, e.bounds.y], size: [e.bounds.width, e.bounds.height],
            style: this.vertexStyle(page, e, assets),
          });
          cells.set(e.id, cell);
        }
        for (const e of page.elements) {
          if (e.kind !== 'connector' || !isVisible(page, e)) continue;
          const source = e.from.elementId ? cells.get(e.from.elementId) ?? null : null;
          const target = e.to.elementId ? cells.get(e.to.elementId) ?? null : null;
          const edge = g.insertEdge({ parent, id: e.id, value: e.label?.value ?? '', source, target, style: this.edgeStyle(page, e) });
          const geo = edge.getGeometry()!.clone();
          if (!source && e.from.point) geo.setTerminalPoint(new MxPoint(e.from.point.x, e.from.point.y), true);
          if (!target && e.to.point) geo.setTerminalPoint(new MxPoint(e.to.point.x, e.to.point.y), false);
          geo.points = e.waypoints.map((p) => new MxPoint(p.x, p.y));
          g.getDataModel().setGeometry(edge, geo);
        }
      });
      const keep = selected.map((id) => g.getDataModel().getCell(id)).filter((c): c is Cell => !!c);
      g.setSelectionCells(keep);
    } catch (e) {
      return err('projection_failed', `canvas projection failed: ${(e as Error).message}`);
    } finally {
      this.projecting = false;
    }
    if (firstProjection) this.fit('page');
    this.drawPage();
    return ok(undefined);
  }

  /**
   * Incremental projection of one committed diff: changed cells are updated in place, so a
   * one-object edit costs one cell, not the page. Anything that can affect other cells' order or
   * appearance (page/layer/asset/document changes, z-order, kind changes, out-of-order inserts,
   * another page) falls back to a full projection.
   */
  projectChanges(snapshot: Snapshot, pageId: string, diff: ResolvedDiff): Result<void> {
    const page = snapshot.document.pages.find((p) => p.id === pageId);
    if (!page || !this.page || this.page.id !== pageId || !this.snapshot) return this.project(snapshot, pageId);
    const changes = diff.changes;
    if (changes.some((c) => c.entity !== 'element')) return this.project(snapshot, pageId);
    const mine = changes.filter((c) => c.pageId === pageId || (c.before as any)?.id && this.element(c.id));
    const g = this.graph;
    const model = g.getDataModel();
    const maxZ = page.elements.reduce((m, e) => (isVisible(page, e) ? Math.max(m, e.zIndex) : m), -Infinity);
    const byId = new Map(page.elements.map((e) => [e.id, e]));
    for (const c of mine) {
      const before = c.before as Element | null, after = c.after as Element | null;
      if (before && after && (before.zIndex !== after.zIndex || before.kind !== after.kind)) return this.project(snapshot, pageId);
      const now = byId.get(c.id);
      if (now && isVisible(page, now) && !model.getCell(c.id) && now.zIndex < maxZ) return this.project(snapshot, pageId);
      if (now?.kind === 'group' || before?.kind === 'group') return this.project(snapshot, pageId);
    }
    this.snapshot = snapshot;
    this.page = page;
    const selected = this.getSelection();
    const assets = new Map(snapshot.document.assets.map((a) => [a.id, a]));
    this.projecting = true;
    try {
      const parent = g.getDefaultParent();
      g.batchUpdate(() => {
        const ordered = [...mine].sort((a, b) => Number(((a.after ?? a.before) as Element).kind === 'connector') - Number(((b.after ?? b.before) as Element).kind === 'connector'));
        for (const c of ordered) {
          const e = byId.get(c.id);
          const cell = model.getCell(c.id);
          if (!e || !isVisible(page, e)) { if (cell) g.removeCells([cell], false); continue; }
          if (e.kind !== 'connector') {
            const value = e.kind === 'shape' || e.kind === 'text' ? e.text?.value ?? '' : '';
            if (!cell) {
              g.insertVertex({ parent, id: e.id, value, position: [e.bounds.x, e.bounds.y], size: [e.bounds.width, e.bounds.height], style: this.vertexStyle(page, e, assets) });
              continue;
            }
            model.setValue(cell, value);
            model.setGeometry(cell, new MxGeometry(e.bounds.x, e.bounds.y, e.bounds.width, e.bounds.height));
            model.setStyle(cell, this.vertexStyle(page, e, assets));
          } else {
            const source = e.from.elementId ? model.getCell(e.from.elementId) : null;
            const target = e.to.elementId ? model.getCell(e.to.elementId) : null;
            const edge = cell ?? g.insertEdge({ parent, id: e.id, value: e.label?.value ?? '', source, target, style: this.edgeStyle(page, e) });
            if (cell) {
              model.setValue(edge, e.label?.value ?? '');
              model.setStyle(edge, this.edgeStyle(page, e));
              model.setTerminal(edge, source, true);
              model.setTerminal(edge, target, false);
            }
            const geo = new MxGeometry();
            geo.relative = true;
            if (!source && e.from.point) geo.setTerminalPoint(new MxPoint(e.from.point.x, e.from.point.y), true);
            if (!target && e.to.point) geo.setTerminalPoint(new MxPoint(e.to.point.x, e.to.point.y), false);
            geo.points = e.waypoints.map((p) => new MxPoint(p.x, p.y));
            model.setGeometry(edge, geo);
          }
        }
      });
      const keep = selected.map((id) => model.getCell(id)).filter((c): c is Cell => !!c);
      g.setSelectionCells(keep);
    } catch (e) {
      return err('projection_failed', `canvas projection failed: ${(e as Error).message}`);
    } finally {
      this.projecting = false;
    }
    return ok(undefined);
  }

  private textStyle(t: { fontFamily: string; fontSizePt: number; bold: boolean; italic: boolean; underline: boolean; colour: string; horizontalAlign: string; verticalAlign: string; wrap: boolean; paddingPt: number } | undefined): CellStyle {
    if (!t) return {};
    return {
      fontFamily: t.fontFamily, fontSize: t.fontSizePt, fontColor: splitColour(t.colour).colour,
      fontStyle: (t.bold ? 1 : 0) | (t.italic ? 2 : 0) | (t.underline ? 4 : 0),
      align: t.horizontalAlign as any, verticalAlign: t.verticalAlign as any, whiteSpace: t.wrap ? 'wrap' : 'nowrap', spacing: t.paddingPt,
    } as CellStyle;
  }

  private vertexStyle(page: Page, e: Element, assets: Map<string, Asset>): CellStyle {
    const locked = isLocked(page, e);
    const base: CellStyle = { rotation: e.rotationDeg, movable: !locked, resizable: !locked, rotatable: !locked && e.kind !== 'group', editable: !locked, deletable: !locked } as CellStyle;
    const override = layerColourOverride(page, e);
    if (e.kind === 'group') return { ...base, fillColor: '#FFFFFF', fillOpacity: 0, strokeColor: 'none', editable: false, rotatable: true } as CellStyle;
    if (e.kind === 'image') {
      const asset = assets.get(e.assetId);
      return { ...base, shape: 'image', image: asset ? this.assets.urlFor(asset) ?? '' : '', imageAspect: e.fit !== 'stretch', opacity: e.opacity * 100, editable: false } as CellStyle;
    }
    if (e.kind === 'connector') return base;
    const st = e.style;
    const fill = splitColour(override ?? st.fill), stroke = splitColour(override && st.stroke !== 'none' ? override : st.stroke);
    return {
      ...base,
      ...(e.kind === 'shape' ? presetCanvasStyle(e.geometry.preset) : {}),
      ...(e.kind === 'shape' && e.geometry.preset === 'roundedRect' && e.geometry.cornerRadiusPt ? { arcSize: e.geometry.cornerRadiusPt * 2, absoluteArcSize: true } : {}),
      fillColor: fill.colour, fillOpacity: fill.opacity * st.fillOpacity * 100, strokeColor: stroke.colour, strokeOpacity: stroke.opacity * 100,
      strokeWidth: st.strokeWidthPt, dashed: st.dash !== 'solid', dashPattern: DASH_ARRAYS[st.dash] || undefined,
      ...this.textStyle(e.text),
    } as CellStyle;
  }

  private edgeStyle(page: Page, e: Extract<Element, { kind: 'connector' }>): CellStyle {
    const locked = isLocked(page, e);
    const s = e.style;
    const style: any = {
      edgeStyle: e.route === 'orthogonal' ? 'orthogonalEdgeStyle' : undefined, curved: e.route === 'curved',
      strokeColor: splitColour(layerColourOverride(page, e) ?? s.stroke).colour, strokeWidth: s.strokeWidthPt,
      dashed: s.dash !== 'solid', dashPattern: DASH_ARRAYS[s.dash] || undefined,
      startArrow: MAX_ARROWS[s.startArrow], endArrow: MAX_ARROWS[s.endArrow], movable: !locked, editable: !locked, deletable: !locked,
      ...this.textStyle(e.label),
    };
    if (e.from.glue === 'static' && e.from.port) { const p = DEFAULT_PORTS[e.from.port] ?? this.customPort(e.from.elementId, e.from.port); if (p) Object.assign(style, { exitX: p.x, exitY: p.y, exitPerimeter: true }); }
    if (e.to.glue === 'static' && e.to.port) { const p = DEFAULT_PORTS[e.to.port] ?? this.customPort(e.to.elementId, e.to.port); if (p) Object.assign(style, { entryX: p.x, entryY: p.y, entryPerimeter: true }); }
    return style as CellStyle;
  }

  private customPort(elementId: string | undefined, port: string) {
    const t = elementId ? this.element(elementId) : undefined;
    return t?.kind === 'shape' ? t.ports?.find((p) => p.name === port) : undefined;
  }

  private portName(elementId: string | null, x?: number, y?: number): string | undefined {
    if (x === undefined || y === undefined || x === null || y === null) return undefined;
    const t = elementId ? this.element(elementId) : undefined;
    const custom = t?.kind === 'shape' ? (t.ports ?? []).map((p) => [p.name, p] as const) : [];
    for (const [name, p] of [...PORT_NAMES, ...custom]) if (Math.abs(p.x - Number(x)) < 1e-6 && Math.abs(p.y - Number(y)) < 1e-6) return name;
    return undefined;
  }

  /** Page background, border shadow and grid drawn in the view's background pane. */
  private drawPage() {
    if (!this.page || !this.graph) return;
    const view = this.graph.getView();
    const pane = view.getBackgroundPane() as SVGGElement;
    const ns = 'http://www.w3.org/2000/svg';
    this.gridLayer?.remove();
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('data-role', 'page');
    const s = view.scale, t = view.translate;
    const x = t.x * s, y = t.y * s, w = this.page.widthPt * s, h = this.page.heightPt * s;
    const shadow = document.createElementNS(ns, 'rect');
    Object.entries({ x: x + 3, y: y + 3, width: w, height: h, fill: 'rgba(0,0,0,0.18)' }).forEach(([k, v]) => shadow.setAttribute(k, String(v)));
    const rect = document.createElementNS(ns, 'rect');
    Object.entries({ x, y, width: w, height: h, fill: this.page.background === 'none' ? '#FFFFFF' : splitColour(this.page.background).colour, stroke: '#9aa1a9', 'data-page-id': this.page.id }).forEach(([k, v]) => rect.setAttribute(k, String(v)));
    g.append(shadow, rect);
    if (this.page.grid.visible) {
      const step = this.page.grid.spacingPt * s;
      if (step >= 4) {
        const path = document.createElementNS(ns, 'path');
        let d = '';
        for (let gx = step; gx < w; gx += step) d += `M${(x + gx).toFixed(1)},${y}v${h}`;
        for (let gy = step; gy < h; gy += step) d += `M${x},${(y + gy).toFixed(1)}h${w}`;
        path.setAttribute('d', d);
        path.setAttribute('stroke', '#e3e7ec');
        path.setAttribute('stroke-width', '1');
        path.setAttribute('data-role', 'grid');
        g.append(path);
      }
    }
    pane.insertBefore(g, pane.firstChild);
    this.gridLayer = g;
  }

  // ---------------- gestures ----------------
  private hookHandlers() {
    const g = this.graph;
    const self = this;
    const selectionIds = () => this.getSelection();
    const sel = g.getPlugin('SelectionHandler') as any;
    if (sel) {
      const start = sel.start.bind(sel);
      sel.start = (cell: Cell, x: number, y: number, cells?: Cell[]) => { self.arm('move', x, y, selectionIds()); return start(cell, x, y, cells); };
      const reset = sel.reset.bind(sel);
      sel.reset = () => { const r = reset(); self.endIfUncommitted('move'); return r; };
    }
    const createVertexHandler = g.createVertexHandler.bind(g);
    g.createVertexHandler = (state: CellState) => {
      const h = createVertexHandler(state) as any;
      const start = h.start.bind(h);
      h.start = (x: number, y: number, index: number) => { self.arm(index === InternalEvent.ROTATION_HANDLE ? 'rotate' : 'resize', x, y, [state.cell.id!]); return start(x, y, index); };
      const reset = h.reset.bind(h);
      h.reset = () => { const r = reset(); self.endIfUncommitted('resize', 'rotate'); return r; };
      return h;
    };
    const createEdgeHandler = g.createEdgeHandler.bind(g);
    g.createEdgeHandler = (state: CellState, edgeStyle: any) => {
      const h = createEdgeHandler(state, edgeStyle) as any;
      const start = h.start.bind(h);
      h.start = (x: number, y: number, index: number) => { self.arm('bend', x, y, [state.cell.id!]); return start(x, y, index); };
      const reset = h.reset.bind(h);
      h.reset = () => { const r = reset(); self.endIfUncommitted('bend'); return r; };
      return h;
    };
    const editor = g.getPlugin('CellEditorHandler') as any;
    if (editor) {
      const start = editor.startEditing.bind(editor);
      editor.startEditing = (cell: Cell, trigger?: MouseEvent | null) => {
        const r = start(cell, trigger);
        if (editor.getEditingCell()) self.begin('text', [cell.id!]);
        return r;
      };
      const stop = editor.stopEditing.bind(editor);
      editor.stopEditing = (cancel = false) => {
        const r = stop(cancel);
        self.endIfUncommitted('text');
        return r;
      };
    }
  }

  private arm(kind: GestureKind, x: number, y: number, ids: string[]) {
    if (this.projecting || this.gesture || this.tool !== 'select') return;
    this.pending = { kind, x, y, ids };
  }

  private begin(kind: GestureKind, ids: string[]) {
    this.pending = null;
    if (this.projecting || this.gesture) return;
    this.gesture = kind;
    this.collected = [];
    this.emit({ type: 'gesture-begin', gesture: kind, ids });
  }

  /** Handler reset without a model change: the gesture ends with no edit (cancel). */
  private endIfUncommitted(...kinds: GestureKind[]) {
    this.pending = null;
    if (!this.gesture || !kinds.includes(this.gesture)) return;
    queueMicrotask(() => {
      if (!this.gesture || !kinds.includes(this.gesture)) return;
      const kind = this.gesture;
      this.gesture = null;
      this.emit({ type: 'gesture-cancel', gesture: kind });
    });
  }

  isGestureActive() { return this.gesture !== null; }

  cancelGesture() {
    this.pending = null;
    if (!this.gesture) return;
    const kind = this.gesture;
    this.gesture = null;
    const editor = this.graph.getPlugin('CellEditorHandler') as any;
    if (kind === 'text' && editor?.getEditingCell()) { this.projecting = true; try { editor.stopEditing(true); } finally { this.projecting = false; } }
    (this.graph.getPlugin('SelectionHandler') as any)?.reset?.();
    this.emit({ type: 'gesture-cancel', gesture: kind });
    if (this.snapshot && this.page) this.project(this.snapshot, this.page.id);
  }

  private onModelChange(changes: any[]) {
    if (this.projecting || !this.gesture) return;
    for (const c of changes) {
      const cell: Cell | undefined = c.cell;
      const id = cell?.id;
      if (!id) continue;
      if (c instanceof GeometryChange && c.geometry) {
        const geo = c.geometry;
        if (cell.isVertex()) this.collected.push({ kind: 'geometry', id, x: geo.x, y: geo.y, width: geo.width, height: geo.height });
        else {
          this.collected.push({ kind: 'points', id, points: (geo.points ?? []).map((p: MxPoint) => ({ x: p.x, y: p.y })) });
          for (const [end, source] of [['from', true], ['to', false]] as const) {
            const tp = geo.getTerminalPoint(source);
            if (tp && !cell.getTerminal(source)) this.collected.push({ kind: 'terminal', id, end, elementId: null, point: { x: tp.x, y: tp.y } });
          }
        }
      } else if (c instanceof StyleChange && cell.isVertex()) {
        this.collected.push({ kind: 'rotation', id, rotationDeg: Number((c.style as any)?.rotation ?? 0) });
      } else if (c instanceof ValueChange) {
        this.collected.push({ kind: 'text', id, value: String(c.value ?? '') });
      } else if (c instanceof TerminalChange) {
        const style: any = cell.getStyle() ?? {};
        const source = (c as any).source as boolean;
        const tid = (c as any).terminal?.id ?? null;
        const port = tid ? this.portName(tid, source ? style.exitX : style.entryX, source ? style.exitY : style.entryY) : undefined;
        this.collected.push({ kind: 'terminal', id, end: source ? 'from' : 'to', elementId: tid, ...(port ? { port } : {}) });
      }
    }
    if (this.collected.length === 0) return;
    // maxGraph applies one gesture as one model edit; report it as one completed gesture.
    const kind = this.gesture;
    const changesForGesture = this.collected;
    this.gesture = null;
    this.collected = [];
    queueMicrotask(() => this.emit({ type: 'gesture-end', gesture: kind, changes: changesForGesture }));
  }

  // ---------------- tools ----------------
  setTool(tool: 'select' | 'shape' | 'text' | 'connector') {
    this.tool = tool;
    this.graph.setConnectable(tool === 'connector');
    this.container.style.cursor = tool === 'select' ? '' : 'crosshair';
  }

  private onMouseDown(me: any) {
    if (this.tool === 'shape' || this.tool === 'text') {
      this.createStart = { x: me.getGraphX(), y: me.getGraphY() };
      me.consume();
    }
  }

  private onMouseMove(me: any) {
    const p = this.pending;
    if (p && Math.hypot(me.getGraphX() - p.x, me.getGraphY() - p.y) > Math.max(this.graph.getEventTolerance?.() ?? 4, 3)) this.begin(p.kind, p.ids);
  }

  private onMouseUp(me: any) {
    this.pending = null;
    if (!this.createStart || (this.tool !== 'shape' && this.tool !== 'text')) return;
    const a = this.screenToPage(this.createStart), b = this.screenToPage({ x: me.getGraphX(), y: me.getGraphY() });
    this.createStart = null;
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const bounds = w < 4 && h < 4
      ? { x: a.x, y: a.y, width: this.tool === 'text' ? 144 : 108, height: this.tool === 'text' ? 28 : 54 }
      : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(w, 4), height: Math.max(h, 4) };
    me.consume();
    this.emit({ type: 'create', tool: this.tool, bounds });
  }

  private onConnect(edge: Cell | null) {
    if (!edge) return;
    const style: any = edge.getStyle() ?? {};
    const src = edge.getTerminal(true)?.id ?? null, tgt = edge.getTerminal(false)?.id ?? null;
    const geo = edge.getGeometry();
    const end = (id: string | null, source: boolean) => {
      if (id) {
        const port = this.portName(id, source ? style.exitX : style.entryX, source ? style.exitY : style.entryY);
        return { elementId: id, ...(port ? { port } : {}) };
      }
      const tp = geo?.getTerminalPoint(source);
      return { point: { x: tp?.x ?? 0, y: tp?.y ?? 0 } };
    };
    this.projecting = true;
    try { this.graph.removeCells([edge]); } finally { this.projecting = false; }
    this.emit({ type: 'create', tool: 'connector', from: end(src, true), to: end(tgt, false) });
  }

  // ---------------- selection / viewport ----------------
  setSelection(ids: string[]) {
    const model = this.graph.getDataModel();
    this.projecting = true;
    try { this.graph.setSelectionCells(ids.map((id) => model.getCell(id)).filter((c): c is Cell => !!c)); } finally { this.projecting = false; }
  }

  getSelection(): string[] {
    return this.graph.getSelectionCells().map((c) => c.id!).filter(Boolean);
  }

  private screenToPage(p: Point): Point {
    // maxGraph graph coordinates are already scaled; convert to model units (pt).
    const v = this.graph.getView();
    return { x: p.x / v.scale - v.translate.x, y: p.y / v.scale - v.translate.y };
  }

  private clientToPage(p: Point): Point {
    const r = this.container.getBoundingClientRect();
    return this.screenToPage({ x: p.x - r.left + this.container.scrollLeft, y: p.y - r.top + this.container.scrollTop });
  }

  /** Test/inspection helper: rendered state of every cell (page coordinates), keyed by element ID. */
  cellStates(): Record<string, { x: number; y: number; width: number; height: number; points: Point[]; style: string; value: string }> {
    const v = this.graph.getView();
    const out: Record<string, any> = {};
    for (const cell of this.graph.getChildCells(this.graph.getDefaultParent(), true, true)) {
      const st = v.getState(cell);
      if (!st || !cell.id) continue;
      const pt = (q: { x: number; y: number }) => ({ x: +(q.x / v.scale - v.translate.x).toFixed(3), y: +(q.y / v.scale - v.translate.y).toFixed(3) });
      out[cell.id] = {
        x: +(st.x / v.scale - v.translate.x).toFixed(3), y: +(st.y / v.scale - v.translate.y).toFixed(3),
        width: +(st.width / v.scale).toFixed(3), height: +(st.height / v.scale).toFixed(3),
        points: (st.absolutePoints ?? []).filter(Boolean).map((q) => pt(q!)), style: JSON.stringify(cell.style), value: String(cell.value ?? ''),
      };
    }
    return out;
  }

  pageToClient(p: Point): Point {
    const v = this.graph.getView();
    const r = this.container.getBoundingClientRect();
    return { x: r.left + (p.x + v.translate.x) * v.scale - this.container.scrollLeft, y: r.top + (p.y + v.translate.y) * v.scale - this.container.scrollTop };
  }

  zoom(factor: number, around?: Point) {
    const v = this.graph.getView();
    const next = Math.min(8, Math.max(0.1, this.zoomLevel * factor));
    const anchor = around ?? this.screenToPage({ x: this.container.clientWidth / 2, y: this.container.clientHeight / 2 });
    const screen = { x: (anchor.x + v.translate.x) * v.scale, y: (anchor.y + v.translate.y) * v.scale };
    this.zoomLevel = next;
    const s = next * PX_PER_PT;
    v.scaleAndTranslate(s, screen.x / s - anchor.x, screen.y / s - anchor.y);
  }

  fit(target: 'page' | 'selection' | 'actual') {
    if (!this.page) return;
    const v = this.graph.getView();
    const cw = this.container.clientWidth || 800, ch = this.container.clientHeight || 600;
    let box = { x: 0, y: 0, width: this.page.widthPt, height: this.page.heightPt };
    if (target === 'selection') {
      const sel = this.getSelection().map((id) => this.element(id)).filter((e): e is Element => !!e);
      if (sel.length) {
        const xs = sel.flatMap((e) => [e.bounds.x, e.bounds.x + e.bounds.width]), ys = sel.flatMap((e) => [e.bounds.y, e.bounds.y + e.bounds.height]);
        box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      }
    }
    const margin = 24;
    this.zoomLevel = target === 'actual' ? 1 : Math.max(0.1, Math.min(8, Math.min((cw - 2 * margin) / (box.width * PX_PER_PT), (ch - 2 * margin) / (box.height * PX_PER_PT))));
    const s = this.zoomLevel * PX_PER_PT;
    v.scaleAndTranslate(s, (cw / s - box.width) / 2 - box.x, (ch / s - box.height) / 2 - box.y);
  }

  dispose() {
    for (const c of this.cleanup) c();
    this.graph?.destroy();
  }
}
