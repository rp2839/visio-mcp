import { CommandEngine } from '../../src/commands/CommandEngine';
import { newDocument, defaultShapeStyle, defaultText } from '../../src/model/defaults';
import { canonicalSerialize } from '../../src/model/canonical';
import type { Asset, DiagramDocument, Element, MutationRequest, Operation, Snapshot } from '../../src/model/types';

/** Deterministic UUIDs: uuid(1) = 00000000-0000-4000-8000-000000000001. */
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export function sequence(start = 0x1000) {
  let n = start;
  return () => uuid(n++);
}

export const ids = {
  document: uuid(1),
  page: uuid(2),
  image: uuid(100),
  shape: uuid(101),
  shapes: Array.from({ length: 19 }, (_, i) => uuid(101 + i)),
};

export const logoAsset = (version: 1 | 2): Asset => ({
  id: version === 1 ? 'asset:logo' : 'asset:logo-v2', name: `Logo v${version}`, mimeType: 'image/png',
  sha256: (version === 1 ? 'a' : 'b').repeat(64), widthPx: 200, heightPx: 80, tags: ['logo'], provenance: 'approved library',
});

/** One image, 19 ordinary shapes and two approved asset descriptors. */
export function seedDocument(count = 20): DiagramDocument {
  const doc = newDocument(ids.document, ids.page, 'Seed');
  doc.assets = [logoAsset(1), logoAsset(2)];
  const elements: Element[] = [{
    id: ids.image, kind: 'image', alias: 'logo', name: 'Company logo', layerIds: [], zIndex: 0, locked: false, hidden: false,
    bounds: { x: 20, y: 20, width: 100, height: 40 }, rotationDeg: 0, metadata: {},
    assetId: 'asset:logo', fit: 'contain', opacity: 1, preserveAspectRatio: true,
  }];
  for (let i = 0; i < count - 1; i++) {
    elements.push({
      id: ids.shapes[i], kind: 'shape', alias: `s${i}`, name: i < 2 ? 'Box' : `Box ${i}`, layerIds: [], zIndex: i + 1, locked: false, hidden: false,
      bounds: { x: 150 + (i % 5) * 120, y: 100 + Math.floor(i / 5) * 90, width: 100, height: 60 }, rotationDeg: 0, metadata: {},
      geometry: { preset: 'roundedRect', cornerRadiusPt: 6 }, style: defaultShapeStyle(), text: defaultText(`Shape ${i}`),
    });
  }
  doc.pages[0].elements = elements;
  return doc;
}

export function createTestEngine(opts: { document?: DiagramDocument; revision?: number } = {}) {
  const document = structuredClone(opts.document ?? seedDocument());
  if (opts.revision !== undefined) document.revision = opts.revision;
  const tx = sequence(0x900000);
  const engine = new CommandEngine({ document, newUuid: sequence(0x5000), now: () => '2026-10-02T12:00:00.000Z' });
  const scope = () => engine.scope();
  const request = (operations: Operation[], overrides: Partial<MutationRequest> = {}): MutationRequest => {
    const s = scope();
    return { documentId: s.documentId, sessionId: s.sessionId, transactionId: tx(), baseRevision: s.revision, atomic: true, operations, ...overrides };
  };
  return { engine, store: { snapshot: () => engine.current() }, documentId: document.id, sessionId: () => scope().sessionId, scope, request, nextTx: tx };
}

export function exactElementHashes(snapshot: Snapshot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of snapshot.document.pages) for (const e of p.elements) out[e.id] = canonicalSerialize(e);
  return out;
}

export function hashesExcept(snapshot: Snapshot, ...except: string[]) {
  const h = exactElementHashes(snapshot);
  for (const id of except) delete h[id];
  return h;
}

export const element = (snapshot: Snapshot, id: string) => snapshot.document.pages.flatMap((p) => p.elements).find((e) => e.id === id)!;
