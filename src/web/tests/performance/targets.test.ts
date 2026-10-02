import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommandEngine } from '../../src/commands/CommandEngine';
import { readSummary } from '../../src/bridge/readTools';
import { canonicalSerialize } from '../../src/model/canonical';
import { benchmarkDocument, uuid } from './fixture';

/**
 * Spec §18 targets, measured on the engine without transport or canvas. Preferred targets are
 * reported (results JSON), not gated; the assertions use the "acceptable" ceilings with slack so
 * the suite is not flaky on a loaded CI box. Browser-side preview and canvas costs are measured
 * in tests/browser/performance.spec.ts; VSDX save in Diagram.Visio.Tests PerformanceTests.
 */
const results: Record<string, { medianMs: number; p95Ms: number; runs: number; preferredMs: number; acceptableMs?: number; preferredMet: boolean }> = {};

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
}

async function measure(name: string, runs: number, preferredMs: number, acceptableMs: number | undefined, fn: (i: number) => Promise<unknown> | unknown) {
  await fn(-1); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(i); samples.push(performance.now() - t); }
  const { median, p95 } = stats(samples);
  results[name] = { medianMs: +median.toFixed(2), p95Ms: +p95.toFixed(2), runs, preferredMs, ...(acceptableMs ? { acceptableMs } : {}), preferredMet: median < preferredMs };
  return median;
}

function engine() {
  let n = 0x900000;
  const e = new CommandEngine({ document: benchmarkDocument(), newUuid: () => uuid(n++), now: () => '2026-10-02T12:00:00.000Z' });
  const req = (operations: any[]) => { const s = e.scope(); return { ...s, transactionId: uuid(n++), baseRevision: s.revision, atomic: true as const, operations }; };
  return { e, req };
}

describe('performance targets (10 pages, 500 visible elements per page)', () => {
  it('single edit: preferred < 100 ms, acceptable < 250 ms', async () => {
    const { e, req } = engine();
    const target = e.current().document.pages[0].elements[10].id;
    const median = await measure('singleEdit', 30, 100, 250, () => e.execute(req([{ op: 'move', target, delta: { xPt: 1, yPt: 0 } }]), 'mcp'));
    expect(median).toBeLessThan(250);
  });

  it('100-operation batch: preferred < 500 ms', async () => {
    const { e, req } = engine();
    const ids = e.current().document.pages[0].elements.slice(0, 100).map((x) => x.id);
    const median = await measure('batch100', 10, 500, undefined, (i) => e.execute(req(ids.map((id) => ({ op: 'set', target: id, patch: { style: { fill: i % 2 ? '#FFEECC' : '#CCEEFF' } } }))), 'mcp'));
    expect(median).toBeLessThan(2000);
  });

  it('semantic summary of 500 elements: < 250 ms excluding transport', async () => {
    const { e } = engine();
    const snap = e.current();
    const median = await measure('summary500', 20, 250, undefined, () => JSON.stringify(readSummary(snap, { includeGeometry: true })));
    expect(median).toBeLessThan(250);
  });

  it('one-object correction leaves all 4999 other objects byte-identical', async () => {
    const { e, req } = engine();
    const before = new Map(e.current().document.pages.flatMap((p) => p.elements).map((x) => [x.id, canonicalSerialize(x)]));
    const target = e.current().document.pages[3].elements[42].id;
    const r = await e.execute(req([{ op: 'set', target, patch: { text: { value: 'Corrected' } } }]), 'mcp');
    expect(r.ok && r.value.changed).toEqual([target]);
    let unchanged = 0;
    for (const x of e.current().document.pages.flatMap((p) => p.elements)) if (x.id !== target && before.get(x.id) === canonicalSerialize(x)) unchanged++;
    expect(unchanged).toBe(4999);
  });

  it('writes the results file', () => {
    mkdirSync('perf-results', { recursive: true });
    writeFileSync('perf-results/performance-engine.json', JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch }, results }, null, 2));
    console.log(JSON.stringify(results));
    expect(Object.keys(results).length).toBe(3);
  });
});
