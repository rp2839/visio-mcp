import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { boot, revision, waitRevision } from './helpers';

/**
 * Browser-side §18 measurements with the real canvas: 500 visible elements on the page.
 * Reported, not gated tightly (ceilings are generous); see docs/acceptance/performance.md.
 */
test('500 visible elements: edit-to-canvas latency and 1600×1200 preview', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const created = await page.evaluate(async () => {
    const d = (window as any).__diagram; const s = d.scope();
    const operations = Array.from({ length: 500 }, (_, i) => ({ op: 'create', element: { kind: 'shape', alias: `n${i}`, text: { value: `Node ${i}` },
      bounds: { x: 10 + (i % 25) * 32, y: 10 + Math.floor(i / 25) * 28, width: 28, height: 22 } } }));
    const t = performance.now();
    const r = await d.agentApply({ documentId: s.documentId, sessionId: s.sessionId, baseRevision: s.revision, transactionId: crypto.randomUUID(), operations });
    await new Promise(requestAnimationFrame);
    return { ok: r.ok, ms: performance.now() - t, ids: r.ok ? r.value.created : [] };
  });
  expect(created.ok).toBe(true);
  await waitRevision(page, 1);
  await expect(page.locator('[data-testid=canvas] svg g')).not.toHaveCount(0);

  const edits = await page.evaluate(async (ids: string[]) => {
    const d = (window as any).__diagram;
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = d.scope();
      const t = performance.now();
      const r = await d.agentApply({ documentId: s.documentId, sessionId: s.sessionId, baseRevision: s.revision, transactionId: crypto.randomUUID(), operations: [{ op: 'move', target: ids[i * 7], delta: { xPt: 2, yPt: 0 } }] });
      if (!r.ok) throw new Error(r.error.message);
      await new Promise(requestAnimationFrame); // include the canvas update and paint
      samples.push(performance.now() - t);
    }
    return samples.sort((a, b) => a - b);
  }, created.ids);
  expect(await revision(page)).toBe(21);

  const renders = await page.evaluate(async () => {
    const d = (window as any).__diagram; const s = d.scope();
    const samples: number[] = [];
    let last: any = null;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      last = await d.request({ protocolVersion: 1, kind: 'request', requestId: crypto.randomUUID(), method: 'doc.render', documentId: s.documentId, sessionId: s.sessionId,
        params: { pageId: d.pageId(), format: 'png', maxWidth: 1600, maxHeight: 1200 } });
      samples.push(performance.now() - t);
    }
    return { samples: samples.sort((a, b) => a - b), ok: !last.error, width: last.result?.widthPx, height: last.result?.heightPx };
  });
  expect(renders.ok).toBe(true);
  expect(Math.max(renders.width, renders.height)).toBeGreaterThan(1000);

  const median = (a: number[]) => a[Math.floor(a.length / 2)];
  const results = {
    environment: { browser: 'chromium (headless)', userAgent: await page.evaluate(() => navigator.userAgent) },
    create500Batch: { ms: +created.ms.toFixed(1), preferredMs: 500 },
    singleEditWithCanvas: { medianMs: +median(edits).toFixed(1), p95Ms: +edits[Math.floor(edits.length * 0.95) - 1].toFixed(1), runs: edits.length, preferredMs: 100, acceptableMs: 250 },
    preview1600x1200: { medianMs: +median(renders.samples).toFixed(1), runs: renders.samples.length, preferredMs: 1000 },
  };
  mkdirSync('perf-results', { recursive: true });
  writeFileSync('perf-results/performance-browser.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  expect(median(edits)).toBeLessThan(1000);
  expect(median(renders.samples)).toBeLessThan(5000);
});
