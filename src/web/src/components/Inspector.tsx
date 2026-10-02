import type { Element, Operation } from '../model/types';
import { fromPoints, toPoints, type Unit } from '../model/units';
import { useController, useEditorState } from './hooks';
import { Check, Field, Select, round } from './fields';
import { ArrangePanel } from './ArrangePanel';
import { LayersPanel } from './LayersPanel';

const UNITS: readonly Unit[] = ['mm', 'cm', 'in', 'pt'];

export function Inspector() {
  const c = useController();
  const selection = useEditorState((s) => s.selection);
  const units = useEditorState((s) => s.units);
  useEditorState((s) => s.snapshot.revision); // re-render on commits
  const elements = selection.map((id) => c.element(id)).filter((e): e is Element => !!e);
  const one = elements.length === 1 ? elements[0] : null;
  const setAll = (patch: any, description: string) =>
    c.apply(elements.map((e) => ({ op: 'set', target: e.id, patch }) as Operation), description);
  const num = (v: string) => toPoints(Number(v), units);

  return (
    <aside className="inspector" data-testid="inspector">
      <section>
        <h4>Geometry</h4>
        <Select label="Units" value={units} options={UNITS} onChange={(u) => c.setUnits(u)} testid="units" />
        {one ? (
          <>
            <div className="grid2">
              <Field label="X" testid="geo-x" value={round(fromPoints(one.bounds.x, units))} onCommit={(v) => void c.apply([{ op: 'move', target: one.id, to: { xPt: num(v), yPt: one.bounds.y } }], 'Move')} />
              <Field label="Y" testid="geo-y" value={round(fromPoints(one.bounds.y, units))} onCommit={(v) => void c.apply([{ op: 'move', target: one.id, to: { xPt: one.bounds.x, yPt: num(v) } }], 'Move')} />
              <Field label="W" testid="geo-w" value={round(fromPoints(one.bounds.width, units))} disabled={one.kind === 'connector'} onCommit={(v) => void c.apply([{ op: 'resize', target: one.id, widthPt: num(v) }], 'Resize')} />
              <Field label="H" testid="geo-h" value={round(fromPoints(one.bounds.height, units))} disabled={one.kind === 'connector'} onCommit={(v) => void c.apply([{ op: 'resize', target: one.id, heightPt: num(v) }], 'Resize')} />
            </div>
            {one.kind === 'group'
              ? <Field label="Rotate by (°)" testid="geo-rotate-by" value={0} onCommit={(v) => void c.apply([{ op: 'rotate', target: one.id, deltaDeg: Number(v) }], 'Rotate group')} />
              : one.kind !== 'connector' && <Field label="Rotation (°)" testid="geo-rotation" value={round(one.rotationDeg)} onCommit={(v) => void c.apply([{ op: 'rotate', target: one.id, angleDeg: Number(v) }], 'Rotate')} />}
            <Field label="Alias" testid="alias" value={one.alias ?? ''} onCommit={(v) => void c.apply([{ op: 'set', target: one.id, patch: { alias: v || null } }], 'Alias')} />
            <Field label="Name" value={one.name ?? ''} onCommit={(v) => void c.apply([{ op: 'set', target: one.id, patch: { name: v || null } }], 'Name')} />
            <Check label="Locked" testid="locked" checked={one.locked} onChange={(v) => void c.apply([{ op: 'set', target: one.id, patch: { locked: v } }], v ? 'Lock' : 'Unlock')} />
            <code className="id" data-testid="element-id">{one.id}</code>
          </>
        ) : <p className="hint">{elements.length ? `${elements.length} selected` : 'Nothing selected'}</p>}
      </section>
      {elements.length > 0 && <StyleSection elements={elements} setAll={setAll} />}
      {one && (one.kind === 'shape' || one.kind === 'text' || one.kind === 'connector') && <TextSection element={one} />}
      <ArrangePanel />
      <LayersPanel />
    </aside>
  );
}

