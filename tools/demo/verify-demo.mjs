#!/usr/bin/env node
// Verifies the §23 demonstration from saved semantic evidence (tools/demo/out), not from pixels.
// Usage: node tools/demo/verify-demo.mjs [outDir]. Exit code 1 if any check FAILS.
// Steps that need Microsoft Visio/Word are reported NOT RUN: they are never inferred from library results.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? new URL('./out', import.meta.url).pathname;
const load = (f) => JSON.parse(readFileSync(join(out, f), 'utf8'));
const results = [];
const check = (step, title, fn) => {
  try { const detail = fn(); results.push({ step, title, status: 'PASS', detail: detail ?? '' }); }
  catch (e) { results.push({ step, title, status: 'FAIL', detail: e.message }); }
};
const notRun = (step, title, why) => results.push({ step, title, status: 'NOT RUN', detail: why });
const assert = (c, m) => { if (!c) throw new Error(m); };

// Same canonical form as src/web/src/model/canonical.ts: sorted keys, no whitespace.
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const elements = (snap) => new Map(snap.document.pages.flatMap((p) => p.elements).map((e) => [e.id, e]));
const byAlias = (snap, a) => [...elements(snap).values()].find((e) => e.alias === a);
const changedIds = (a, b) => {
  const ea = elements(a), eb = elements(b), ids = new Set([...ea.keys(), ...eb.keys()]);
  return [...ids].filter((id) => !ea.has(id) || !eb.has(id) || canonical(ea.get(id)) !== canonical(eb.get(id))).sort();
};

if (!existsSync(join(out, 'demo-evidence.json'))) {
  console.error(`no evidence in ${out}; run: npm --prefix src/web run test:browser -- tests/browser/demo.spec.ts`);
  process.exit(2);
}
const ev = load('demo-evidence.json');
const step = (n) => ev.steps.find((s) => s.step === n) ?? (() => { throw new Error(`no evidence for step ${n}`); })();

check(1, 'Human opens a blank A4 landscape page', () => {
  const p = step(1).snapshot.document.pages[0];
  assert(Math.abs(p.widthPt - 841.89) < 0.01 && Math.abs(p.heightPt - 595.28) < 0.01, `page is ${p.widthPt}×${p.heightPt}`);
  assert(p.elements.length === 0, 'page is not blank');
});
check(2, 'Agent creates labelled blocks, connectors and annotations through MCP', () => {
  const s = step(2).snapshot;
  const blocks = ['crm', 'billing', 'dwh', 'esgblock'].map((a) => byAlias(s, a));
  assert(blocks.every((b) => b?.kind === 'shape' && b.text?.value), 'four labelled blocks expected');
  const conns = [...elements(s).values()].filter((e) => e.kind === 'connector');
  const ids = new Set(blocks.map((b) => b.id));
  assert(conns.length === 3 && conns.every((c) => ids.has(c.from.elementId) && ids.has(c.to.elementId)), 'three glued connectors expected');
  assert(byAlias(s, 'note')?.kind === 'text', 'annotation missing');
  assert(step(2).result.created.length === 10 && s.revision === 1, 'expected one atomic transaction creating 10 elements');
  return `${blocks.length} blocks, ${conns.length} connectors, 1 note, 2 logos in revision ${s.revision}`;
});
check(3, 'UI visibly updates after the transaction', () => 'asserted in-browser (canvas cells present after revision 1); see demo.spec.ts');
check(4, 'Agent requests a PNG preview and notices one alignment problem', () => {
  const s4 = step(4);
  assert(s4.preview.revision === step(2).snapshot.revision, 'preview is not labelled with the current revision');
  const png = readFileSync(join(out, s4.preview.file));
  assert(png.subarray(1, 4).toString() === 'PNG', 'preview is not a PNG');
  const t = s4.topsPt;
  assert(t.crm === t.dwh && t.billing !== t.crm, 'expected exactly one misaligned block');
  return `preview ${s4.preview.widthPx}×${s4.preview.heightPx}; billing top ${t.billing.toFixed(2)} vs ${t.crm.toFixed(2)} pt`;
});
check(5, 'Agent aligns only the affected elements', () => {
  const a = step(4).snapshot, b = step(5).snapshot;
  const billing = byAlias(b, 'billing');
  const changed = changedIds(a, b);
  assert(canonical(changed) === canonical([billing.id]), `changed ${changed.length} element(s): ${changed}`);
  assert(['crm', 'billing', 'dwh'].map((x) => byAlias(b, x).bounds.y).every((y, _, all) => y === all[0]), 'tops not aligned');
  return 'exactly 1 element changed';
});
check(6, 'Human drags one element and changes one fill colour', () => {
  const a = step(5).snapshot, b = step(6).snapshot;
  const changed = changedIds(a, b);
  const dwh = byAlias(b, 'dwh'), esg = byAlias(b, 'esgblock');
  assert(canonical(changed) === canonical([dwh.id, esg.id].sort()), `changed: ${changed}`);
  assert(canonical(byAlias(a, 'dwh').bounds) !== canonical(dwh.bounds), 'dwh did not move');
  assert(esg.style.fill.toUpperCase() === '#FFE0B2', `fill is ${esg.style.fill}`);
  return 'two GUI transactions, two elements';
});
check(7, 'Agent reads changes since its revision and preserves the human edit', () => {
  const s7 = step(7), human = step(6).snapshot, after = s7.snapshot;
  assert(s7.staleError?.code === 'revision_conflict' && s7.staleError.outcome === 'not_applied', 'stale edit was not refused');
  assert(s7.changes.transactions.length === 2 && s7.changes.transactions.every((t) => t.source === 'gui'), 'changes since the agent revision should be the two human transactions');
  const dwhBefore = byAlias(human, 'dwh'), dwhAfter = byAlias(after, 'dwh');
  assert(canonical(dwhBefore.bounds) === canonical(dwhAfter.bounds), 'human move was lost');
  assert(canonical(byAlias(human, 'esgblock')) === canonical(byAlias(after, 'esgblock')), 'human fill change was lost');
  assert(canonical(changedIds(human, after)) === canonical([dwhAfter.id]) && dwhAfter.text.value.includes('Snowflake'), 'retry changed more than the text');
  return 'conflict → get_changes → text-only retry; human geometry/fill intact';
});
check(8, 'Agent replaces one company logo from the approved assets', () => {
  const s9 = step(9);
  const img = elements(s9.snapshot).get(s9.imageId);
  assert(img.assetId === 'asset:esg-global', `image uses ${img.assetId}`);
  const asset = s9.snapshot.document.assets.find((a) => a.id === img.assetId);
  assert(asset?.provenance === 'approved demo library', 'asset is not from the approved library');
  return `logo → ${img.assetId} (${asset.sha256.slice(0, 12)}…)`;
});
check(9, 'Only that image object changes', () => {
  const changed = changedIds(step(7).snapshot, step(9).snapshot);
  assert(canonical(changed) === canonical([step(9).imageId]), `changed: ${changed}`);
  return `${elements(step(9).snapshot).size - 1} other elements byte-identical`;
});

