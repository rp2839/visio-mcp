import { PAGE_PRESETS } from '../model/defaults';
import { useController, useEditorState } from './hooks';

export function PageTabs() {
  const c = useController();
  const pages = useEditorState((s) => s.snapshot.document.pages);
  const pageId = useEditorState((s) => s.pageId);
  const page = pages.find((p) => p.id === pageId)!;
  const status = useEditorState((s) => s.status);
  const revision = useEditorState((s) => s.snapshot.revision);
  const dirty = useEditorState((s) => s.dirty);
  const add = async () => { const r = await c.apply([{ op: 'addPage', index: pages.length }], 'Add page'); if (r.ok) c.setPage(c.getState().snapshot.document.pages[pages.length].id); };
  return (
    <footer className="page-tabs">
      {pages.map((p, i) => (
        <button key={p.id} data-testid={`page-tab-${i}`} className={p.id === pageId ? 'active' : ''} onClick={() => c.setPage(p.id)}
          onDoubleClick={() => { const n = prompt('Rename page', p.name); if (n) void c.apply([{ op: 'setPage', pageId: p.id, patch: { name: n } }], 'Rename page'); }}>{p.name}</button>
      ))}
      <button data-testid="page-add" onClick={() => void add()}>+</button>
      <span className="sep" />
      <button data-testid="page-left" disabled={pages[0].id === pageId} onClick={() => void c.apply([{ op: 'reorderPage', pageId, index: pages.findIndex((p) => p.id === pageId) - 1 }], 'Reorder page')}>◀</button>
      <button data-testid="page-right" disabled={pages[pages.length - 1].id === pageId} onClick={() => void c.apply([{ op: 'reorderPage', pageId, index: pages.findIndex((p) => p.id === pageId) + 1 }], 'Reorder page')}>▶</button>
      <button data-testid="page-duplicate" onClick={() => void c.apply([{ op: 'duplicatePage', pageId }], 'Duplicate page')}>Duplicate</button>
      <button data-testid="page-delete" disabled={pages.length === 1} onClick={() => { if (confirm(`Delete page ${page.name}?`)) void c.apply([{ op: 'deletePage', pageId }], 'Delete page'); }}>Delete</button>
      <select data-testid="page-size" value="" onChange={(e) => {
        const v = e.target.value;
        if (v === 'custom') { const w = prompt('Width (mm)'), h = prompt('Height (mm)'); if (w && h) void c.apply([{ op: 'setPage', pageId, patch: { widthPt: Number(w) * 72 / 25.4, heightPt: Number(h) * 72 / 25.4 } }], 'Page size'); }
        else if (v) void c.apply([{ op: 'setPage', pageId, patch: PAGE_PRESETS[v] }], `Page size ${v}`);
      }}>
        <option value="">Page size…</option>
        {Object.keys(PAGE_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
        <option value="custom">Custom…</option>
      </select>
      <label className="check"><input type="checkbox" data-testid="grid-visible" checked={page.grid.visible} onChange={(e) => void c.apply([{ op: 'setPage', pageId, patch: { grid: { visible: e.target.checked } } }], 'Grid')} />Grid</label>
      <label className="check"><input type="checkbox" data-testid="grid-snap" checked={page.grid.snap} onChange={(e) => void c.apply([{ op: 'setPage', pageId, patch: { grid: { snap: e.target.checked } } }], 'Snap')} />Snap</label>
      <span className="status" data-testid="status">{status}</span>
      <span className="revision" data-testid="revision">rev {revision}{dirty ? ' •' : ''}</span>
    </footer>
  );
}
