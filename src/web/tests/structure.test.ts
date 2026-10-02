import { describe, expect, it } from 'vitest';
import { createTestEngine, element, exactElementHashes, ids, logoAsset, uuid } from './support/engine';
import { richScene } from './support/scenes';

describe('structural operations', () => {
  it('pages: add, rename, size, reorder, duplicate, delete', async () => {
    const { engine, store, request } = createTestEngine();
    const before = exactElementHashes(store.snapshot());
    let r = await engine.execute(request([{ op: 'addPage', page: { id: uuid(0x500), name: 'B', widthPt: 595.28, heightPt: 841.89 } }]), 'gui');
    expect(r.ok && r.value.changedPageIds).toEqual([uuid(0x500)]);
    r = await engine.execute(request([{ op: 'setPage', pageId: 'B', patch: { name: 'Bee', grid: { spacingPt: 20 } } }, { op: 'reorderPage', pageId: uuid(0x500), index: 0 }]), 'gui');
    const pages = store.snapshot().document.pages;
    expect(pages.map((p) => p.name)).toEqual(['Bee', 'Page-1']);
    expect(pages[0].grid).toEqual({ visible: true, spacingPt: 20, snap: true });
    r = await engine.execute(request([{ op: 'duplicatePage', pageId: ids.page, newPageId: uuid(0x501), name: 'Copy' }]), 'gui');
    expect(r.ok && r.value.created).toHaveLength(20);
    const copy = store.snapshot().document.pages.find((p) => p.id === uuid(0x501))!;
    expect(copy.elements.every((e) => !before[e.id])).toBe(true);
    expect(copy.elements.map((e) => e.alias)).toEqual(store.snapshot().document.pages.find((p) => p.id === ids.page)!.elements.map((e) => e.alias));
    r = await engine.execute(request([{ op: 'deletePage', pageId: uuid(0x501) }]), 'gui');
    expect(r.ok && r.value.deleted).toHaveLength(20);
    expect(exactElementHashes(store.snapshot())).toEqual(before);
    const last = await engine.execute(request([{ op: 'deletePage', pageId: uuid(0x500) }, { op: 'deletePage', pageId: ids.page }]), 'gui');
    expect(!last.ok && last.error.message).toMatch(/last page/);
  });

  it('layers: add, set, assign, delete reports unassigned members', async () => {
    const { engine, store, request } = createTestEngine();
    const L = uuid(0x600);
    let r = await engine.execute(request([{ op: 'addLayer', layer: { id: L, name: 'Notes' } }, { op: 'assignLayer', targets: [ids.shapes[0], ids.shapes[1]], layers: ['Notes'] }], { pageId: ids.page }), 'gui');
    expect(r.ok && r.value.changedLayerIds).toEqual([L]);
    expect(r.ok && r.value.changed.sort()).toEqual([ids.shapes[0], ids.shapes[1]].sort());
    r = await engine.execute(request([{ op: 'setLayer', layer: L, patch: { visible: false, printable: false } }], { pageId: ids.page }), 'gui');
    expect(r.ok && r.value.changed).toEqual([]);
    expect(store.snapshot().document.pages[0].layers[0]).toMatchObject({ visible: false, printable: false });
    r = await engine.execute(request([{ op: 'deleteLayer', layer: 'Notes' }], { pageId: ids.page }), 'gui');
    expect(r.ok && r.value.changed.sort()).toEqual([ids.shapes[0], ids.shapes[1]].sort());
    expect(element(store.snapshot(), ids.shapes[0]).layerIds).toEqual([]);
  });

  it('assets: register, single-image reference, global replacement, in-use delete rejects', async () => {
    const { engine, store, request } = createTestEngine();
    const v3 = { ...logoAsset(2), id: `asset:logo~${'d'.repeat(64)}`, sha256: 'd'.repeat(64) };
    let r = await engine.execute(request([{ op: 'registerAsset', asset: v3 }, { op: 'set', target: ids.image, patch: { assetId: v3.id } }]), 'mcp');
    expect(r.ok && r.value.changed).toEqual([ids.image]);
    expect(r.ok && r.value.changedAssetIds).toEqual([v3.id]);
    const del = await engine.execute(request([{ op: 'deleteAsset', assetId: v3.id }]), 'mcp');
    expect(!del.ok && del.error.code).toBe('dependency_conflict');
    r = await engine.execute(request([{ op: 'replaceAssetGlobal', fromAssetId: v3.id, toAssetId: 'asset:logo' }]), 'mcp');
    expect(r.ok && r.value.changed).toEqual([ids.image]);
    const clash = await engine.execute(request([{ op: 'registerAsset', asset: { ...logoAsset(1), sha256: 'e'.repeat(64) } }]), 'mcp');
    expect(!clash.ok && clash.error.code).toBe('invalid_request');
    const wrongVersion = await engine.execute(request([{ op: 'registerAsset', asset: { ...v3, id: `asset:logo~${'f'.repeat(64)}` } }]), 'mcp');
    expect(wrongVersion.ok).toBe(false);
    expect(element(store.snapshot(), ids.image)).toMatchObject({ assetId: 'asset:logo' });
  });

  it('deleting a page with cross-page dependencies is impossible by construction; layer refs are page-local', async () => {
    const { engine, request, page2 } = await richScene();
    const r = await engine.execute(request([{ op: 'addLayer', pageId: page2, layer: { id: uuid(0x700), name: 'P2' } }, { op: 'assignLayer', targets: [ids.shape], layers: [uuid(0x700)] }], { pageId: ids.page }), 'gui');
    expect(!r.ok && r.error.code).toBe('not_found');
  });
});
