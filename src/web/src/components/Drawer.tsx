import { useState } from 'react';
import { useEditorState } from './hooks';
import { TransactionDrawer } from './TransactionDrawer';
import { ScriptDrawer } from './ScriptDrawer';

/** Collapsible Agent/Script drawer: script editor plus transparent transaction log. */
export function Drawer() {
  const [open, setOpen] = useState(false);
  const revision = useEditorState((s) => s.snapshot.revision);
  return (
    <section className={`drawer ${open ? 'open' : ''}`}>
      <button className="drawer-toggle" data-testid="drawer-toggle" onClick={() => setOpen(!open)}>{open ? '▼' : '▲'} Agent / Script — revision {revision}</button>
      {open && (
        <div className="drawer-body">
          <ScriptDrawer />
          <TransactionDrawer />
        </div>
      )}
    </section>
  );
}