function StyleSection(props: { elements: Element[]; setAll: (patch: any, d: string) => unknown }) {
  const first = props.elements[0];
  if (first.kind === 'image') {
    return (
      <section>
        <h4>Image</h4>
        <Select label="Fit" value={first.fit} options={['contain', 'cover', 'stretch'] as const} onChange={(v) => void props.setAll({ fit: v }, 'Image fit')} />
        <Field label="Opacity" value={first.opacity} onCommit={(v) => void props.setAll({ opacity: Number(v) }, 'Image opacity')} />
        <code>{first.assetId}</code>
      </section>
    );
  }
  if (first.kind === 'group') return null;
  const st: any = first.style;
  return (
    <section>
      <h4>Style</h4>
      {first.kind !== 'connector' && <Field label="Fill" testid="style-fill" value={st.fill} onCommit={(v) => void props.setAll({ style: { fill: v } }, 'Fill')} />}
      {first.kind !== 'connector' && <Field label="Fill opacity" value={st.fillOpacity} onCommit={(v) => void props.setAll({ style: { fillOpacity: Number(v) } }, 'Fill opacity')} />}
      <Field label="Line" testid="style-stroke" value={st.stroke} onCommit={(v) => void props.setAll({ style: { stroke: v } }, 'Line colour')} />
      <Field label="Line width (pt)" testid="style-stroke-width" value={st.strokeWidthPt} onCommit={(v) => void props.setAll({ style: { strokeWidthPt: Number(v) } }, 'Line width')} />
      <Select label="Dash" value={st.dash} options={['solid', 'dash', 'dot', 'dashDot'] as const} onChange={(v) => void props.setAll({ style: { dash: v } }, 'Dash')} />
      {first.kind === 'connector' && (
        <>
          <Select label="Start arrow" value={st.startArrow} options={['none', 'triangle', 'open', 'diamond', 'circle'] as const} onChange={(v) => void props.setAll({ style: { startArrow: v } }, 'Arrow')} />
          <Select label="End arrow" value={st.endArrow} options={['none', 'triangle', 'open', 'diamond', 'circle'] as const} onChange={(v) => void props.setAll({ style: { endArrow: v } }, 'Arrow')} />
          <Select label="Route" value={first.route} options={['straight', 'orthogonal', 'curved'] as const} onChange={(v) => void props.setAll({ route: v }, 'Route')} />
        </>
      )}
    </section>
  );
}

function TextSection(props: { element: Element }) {
  const c = useController();
  const e = props.element as any;
  const key = e.kind === 'connector' ? 'label' : 'text';
  const t = e[key];
  const set = (patch: any, d: string) => void c.apply([{ op: 'set', target: e.id, patch: { [key]: patch } }], d);
  return (
    <section>
      <h4>Text</h4>
      <Field label="Text" testid="text-value" value={t?.value ?? ''} onCommit={(v) => set({ value: v }, 'Text')} />
      <Field label="Font" value={t?.fontFamily ?? 'Calibri'} onCommit={(v) => set({ fontFamily: v }, 'Font')} />
      <Field label="Size (pt)" testid="text-size" value={t?.fontSizePt ?? 11} onCommit={(v) => set({ fontSizePt: Number(v) }, 'Font size')} />
      <Field label="Colour" value={t?.colour ?? '#000000'} onCommit={(v) => set({ colour: v }, 'Text colour')} />
      <div className="row">
        <Check label="B" testid="text-bold" checked={!!t?.bold} onChange={(v) => set({ bold: v }, 'Bold')} />
        <Check label="I" checked={!!t?.italic} onChange={(v) => set({ italic: v }, 'Italic')} />
        <Check label="U" checked={!!t?.underline} onChange={(v) => set({ underline: v }, 'Underline')} />
      </div>
      <Select label="Align" value={t?.horizontalAlign ?? 'center'} options={['left', 'center', 'right'] as const} onChange={(v) => set({ horizontalAlign: v }, 'Align text')} />
      <Select label="Vertical" value={t?.verticalAlign ?? 'middle'} options={['top', 'middle', 'bottom'] as const} onChange={(v) => set({ verticalAlign: v }, 'Align text')} />
    </section>
  );
}
