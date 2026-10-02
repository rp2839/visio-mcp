import { expect, test } from '@playwright/test';
import { boot, snap } from './helpers';

test('asset.rasterize renders an SVG asset to a PNG derivative for VSDX export', async ({ page }) => {
  await boot(page);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#ff0000"/></svg>';
  const sha = 'a'.repeat(64);
  const s = await snap(page);
  const r = await page.evaluate(async ({ svg, sha, s }) => {
    const d = (window as any).__diagram;
    d.putAsset(sha, 'data:image/svg+xml;base64,' + btoa(svg));
    await d.agentApply({
      documentId: s.documentId, sessionId: s.sessionId, baseRevision: s.revision, transactionId: 'tx-svg',
      operations: [{ op: 'registerAsset', asset: { id: 'asset:vec', name: 'Vec', mimeType: 'image/svg+xml', sha256: sha, widthPx: 20, heightPx: 10, tags: [] } }],
    });
    return d.host('asset.rasterize', { sha256: sha });
  }, { svg, sha, s });
  expect(r.ok).toBe(true);
  expect(r.value.mimeType).toBe('image/png');
  expect(r.value.widthPx / r.value.heightPx).toBeCloseTo(2, 1);
  const bytes = Buffer.from(r.value.data, 'base64');
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  const missing = await page.evaluate(() => (window as any).__diagram.host('asset.rasterize', { sha256: 'b'.repeat(64) }));
  expect(missing.error.code).toBe('not_found');
});
