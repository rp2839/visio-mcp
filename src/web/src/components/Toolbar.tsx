import { useController, useEditorState } from './hooks';

export function Toolbar(props: { onInsertImage: () => void; onSave?: () => void }) {
  const c = useController();
  const tool = useEditorState((s) => s.tool);
  const preset = useEditorState((s) => s.shapePreset);
  const canUndo = useEditorState((s) => s.canUndo);
  const canRedo = useEditorState((s) => s.canRedo);
  const btn = (id: string, label: string, active: boolean, onClick: () => void, disabled = false) => (
    <button data-testid={id} className={active ? 'active' : ''} onClick={onClick} disabled={disabled} title={label}>{label}</button>
  );
  return (
    <div className="toolbar" role="toolbar">
      {btn('tool-select', 'Select', tool === 'select', () => c.setTool('select'))}
      {btn('tool-connector', 'Connector', tool === 'connector', () => c.setTool('connector'))}
      {btn('tool-text', 'Text', tool === 'text', () => c.setTool('text'))}
      {btn('tool-rect', 'Rect', tool === 'shape' && preset === 'rectangle', () => c.setTool('shape', 'rectangle'))}
      {btn('tool-ellipse', 'Ellipse', tool === 'shape' && preset === 'ellipse', () => c.setTool('shape', 'ellipse'))}
      {btn('tool-image', 'Image…', false, props.onInsertImage)}
      <span className="sep" />
      {btn('undo', 'Undo', false, () => void c.undo(), !canUndo)}
      {btn('redo', 'Redo', false, () => void c.redo(), !canRedo)}
      <span className="sep" />
      {btn('zoom-out', '−', false, () => c.zoom(1 / 1.25))}
      {btn('zoom-in', '+', false, () => c.zoom(1.25))}
      {btn('fit-page', 'Fit page', false, () => c.fit('page'))}
      {btn('fit-selection', 'Fit selection', false, () => c.fit('selection'))}
      {btn('zoom-100', '100%', false, () => c.fit('actual'))}
    </div>
  );
}
