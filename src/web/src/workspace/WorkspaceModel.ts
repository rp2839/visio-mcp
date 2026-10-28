import { EditorModel, noHost, type HostApi, type RecentEntry } from '../editor/EditorModel';
import type { AgentDocument } from '../bridge/engineHandlers';
import type { DiagramDocument, Scope } from '../contracts/generated';
import { fail, ok, type Result } from '../model/result';
import type { DocumentState } from './Workspace';
import { HelpState } from './HelpState';
import type { startApp } from '../bridge/bootstrap';
import { FileIngressModel, type IngressBatch, type IngressQueueItem, type IngressTarget } from './FileIngressModel';
import { mapIngressDropPoint } from './ingressGeometry';
import { clipboardPasteAction } from '../commands/clipboardPaste';

type App = ReturnType<typeof startApp>;

/** Soft limit: past this the person is told to close some. Each tab keeps its own history, so the cost is bounded but real. */
export const TAB_LIMIT = 20;

/**
 * The window's tabs: one `EditorModel` per open document, the active one shown. It owns what belongs to the window rather than a
 * document: which tab is active, opening, closing and switching, and the two ways a close can be asked (a tab, or the whole window).
 */
export class WorkspaceModel {
  readonly ingress = new FileIngressModel();
  private checkingFiles = false;
  async checkFiles(): Promise<void> {
    if (this.preferences.dialogOpen) return;
    if(this.checkingFiles)return;this.checkingFiles=true;
    try{for(const tab of [...this.tabs]) if(this.tabs.includes(tab)) await tab.files.check();}finally{this.checkingFiles=false;}
  }
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private untitled = 0;
  private hostApi: HostApi = noHost;
  /** The Help panels (shortcut list, About, command palette). */
  readonly help = new HelpState(() => this.hostApi.appAbout(), () => this.bump());
  private readonly unsubscribe = new Map<EditorModel, () => void>();
  /** Set by the page: gives a new tab its editor wiring (component previews, renderer, recovery hooks). */
  configure: (model: EditorModel, state: DocumentState) => void = () => {};
  /** A short message the strip shows (for example, the tab limit). */
  notice: string | null = null;
  /** Window-wide settings warning, independent of tab status and restore notices. */
  get preferencesDiagnostic(): string | null { return this.app.preferences.diagnostic; }
  get preferences() { return this.app.preferences; }
  async openPreferences(): Promise<void> {
    if (this.isBusy() || this.recentPrompt || this.help.panel || this.tabs.some(t => t.closePrompt || t.newDocument.prompt || t.exportPrompt || t.report || t.connectPrompt || t.files.prompt || t.recoveryOffers.length || t.recoveryReport)) return;
    await this.preferences.open();
  }
  applyPreferencesUnits(units: import('../model/validate').Unit): void {
    for (const tab of this.tabs) { tab.unit = units; tab.bump(); }
    this.bump();
  }
  recentPrompt = false;
  showRecent(): void { if (this.preferences.dialogOpen) return; this.recentPrompt = true; this.bump(); }
  closeRecent(): void { this.recentPrompt = false; this.bump(); }
  async openRecent(entry: RecentEntry): Promise<{ opened: boolean; error?: string }> {
    const existing = entry.kind === 'json' ? this.tabs.find(t => sameFile(t.engine.status().savedPath, entry.path)) : undefined;
    if (existing) { this.activate(existing); return { opened: true }; }
    return this.openFile(entry.kind, entry.id);
  }
  protectNew: (scope: Scope) => Promise<Result<unknown>> = async () => ok({});
  /** Said once after a start that brought documents back; stays until dismissed. */
  banner: { text: string; lines: string[] } | null = null;
  dismissBanner(): void { this.banner = null; this.bump(); }
  /** Documents agents have open in the background; each shows as a tab that is brought here when clicked. */
  agentDocs: AgentDocument[] = [];
  /** The agent tab whose close button was pressed once; a second press confirms throwing its work away. */
  armedDiscard: string | null = null;
  /** True while the person is mid-gesture: documents are not moved or switched under their hands. Set by the page. */
  isBusy: () => boolean = () => false;
  /** Tabs most recently used first: what Ctrl+Tab steps through. */
  private mru: EditorModel[] = [];
  private cycling: { order: EditorModel[]; index: number } | null = null;
  /** Said to screen readers when the tab order changes. */
  liveMessage = '';
  private persisting = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersisted = '';

