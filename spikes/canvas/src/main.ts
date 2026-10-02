import { ProbeCanvas } from './projection';
import { renderProbe } from './render';
import type { ProbeIntent, ProbeSceneDto } from './types';
import { LOGO_PNG_DATA_URL } from './logo';
import { installBridge } from './bridge';

let store: ProbeSceneDto = {
  revision: 0,
  rect: { id: 'rect', x: 80, y: 80, width: 160, height: 80, rotation: 0, text: 'Probe' },
  ellipse: { id: 'ellipse', x: 480, y: 80, width: 160, height: 80, rotation: 0, text: 'Target' },
  picture: { id: 'picture', x: 80, y: 320, width: 96, height: 96, rotation: 0, assetDataUrl: LOGO_PNG_DATA_URL },
  connector: { id: 'connector', from: { elementId: 'rect' }, to: { elementId: 'ellipse' } },
};

const canvas = new ProbeCanvas(document.getElementById('canvas')!);
const timings: { what: string; ms: number }[] = [];

function apply(intents: ProbeIntent[]) {
  const t0 = performance.now();
  const next: ProbeSceneDto = structuredClone(store);
  const boxes: Record<string, { x: number; y: number; width: number; height: number; rotation: number; text?: string }> = {
    [next.rect.id]: next.rect, [next.ellipse.id]: next.ellipse, [next.picture.id]: next.picture,
  };
  for (const i of intents) {
    if (i.kind === 'geometry') Object.assign(boxes[i.id], { x: i.x, y: i.y, width: i.width, height: i.height });
    if (i.kind === 'rotation') boxes[i.id].rotation = i.rotation;
    if (i.kind === 'text') boxes[i.id].text = i.text;
    if (i.kind === 'connect') next.connector[i.end] = { elementId: i.elementId };
  }
  next.revision = store.revision + 1; // one gesture = one transaction
  store = next;
  canvas.project(store);
  timings.push({ what: 'commit+project', ms: performance.now() - t0 });
}

canvas.onIntents(apply);
canvas.project(store);

const api = {
  readProbeState: (): ProbeSceneDto => structuredClone(store),
  project: (scene: ProbeSceneDto) => { store = structuredClone(scene); canvas.project(store); },
  renderProbe: async () => Array.from(await renderProbe(store)),
  gestureLog: () => [...canvas.gestureLog],
  isGestureActive: () => canvas.isGestureActive(),
  cancelGesture: () => canvas.cancelGesture(),
  zoomIn: () => canvas.graph.zoomIn(),
  select: (id: string) => canvas.graph.setSelectionCell(canvas.graph.getDataModel().getCell(id)),
  startTextEdit: (id: string) => canvas.graph.startEditingAtCell(canvas.graph.getDataModel().getCell(id)),
  stopTextEdit: (cancel: boolean) => canvas.graph.stopEditing(cancel),
  cellBounds: (id: string) => {
    const s = canvas.graph.getView().getState(canvas.graph.getDataModel().getCell(id)!);
    return s ? { x: s.x, y: s.y, width: s.width, height: s.height } : null;
  },
  edgeEnds: (id: string) => {
    const s = canvas.graph.getView().getState(canvas.graph.getDataModel().getCell(id)!);
    const pts = s?.absolutePoints ?? [];
    return pts.length ? { start: { x: pts[0]!.x, y: pts[0]!.y }, end: { x: pts[pts.length - 1]!.x, y: pts[pts.length - 1]!.y } } : null;
  },
  timings: () => [...timings],
};
(window as any).probe = api;

// WebView2 host bridge (I04). Present only when hosted; batched moves are one revision.
const webview = (window as any).chrome?.webview;
if (webview) {
  installBridge(webview, {
    documentId: 'd0000000-0000-4000-8000-000000000001',
    sessionId: crypto.randomUUID(),
    revision: () => store.revision,
    has: (id) => id === store.rect.id || id === store.ellipse.id || id === store.picture.id,
    applyMove: (id, dx, dy) => {
      const box = [store.rect, store.ellipse, store.picture].find((b) => b.id === id)!;
      apply([{ kind: 'geometry', id, x: box.x + dx, y: box.y + dy, width: box.width, height: box.height }]);
      return [id];
    },
  });
}
