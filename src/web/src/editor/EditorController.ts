import { CommandEngine } from '../commands/CommandEngine';
import type { Asset, Bounds, DiagramDocument, Element, Operation, Page, Snapshot, TransactionResult, TransactionSummary } from '../model/types';
import type { Result } from '../model/result';
import { newDocument } from '../model/defaults';
import type { CanvasAdapter, CanvasIntent } from '../canvas/CanvasAdapter';
import { GestureController, type GestureToken } from '../canvas/GestureController';
import { gestureOperations } from '../canvas/translate';
import { SnapshotProjector } from '../canvas/SnapshotProjector';
import type { Unit } from '../model/units';
import { isLocked, isVisible } from '../canvas/styleMap';
import type { AssetResolver } from './assets';

export type Tool = 'select' | 'shape' | 'text' | 'connector';
export type EditorState = {
  snapshot: Snapshot;
  pageId: string;
  selection: string[];
  tool: Tool;
  shapePreset: string;
  units: Unit;
  status: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  lastResult: TransactionResult | null;
  transactions: TransactionSummary[];
  gestureActive: boolean;
};

/**
 * Application state for the manual editor. Every document change goes through
 * CommandEngine.execute/undo/redo (source "gui"); the canvas only projects snapshots and
 * reports intents. No mutation shortcut bypasses the engine.
 */
export class EditorController {
  readonly engine: CommandEngine;
  readonly gestures: GestureController;
  readonly projector = new SnapshotProjector();
  private adapter: CanvasAdapter | null = null;
  private listeners = new Set<() => void>();
  private state: EditorState;
  private token: GestureToken | null = null;
  private clipboard: string[] = [];

  constructor(readonly assets: AssetResolver, document?: DiagramDocument) {
    const doc = document ?? newDocument(crypto.randomUUID(), crypto.randomUUID());
    this.engine = new CommandEngine({ document: doc });
    this.gestures = new GestureController(this.engine, { onStatus: (m) => this.set({ status: m }) });
    this.gestures.onGestureState((active) => this.set({ gestureActive: active }));
    this.engine.setSnapshotProjector((s) => this.projector.project(s));
    this.engine.setProjector((snapshot) => this.adapter ? this.adapter.project(snapshot, this.pageIdFor(snapshot)) : { ok: true, value: undefined });
    this.engine.onCommitted((e) => {
      // Backstop: a mutation admitted before the gesture started has landed; the preview is stale.
      if (this.token && e.revision > this.token.baseRevision) {
        const stale = this.token;
        this.token = null;
        this.gestures.cancel(stale);
        this.adapter?.cancelGesture();
        this.set({ status: 'Your edit was discarded because the document changed during the gesture.' });
      }
      void this.refresh();
    });
    this.engine.onLifecycle(() => { this.gestures.cancelAll(); this.adapter?.cancelGesture(); this.refresh(true); });
    const snapshot = this.engine.current();
    this.state = {
      snapshot, pageId: snapshot.document.pages[0].id, selection: [], tool: 'select', shapePreset: 'rectangle', units: 'mm', status: 'Ready',
      dirty: this.engine.isDirty(), canUndo: false, canRedo: false, lastResult: null, transactions: [], gestureActive: false,
    };
  }

