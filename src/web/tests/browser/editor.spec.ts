import { test, expect } from '@playwright/test';
import { bmp, boot, centreOf, commit, drag, pageElements, revision, selection, snap, toClient, waitRevision } from './helpers';

test('manual_edit_without_llm', async ({ page }) => {
  await boot(page);
  const s0 = await snap(page);
  // Finite A4 landscape page.
  expect(s0.document.pages[0].widthPt).toBeCloseTo(841.89, 1);
  expect(s0.document.pages[0].heightPt).toBeCloseTo(595.28, 1);
  await expect(page.locator('[data-role=page] rect[data-page-id]')).toHaveCount(1);

  // Rectangle via tool drag.
  await page.getByTestId('tool-rect').click();
  const a = await toClient(page, { x: 72, y: 72 }), b = await toClient(page, { x: 216, y: 144 });
  await drag(page, a, b);
  await waitRevision(page, 1);
  let els = await pageElements(page);
  const rect = els[0];
  expect(rect.kind).toBe('shape');
  expect(rect.bounds.width).toBeGreaterThan(130);

  // Text box via tool click.
  await page.getByTestId('tool-text').click();
  await page.mouse.click((await toClient(page, { x: 72, y: 300 })).x, (await toClient(page, { x: 72, y: 300 })).y);
  await waitRevision(page, 2);

  // Ellipse from the stencil panel.
  await page.getByTestId('stencil-ellipse').click();
  await waitRevision(page, 3);
  els = await pageElements(page);
  const ellipse = els.find((e: any) => e.geometry?.preset === 'ellipse');
  // Move it away so the connector has room.
  await page.getByTestId('geo-x').fill('150'); await page.getByTestId('geo-x').press('Enter');
  await waitRevision(page, 4);

  // Connector from rectangle to ellipse with the connector tool.
  await page.getByTestId('tool-connector').click();
  els = await pageElements(page);
  const r1 = els.find((e: any) => e.id === rect.id), e1 = els.find((e: any) => e.id === ellipse.id);
  await drag(page, await centreOf(page, r1.bounds), await centreOf(page, e1.bounds));
  await waitRevision(page, 5);
  els = await pageElements(page);
  const conn = els.find((e: any) => e.kind === 'connector');
  expect(conn.from.elementId).toBe(rect.id);
  expect(conn.to.elementId).toBe(ellipse.id);
  await page.getByTestId('tool-select').click();

  // Move the rectangle by dragging: one revision; glue persists; snapped to grid.
  const before = await revision(page);
  const rc = await centreOf(page, r1.bounds);
  await drag(page, rc, { x: rc.x + 40, y: rc.y + 60 });
  await waitRevision(page, before + 1);
  els = await pageElements(page);
  const moved = els.find((e: any) => e.id === rect.id);
  const spacing = (await snap(page)).document.pages[0].grid.spacingPt;
  expect(Math.abs(moved.bounds.x / spacing - Math.round(moved.bounds.x / spacing))).toBeLessThan(1e-9);
  expect(els.find((e: any) => e.kind === 'connector').from.elementId).toBe(rect.id);

  // Resize via the selected rectangle's bottom-right handle.
  await page.evaluate((id) => (window as any).__diagram && null, rect.id);
  await page.mouse.click((await centreOf(page, moved.bounds)).x, (await centreOf(page, moved.bounds)).y);
  const br = await toClient(page, { x: moved.bounds.x + moved.bounds.width, y: moved.bounds.y + moved.bounds.height });
  const r2 = await revision(page);
  await drag(page, br, { x: br.x + 50, y: br.y + 30 });
  await waitRevision(page, r2 + 1);
  els = await pageElements(page);
  expect(els.find((e: any) => e.id === rect.id).bounds.width).toBeGreaterThan(moved.bounds.width);

  // Inspector: geometry (rotation), style and text; each commit is one revision.
  await commit(page, 'geo-rotation', '33');
  await waitRevision(page, r2 + 2);
  await commit(page, 'style-fill', '#FFCC00');
  await waitRevision(page, r2 + 3);
  await commit(page, 'text-value', 'Hello');
  await waitRevision(page, r2 + 4);
  await page.getByTestId('text-bold').check();
  await waitRevision(page, r2 + 5);
  els = await pageElements(page);
  const styled = els.find((e: any) => e.id === rect.id);
  expect(styled.rotationDeg).toBe(33);
  expect(styled.style.fill).toBe('#FFCC00');
  expect(styled.text).toMatchObject({ value: 'Hello', bold: true });
  await expect(page.locator('[data-testid=canvas] svg text', { hasText: 'Hello' })).toHaveCount(1);

  // Undo / Redo restore exact state at higher revisions.
  const beforeUndo = await revision(page);
  await page.getByTestId('undo').click();
  await waitRevision(page, beforeUndo + 1);
  expect((await pageElements(page)).find((e: any) => e.id === rect.id).text.bold).toBe(false);
  await page.getByTestId('redo').click();
  await waitRevision(page, beforeUndo + 2);
  expect((await pageElements(page)).find((e: any) => e.id === rect.id).text.bold).toBe(true);

  // Images: PNG, JPEG, BMP and sanitised SVG are independent image objects with hashed assets.
  const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 8; c.height = 4; c.getContext('2d')!.fillRect(0, 0, 4, 4); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  const jpeg = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 6; c.height = 6; c.getContext('2d')!.fillRect(0, 0, 3, 3); return c.toDataURL('image/jpeg').split(',')[1]; }), 'base64');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#2CA02C"/></svg>');
  for (const [name, mimeType, buffer] of [['a.png', 'image/png', png], ['b.jpg', 'image/jpeg', jpeg], ['c.bmp', 'image/bmp', bmp()], ['d.svg', 'image/svg+xml', svg]] as const) {
    const r = await revision(page);
    await page.getByTestId('image-input').setInputFiles({ name, mimeType, buffer });
    await waitRevision(page, r + 1);
  }
  const s1 = await snap(page);
  const images = s1.document.pages[0].elements.filter((e: any) => e.kind === 'image');
  expect(images).toHaveLength(4);
  expect(new Set(images.map((i: any) => i.assetId)).size).toBe(4);
  expect(s1.document.assets.map((a: any) => a.mimeType).sort()).toEqual(['image/bmp', 'image/jpeg', 'image/png', 'image/svg+xml']);
  for (const a of s1.document.assets) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  // A hostile SVG is rejected and changes nothing.
  const rHostile = await revision(page);
  await page.getByTestId('image-input').setInputFiles({ name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
  await expect(page.getByTestId('status')).toContainText('rejected');
  expect(await revision(page)).toBe(rHostile);

  // Multi-selection (Ctrl+A), copy/paste remaps UUIDs and internal connector glue.
  await page.locator('[data-testid=canvas]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+A');
  const all = await selection(page);
  expect(all.length).toBeGreaterThanOrEqual(8);
  await page.mouse.click((await centreOf(page, (await pageElements(page)).find((e: any) => e.id === rect.id).bounds)).x, (await centreOf(page, (await pageElements(page)).find((e: any) => e.id === rect.id).bounds)).y);
  await page.keyboard.down('Shift');
  await page.mouse.click((await centreOf(page, e1.bounds)).x, (await centreOf(page, e1.bounds)).y);
  await page.keyboard.up('Shift');
  // Select rectangle, ellipse and connector programmatically through the UI path is fragile; use Ctrl+A subset copy:
  const rCopy = await revision(page);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+C');
  await page.keyboard.press('Control+V');
  await waitRevision(page, rCopy + 1);
  const s2 = await snap(page);
  const ids1 = new Set(s1.document.pages[0].elements.map((e: any) => e.id));
  const copies = s2.document.pages[0].elements.filter((e: any) => !ids1.has(e.id));
  expect(copies.length).toBe(s1.document.pages[0].elements.length);
  const copiedConn = copies.find((e: any) => e.kind === 'connector');
  expect(ids1.has(copiedConn.from.elementId)).toBe(false); // glue remapped to the copy
  expect(copies.some((e: any) => e.id === copiedConn.from.elementId)).toBe(true);

  // Delete removes the selection as one transaction; undo brings it back.
  const rDel = await revision(page);
  await page.keyboard.press('Delete');
  await waitRevision(page, rDel + 1);
  expect((await pageElements(page)).length).toBe(s1.document.pages[0].elements.length);
  await page.getByTestId('undo').click();
  await waitRevision(page, rDel + 2);
  expect((await pageElements(page)).length).toBe(s2.document.pages[0].elements.length);

  // Zoom and fit change only the view, never the document.
  const rView = await revision(page);
  await page.getByTestId('zoom-in').click();
  await page.getByTestId('zoom-out').click();
  await page.getByTestId('fit-page').click();
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 120);
  expect(await revision(page)).toBe(rView);
});

