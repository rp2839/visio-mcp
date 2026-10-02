import { describe, expect, it } from 'vitest';
import { affectedImages, prepareDocumentAsset, replaceAssetEverywhere, replaceImageAsset, resolveDocumentAsset } from '../src/commands/assetVersions';
import { createTestEngine, element, exactElementHashes, ids, seedDocument, uuid } from './support/engine';
import type { Asset, Element, PreparedAsset } from '../src/model/types';

const prepared = (asset: Asset): PreparedAsset => ({ ref: { preparationId: 'prep-1', asset, expiresAt: '2026-10-02T13:00:00Z' }, byteLength: 10 });
const image = (n: number, assetId: string): Element => ({
  id: uuid(n), kind: 'image', layerIds: [], zIndex: n, locked: false, hidden: false, bounds: { x: n, y: 300, width: 40, height: 20 },
  rotationDeg: 0, metadata: {}, assetId, fit: 'contain', opacity: 1, preserveAspectRatio: true,
});

function twoLogos() {
  const doc = seedDocument(5);
  doc.pages[0].elements.push(image(200, 'asset:logo'), { ...image(201, 'asset:logo-v2'), zIndex: 201 });
  return createTestEngine({ document: doc });
}

describe('asset versions', () => {
  it('SingleImageOnly: replacing one image changes only that element', async () => {
    const t = twoLogos();
    const before = exactElementHashes(t.engine.current());
    const r = await t.engine.execute(t.request(replaceImageAsset(ids.image, 'asset:logo-v2')), 'mcp');
    expect(r.ok && r.value.changed).toEqual([ids.image]);
    const after = exactElementHashes(t.engine.current());
    delete before[ids.image]; delete after[ids.image];
    expect(after).toEqual(before);
    expect(element(t.engine.current(), uuid(200)).kind === 'image' && (element(t.engine.current(), uuid(200)) as any).assetId).toBe('asset:logo');
  });

  it('GlobalReplacementReportsAffectedImages and leaves other images alone', async () => {
    const t = twoLogos();
    const affected = affectedImages(t.engine.current(), 'asset:logo');
    expect(affected.sort()).toEqual([ids.image, uuid(200)].sort());
    const unrelatedBefore = exactElementHashes(t.engine.current());
    const r = await t.engine.execute(t.request(replaceAssetEverywhere('asset:logo', 'asset:logo-v2')), 'mcp');
    expect(r.ok && [...r.value.changed].sort()).toEqual(affected.sort());
    const unrelatedAfter = exactElementHashes(t.engine.current());
    for (const id of affected) { delete unrelatedBefore[id]; delete unrelatedAfter[id]; }
    expect(unrelatedAfter).toEqual(unrelatedBefore);
  });

  it('NewHashSameSlugPinsSeparateVersion', async () => {
    const t = twoLogos();
    const fullHash = 'c'.repeat(64);
    const p = prepareDocumentAsset(t.engine.current(), prepared({ id: 'asset:logo', name: 'Logo 2027', mimeType: 'image/png', sha256: fullHash, tags: ['logo'] }));
    expect(p.resolvedAssetId).toBe(`asset:logo~${fullHash}`);
    expect(p.versioned).toBe(true);
    const r = await t.engine.execute(t.request([...p.operations, ...replaceImageAsset(ids.image, p.resolvedAssetId)]), 'mcp');
    expect(r.ok).toBe(true);
    const assets = t.engine.current().document.assets;
    expect(assets.find((a) => a.id === 'asset:logo')!.sha256).toBe('a'.repeat(64)); // pinned version untouched
    expect((element(t.engine.current(), uuid(200)) as any).assetId).toBe('asset:logo');
    // same bytes again → no new operations
    expect(prepareDocumentAsset(t.engine.current(), prepared({ id: 'asset:logo', name: 'x', mimeType: 'image/png', sha256: fullHash, tags: [] })).operations).toEqual([]);
    // bare slug resolves to the pinned version
    const pinned = resolveDocumentAsset(t.engine.current(), 'logo');
    expect(pinned.ok && pinned.value.sha256).toBe('a'.repeat(64));
  });

  it('InUseDeleteRejects', async () => {
    const t = twoLogos();
    const r = await t.engine.execute(t.request([{ op: 'deleteAsset', assetId: 'asset:logo' }]), 'mcp');
    expect(!r.ok && r.error.code).toBe('dependency_conflict');
    expect(t.engine.current().document.assets.some((a) => a.id === 'asset:logo')).toBe(true);
  });

  it('ImportedDocumentWorksWithoutLibrary: document assets alone resolve and render references', () => {
    const t = createTestEngine();
    const r = resolveDocumentAsset(t.engine.current(), 'asset:logo');
    expect(r.ok && r.value.id).toBe('asset:logo');
    expect(affectedImages(t.engine.current(), 'asset:logo')).toEqual([ids.image]);
    expect(prepareDocumentAsset(t.engine.current(), prepared(t.engine.current().document.assets[0])).operations).toEqual([]);
  });
});
