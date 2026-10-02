import { useEffect, useRef } from 'react';
import { ControllerContext } from './components/hooks';
import { Toolbar } from './components/Toolbar';
import { ShapesPanel } from './components/ShapesPanel';
import { PageCanvas } from './components/PageCanvas';
import { Inspector } from './components/Inspector';
import { PageTabs } from './components/PageTabs';
import { Drawer } from './components/Drawer';
import type { EditorController } from './editor/EditorController';
import type { Asset } from './model/types';

export function App(props: { controller: EditorController; prepareAsset: (file?: File) => Promise<Asset | null> }) {
  const c = props.controller;
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (c.handleKey(e)) e.preventDefault(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [c]);
  const insertImage = async (file?: File) => {
    try {
      const asset = await props.prepareAsset(file);
      if (asset) await c.insertImage(asset);
    } catch (e) {
      c.setStatus(`Image rejected: ${(e as Error).message}`);
    }
  };
  // The host shows its own file picker; the standalone build uses a hidden input.
  const pickImage = () => (fileInput.current ? fileInput.current.click() : void insertImage());
  return (
    <ControllerContext.Provider value={c}>
      <div className="app">
        <header>
          <nav className="menu"><strong>Agentic Diagram</strong></nav>
          <Toolbar onInsertImage={pickImage} />
        </header>
        <ShapesPanel onInsertImage={pickImage} />
        <main><PageCanvas /></main>
        <Inspector />
        <PageTabs />
        <Drawer />
        <input ref={fileInput} data-testid="image-input" type="file" accept="image/png,image/jpeg,image/bmp,image/svg+xml" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void insertImage(f); }} />
      </div>
    </ControllerContext.Provider>
  );
}