  constructor(private readonly app: App, first: EditorModel) {
    app.preferences.subscribe(() => this.bump());
    this.ingress.subscribe(() => this.bump());
    this.adopt(first, app.workspace.active!);
    // every document that appears in the workspace gets an editor, whoever opened it (the person, or an agent in the background)
    this.touch(first);
    app.workspace.subscribe(e => {
      if (e.kind === 'opened' && !e.state.ui) {
        const model = new EditorModel(e.state.engine);
        this.adopt(model, e.state);
        this.configure(model, e.state);
      }
      if (e.kind === 'opened' && app.workspace.active === e.state) this.touch(e.state.ui as EditorModel);
      else if (e.kind === 'activated') this.touch(e.state.ui as EditorModel);
      else if (e.kind === 'closed') this.mru = this.mru.filter(m => this.tabs.includes(m));
      this.bump();
    });
  }

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  bump(): void { this.version++; for (const l of this.listeners) l(); this.schedulePersist(); }

  get host(): HostApi { return this.hostApi; }
  set host(h: HostApi) { this.hostApi = h; for (const m of this.tabs) m.host = h; }

  async pasteFromClipboard(): Promise<void> {
    const target = this.active;
    await target.waitForInternalCopyMarker();
    const described = await this.hostApi.clipboardDescribe();
    if (!described.ok && target.hasInternalCopy) {
      target.say('The system clipboard is busy; using the in-memory diagram copy.', 'info');
      await target.paste();
      return;
    }
    const descriptor = described.ok ? described.value : null;
    const action = clipboardPasteAction(descriptor, target.internalCopyId, target.hasInternalCopy);
    if (action === 'internal') { await target.paste(); return; }
    if (action === 'text') { target.say('Text from the system clipboard cannot be pasted as a diagram object.', 'info'); return; }
    if (action === 'none') { target.say('Nothing to paste.', 'info'); return; }
    if (!descriptor) return;
    const scope = target.engine.scope();
    const imported = await this.hostApi.importClipboardImage(descriptor.sequence, scope);
    if (!imported.ok) { target.say(imported.error.message, 'warning'); return; }
    this.ingress.enqueue({ batchId: imported.value.batchId, items: [imported.value.item], rejections: [] }, {
      ...scope, baseRevision: target.engine.revision,
      placement: { pageId: target.currentPage.id, x: target.currentPage.widthPt / 2, y: target.currentPage.heightPt / 2 },
    });
    void this.processIngress();
  }

  /** Tabs in order. */
  get tabs(): EditorModel[] { return this.app.workspace.documents.map(d => d.ui as EditorModel).filter(Boolean); }
  get active(): EditorModel { return this.app.workspace.active!.ui as EditorModel; }

  private adopt(model: EditorModel, state: DocumentState): void {
    state.ui = model;
    model.untitledNo = ++this.untitled;
    model.host = this.hostApi;
    model.pasteFromClipboard = () => this.pasteFromClipboard();
    model.unit = this.preferences.current.units;
    model.closeTabNow = discard => this.closeNow(model, discard);
    model.newDocument.snapshotDefaults = this.app.preferences.snapshotDefaults;
    model.newDocument.canStart = () => !this.preferences.dialogOpen && !model.controller.isActive() && !model.closePrompt && !model.recoveryOffers.length;
    model.files.canPresent = () => !this.preferences.dialogOpen && !this.recentPrompt && !model.controller.isActive() && !model.closePrompt && !model.newDocument.prompt && !model.recoveryOffers.length && !model.recoveryReport;
    model.newDocument.replacesCurrent = false;
    model.newDocument.create = async document => {
      const target = this.newTab({ document });
      if (!target) return { ok: false, error: { code: 'invalid_request', message: this.notice!, retryable: false } };
      try {
        const protectedResult = await this.protectNew(target.engine.scope());
        if (!protectedResult.ok) target.say('Created the new drawing, but recovery could not protect it. Save it now: ' + protectedResult.error.message, 'warning');
        else target.say('Created a new untitled drawing. Save it to keep it.', 'info');
      } catch { target.say('Created the new drawing, but recovery could not protect it. Save it now.', 'warning'); }
      return ok(target.engine.scope());
    };
    model.newDocument.created = () => {}; // the previous editor, history and view belong to its existing tab

    this.unsubscribe.set(model, model.subscribe(() => this.bump())); // what any tab shows can change the strip (its name, its unsaved dot)
  }

