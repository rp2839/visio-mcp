import { Fragment, useState } from 'react';
import type { Unit } from '../model/validate';
import type { EditorModel } from '../editor/EditorModel';
import { appCommands, type CommandGroup } from '../editor/appCommands';
import type { WorkspaceModel } from '../workspace/WorkspaceModel';
import { useModel } from './useModel';

function RoutingDefaultsDialog({ model }: { model: EditorModel }) {
  if (!model.routingDefaultsOpen) return null;
  const configuredCrossing = model.snapshot.document.routingDefaults?.crossing;
  const crossing = configuredCrossing ?? 'default';
  return <div className="dialog-backdrop" role="presentation"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="routing-defaults-title" data-testid="routing-defaults-dialog" onKeyDown={e => { if (e.key === 'Escape') model.closeRoutingDefaults(); }}>
    <h2 id="routing-defaults-title">Routing defaults</h2>
    <p>These defaults apply only when you preview Beautify. Ordinary edits keep existing routes.</p>
    <label className="field"><span>Connector crossings</span>
      <select aria-label="Default crossing policy" data-testid="routing-default-crossing" value={crossing} onChange={e => void model.apply('inspector', [{ op: 'setRoutingDefaults', crossing: e.target.value === 'default' ? null : e.target.value as 'avoid' | 'allow' }])}>
        <option value="default">Default (avoid crossings)</option><option value="avoid">Avoid crossings</option><option value="allow">Allow crossings</option>
      </select>
    </label>
    <div className="row dialog-actions"><button type="button" autoFocus data-testid="routing-defaults-close" onClick={() => model.closeRoutingDefaults()}>Close</button></div>
  </div></div>;
}

const MENUS: CommandGroup[] = ['File', 'Edit', 'Arrange', 'View', 'Help'];

export function Toolbar({ model, ws }: { model: EditorModel; ws: WorkspaceModel }) {
  useModel(model);
  const [open, setOpen] = useState<string | null>(null);
  const hasSelection = model.selection.length > 0;
  const status = model.engine.status();

  const commands = appCommands(model, ws);
  const menus = MENUS.map(name => ({ name, items: commands.filter(c => c.group === name) }));

  const tool = (id: string, label: string, active: boolean, run: () => void, disabled = false) => (
    <button type="button" className={`tool${active ? ' active' : ''}`} data-testid={`tool-${id}`} title={label} aria-pressed={active} disabled={disabled} onClick={run}>{label}</button>
  );

  return (
    <header className="toolbar" onMouseLeave={() => setOpen(null)}>
      <nav className="menubar" aria-label="Menu">
        {menus.map(m => (
          <div key={m.name} className="menu">
            <button type="button" className="menu-title" data-testid={`menu-${m.name.toLowerCase()}`} aria-expanded={open === m.name} onClick={() => setOpen(open === m.name ? null : m.name)}>{m.name}</button>
            {open === m.name && (
              <div className="menu-list" role="menu">
                {m.items.map(it => (
                  <Fragment key={it.id}>{it.sepBefore && <hr />}
                  <button type="button" role="menuitem" data-testid={`menu-${it.id}`} disabled={it.disabled}
                    onClick={() => { setOpen(null); it.run(); }}>
                    <span className="check">{it.checked ? '✓' : ''}</span><span>{it.label}</span><kbd>{it.shortcut ?? ''}</kbd>
                  </button></Fragment>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="tools" role="toolbar" aria-label="Tools">
        {tool('select', 'Select', model.tool.kind === 'select', () => model.setTool({ kind: 'select' }))}
        {tool('connector', 'Connector', model.tool.kind === 'connector', () => model.setTool(model.tool.kind === 'connector' ? { kind: 'select' } : { kind: 'connector' }))}
        {tool('text', 'Text', model.tool.kind === 'place' && model.tool.what === 'text', () => model.setTool({ kind: 'place', what: 'text' }))}
        {tool('picture', 'Picture', false, () => void model.insertPicture())}
        {tool('script', 'Script', model.drawerOpen, () => model.toggleDrawer())}
        <span className="sep" />
        {tool('undo', 'Undo', false, () => void model.undo())}
        {tool('redo', 'Redo', false, () => void model.redo())}
        {tool('delete', 'Delete', false, () => void model.deleteSelection(), !hasSelection)}
        <span className="sep" />
        {tool('zoom-out', '−', false, () => model.zoomBy(0.8))}
        <span className="zoom" data-testid="zoom">{model.viewport ? `${Math.round((model.viewport.scale / (96 / 72)) * 100)}%` : ''}</span>
        {tool('zoom-in', '+', false, () => model.zoomBy(1.25))}
        {tool('zoom-fit', 'Fit', false, () => model.zoomToFit())}
        <span className="sep" />
        <label className="unit">Units
          <select value={model.unit} data-testid="unit" onChange={e => { model.unit = e.target.value as Unit; model.bump(); }}>
            {(['mm', 'cm', 'in', 'pt', 'px'] as Unit[]).map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        <span className="dirty" data-testid="dirty" title={status.dirty ? 'Unsaved changes' : 'All changes saved'}>{status.dirty ? '●' : '○'}</span>
      </div>
      <RoutingDefaultsDialog model={model} />
    </header>
  );
}