const rtPath = join(out, 'demo-roundtrip.json');
if (existsSync(rtPath)) {
  const rt = load('demo-roundtrip.json');
  check(10, 'Document saves as .vsdx (library-level export)', () => {
    assert(existsSync(join(out, 'demo.vsdx')) && rt.packageBytes > 0, 'no package');
    return `${rt.packageBytes} bytes; export diagnostics: ${[...new Set(rt.exportDiagnostics)].join(', ') || 'none'}`;
  });
  check(14, 'VSDX reopened in the app; agent IDs still resolve (library-level, no Visio save in between)', () => {
    assert(canonical(rt.exportedIds) === canonical(rt.reimportedIds), 'ID sets differ');
    assert(rt.glue.every((g) => g.from === g.fromAfter && g.to === g.toAfter), 'glue changed');
    assert(rt.images.every((i) => i.before === i.after), 'image asset IDs changed');
    return `${rt.reimportedIds.length} IDs, ${rt.glue.length} glued connectors resolved`;
  });
} else {
  notRun(10, 'Document saves as .vsdx', 'run DemoRoundTripTests (dotnet test tests/Diagram.Visio.Tests) after the browser demo');
  notRun(14, 'VSDX reopened in the app; agent IDs still resolve', 'as above');
}
notRun(11, 'File opens in Visio with editable objects', 'requires Microsoft Visio on Windows (I41 WA-02/WA-03)');
notRun(12, 'Moving a connected shape in Visio keeps its connector attached', 'requires Microsoft Visio (I41 WA-04)');
notRun(13, 'VSDX embedded in Word remains activatable/editable', 'requires Microsoft Word + Visio (I41 WA-10/WA-11)');

results.sort((a, b) => a.step - b.step);
for (const r of results) console.log(`${String(r.step).padStart(2)}  ${r.status.padEnd(7)}  ${r.title}${r.detail ? `\n             ${r.detail}` : ''}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${results.filter((r) => r.status === 'PASS').length} PASS, ${failed} FAIL, ${results.filter((r) => r.status === 'NOT RUN').length} NOT RUN`);
process.exit(failed ? 1 : 0);
