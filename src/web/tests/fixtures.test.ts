import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestEngine, ids, seedDocument, uuid } from './support/engine';
import { validateDocument, validateOperations } from '../src/model/validate';
import type { Operation } from '../src/model/types';

/**
 * Produces the cross-language parity fixtures consumed by tests/Diagram.Contracts.Tests.
 * Run with UPDATE_FIXTURES=1 to rewrite; otherwise the committed files must match.
 */
const dir = join(import.meta.dirname, '../../../contracts/fixtures/parity');

export const allOperations: Operation[] = [
  { op: 'create', pageId: ids.page, element: { kind: 'shape', alias: 'n1', bounds: { x: 10, y: 10, width: 50, height: 20 }, style: { fill: '#FFFFFF' }, text: { value: 'N1' }, geometry: { preset: 'ellipse' } } },
  { op: 'create', element: { kind: 'connector', from: { target: 'n1', port: 'east' }, to: { point: { x: 300, y: 40 } }, route: 'straight', style: { endArrow: 'open' } } },
  { op: 'set', target: ids.shape, patch: { alias: null, name: 'Renamed', style: { stroke: '#333333' }, text: { bold: true }, metadata: { k: 'v', gone: null } } },
  { op: 'move', target: ids.shape, delta: { xPt: 8.5039, yPt: 0 } },
  { op: 'move', target: ids.shape, to: { xPt: 100, yPt: 100 } },
  { op: 'resize', target: ids.shape, widthPt: 120 },
  { op: 'rotate', target: ids.shape, angleDeg: 33 },
  { op: 'rotate', target: uuid(0x700), deltaDeg: 15, pivot: { xPt: 10, yPt: 10 } },
  { op: 'delete', target: ids.shapes[4], connectors: 'detach' },
  { op: 'duplicate', targets: [ids.shape], offset: { xPt: 10, yPt: 10 }, aliases: { [ids.shape]: 'copy' } },
  { op: 'group', targets: [ids.shapes[1], ids.shapes[2]], alias: 'g' },
  { op: 'ungroup', target: 'g' },
  { op: 'align', targets: [ids.shapes[1], ids.shapes[2]], edge: 'center' },
  { op: 'distribute', targets: [ids.shapes[1], ids.shapes[2], ids.shapes[3]], axis: 'horizontal' },
  { op: 'setGap', targets: [ids.shapes[1], ids.shapes[2]], axis: 'vertical', gapPt: 14.17 },
  { op: 'zorder', targets: [ids.shapes[1]], action: 'front' },
  { op: 'addPage', page: { name: 'Second', widthPt: 595, heightPt: 842 }, index: 1 },
  { op: 'setPage', pageId: ids.page, patch: { grid: { snap: false } } },
  { op: 'reorderPage', pageId: ids.page, index: 0 },
  { op: 'duplicatePage', pageId: ids.page, name: 'Copy' },
  { op: 'deletePage', pageId: 'Copy' },
  { op: 'addLayer', layer: { name: 'Annotations', locked: false } },
  { op: 'setLayer', layer: 'Annotations', patch: { visible: false, colourOverride: null } },
  { op: 'assignLayer', targets: [ids.shape], layers: ['Annotations'], mode: 'add' },
  { op: 'deleteLayer', layer: 'Annotations' },
  { op: 'registerAsset', asset: { id: 'asset:other', name: 'Other', mimeType: 'image/svg+xml', sha256: 'c'.repeat(64), tags: [] } },
  { op: 'setAsset', assetId: 'asset:other', patch: { tags: ['x'] } },
  { op: 'replaceAssetGlobal', fromAssetId: 'asset:logo', toAssetId: 'asset:logo-v2' },
  { op: 'deleteAsset', assetId: 'asset:other' },
];

async function build() {
  const { engine, request, scope } = createTestEngine();
  const doc = seedDocument();
  const s = scope();
  const r = await engine.execute(request([
    { op: 'create', element: { kind: 'text', alias: 'note', bounds: { x: 20, y: 500, width: 200, height: 30 }, text: { value: 'Note "quoted" ✓' } } },
    { op: 'create', element: { kind: 'connector', alias: 'link', from: { target: 's0' }, to: { target: 's1', port: 'west' }, label: { value: 'flows' }, waypoints: [{ x: 1, y: 2 }] } },
    { op: 'group', targets: ['s5', 's6'], alias: 'grp' },
  ], { pageId: ids.page }), 'mcp');
  if (!r.ok) throw new Error(r.error.message);
  const events: unknown[] = [];
  engine.onCommitted((e) => events.push(e));
  await engine.execute(request([{ op: 'set', target: ids.image, patch: { assetId: 'asset:logo-v2' } }]), 'mcp');
  const changes = await engine.getChanges(engine.scope(), 0);
  const conflict = await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } }], { baseRevision: 0 }), 'mcp');
  const snapshot = engine.current();
  const projection = { documentId: s.documentId, sessionId: snapshot.sessionId, revision: snapshot.revision, connectors: { [r.value.aliases!.link]: { routePoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }], visualBounds: { x: 1, y: 2, width: 2, height: 2 } } }, groupVisualBounds: { [r.value.aliases!.grp]: { x: 0, y: 0, width: 10, height: 10 } } };
  return {
    'document.json': doc,
    'snapshot.json': snapshot,
    'export-snapshot.json': { ...snapshot, projection },
    'operations.json': allOperations,
    'transaction-result.json': r.value,
    'committed-event.json': events[0],
    'change-set.json': changes.ok ? changes.value : null,
    'response-error.json': { protocolVersion: 1, kind: 'response', requestId: 'r-9', documentId: s.documentId, sessionId: s.sessionId, error: conflict.ok ? null : conflict.error },
    'response-result.json': { protocolVersion: 1, kind: 'response', requestId: 'r-8', documentId: s.documentId, sessionId: s.sessionId, result: r.value },
    'request-envelope.json': JSON.parse(readFileSync(join(dir, '..', 'valid-apply.json'), 'utf8')),
    'prepared-asset.json': { ref: { preparationId: 'prep-1', asset: doc.assets[0], expiresAt: '2026-10-02T13:00:00Z' }, byteLength: 1234, sanitised: false },
    'diagnostic.json': { severity: 'warning', code: 'duplicate_agent_id', pageId: ids.page, sourceShapeId: '7', elementId: ids.shape, action: 'regenerated', detail: 'copy' },
  };
}

describe('parity fixtures', () => {
  it('are valid and up to date', async () => {
    const files = await build();
    expect(validateDocument(files['document.json']).ok).toBe(true);
    expect(validateOperations(files['operations.json']).ok).toBe(true);
    mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries(files)) {
      const text = JSON.stringify(value, null, 2) + '\n';
      const path = join(dir, name);
      if (process.env.UPDATE_FIXTURES || !existsSync(path)) writeFileSync(path, text);
      expect(readFileSync(path, 'utf8'), name).toBe(text);
    }
  });
});
