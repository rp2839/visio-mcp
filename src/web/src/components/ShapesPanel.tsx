import { useState } from 'react';
import { PRESETS, presetPath } from '../canvas/presets';
import { useController } from './hooks';
import { AssetsPanel } from './AssetsPanel';

export function ShapesPanel(props: { onInsertImage: () => void }) {
  const c = useController();
  const [tab, setTab] = useState<'shapes' | 'assets'>('shapes');
  const libraries = [...new Set(PRESETS.map((p) => p.library))];
  return (
    <aside className="left-panel">
      <div className="tabs">
        <button className={tab === 'shapes' ? 'active' : ''} onClick={() => setTab('shapes')}>Shapes</button>
        <button data-testid="tab-assets" className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>Assets</button>
      </div>
      {tab === 'shapes' ? libraries.map((lib) => (
        <section key={lib}>
          <h4>{lib}</h4>
          <div className="stencils">
            {PRESETS.filter((p) => p.library === lib).map((p) => (
              <button key={`${lib}-${p.label}`} className="stencil" title={p.label} data-testid={`stencil-${p.label.toLowerCase().replace(/\W+/g, '-')}`}
                onClick={() => void c.createShape(p.name, { x: 72, y: 72, width: 108, height: 54 }, p.label)}
                draggable onDragStart={(e) => e.dataTransfer.setData('application/x-diagram-preset', JSON.stringify(p))}>
                <svg viewBox="-2 -2 44 28" width="44" height="28"><path d={presetPath(p.name, 0, 0, 40, 24)} fill="#fff" stroke="#445" strokeWidth="1.5" /></svg>
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </section>
      )) : <AssetsPanel onImport={props.onInsertImage} />}
    </aside>
  );
}