  private stateOf(model: EditorModel): DocumentState | null { return this.app.workspace.stateOfEngine(model.engine); }

  // ------------------------------------------------------------------ tabs
  /** A new untitled document in a new tab, which becomes the active one. Null if the tab limit was reached. */
  newTab(opts: { activate?: boolean; document?: DiagramDocument } = {}): EditorModel | null {
    if (this.preferences.dialogOpen) return null;
    if (this.app.workspace.documents.length >= TAB_LIMIT) { this.notice = `You have ${TAB_LIMIT} documents open. Close some before opening more.`; this.bump(); return null; }
    this.notice = null;
    const state = this.app.openDocument({ ...(opts.activate === undefined ? {} : { activate: opts.activate }), ...(opts.document ? { document: { document: opts.document, explicitUnsaved: true } } : {}) });
    return state.ui as EditorModel;
  }

  activate(model: EditorModel): void {
    if (this.preferences.dialogOpen) return;
    const s = this.stateOf(model);
    if (s && this.app.workspace.active !== s) { this.app.activateDocument(s.engine.scope().documentId); this.bump(); }
  }

  private touch(model: EditorModel | null): void {
    if (!model || this.cycling) return; // while Ctrl+Tab is held the order stays as it was when it began
    this.mru = [model, ...this.mru.filter(m => m !== model)];
  }

  /**
   * Ctrl+Tab: step through the tabs most recently used first, as long as Ctrl stays down (the first press goes to the previous tab, and
   * pressing Ctrl+Tab twice quickly toggles between two). Releasing Ctrl makes the chosen tab the most recent (`endCycle`).
   */
  cycle(delta: 1 | -1): void {
    if (this.preferences.dialogOpen) return;
    const tabs = this.tabs;
    if (tabs.length < 2) return;
    if (!this.cycling) this.cycling = { order: [...this.mru.filter(m => tabs.includes(m)), ...tabs.filter(t => !this.mru.includes(t))], index: 0 };
    const c = this.cycling;
    c.index = (c.index + delta + c.order.length) % c.order.length;
    this.activate(c.order[c.index]!);
  }

  endCycle(): void {
    const c = this.cycling;
    if (!c) return;
    this.cycling = null;
    this.touch(c.order[c.index]!);
  }

  /** Moves a tab to a position in the tab order (the order is remembered with the rest of the workspace). */
  moveTab(model: EditorModel, index: number): void {
    if (this.preferences.dialogOpen) return;
    const s = this.stateOf(model);
    if (!s) return;
    const before = this.tabs.indexOf(model);
    this.app.workspace.move(s.engine.scope().documentId, index);
    const after = this.tabs.indexOf(model);
    if (after !== before) this.liveMessage = `${model.tabLabel} moved to position ${after + 1} of ${this.tabs.length}`;
    this.bump();
  }

  /** Steps to the next (or previous) tab in tab order, wrapping round. */
  step(delta: 1 | -1): void {
    if (this.preferences.dialogOpen) return;
    const tabs = this.tabs;
    if (tabs.length < 2) return;
    const i = tabs.indexOf(this.active);
    this.activate(tabs[(i + delta + tabs.length) % tabs.length]!);
  }

  /** Opens a file in a tab: an untouched blank tab is used up first; opening a file that is already open shows that tab instead. */
  async openFile(kind: 'json' | 'vsdx' = 'json', recentId?: string, file?: string): Promise<{ opened: boolean; error?: string }> {
    if (this.preferences.dialogOpen) return { opened: false, error: 'Preferences is open' };
    const reuse = this.active.isBlank ? this.active : null;
    const target = reuse ?? this.newTab();
    if (!target) return { opened: false, error: this.notice ?? 'Cannot open another tab' };
    let outcome: { opened: boolean; path?: string; error?: string };
    try { outcome = kind === 'json' ? await target.open(file, recentId) : await target.openVsdx(recentId, file); }
    catch (error) { outcome = { opened: false, error: String(error) }; }
    if (!outcome.opened) { if (!reuse) await this.closeNow(target, true); return outcome; }
    const path = outcome.path;
    if (path) {
      const existing = this.tabs.find(t => t !== target && sameFile(t.engine.status().savedPath, path));
      if (existing) { await this.closeNow(target, true); this.activate(existing); existing.say(`${path} is already open.`, 'info'); }
    }
    this.bump();
    return { opened: true };
  }