  // ---------- subscription ----------
  subscribe = (l: () => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getState = () => this.state;
  private set(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private pageIdFor(snapshot: Snapshot) {
    return snapshot.document.pages.some((p) => p.id === this.state?.pageId) ? this.state.pageId : snapshot.document.pages[0].id;
  }

  private async refresh(projectAll = false) {
    const snapshot = this.engine.current();
    const pageId = this.pageIdFor(snapshot);
    const ids = new Set(snapshot.document.pages.flatMap((p) => p.elements.map((e) => e.id)));
    const changes = await this.engine.getChanges(this.engine.scope(), Math.max(0, snapshot.revision - 20));
    this.set({
      snapshot, pageId, selection: this.state.selection.filter((id) => ids.has(id)),
      dirty: this.engine.isDirty(), canUndo: this.engine.canUndo(), canRedo: this.engine.canRedo(),
      transactions: changes.ok ? changes.value.transactions.slice(-20) : this.state.transactions,
    });
    if (projectAll) this.adapter?.project(snapshot, pageId);
  }

  // ---------- canvas wiring ----------
  attach(adapter: CanvasAdapter) {
    this.adapter = adapter;
    adapter.onIntent((i) => void this.onIntent(i));
    adapter.project(this.engine.current(), this.state.pageId);
    adapter.setTool(this.state.tool);
  }

  detach() { this.adapter = null; }

  page(): Page {
    return this.state.snapshot.document.pages.find((p) => p.id === this.state.pageId)!;
  }

  element(id: string): Element | undefined {
    return this.page().elements.find((e) => e.id === id);
  }

  private async onIntent(i: CanvasIntent) {
    switch (i.type) {
      case 'selection':
        this.set({ selection: i.ids.filter((id) => this.element(id)) });
        return;
      case 'gesture-begin':
        this.token = this.gestures.begin(i.gesture, { ...this.engine.scope(), pageId: this.state.pageId }, i.ids);
        return;
      case 'gesture-cancel':
        if (this.token) this.gestures.cancel(this.token);
        this.token = null;
        this.adapter?.project(this.engine.current(), this.state.pageId);
        return;
      case 'gesture-end': {
        const token = this.token ?? this.gestures.begin(i.gesture, { ...this.engine.scope(), pageId: this.state.pageId }, []);
        this.token = null;
        const startPage = this.engine.current().document.pages.find((p) => p.id === this.state.pageId)!;
        const ops = gestureOperations(startPage, i.gesture, i.changes);
        const r = await this.gestures.commit(token, ops);
        if (!r.ok) this.adapter?.project(this.engine.current(), this.state.pageId); // discard the preview
        else this.set({ lastResult: r.value });
        return;
      }
      case 'create':
        if (i.tool === 'connector' && i.from && i.to) {
          const end = (x: typeof i.from) => (x!.elementId ? { target: x!.elementId, ...(x!.port ? { port: x!.port } : {}) } : { point: x!.point! });
          await this.apply([{ op: 'create', pageId: this.state.pageId, element: { kind: 'connector', from: end(i.from), to: end(i.to) } }], 'Add connector');
        } else if (i.bounds) {
          const r = i.tool === 'text' ? await this.createText(i.bounds) : await this.createShape(this.state.shapePreset, i.bounds);
          if (r.ok) this.setTool('select');
        }
        return;
    }
  }

  // ---------- commands ----------
  async apply(operations: Operation[], description?: string): Promise<Result<TransactionResult>> {
    if (this.gestures.isActive()) return { ok: false, error: { code: 'busy_user_editing', message: 'finish the current gesture first', retryable: true } };
    const s = this.engine.scope();
    const r = await this.engine.execute({ ...s, pageId: this.state.pageId, transactionId: crypto.randomUUID(), baseRevision: s.revision, atomic: true, operations, ...(description ? { description } : {}) }, 'gui');
    if (r.ok) {
      const select = r.value.created.filter((id) => this.engine.current().document.pages.some((p) => p.elements.some((e) => e.id === id && p.id === this.state.pageId)));
      this.set({ lastResult: r.value, status: r.value.noChange ? 'No change' : `Revision ${r.value.revision}`, ...(select.length ? { selection: select } : {}) });
      if (select.length) this.adapter?.setSelection(select);
    } else this.set({ status: r.error.message });
    return r;
  }

  createShape(preset: string, bounds: Bounds, text?: string) {
    return this.apply([{ op: 'create', pageId: this.state.pageId, element: { kind: 'shape', bounds, geometry: { preset: preset as any }, ...(text !== undefined ? { text: { value: text } } : {}) } }], `Add ${preset}`);
  }

  createText(bounds: Bounds, value = 'Text') {
    return this.apply([{ op: 'create', pageId: this.state.pageId, element: { kind: 'text', bounds, text: { value } } }], 'Add text');
  }

  /** Registers a prepared asset and creates its image in one transaction. */
  insertImage(asset: Asset, at: { x: number; y: number } = { x: 72, y: 72 }) {
    const w = Math.min(200, asset.widthPx ?? 100), h = w * ((asset.heightPx ?? 100) / (asset.widthPx ?? 100));
    const exists = this.state.snapshot.document.assets.some((a) => a.id === asset.id);
    return this.apply([
      ...(exists ? [] : [{ op: 'registerAsset', asset } as Operation]),
      { op: 'create', pageId: this.state.pageId, element: { kind: 'image', assetId: asset.id, bounds: { x: at.x, y: at.y, width: w, height: h } } },
    ], `Insert image ${asset.name}`);
  }

  async undo() {
    const s = this.engine.scope();
    const r = await this.engine.undo({ ...s, transactionId: crypto.randomUUID(), baseRevision: s.revision });
    this.set({ status: r.ok ? `Undo → revision ${r.value.revision}` : r.error.message, ...(r.ok ? { lastResult: r.value } : {}) });
    return r;
  }

  async redo() {
    const s = this.engine.scope();
    const r = await this.engine.redo({ ...s, transactionId: crypto.randomUUID(), baseRevision: s.revision });
    this.set({ status: r.ok ? `Redo → revision ${r.value.revision}` : r.error.message, ...(r.ok ? { lastResult: r.value } : {}) });
    return r;
  }

  /** Selected top-level targets (descendants of selected groups are excluded). */
  selectedTargets(): string[] {
    return this.state.selection.filter((id) => this.element(id));
  }

  deleteSelection() {
    const ids = this.selectedTargets();
    if (!ids.length) return;
    return this.apply(ids.map((id) => {
      const e = this.element(id)!;
      return { op: 'delete', target: id, connectors: 'detach', ...(e.kind === 'group' ? { subtree: true } : {}) } as Operation;
    }), `Delete ${ids.length}`);
  }

  copy() { this.clipboard = this.selectedTargets(); this.set({ status: `Copied ${this.clipboard.length}` }); }
  paste() {
    const live = this.clipboard.filter((id) => this.element(id));
    if (live.length) return this.apply([{ op: 'duplicate', targets: live, offset: { xPt: 14.17, yPt: 14.17 } }], 'Paste');
  }
  duplicate() {
    const ids = this.selectedTargets();
    if (ids.length) return this.apply([{ op: 'duplicate', targets: ids }], 'Duplicate');
  }

  nudge(dx: number, dy: number) {
    const ids = this.selectedTargets().filter((id) => !isLocked(this.page(), this.element(id)!));
    if (ids.length) return this.apply(ids.map((id) => ({ op: 'move', target: id, delta: { xPt: dx, yPt: dy } }) as Operation), 'Nudge');
  }

  selectAll() {
    const ids = this.page().elements.filter((e) => isVisible(this.page(), e)).map((e) => e.id);
    this.setSelection(ids);
  }

  setSelection(ids: string[]) {
    this.set({ selection: ids });
    this.adapter?.setSelection(ids);
  }

  setTool(tool: Tool, shapePreset?: string) {
    this.set({ tool, ...(shapePreset ? { shapePreset } : {}) });
    this.adapter?.setTool(tool);
  }

  setUnits(units: Unit) { this.set({ units }); }
  setStatus(status: string) { this.set({ status }); }

  setPage(pageId: string) {
    if (!this.state.snapshot.document.pages.some((p) => p.id === pageId)) return;
    this.gestures.cancelAll();
    this.adapter?.cancelGesture();
    this.set({ pageId, selection: [] });
    this.adapter?.project(this.engine.current(), pageId);
  }

  zoom(factor: number) { this.adapter?.zoom(factor); }
  fit(target: 'page' | 'selection' | 'actual') { this.adapter?.fit(target); }

  /** Keyboard shortcuts familiar from desktop drawing tools. */
  handleKey(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
    const mod = e.ctrlKey || e.metaKey;
    const step = e.shiftKey ? 10 : 1;
    if (mod && e.key.toLowerCase() === 'z') { void (e.shiftKey ? this.redo() : this.undo()); return true; }
    if (mod && e.key.toLowerCase() === 'y') { void this.redo(); return true; }
    if (mod && e.key.toLowerCase() === 'c') { this.copy(); return true; }
    if (mod && e.key.toLowerCase() === 'v') { void this.paste(); return true; }
    if (mod && e.key.toLowerCase() === 'd') { void this.duplicate(); return true; }
    if (mod && e.key.toLowerCase() === 'a') { this.selectAll(); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { void this.deleteSelection(); return true; }
    if (e.key === 'Escape') { this.adapter?.cancelGesture(); this.setTool('select'); return true; }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[e.key] && this.state.selection.length) { void this.nudge(...arrows[e.key]); return true; }
    return false;
  }
}