test('grid, snap, rulers and alignment guides', async ({ page }) => {
  await boot(page);
  await expect(page.locator('[data-role=grid]')).toHaveCount(1);
  await page.getByTestId('grid-visible').uncheck();
  await expect(page.locator('[data-role=grid]')).toHaveCount(0);
  await page.getByTestId('grid-visible').check();
  await expect(page.locator('[data-role=grid]')).toHaveCount(1);
  // Rulers are unit-labelled and follow the unit selector.
  await expect(page.getByTestId('ruler-horizontal')).toHaveAttribute('data-unit', 'mm');
  await page.getByTestId('units').selectOption('in');
  await expect(page.getByTestId('ruler-horizontal')).toHaveAttribute('data-unit', 'in');
  await page.getByTestId('units').selectOption('mm');

  // Grid visibility is canonical page state: each toggle was a transaction.
  const r0 = await revision(page);
  expect(r0).toBe(2);
  // Two shapes; dragging one level with the other shows an alignment guide.
  await page.getByTestId('stencil-rectangle').click();
  await page.getByTestId('stencil-process').click();
  await waitRevision(page, r0 + 2);
  let els = await pageElements(page);
  await commit(page, 'geo-x', '120');
  await waitRevision(page, r0 + 3);
  await commit(page, 'geo-y', '80');
  await waitRevision(page, r0 + 4);
  els = await pageElements(page);
  const [first, second] = els;
  const from = await centreOf(page, second.bounds);
  const target = await centreOf(page, { ...first.bounds, x: second.bounds.x });
  let guides = 0;
  await drag(page, from, { x: from.x, y: target.y + 1 }, {
    steps: 12,
    midway: async () => { guides = await page.locator('[data-testid=canvas] svg path[stroke="#ff0000"]:not([visibility=hidden])').count(); },
  });
  await waitRevision(page, r0 + 5);
  expect(guides).toBeGreaterThan(0);
  // Snap: committed coordinates are multiples of the grid spacing.
  els = await pageElements(page);
  const spacing = (await snap(page)).document.pages[0].grid.spacingPt;
  const moved = els.find((e: any) => e.id === second.id);
  expect(Math.abs(moved.bounds.y / spacing - Math.round(moved.bounds.y / spacing))).toBeLessThan(1e-9);
});