  enqueueIngress(batch: IngressBatch): void {
    const target = this.active;
    let pinned: IngressTarget = { ...target.engine.scope(), baseRevision: target.engine.revision };
    if (batch.target) {
      const received = batch.target;
      const source = this.tabs.find(tab => tab.engine.scope().documentId === received.documentId && tab.engine.scope().sessionId === received.sessionId);
      if (source !== target || source.engine.revision !== received.baseRevision || source.currentPage.id !== received.pageId) {
        void this.hostApi.dismissIngress(batch.items.map(item => item.ticketId));
        return;
      }
      pinned = {
        documentId: received.documentId, sessionId: received.sessionId, baseRevision: received.baseRevision,
        placement: { pageId: received.pageId, x: received.x, y: received.y },
      };
    }
    this.ingress.enqueue(batch, pinned);
    void this.processIngress();
  }

  captureIngressTarget(point: { clientX: number; clientY: number }): { documentId: string; sessionId: string; baseRevision: number; pageId: string; x: number; y: number } | null {
    const source = this.active;
    const rect = document.querySelector<HTMLElement>('[data-testid="canvas"]')?.getBoundingClientRect();
    const viewport = source.viewport;
    if (!rect || !viewport) return null;
    const mapped = mapIngressDropPoint({ x: point.clientX, y: point.clientY }, rect, viewport);
    if (!mapped) return null;
    const scope = source.engine.scope();
    return { ...scope, baseRevision: source.engine.revision, pageId: source.currentPage.id, ...mapped };
  }

  async placeIngressImage(ticketId: string): Promise<void> {
    const item = this.ingress.items.find(candidate => candidate.ticketId === ticketId && candidate.status === 'offered');
    if (!item?.image || item.kind !== 'image') return;
    const source = this.tabs.find(tab => tab.engine.scope().documentId === item.target.documentId && tab.engine.scope().sessionId === item.target.sessionId);
    const placement = item.target.placement;
    if (!source || source.engine.revision !== item.target.baseRevision || (placement && source.currentPage.id !== placement.pageId)) {
      this.ingress.setImageMessage(ticketId, 'The original drawing, page, or revision changed. Choose a fresh placement or keep this picture in the library.');
      return;
    }
    const at = placement ? { pageId: placement.pageId, x: placement.x, y: placement.y } : { pageId: source.currentPage.id, x: source.currentPage.widthPt / 2, y: source.currentPage.heightPt / 2 };
    const result = await source.placeIngressImage({ id: item.image.asset.id, sha256: item.image.asset.sha256 }, {
      ...source.engine.scope(), pageId: at.pageId, baseRevision: item.target.baseRevision, x: at.x, y: at.y,
    });
    if (!result.ok) { this.ingress.setImageMessage(ticketId, result.error.message + ' The picture remains in the library.'); return; }
    this.ingress.markImage(ticketId, 'placed', 'Placed in the original drawing as one undoable change.');
  }

  keepIngressImage(ticketId: string): void {
    const item = this.ingress.items.find(candidate => candidate.ticketId === ticketId && candidate.status === 'offered');
    if (!item) return;
    this.ingress.markImage(ticketId, 'kept', `${item.image?.asset.name ?? item.displayName} was kept in the picture library.`);
  }

  chooseCurrentTargetForIngressImage(ticketId: string): void {
    const target = this.active;
    this.ingress.retargetImage(ticketId, {
      ...target.engine.scope(), baseRevision: target.engine.revision,
      placement: { pageId: target.currentPage.id, x: target.currentPage.widthPt / 2, y: target.currentPage.heightPt / 2 },
    });
  }

  cancelIngress(batchId: string): void {
    this.ingress.cancel(batchId, ticketIds => { void this.hostApi.dismissIngress(ticketIds); });
  }

