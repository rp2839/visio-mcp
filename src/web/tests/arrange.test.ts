import { describe, expect, it } from 'vitest';
import { createTestEngine, element, hashesExcept, ids } from './support/engine';
import { richScene } from './support/scenes';

const three = [ids.shapes[0], ids.shapes[1], ids.shapes[2]];

describe('arrange and order', () => {
  it('align_changes_only_selected_geometry', async () => {
    const { engine, store, request } = createTestEngine();
    await engine.execute(request([{ op: 'move', target: ids.shapes[1], delta: { xPt: 7, yPt: 33 } }]), 'gui');
    const before = store.snapshot();
    const r = await engine.execute(request([{ op: 'align', targets: three, edge: 'top' }]), 'mcp');
    expect(r.ok).toBe(true);
    const tops = three.map((id) => element(store.snapshot(), id).bounds.y);
    expect(new Set(tops).size).toBe(1);
    expect(r.ok && r.value.changed).toEqual([ids.shapes[1]]); // others were already at the top edge
    expect(hashesExcept(store.snapshot(), ...three)).toEqual(hashesExcept(before, ...three));
    const xs = three.map((id) => element(store.snapshot(), id).bounds.x);
    expect(xs).toEqual(three.map((id) => element(before, id).bounds.x));
  });

  it('align center uses the selection extent', async () => {
    const { engine, store, request } = createTestEngine();
    const before = store.snapshot();
    const b = [ids.shapes[0], ids.shapes[5]].map((id) => element(before, id).bounds);
    await engine.execute(request([{ op: 'align', targets: [ids.shapes[0], ids.shapes[5]], edge: 'middle' }]), 'mcp');
    const mid = (Math.min(...b.map((x) => x.y)) + Math.max(...b.map((x) => x.y + x.height))) / 2;
    for (const id of [ids.shapes[0], ids.shapes[5]]) { const x = element(store.snapshot(), id).bounds; expect(x.y + x.height / 2).toBeCloseTo(mid, 9); }
  });

  it('distribute_preserves_ends', async () => {
    const { engine, store, request } = createTestEngine();
    await engine.execute(request([{ op: 'move', target: ids.shapes[1], delta: { xPt: -60, yPt: 0 } }]), 'gui');
    const before = store.snapshot();
    await engine.execute(request([{ op: 'distribute', targets: three, axis: 'horizontal' }]), 'mcp');
    const b = three.map((id) => element(store.snapshot(), id).bounds);
    expect(b[0].x).toBe(element(before, three[0]).bounds.x);
    expect(b[2].x).toBe(element(before, three[2]).bounds.x);
    expect(b[1].x - (b[0].x + b[0].width)).toBeCloseTo(b[2].x - (b[1].x + b[1].width), 9);
  });

  it('gap_preserves_first', async () => {
    const { engine, store, request } = createTestEngine();
    const before = store.snapshot();
    await engine.execute(request([{ op: 'setGap', targets: three, axis: 'horizontal', gapPt: 5 }]), 'mcp');
    const b = three.map((id) => element(store.snapshot(), id).bounds);
    expect(b[0]).toEqual(element(before, three[0]).bounds);
    expect(b[1].x - (b[0].x + b[0].width)).toBeCloseTo(5, 9);
    expect(b[2].x - (b[1].x + b[1].width)).toBeCloseTo(5, 9);
  });

  it('input order breaks equal-position ties deterministically', async () => {
    const { engine, store, request } = createTestEngine();
    await engine.execute(request([{ op: 'move', target: ids.shapes[1], to: { xPt: 150, yPt: 300 } }]), 'gui'); // same x as shapes[0]
    await engine.execute(request([{ op: 'setGap', targets: [ids.shapes[1], ids.shapes[0]], axis: 'horizontal', gapPt: 0 }]), 'mcp');
    expect(element(store.snapshot(), ids.shapes[1]).bounds.x).toBe(150); // first in input order stays
  });

  it('reorder_reports_intervening_ids', async () => {
    const { engine, store, request } = createTestEngine();
    const r = await engine.execute(request([{ op: 'zorder', targets: [ids.shapes[0]], action: 'front' }]), 'mcp');
    // shapes[0] jumps above every later element: all of them shift down one rank
    expect(r.ok && r.value.changed.length).toBe(19);
    const z = store.snapshot().document.pages[0].elements.map((e) => e.id);
    expect(z[z.length - 1]).toBe(ids.shapes[0]);
    const f = await engine.execute(request([{ op: 'zorder', targets: [ids.shapes[3]], action: 'forward' }]), 'mcp');
    expect(f.ok && f.value.changed.sort()).toEqual([ids.shapes[3], ids.shapes[4]].sort());
    const values = store.snapshot().document.pages[0].elements.map((e) => e.zIndex);
    expect(new Set(values).size).toBe(values.length);
  });

  it('mixed_page_rejects', async () => {
    const { engine, request } = await richScene();
    const r = await engine.execute(request([{ op: 'align', targets: [ids.shapes[0], '00000000-0000-4000-8000-000000000300'], edge: 'left' }]), 'mcp');
    expect(!r.ok && r.error.code).toBe('invalid_request');
  });
});
