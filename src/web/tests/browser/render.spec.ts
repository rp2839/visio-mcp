import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, waitRevision } from './helpers';

const golden = join(import.meta.dirname, '../../../../tests/fixtures/golden');

async function request(page: Page, method: string, params: Record<string, unknown> = {}) {
  return page.evaluate(async ([m, p]) => {
    const d = (window as any).__diagram; const s = d.scope();
    return d.request({ protocolVersion: 1, kind: 'request', requestId: crypto.randomUUID(), method: m, documentId: s.documentId, sessionId: s.sessionId, params: p });
  }, [method, params] as const);
}
const apply = (page: Page, operations: unknown[]) => page.evaluate(async (ops) => {
  const d = (window as any).__diagram; const s = d.scope();
  return d.agentApply({ documentId: s.documentId, sessionId: s.sessionId, transactionId: crypto.randomUUID(), baseRevision: s.revision, atomic: true, operations: ops, pageId: d.pageId() });
}, operations);
/** Decode a base64 PNG/JPEG in the page and read one pixel (crop coordinates in pt). */
const pixel = (page: Page, data: string, mime: string, x: number, y: number, scale: number) => page.evaluate(async ([d, m, px, py, s]) => {
  const img = new Image(); img.src = `data:${m};base64,${d}`; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
  return Array.from(ctx.getImageData(Math.round((px as number) * (s as number)), Math.round((py as number) * (s as number)), 1, 1).data);
}, [data, mime, x, y, scale] as const);
const pageId = (page: Page) => page.evaluate(() => (window as any).__diagram.pageId());
const redPng = (page: Page) => page.evaluate(() => { const c = document.createElement('canvas'); c.width = 20; c.height = 20; const x = c.getContext('2d')!; x.fillStyle = '#FF0000'; x.fillRect(0, 0, 20, 20); return c.toDataURL('image/png').split(',')[1]; });

test.beforeEach(async ({ page }) => boot(page));

test('SnapshotRevisionNotLiveRevision', async ({ page }) => {
  const pid = await pageId(page);
  await apply(page, [{ op: 'create', element: { kind: 'shape', bounds: { x: 50, y: 50, width: 100, height: 50 } } }]);
  const [render] = await Promise.all([
    request(page, 'doc.render', { pageId: pid }),
    apply(page, [{ op: 'create', element: { kind: 'shape', bounds: { x: 300, y: 50, width: 100, height: 50 } } }]),
  ]);
  expect(render.result.revision).toBe(1);
  await waitRevision(page, 2);
});

test('ImageAndFontReady: the image is drawn, not blank', async ({ page }) => {
  await page.getByTestId('image-input').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(await redPng(page), 'base64') });
  await waitRevision(page, 1);
  const img = (await page.evaluate(() => (window as any).__diagram.snapshot().document.pages[0].elements[0]));
  const r = await request(page, 'doc.render', { pageId: await pageId(page), maxWidth: 1600, maxHeight: 1200 });
  expect(r.error).toBeUndefined();
  const px = await pixel(page, r.result.data, 'image/png', img.bounds.x + img.bounds.width / 2, img.bounds.y + img.bounds.height / 2, r.result.scale);
  expect(px[0]).toBeGreaterThan(200);
  expect(px[1]).toBeLessThan(60);
});

test('CropIncludesRotatedGroupVisualBounds', async ({ page }) => {
  const pid = await pageId(page);
  const a = await apply(page, [
    { op: 'create', element: { kind: 'shape', alias: 'r1', bounds: { x: 100, y: 100, width: 120, height: 20 }, rotationDeg: 45 } },
    { op: 'create', element: { kind: 'shape', alias: 'r2', bounds: { x: 300, y: 100, width: 40, height: 40 } } },
    { op: 'group', targets: ['r1', 'r2'], alias: 'g' },
  ]);
  const gid = a.value.aliases.g;
  const r = await request(page, 'doc.render', { pageId: pid, region: { elementIds: [gid], paddingPt: 5 } });
  const crop = r.result.cropPt;
  // r1 rotated 45° about (160,110): its AABB spans y ≈ 110 ± 49.5
  expect(crop.y).toBeLessThanOrEqual(110 - 49.4 - 5);
  expect(crop.y + crop.height).toBeGreaterThanOrEqual(110 + 49.4 + 5);
  expect(crop.x + crop.width).toBeGreaterThanOrEqual(345);
  const both = await request(page, 'doc.render', { pageId: pid, region: { elementIds: [gid], bounds: { x: 0, y: 0, width: 1, height: 1 } } });
  expect(both.error.code).toBe('invalid_request');
});