  processIngress(): Promise<void> {
    return this.ingress.drain((item, expected) => {
      if (this.preferences.dialogOpen) return 'Preferences is open.';
      if (this.isBusy()) return 'Finish the current canvas gesture first.';
      if (this.recentPrompt || this.help.panel) return 'Close the open panel before processing dropped files.';
      const source = this.tabs.find(tab => tab.engine.scope().documentId === expected.documentId && tab.engine.scope().sessionId === expected.sessionId);
      if (!source) return 'The drawing that received these files is no longer open. Cancel and drop them again.';
      if (source.engine.revision !== expected.baseRevision) return 'The drawing changed after the drop. Cancel and drop the files again.';
      if (this.tabs.some(tab => tab.closePrompt || tab.newDocument.prompt || tab.exportPrompt || tab.report || tab.connectPrompt || tab.files.prompt || tab.recoveryOffers.length || tab.recoveryReport || tab.controller.isActive()))
        return 'Finish or close the open dialog before processing dropped files.';
      return null;
    }, async (item: IngressQueueItem, expected: IngressTarget) => {
      const source = this.tabs.find(tab => tab.engine.scope().documentId === expected.documentId && tab.engine.scope().sessionId === expected.sessionId);
      if (!source) return { opened: false, error: 'The drawing that received these files is no longer open.' };
      if (item.kind === 'image') {
        const imported = await this.hostApi.importIngressImage(item.ticketId, source.engine.scope());
        if (!imported.ok) return { opened: false, error: imported.error.message };
        await source.refreshLibrary();
        return { opened: true, image: { asset: imported.value.asset, width: imported.value.width, height: imported.value.height, notes: imported.value.notes } };
      }
      const reuse = source.isBlank ? source : null;
      const target = reuse ?? this.newTab();
      if (!target) return { opened: false, error: this.notice ?? 'Cannot open another tab.' };
      const result = await target.openIngress(item.ticketId);
      if (!result.opened) { if (!reuse) await this.closeNow(target, true); return { opened: false, error: result.error ?? 'The file was not opened.' }; }
      if (result.existingDocumentId) {
        if (!reuse) await this.closeNow(target, true);
        const existing = this.tabs.find(tab => tab.engine.scope().documentId === result.existingDocumentId);
        if (existing) this.activate(existing);
        return { opened: true, path: result.path, existingDocumentId: result.existingDocumentId };
      }
      const nextTarget = reuse ? { ...target.engine.scope(), baseRevision: target.engine.revision } : undefined;
      return { opened: true, path: result.path, ...(nextTarget ? { nextTarget } : {}) };
    });
  }

  /** Resolves once the last session's tabs are back; files the shell names are opened after that, so they land beside them. */
  restored: Promise<void> = Promise.resolve();

  /** The shell named files to open (double-click, Open with, second launch): one tab each, in order, the last one shown. */
  async openFromShell(files: Array<{ path: string; kind: 'json' | 'vsdx' }>): Promise<Result<{ opened: number }>> {
    await this.restored;
    const before = this.tabs.length;
    for (const f of files) await this.openFile(f.kind, undefined, f.path);
    return ok({ opened: Math.max(0, this.tabs.length - before) });
  }

  /** The person asked to close a tab. Unsaved work asks first. Resolves true once it is closed, false if they chose Cancel. */
  async closeTab(model: EditorModel): Promise<boolean> {
    if (this.preferences.dialogOpen) return false;
    if (!this.tabs.includes(model)) return true;
    this.activate(model);
    if (model.beginTabClose()) return new Promise<boolean>(resolve => { model.tabCloseResult = resolve; }); // the dialog asks; its answer comes back through closeTabNow
    await this.closeNow(model, false);
    return true;
  }

  /** Closes several tabs one after another, asking about each that has unsaved work; Cancel on any of them leaves the rest open. */
  async closeMany(models: EditorModel[]): Promise<void> {
    if (this.preferences.dialogOpen) return;
    for (const m of [...models]) if (!(await this.closeTab(m))) return;
  }

  /** Puts a saved tab's file path on the clipboard. */
  async copyPath(model: EditorModel): Promise<void> {
    const r = await this.hostApi.documentCopyPath(model.engine.scope().documentId);
    model.say(r.ok ? 'Path copied.' : r.error.message, r.ok ? 'info' : 'warning');
  }

  /** Shows a saved tab's file in Explorer. */
  async reveal(model: EditorModel): Promise<void> {
    const r = await this.hostApi.documentReveal(model.engine.scope().documentId);
    if (!r.ok) model.say(r.error.message, 'warning');
  }

