import {
  Graph, InternalEvent, VertexHandler, EdgeHandler, SelectionHandler, CellEditorHandler,
  VertexHandlerConfig, GeometryChange, type Cell,
} from '@maxgraph/core';
import type { GestureEvent, GestureKind, ProbeIntent, ProbeSceneDto } from './types';

VertexHandlerConfig.rotationEnabled = true;

/**
 * Projects a plain ProbeSceneDto into maxGraph and translates committed gestures into
 * plain intents. Cells never leave this module; the store remains the authority.
 */
export class ProbeCanvas {
  readonly graph: Graph;
  private projecting = false;
  private gesture: GestureKind | null = null;
  /** Handler armed on pointer-down; becomes an active gesture only after drag tolerance. */
  private pending: { kind: GestureKind; x: number; y: number } | null = null;
  private listeners: ((intents: ProbeIntent[]) => void)[] = [];
  readonly gestureLog: GestureEvent[] = [];
  private scene!: ProbeSceneDto;

  constructor(container: HTMLElement, interactive = true) {
    this.graph = new Graph(container);
    // New edges are created by tools, not by dragging from a vertex centre (which would
    // otherwise swallow move gestures). Existing endpoints can be re-glued via EdgeHandler.
    this.graph.setConnectable(false);
    this.graph.setEnabled(interactive);
    this.graph.setCellsDisconnectable(true);
    this.graph.setAllowDanglingEdges(false);
    this.graph.setHtmlLabels(false);
    if (interactive) {
      this.graph.getDataModel().addListener(InternalEvent.CHANGE, (_s: unknown, evt: any) => this.onModelChange(evt.getProperty('edit').changes));
      this.hookGestures();
    }
  }

  onIntents(listener: (intents: ProbeIntent[]) => void) { this.listeners.push(listener); }

  isGestureActive() { return this.gesture !== null; }

  project(scene: ProbeSceneDto) {
    this.scene = scene;
    this.projecting = true;
    const g = this.graph;
    try {
      g.batchUpdate(() => {
        const parent = g.getDefaultParent();
        g.removeCells(g.getChildCells(parent), true);
        const r = scene.rect, e = scene.ellipse, p = scene.picture;
        g.insertVertex({ parent, id: r.id, value: r.text, position: [r.x, r.y], size: [r.width, r.height],
          style: { fillColor: '#1F77B4', fontColor: '#ffffff', rotation: r.rotation } });
        g.insertVertex({ parent, id: e.id, value: e.text, position: [e.x, e.y], size: [e.width, e.height],
          style: { shape: 'ellipse', perimeter: 'ellipsePerimeter', rotation: e.rotation } });
        g.insertVertex({ parent, id: p.id, value: '', position: [p.x, p.y], size: [p.width, p.height],
          style: { shape: 'image', image: p.assetDataUrl, rotation: p.rotation, editable: false } });
        const byId = (id: string) => g.getDataModel().getCell(id);
        g.insertEdge({ parent, id: scene.connector.id, value: '', source: byId(scene.connector.from.elementId),
          target: byId(scene.connector.to.elementId), style: { edgeStyle: 'orthogonalEdgeStyle', endArrow: 'classic' } });
      });
    } finally {
      this.projecting = false;
    }
  }

  private emitGesture(phase: GestureEvent['phase'], kind: GestureKind) {
    this.gestureLog.push({ phase, kind, revision: this.scene.revision });
  }

  private arm(kind: GestureKind, x: number, y: number) {
    if (this.projecting || this.gesture) return;
    this.pending = { kind, x, y };
  }

  private begin(kind: GestureKind) {
    this.pending = null;
    if (this.projecting || this.gesture) return;
    this.gesture = kind;
    this.emitGesture('begin', kind);
  }

  private end(phase: 'commit' | 'cancel') {
    if (!this.gesture) return;
    this.emitGesture(phase, this.gesture);
    this.gesture = null;
  }

