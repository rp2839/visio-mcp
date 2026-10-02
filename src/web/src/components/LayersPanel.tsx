import { useController, useEditorState } from './hooks';

export function LayersPanel() {
  const c = useController();
  const pageId = useEditorState((s) => s.pageId);
  const layers = useEditorState((s) => s.snapshot.document.pages.find((p) => p.id === s.pageId)?.layers ?? []);
  const selection = useEditorState((s) => s.selection);
  const one = selection.length ? c.element(selection[0]) : undefined;
  const setLayer = (id: string, patch: any, d: string) => void c.apply([{ op: 'setLayer', pageId, layer: id, patch }], d);
  return (
    <section className="layers" data-testid="layers">
      <h4>Layers</h4>
      <button data-testid="layer-add" onClick={() => void c.apply([{ op: 'addLayer', pageId, layer: {} }], 'Add layer')}>Add layer</button>
      <table>
        <thead><tr><th>Name</th><th title="visible">👁</th><th title="locked">🔒</th><th title="printable">🖨</th><th /></tr></thead>
        <tbody>
          {layers.map((l) => (
            <tr key={l.id} data-testid={`layer-${l.name}`}>
              <td><button className="link" onClick={() => { const n = prompt('Rename layer', l.name); if (n) setLayer(l.id, { name: n }, 'Rename layer'); }}>{l.name}</button></td>
              <td><input type="checkbox" data-testid={`layer-visible-${l.name}`} checked={l.visible} onChange={(e) => setLayer(l.id, { visible: e.target.checked }, 'Layer visibility')} /></td>
              <td><input type="checkbox" data-testid={`layer-locked-${l.name}`} checked={l.locked} onChange={(e) => setLayer(l.id, { locked: e.target.checked }, 'Layer lock')} /></td>
              <td><input type="checkbox" checked={l.printable} onChange={(e) => setLayer(l.id, { printable: e.target.checked }, 'Layer print')} /></td>
              <td>
                {selection.length > 0 && <button data-testid={`layer-assign-${l.name}`} disabled={!!one?.layerIds.includes(l.id)} onClick={() => void c.apply([{ op: 'assignLayer', targets: selection, layers: [l.id], mode: 'add' }], 'Assign layer')}>Assign</button>}
                <button data-testid={`layer-delete-${l.name}`} onClick={() => { if (confirm(`Delete layer ${l.name}? Members are unassigned, not deleted.`)) void c.apply([{ op: 'deleteLayer', pageId, layer: l.id }], 'Delete layer'); }}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