  /** Closes a tab without asking. `discard` throws away its recovery session (Don't save); a closed unchanged tab leaves nothing behind either way. */
  async closeNow(model: EditorModel, discard: boolean): Promise<void> {
    if (this.preferences.dialogOpen) return;
    const state = this.stateOf(model);
    if (!state) return;
    const scope = state.engine.scope();
    if (this.app.workspace.documents.length === 1) this.newTab(); // the window always shows a document
    this.app.closeDocument(scope.documentId);
    if (discard) await this.hostApi.recoveryDiscard(scope.sessionId);
    this.unsubscribe.get(model)?.(); this.unsubscribe.delete(model);
    model.dispose();
    this.bump();
  }

  // ------------------------------------------------------------------ documents agents work on in the background
  setAgentDocs(list: AgentDocument[]): void {
    this.agentDocs = list;
    if (this.armedDiscard && !list.some(d => d.documentId === this.armedDiscard)) this.armedDiscard = null;
    this.bump();
  }

  async refreshAgentDocs(): Promise<void> {
    const r = await this.hostApi.agentDocuments();
    if (r.ok) this.setAgentDocs(r.value.documents);
  }

  /** The host moves a background document here: it becomes a tab (unsaved, with a fresh history) and, normally, the one showing. */
  async adoptDocument(document: DiagramDocument, activate: boolean): Promise<Result<Scope & { revision: number }>> {
    if (this.preferences.dialogOpen || this.isBusy()) return fail('busy_user_editing', 'the person is editing; try again in a moment', { retryable: true, outcome: 'none' });
    const target = this.newTab({ activate: false });
    if (!target) return fail('limit_exceeded', this.notice ?? 'too many documents are open', { outcome: 'none' });
    const replaced = await target.engine.replaceDocument(document, { ...target.engine.scope(), baseRevision: target.engine.revision });
    if (!replaced.ok) { await this.closeNow(target, true); return replaced; }
    target.pageId = undefined;
    target.afterRecoveryRestore(); // the host learns the document's new session here
    target.showCommittedNow();
    if (activate) this.activate(target);
    target.say('Opened from the background. It has not been saved.', 'info');
    return ok({ ...target.engine.scope(), revision: target.engine.revision });
  }

  /** An agent asked to show a tab that is already here. */
  activateById(documentId: string): Result<{ activated: string }> {
    const tab = this.tabs.find(t => t.engine.scope().documentId === documentId);
    if (!tab) return fail('document_mismatch', 'that document is not open in the window', { outcome: 'none' });
    if (tab === this.active) return ok({ activated: documentId }); // already showing: nothing to switch, so a gesture in progress is no reason to refuse
    if (this.preferences.dialogOpen || this.isBusy()) return fail('busy_user_editing', 'the person is editing; try again in a moment', { retryable: true, outcome: 'none' });
    this.activate(tab);
    return ok({ activated: documentId });
  }

  /** The person clicked a background document's tab. */
  async showAgentDocument(documentId: string): Promise<void> {
    if (this.preferences.dialogOpen) return;
    const r = await this.hostApi.documentShow(documentId);
    this.notice = r.ok ? null : r.error.message;
    await this.refreshAgentDocs();
  }

  /** Closing a background tab throws its work away: the first press asks, the second does it. */
  async discardAgentDocument(documentId: string): Promise<void> {
    if (this.preferences.dialogOpen) return;
    const doc = this.agentDocs.find(d => d.documentId === documentId);
    if (doc && doc.unsaved && this.armedDiscard !== documentId) { this.armedDiscard = documentId; this.bump(); return; }
    this.armedDiscard = null;
    const r = await this.hostApi.documentDiscard(documentId);
    if (!r.ok) this.notice = r.error.message;
    await this.refreshAgentDocs();
  }