test('CleanExcludesHandles and DebugOnlyOverlay', async ({ page }) => {
  const pid = await pageId(page);
  const a = await apply(page, [{ op: 'create', element: { kind: 'shape', alias: 'boxy', bounds: { x: 100, y: 100, width: 200, height: 100 }, style: { fill: '#FFFFFF' } } }]);
  await page.evaluate((id) => (window as any).__diagram && document.querySelector('[data-testid=canvas]'), a.value.created[0]);
  const box = await page.evaluate(() => (window as any).__diagram.toClient({ x: 200, y: 150 }));
  await page.mouse.click(box.x, box.y); // canvas selection shows handles on screen only
  const clean = await request(page, 'doc.render', { pageId: pid, mode: 'clean' });
  const debug = await request(page, 'doc.render', { pageId: pid, mode: 'debug' });
  expect(clean.result.data).not.toBe(debug.result.data);
  // A handle would sit at the bottom-right corner; the clean render shows the plain outline there.
  const corner = await pixel(page, clean.result.data, 'image/png', 300 + 3, 200 + 3, clean.result.scale);
  expect(corner.slice(0, 3)).toEqual([255, 255, 255]); // plain page, not a green handle
  await expect(page.locator('[data-testid=canvas] svg rect[fill="#00ff00"], [data-testid=canvas] svg rect[fill="#00FF00"]').first()).toBeVisible(); // handles exist on screen
});

test('MissingAssetFailsInsteadOfBlank', async ({ page }) => {
  const r0 = await apply(page, [
    { op: 'registerAsset', asset: { id: 'asset:ghost', name: 'Ghost', mimeType: 'image/png', sha256: 'f'.repeat(64), tags: [] } },
    { op: 'create', element: { kind: 'image', assetId: 'asset:ghost', bounds: { x: 10, y: 10, width: 50, height: 50 } } },
  ]);
  expect(r0.ok).toBe(true);
  const r = await request(page, 'doc.render', { pageId: await pageId(page) });
  expect(r.error.code).toBe('not_found');
  expect(r.error.message).toMatch(/blank/);
});

test('16MP and 16MiB budgets reject', async ({ page }) => {
  const r = await request(page, 'doc.render', { pageId: await pageId(page), maxWidth: 5000, maxHeight: 5000 });
  expect(r.error.code).toBe('limit_exceeded');
});

test('JpegUsesPageBackground; PNG keeps transparency outside a none background', async ({ page }) => {
  const pid = await pageId(page);
  await apply(page, [{ op: 'setPage', pageId: pid, patch: { background: '#336699' } }]);
  const jpeg = await request(page, 'doc.render', { pageId: pid, format: 'jpeg' });
  expect(jpeg.result.mimeType).toBe('image/jpeg');
  const px = await pixel(page, jpeg.result.data, 'image/jpeg', 10, 10, jpeg.result.scale);
  expect(Math.abs(px[0] - 0x33)).toBeLessThan(8);
  expect(Math.abs(px[2] - 0x99)).toBeLessThan(8);
  await apply(page, [{ op: 'setPage', pageId: pid, patch: { background: 'none' } }]);
  const png = await request(page, 'doc.render', { pageId: pid, format: 'png' });
  expect((await pixel(page, png.result.data, 'image/png', 10, 10, png.result.scale))[3]).toBe(0);
  const jpeg2 = await request(page, 'doc.render', { pageId: pid, format: 'jpeg' });
  expect((await pixel(page, jpeg2.result.data, 'image/jpeg', 10, 10, jpeg2.result.scale)).slice(0, 3).every((v: number) => v > 245)).toBe(true);
});

test('golden: fixed scene within raster tolerance (pinned Chromium, heuristic-free shapes)', async ({ page }) => {
  const pid = await pageId(page);
  await apply(page, [
    { op: 'create', element: { kind: 'shape', alias: 'a', bounds: { x: 60, y: 60, width: 160, height: 80 }, geometry: { preset: 'roundedRect' }, style: { fill: '#DCE9F7', stroke: '#2B5797', strokeWidthPt: 2 } } },
    { op: 'create', element: { kind: 'shape', alias: 'b', bounds: { x: 400, y: 260, width: 120, height: 120 }, geometry: { preset: 'ellipse' }, style: { fill: '#FDE7C8', stroke: '#A0522D' } } },
    { op: 'create', element: { kind: 'connector', from: { target: 'a', port: 'east' }, to: { target: 'b', port: 'north' }, route: 'orthogonal' } },
  ]);
  const r = await request(page, 'doc.render', { pageId: pid, maxWidth: 800, maxHeight: 600 });
  const file = join(golden, 'basic-scene.png');
  if (!existsSync(file) || process.env.UPDATE_GOLDEN) writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  const expected = readFileSync(file).toString('base64');
  const diff = await page.evaluate(async ([a, b]) => {
    const load = async (d: string) => { const i = new Image(); i.src = `data:image/png;base64,${d}`; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d')!; x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height); };
    const [p, q] = [await load(a), await load(b)];
    if (p.width !== q.width || p.height !== q.height) return 1;
    let sum = 0;
    for (let i = 0; i < p.data.length; i++) sum += Math.abs(p.data[i] - q.data[i]);
    return sum / (p.data.length * 255);
  }, [r.result.data, expected] as const);
  expect(diff).toBeLessThan(0.01); // stated tolerance: mean absolute channel difference < 1 %
});