  private hookGestures() {
    const self = this;
    const tolerance = () => Math.max(this.graph.getEventTolerance?.() ?? 4, 2);
    this.graph.addMouseListener({
      mouseDown() {},
      mouseMove(_s: unknown, me: any) {
        const p = self.pending;
        if (p && Math.hypot(me.getGraphX() - p.x, me.getGraphY() - p.y) > tolerance()) self.begin(p.kind);
      },
      mouseUp() { self.pending = null; },
    });
    // Begin hooks: maxGraph handlers' start() runs only when a drag actually starts,
    // so selection clicks, rubber-band selection and zoom never activate the hook.
    const moveStart = SelectionHandler.prototype.start;
    SelectionHandler.prototype.start = function (this: SelectionHandler, ...a: Parameters<typeof moveStart>) {
      self.arm('move', a[1], a[2]);
      return moveStart.apply(this, a);
    };
    const moveReset = SelectionHandler.prototype.reset;
    SelectionHandler.prototype.reset = function (this: SelectionHandler) {
      const r = moveReset.apply(this);
      if (self.gesture === 'move') self.cancelGesture();
      return r;
    };
    const vStart = VertexHandler.prototype.start;
    VertexHandler.prototype.start = function (this: VertexHandler, x: number, y: number, index: number) {
      self.arm(index === InternalEvent.ROTATION_HANDLE ? 'rotate' : 'resize', x, y);
      return vStart.call(this, x, y, index);
    };
    const vReset = VertexHandler.prototype.reset;
    VertexHandler.prototype.reset = function (this: VertexHandler) {
      const r = vReset.apply(this);
      if (self.gesture === 'rotate' || self.gesture === 'resize') self.cancelGesture();
      return r;
    };
    const eStart = EdgeHandler.prototype.start;
    EdgeHandler.prototype.start = function (this: EdgeHandler, x: number, y: number, index: number) {
      self.arm('bend', x, y);
      return eStart.call(this, x, y, index);
    };
    const eReset = EdgeHandler.prototype.reset;
    EdgeHandler.prototype.reset = function (this: EdgeHandler) {
      const r = eReset.apply(this);
      if (self.gesture === 'bend') self.cancelGesture();
      return r;
    };
    const tStart = CellEditorHandler.prototype.startEditing;
    CellEditorHandler.prototype.startEditing = function (this: CellEditorHandler, cell: Cell, trigger?: MouseEvent | null) {
      // startEditing internally stops any previous edit, so begin only afterwards.
      const r = tStart.call(this, cell, trigger);
      if (this.getEditingCell()) self.begin('text');
      return r;
    };
    const tStop = CellEditorHandler.prototype.stopEditing;
    CellEditorHandler.prototype.stopEditing = function (this: CellEditorHandler, cancel = false) {
      const r = tStop.call(this, cancel);
      if (self.gesture === 'text') self.cancelGesture();
      return r;
    };
  }

  /** Cancels any active gesture: the preview is discarded and the store snapshot re-projected. */
  cancelGesture() {
    this.pending = null;
    if (!this.gesture) return;
    this.end('cancel');
    this.project(this.scene);
  }

  private onModelChange(changes: unknown[]) {
    if (this.projecting) return;
    const intents: ProbeIntent[] = [];
    for (const c of changes as any[]) {
      const cell: Cell | undefined = c.cell;
      if (!cell?.id) continue;
      if (c instanceof GeometryChange && cell.isVertex() && c.geometry) {
        const geo = c.geometry;
        intents.push({ kind: 'geometry', id: cell.id, x: geo.x, y: geo.y, width: geo.width, height: geo.height });
      } else if (c.constructor?.name === 'StyleChange' && cell.isVertex()) {
        intents.push({ kind: 'rotation', id: cell.id, rotation: Number(c.style?.rotation ?? 0) });
      } else if (c.constructor?.name === 'ValueChange' && cell.isVertex()) {
        intents.push({ kind: 'text', id: cell.id, text: String(c.value ?? '') });
      } else if (c.constructor?.name === 'TerminalChange' && cell.isEdge() && c.terminal?.id) {
        intents.push({ kind: 'connect', id: cell.id, end: c.source ? 'from' : 'to', elementId: c.terminal.id });
      }
    }
    if (intents.length === 0) return;
    const kind = this.gesture;
    if (kind) {
      this.gestureLog.push({ phase: 'commit', kind, revision: this.scene.revision });
      this.gesture = null;
    }
    // Defer so maxGraph finishes its own event dispatch before the store re-projects.
    queueMicrotask(() => this.listeners.forEach((l) => l(intents)));
  }
}