  // ------------------------------------------------------------------ remembering the tabs between runs
  private schedulePersist(): void {
    if (!this.persisting || this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; void this.persist(); }, 150);
  }

  /** Tells the host which documents are open, in order, and which is showing. Unchanged lists are not sent again. */
  async persist(): Promise<void> {
    const tabs = this.tabs.map(t => ({ documentId: t.engine.scope().documentId, sessionId: t.engine.scope().sessionId, title: t.tabLabel, unsaved: t.engine.status().unsaved }));
    const active = this.active.engine.scope().documentId;
    const body = JSON.stringify([tabs, active]);
    if (body === this.lastPersisted) return;
    this.lastPersisted = body;
    await this.hostApi.workspaceSave(tabs, active);
  }

  /**
   * At start: bring back what the last run had open, in order. Saved tabs reopen from their files; tabs with unsaved work come back from
   * their recovery sessions, still unsaved. Sessions that no tab owns are offered in the recovery dialog. Nothing is asked about what is restored.
   */
  async restoreWorkspace(holder: EditorModel): Promise<void> {
    if (this.preferences.dialogOpen) return;
    try {
      const mem = await this.hostApi.workspaceLoad();
      if (!mem.ok || !mem.value.found || mem.value.tabs.length === 0) { await holder.checkRecovery(); return; }
      const listed = await this.hostApi.recoveryList();
      const sessions = listed.ok ? listed.value.sessions : [];
      const claimed = new Set<string>();
      const byDocument = new Map<string, EditorModel>();
      const lines: string[] = [];
      let restored = 0, withWork = 0;
      for (const tab of mem.value.tabs) {
        const session = sessions.find(s => s.sessionId === tab.sessionId);
        if (!session && !tab.path) continue; // an untitled tab nobody touched
        const reuse = restored === 0 && this.tabs.length === 1 && this.active.isBlank;
        const target = reuse ? this.active : this.newTab();
        if (!target) break;
        this.activate(target);
        const name = tab.title ?? tab.path ?? 'A document';
        let ok = false;
        if (session) {
          claimed.add(session.sessionId);
          const r = await holder.restoreSession(session, target, target.engine.revision);
          ok = r.ok;
          if (r.ok) { withWork++; lines.push(...session.loss.messages); } else lines.push(`${name}: the unsaved changes could not be restored (${r.message}).`);
        }
        if (!ok && tab.path) {
          ok = (await target.open(tab.path)).opened;
          if (!ok) lines.push(`${tab.path} could not be reopened.`);
          else if (session) lines.push(`${name} was reopened from its file; its unsaved changes were lost.`);
        }
        if (ok) { restored++; byDocument.set(tab.documentId, target); }
        else if (!reuse) await this.closeNow(target, false);
      }
      const orphans = sessions.filter(s => !claimed.has(s.sessionId));
      if (orphans.length) holder.offerSessions(orphans);
      const wanted = mem.value.activeDocumentId ? byDocument.get(mem.value.activeDocumentId) : undefined;
      if (wanted) this.activate(wanted);
      if (restored > 0 && (!mem.value.cleanExit || withWork > 0)) {
        const text = !mem.value.cleanExit
          ? `Restored ${restored} document${restored === 1 ? '' : 's'} after an unexpected exit. Unsaved changes are kept.`
          : `Reopened ${restored} document${restored === 1 ? '' : 's'}, ${withWork} with unsaved changes.`;
        this.banner = { text, lines };
      } else if (lines.length) this.banner = { text: 'Some documents could not be brought back.', lines };
    } finally {
      this.persisting = true;
      this.bump();
    }
  }

  /** The person chose Recover in the dialog: the session opens as its own tab (an untouched blank one is used up first). */
  async restoreOrphan(holder: EditorModel, sessionId: string): Promise<void> {
    if (this.preferences.dialogOpen) return;
    const target = this.active.isBlank ? this.active : this.newTab();
    if (!target) return;
    this.activate(target);
    await holder.restoreOffered(sessionId, target);
  }

  // ------------------------------------------------------------------ closing the window
  /** Tabs with work nobody saved. */
  get unsavedTabs(): EditorModel[] { return this.tabs.filter(t => t.engine.status().unsaved); }

  /** The host wants to close the window. Nothing unsaved: it may. Otherwise one prompt covers every unsaved tab. */
  beginClose(): { dirty: boolean } {
    if (this.preferences.dialogOpen) return { dirty: true };
    const dirty = this.unsavedTabs;
    if (dirty.length === 0) return { dirty: false };
    const first = dirty[0]!;
    this.activate(first);
    first.saveAllForClose = () => this.saveAll();
    return first.beginClose(dirty.length);
  }

  /** Saves each unsaved tab in turn, showing it; stops at the first that does not save (a cancelled Save as). */
  private async saveAll(): Promise<boolean> {
    for (const t of this.unsavedTabs) {
      this.activate(t);
      await t.save(false);
      if (t.engine.status().unsaved) return false;
    }
    return true;
  }
}

const norm = (p: string | null | undefined) => (p ?? '').replace(/\//g, '\\').toLowerCase();
const sameFile = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && norm(a) === norm(b);
