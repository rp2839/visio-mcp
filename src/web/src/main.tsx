import { createRoot } from 'react-dom/client';
import { App } from './App';
import { EditorController } from './editor/EditorController';
import { HostAssetResolver, MemoryAssetResolver, prepareLocally } from './editor/assets';
import { connectHost, tableDispatcher } from './bridge/bootstrap';
import { lifecycleHandlers } from './bridge/hostServices';
import type { Asset, PreparedAsset } from './model/types';
import './styles.css';

const webview = (window as any).chrome?.webview;
const memory = new MemoryAssetResolver();
const controller = new EditorController(webview ? new HostAssetResolver() : memory);
let prepareAsset: (file?: File) => Promise<Asset | null>;

if (webview) {
  const client = connectHost(webview, controller.engine, tableDispatcher({
    ...lifecycleHandlers(controller.engine, { cancelGestures: () => controller.gestures.cancelAll() }),
  }));
  prepareAsset = async () => {
    const r = await client.request('host.prepareAsset');
    if (!r.ok) throw new Error(r.error.message);
    return (r.result as PreparedAsset).ref.asset;
  };
} else {
  prepareAsset = async (file) => (file ? prepareLocally(file, memory) : null);
}

createRoot(document.getElementById('root')!).render(<App controller={controller} prepareAsset={prepareAsset} />);

// Test-only read API (dev/test builds): canonical state, never a mutation shortcut.
if (import.meta.env.DEV || location.search.includes('testapi')) {
  (window as any).__diagram = {
    snapshot: () => structuredClone(controller.engine.current()),
    selection: () => [...controller.getState().selection],
    pageId: () => controller.getState().pageId,
    toClient: (p: { x: number; y: number }) => (controller as any).adapter?.pageToClient(p),
    gestureActive: () => controller.gestures.isActive(),
    status: () => controller.getState().status,
    // Simulated external (agent) request through the same engine entry point MCP uses.
    agentApply: (req: unknown) => controller.engine.execute(req as any, 'mcp'),
    scope: () => controller.engine.scope(),
    lifecycleReplace: async () => {
      const s = controller.engine.scope();
      controller.gestures.cancelAll();
      return controller.engine.replaceDocument(structuredClone(controller.engine.current().document), { ...s, baseRevision: s.revision });
    },
  };
}
