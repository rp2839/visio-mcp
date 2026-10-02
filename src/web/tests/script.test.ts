import { describe, expect, it } from 'vitest';
import { compile, validateScript } from '../src/script/compiler';
import { createTestEngine, element, exactElementHashes, ids, logoAsset, sequence, uuid } from './support/engine';
import { richScene } from './support/scenes';
import type { Operation, PreparedAssetRef } from '../src/model/types';

const mm = (v: number) => (v * 72) / 25.4;

/** Local script scene: "logo" is a shape alias here; the image uses alias "pic". */
function scene() {
  const t = createTestEngine();
  const snapshot = { ...t.engine.current(), pageId: ids.page };
  const doc = structuredClone(snapshot.document);
  doc.pages[0].elements[0].alias = 'pic';
  doc.pages[0].elements[1].alias = 'logo';
  const s = { ...snapshot, document: doc };
  const context = { snapshot: s, newUuid: sequence(0xa000) };
  return { ...t, snapshot: s, context };
}

const ok = (source: string, ctx = scene().context) => {
  const r = compile(source, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.operations;
};
const bad = (source: string, ctx = scene().context) => {
  const r = compile(source, ctx);
  if (r.ok) throw new Error(`expected failure for: ${source}`);
  return r.error;
};

describe('DrawScript parsing and compilation', () => {
  it('set is a patch: quoted # colour, other properties untouched', () => {
    const { context } = scene();
    expect(compile('set logo stroke="#333333"', context).ok).toBe(true);
    expect(ok('set logo stroke="#333333"')).toEqual([{ op: 'set', target: ids.shapes[0], patch: { style: { stroke: '#333333' } } }]);
  });

  it('comments, quoted # and JSON escapes', () => {
    const ops = ok('set logo text="#1 \\"best\\" \\u00e9\\n" # trailing comment\n# full line comment\n');
    expect(ops).toEqual([{ op: 'set', target: ids.shapes[0], patch: { text: { value: '#1 "best" é\n' } } }]);
  });

  it('spec §9.2 example compiles into the typed union with units converted', () => {
    const ctx = scene().context;
    ctx.snapshot.document.pages[0].name = 'Architecture';
    const ops = ok(`page use "Architecture"
add shape id=elexon type=roundedRect x=90mm y=25mm w=70mm h=20mm
set elexon text="Elexon"
set elexon fill="#FFFFFF" stroke="#53606F" strokeWidth=1pt
add shape id=dip type=roundedRect x=90mm y=65mm w=70mm h=25mm
set dip text="Data Integration Platform (DIP)"
add image id=corona asset="asset:logo" x=25mm y=125mm w=45mm h=20mm fit=contain
connect id=elexon_dip from=elexon.south to=dip.north route=orthogonal endArrow=triangle
align hcenter elexon dip
set-gap vertical elexon dip 20mm`, ctx);
    expect(ops.map((o) => o.op)).toEqual(['create', 'set', 'set', 'create', 'set', 'create', 'create', 'align', 'setGap']);
    const elexon = (ops[0] as any).element;
    expect(elexon).toMatchObject({ kind: 'shape', alias: 'elexon', geometry: { preset: 'roundedRect' } });
    expect(elexon.bounds.x).toBeCloseTo(mm(90), 9);
    expect((ops[6] as any).element.from).toEqual({ target: elexon.id, port: 'south' });
    expect((ops[7] as any).edge).toBe('center'); // hcenter synonym
    expect((ops[8] as any).gapPt).toBeCloseTo(mm(20), 9);
  });

  it('every §9.3 command family compiles', () => {
    const ctx = scene().context;
    const ops = ok(`page add name="Two"
page rename "Main"
page size preset="A3 landscape"
page size w=200mm h=100mm
add text id=t x=1cm y=1cm w=3in h=20pt text="Hi" bold=true
add shape id=a x=0mm y=0mm w=10mm h=10mm
add shape id=b x=20mm y=0mm w=10mm h=10mm
connect id=ab from=a to=b
group id=g a b
move g dx=5mm
move t x=10mm y=10mm
resize a w=12mm
rotate t angle=33
rotate g by=30deg pivotX=50mm pivotY=40mm
duplicate t as=t2 dx=1mm dy=1mm
delete t2
distribute horizontal s1 s2 s3
z front s1
layer add name="Notes" locked=false
layer set "Notes" visible=false
layer assign "Notes" s1 s2
asset replace pic asset="asset:logo-v2"
asset replace global from="asset:logo" to="asset:logo-v2"
ungroup g`, ctx);
    expect(ops.map((o) => o.op)).toEqual(['addPage', 'setPage', 'setPage', 'setPage', 'create', 'create', 'create', 'create', 'group', 'move', 'move', 'resize', 'rotate', 'rotate', 'duplicate', 'delete', 'distribute', 'zorder', 'addLayer', 'setLayer', 'assignLayer', 'set', 'replaceAssetGlobal', 'ungroup']);
    expect((ops[13] as any).pivot.xPt).toBeCloseTo(mm(50), 9);
  });

  it('errors carry original line/column and never mutate', () => {
    const { engine, store, context } = scene();
    const beforeHashes = exactElementHashes(store.snapshot());
    const badScript = bad('set logo name="ok"\nset logo nonsense=1', context);
    expect(badScript.details!.line).toBe(2);
    expect(badScript.details!.column).toBe(10);
    const v = validateScript('add shape id=x x=1mm y=1mm w=1mm h=1mm', context);
    expect(v.ok && v.value.created).toHaveLength(1);
    expect(exactElementHashes(store.snapshot())).toEqual(beforeHashes); // validate never commits
    expect(engine.scope().revision).toBe(0);
  });

  it('typed values: dimensions need units; colours, bools and enums are checked', () => {
    expect(bad('move logo dx=5').message).toMatch(/unit/);
    expect(bad('set logo fill=red').message).toMatch(/#RRGGBB/);
    expect(bad('set logo fill=#FF0000').message).toMatch(/missing value|#RRGGBB/); // unquoted # starts a comment
    expect(bad('set logo bold=yes').message).toMatch(/true or false/);
    expect(bad('set logo dash=wavy').message).toMatch(/one of/);
    expect(ok('set logo fill="#FF000080" bold=true fontSize=12pt')[0]).toMatchObject({ patch: { style: { fill: '#FF000080' }, text: { bold: true, fontSizePt: 12 } } });
  });

  it('dotted alias vs port: whole alias wins; quoted dotted alias with an explicit port field', () => {
    const ctx = scene().context;
    ctx.snapshot.document.pages[0].elements[3].alias = 'svc.api';
    const ops = ok(`connect from=svc.api to=logo.east
connect from="svc.api" fromPort=north to=s3`, ctx);
    expect((ops[0] as any).element.from).toEqual({ target: ids.shapes[2] });
    expect((ops[0] as any).element.to).toEqual({ target: ids.shapes[0], port: 'east' });
    expect((ops[1] as any).element.from).toEqual({ target: ids.shapes[2], port: 'north' });
    expect(bad('connect from=logo.nowhere.x to=s3').message).toMatch(/no element/);
  });

  it('rotate: angle/by exclusive; group angle rejected with guidance; pivot halves and targets checked', async () => {
    const r = await richScene();
    const ctx = { snapshot: { ...r.engine.current(), pageId: ids.page }, newUuid: sequence(0xb000) };
    expect(bad('rotate s1 angle=10 by=5', ctx).message).toMatch(/not both/);
    expect(bad('rotate outer angle=30', ctx).message).toMatch(/by=/);
    expect(bad('rotate outer by=30 pivotX=1mm', ctx).message).toMatch(/both pivotX/);
    expect(bad('rotate s1 by=30 pivotX=1mm pivotY=1mm', ctx).message).toMatch(/only valid for groups/);
    expect(ok('rotate outer by=-15', ctx)).toEqual([{ op: 'rotate', target: r.outer, deltaDeg: -15 }]);
    expect(ok('rotate s1 by=15', ctx)).toEqual([{ op: 'rotate', target: ids.shapes[1], deltaDeg: 15 }]);
  });

  it('unknown commands and fields reject; absolute and delta move cannot mix', () => {
    expect(bad('explode logo').message).toMatch(/unknown command/);
    expect(bad('move logo x=1mm dx=1mm').message).toMatch(/not both/);
    expect(bad('add shape x=1mm y=1mm w=1mm').message).toMatch(/needs x=, y=, w= and h=/);
    expect(bad('add shape id=logo x=1mm y=1mm w=1mm h=1mm').message).toMatch(/already exists/);
  });

  it('ambiguous display names are reported with candidates', () => {
    const e = bad('set Box fill="#000000"');
    expect(e.code).toBe('ambiguous_target');
    expect((e.details!.candidates as string[]).length).toBe(2);
  });
});

describe('DrawScript execution', () => {
  const run = (t: ReturnType<typeof createTestEngine>, script: string, extra: Partial<{ transactionId: string; preparedAssetRefs: Record<string, PreparedAssetRef> }> = {}) => {
    const s = t.scope();
    return t.engine.executeScript({ documentId: s.documentId, sessionId: s.sessionId, pageId: ids.page, transactionId: extra.transactionId ?? t.nextTx(), baseRevision: s.revision, script, ...(extra.preparedAssetRefs ? { preparedAssetRefs: extra.preparedAssetRefs } : {}) }, compile);
  };

  it('script_equals_typed_operations', async () => {
    const a = createTestEngine(), b = createTestEngine();
    const script = 'set s0 fill="#ABCDEF"\nmove s1 dx=3mm dy=0mm\nalign top s2 s3';
    const r1 = await run(a, script);
    const ops: Operation[] = [
      { op: 'set', target: ids.shapes[0], patch: { style: { fill: '#ABCDEF' } } },
      { op: 'move', target: ids.shapes[1], delta: { xPt: mm(3), yPt: 0 } },
      { op: 'align', targets: [ids.shapes[2], ids.shapes[3]], edge: 'top' },
    ];
    const r2 = await b.engine.execute(b.request(ops), 'mcp');
    expect(r1.ok && r2.ok).toBe(true);
    expect(exactElementHashes(a.engine.current())).toEqual(exactElementHashes(b.engine.current()));
    expect(r1.ok && r1.value.operations).toEqual(ops);
  });

  it('one_batch_one_undo', async () => {
    const t = createTestEngine();
    const before = exactElementHashes(t.engine.current());
    const r = await run(t, 'add shape id=n x=1mm y=1mm w=10mm h=10mm\nset s0 fill="#000000"\ndelete s5');
    expect(r.ok && r.value.revision).toBe(1);
    await t.engine.undo({ ...t.scope(), transactionId: t.nextTx(), baseRevision: 1 });
    expect(exactElementHashes(t.engine.current())).toEqual(before);
  });

  it('duplicate_script_create_retries_once (cache precedes compile; no new live IDs)', async () => {
    const t = createTestEngine();
    const tx = t.nextTx();
    const first = await run(t, 'add shape id=once x=1mm y=1mm w=1mm h=1mm', { transactionId: tx });
    const retry = await run({ ...t, scope: () => ({ ...t.scope(), revision: 0 }) }, 'add shape id=once x=1mm y=1mm w=1mm h=1mm', { transactionId: tx });
    expect(retry).toEqual(first);
    expect(t.engine.current().document.pages[0].elements.filter((e) => e.alias === 'once')).toHaveLength(1);
  });

  it('page_use_is_context_only: no revision for the use itself; aliases resolve on the used page', async () => {
    const r = await richScene();
    const s = r.scope();
    const res = await r.engine.executeScript({ documentId: s.documentId, sessionId: s.sessionId, transactionId: r.nextTx(), baseRevision: s.revision, script: 'page use "Second"\nset s0 name="second page s0"' }, compile);
    expect(res.ok && res.value.changed).toEqual([uuid(0x300)]);
    expect(res.ok && res.value.changedPageIds).toEqual([r.page2]);
  });

  it('asset_prepare_precedes_commit: import needs a host-prepared ref and registers it atomically', async () => {
    const t = createTestEngine();
    const asset = { ...logoAsset(2), id: `asset:new~${'c'.repeat(64)}`, sha256: 'c'.repeat(64) };
    const refs = { brand: { preparationId: 'prep-1', asset, expiresAt: '2099-01-01T00:00:00Z' } };
    const missing = await run(t, 'asset import ref=brand');
    expect(!missing.ok && missing.error.message).toMatch(/prepared/);
    let verified = 0;
    t.engine.setPreparedRefVerifier(() => { verified++; return { ok: true, value: undefined }; });
    const r = await run(t, `asset import ref=brand\nasset replace pic asset="${asset.id}"`.replace('pic', ids.image), { preparedAssetRefs: refs });
    expect(r.ok, !r.ok ? r.error.message : '').toBe(true);
    expect(verified).toBe(1);
    expect(element(t.engine.current(), ids.image)).toMatchObject({ assetId: asset.id });
    expect(r.ok && r.value.changedAssetIds).toEqual([asset.id]);
  });

  it('1001_operations_reject', async () => {
    const t = createTestEngine();
    const script = Array.from({ length: 1001 }, (_, i) => `move s${i % 19} dx=1pt`).join('\n');
    const r = await run(t, script);
    expect(!r.ok && r.error.code).toBe('limit_exceeded');
    expect(t.engine.current().revision).toBe(0);
  });

  it('planner errors map back to the script line', async () => {
    const t = createTestEngine();
    const r = await run(t, 'set s0 name="fine"\n\ndelete s0 # glued? no — but locked below\nset s1 locked=true\nmove s1 dx=1mm');
    expect(!r.ok && r.error.code).toBe('locked_target');
    expect(!r.ok && r.error.details?.line).toBe(5);
  });
});
