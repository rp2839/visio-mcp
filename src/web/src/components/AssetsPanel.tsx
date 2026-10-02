import { useController, useEditorState } from './hooks';

/** Document asset catalogue: thumbnails, tags, single-image vs global replacement, copy ID. */
export function AssetsPanel(props: { onImport: () => void }) {
  const c = useController();
  const assets = useEditorState((s) => s.snapshot.document.assets);
  const selection = useEditorState((s) => s.selection);
  const selectedImage = selection.map((id) => c.element(id)).find((e) => e?.kind === 'image');
  return (
    <div className="assets">
      <button data-testid="asset-import" onClick={props.onImport}>Import image…</button>
      {assets.length === 0 && <p className="hint">No assets in this document.</p>}
      <ul>
        {assets.map((a) => (
          <li key={a.id} data-testid={`asset-${a.id}`} draggable onDragStart={(e) => e.dataTransfer.setData('application/x-diagram-asset', a.id)}>
            {c.assets.urlFor(a) ? <img src={c.assets.urlFor(a)!} alt="" width={40} height={28} /> : <span className="thumb-missing">?</span>}
            <div className="asset-meta">
              <strong>{a.name}</strong>
              <code title="asset ID">{a.id.length > 40 ? `${a.id.slice(0, 40)}…` : a.id}</code>
              <small>{a.mimeType} {a.widthPx ?? '?'}×{a.heightPx ?? '?'} {a.tags.join(', ')}</small>
              <div className="row">
                <button onClick={() => void c.insertImage(a)}>Place</button>
                <button onClick={() => { const n = prompt('Rename asset', a.name); if (n) void c.apply([{ op: 'setAsset', assetId: a.id, patch: { name: n } }], 'Rename asset'); }}>Rename</button>
                <button onClick={() => { const t = prompt('Tags (comma separated)', a.tags.join(', ')); if (t !== null) void c.apply([{ op: 'setAsset', assetId: a.id, patch: { tags: t.split(',').map((x) => x.trim()).filter(Boolean) } }], 'Tag asset'); }}>Tags</button>
                <button onClick={() => void navigator.clipboard?.writeText(a.id)}>Copy ID</button>
                {selectedImage?.kind === 'image' && selectedImage.assetId !== a.id && (
                  <button data-testid={`asset-use-${a.id}`} onClick={() => void c.apply([{ op: 'set', target: selectedImage.id, patch: { assetId: a.id } }], 'Replace selected image')}>Use for selected image</button>
                )}
                {selectedImage?.kind === 'image' && selectedImage.assetId !== a.id && (
                  <button onClick={() => { if (confirm(`Replace ${selectedImage.assetId} with ${a.id} in every image?`)) void c.apply([{ op: 'replaceAssetGlobal', fromAssetId: selectedImage.assetId, toAssetId: a.id }], 'Replace asset globally'); }}>Replace globally</button>
                )}
                <button data-testid={`asset-delete-${a.id}`} onClick={() => void c.deleteAsset(a)}>Delete</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
