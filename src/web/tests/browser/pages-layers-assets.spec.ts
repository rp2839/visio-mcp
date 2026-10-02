import { expect, test, type Page } from '@playwright/test';
import { bmp, boot, centreOf, commit, drag, pageElements, revision, selection, snap, toClient, waitRevision } from './helpers';

/** Answers prompt/confirm dialogs in order. */
function answer(page: Page, ...answers: (string | boolean)[]) {
  const queue = [...answers];
  const handler = async (d: import('@playwright/test').Dialog) => {
    const a = queue.shift();
    if (a === false) await d.dismiss();
    else await d.accept(typeof a === 'string' ? a : undefined);
    if (queue.length === 0) page.off('dialog', handler);
  };
  page.on('dialog', handler);
}

async function seedShape(page: Page, x = 300, y = 200) {
  const s = await snap(page);
  const r = await page.evaluate(({ s, x, y }) => (window as any).__diagram.agentApply({
    documentId: s.documentId, sessionId: s.sessionId, baseRevision: s.revision, transactionId: crypto.randomUUID(),
    operations: [{ op: 'create', element: { kind: 'shape', alias: `box${x}`, bounds: { x, y, width: 100, height: 60 } } }],
  }), { s, x, y });
  expect(r.ok).toBe(true);
  return r.value.created[0] as string;
}

const el = async (page: Page, id: string) => (await snap(page)).document.pages.flatMap((p: any) => p.elements).find((e: any) => e.id === id);

test('pages: add, rename, reorder, duplicate, delete, presets and custom size', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  await page.getByTestId('page-add').click();
  await expect.poll(async () => (await snap(page)).document.pages.length).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).__diagram.pageId())).toBe((await snap(page)).document.pages[1].id); // new page is active
  answer(page, 'Second');
  await page.getByTestId('page-tab-1').dblclick();
  await expect.poll(async () => (await snap(page)).document.pages[1].name).toBe('Second');
  await page.getByTestId('page-tab-1').click();
  await page.getByTestId('page-left').click();
  await expect.poll(async () => (await snap(page)).document.pages[0].name).toBe('Second');
  await page.getByTestId('page-duplicate').click();
  await expect.poll(async () => (await snap(page)).document.pages.length).toBe(3);
  answer(page, true);
  await page.getByTestId('page-delete').click();
  await expect.poll(async () => (await snap(page)).document.pages.length).toBe(2);
  const current = await page.evaluate(() => (window as any).__diagram.pageId());
  await page.getByTestId('page-size').selectOption('A4 portrait');
  await expect.poll(async () => (await snap(page)).document.pages.find((p: any) => p.id === current).widthPt).toBeCloseTo(595.28, 1);
  answer(page, '100', '50');
  await page.getByTestId('page-size').selectOption('custom');
  await expect.poll(async () => (await snap(page)).document.pages.find((p: any) => p.id === current).heightPt).toBeCloseTo(50 * 72 / 25.4, 3);
  // Dismissed delete changes nothing.
  const r = await revision(page);
  answer(page, false);
  await page.getByTestId('page-delete').click();
  await page.waitForTimeout(100);
  expect(await revision(page)).toBe(r);
  expect(errors).toEqual([]);
});

test('layers: assignment, hidden objects are unselectable, locked-layer objects cannot be edited', async ({ page }) => {
  await boot(page);
  const id = await seedShape(page);
  await page.getByTestId('layer-add').click();
  await expect(page.getByTestId('layer-Layer 1')).toBeVisible();
  answer(page, 'Ops');
  await page.getByTestId('layer-Layer 1').getByRole('button', { name: 'Layer 1' }).click();
  await expect(page.getByTestId('layer-Ops')).toBeVisible();
  const b = (await el(page, id)).bounds;
  const c = await centreOf(page, b);
  await page.mouse.click(c.x, c.y);
  expect(await selection(page)).toEqual([id]);
  await page.getByTestId('layer-assign-Ops').click();
  await expect.poll(async () => (await el(page, id)).layerIds.length).toBe(1);

  // Hidden layer: the element cannot be selected by click or select-all.
  await page.getByTestId('layer-visible-Ops').uncheck();
  await expect.poll(async () => (await snap(page)).document.pages[0].layers[0].visible).toBe(false);
  await page.mouse.click(c.x, c.y);
  expect(await selection(page)).toEqual([]);
  await page.keyboard.press('Control+a');
  expect(await selection(page)).not.toContain(id);
  await page.getByTestId('layer-visible-Ops').check();

  // Print flag toggles.
  await page.locator('[data-testid="layer-Ops"] input[type=checkbox]').nth(2).uncheck();
  await expect.poll(async () => (await snap(page)).document.pages[0].layers[0].printable).toBe(false);

  // Locked layer: drag, resize and inspector edits leave the object unchanged.
  await page.getByTestId('layer-locked-Ops').check();
  await expect.poll(async () => (await snap(page)).document.pages[0].layers[0].locked).toBe(true);
  const r = await revision(page);
  await drag(page, c, { x: c.x + 60, y: c.y + 40 });
  await page.mouse.click(c.x, c.y);
  const br = await toClient(page, { x: b.x + b.width, y: b.y + b.height });
  await drag(page, br, { x: br.x + 40, y: br.y + 40 });
  if (await page.getByTestId('geo-x').isEnabled()) await commit(page, 'geo-x', '10');
  await page.waitForTimeout(150);
  expect(await revision(page)).toBe(r);
  expect((await el(page, id)).bounds).toEqual(b);
  const agent = await page.evaluate(({ id }) => {
    const d = (window as any).__diagram; const s = d.scope();
    return d.agentApply({ documentId: s.documentId, sessionId: s.sessionId, baseRevision: s.revision, transactionId: crypto.randomUUID(), operations: [{ op: 'move', target: id, delta: { xPt: 5, yPt: 0 } }] });
  }, { id });
  expect(agent.error.code).toBe('locked_target');

  // Deleting the layer unassigns members, never deletes them.
  answer(page, true);
  await page.getByTestId('layer-delete-Ops').click();
  await expect.poll(async () => (await snap(page)).document.pages[0].layers.length).toBe(0);
  expect((await el(page, id)).layerIds).toEqual([]);
});

test('assets: import, thumbnail, rename/tags, single vs global replacement, in-use delete, copy ID', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  const other = bmp(); for (let i = 54; i < other.length; i++) other[i] = 255 - other[i];
  await page.getByTestId('image-input').setInputFiles({ name: 'logo.bmp', mimeType: 'image/bmp', buffer: bmp() });
  await waitRevision(page, 1);
  await page.getByTestId('image-input').setInputFiles({ name: 'photo.bmp', mimeType: 'image/bmp', buffer: other });
  await waitRevision(page, 2);
  const s = await snap(page);
  const [logo, photo] = s.document.assets;
  expect(logo.id).toMatch(/^asset:logo~[0-9a-f]{64}$/);
  await page.getByTestId('tab-assets').click();
  await expect(page.getByTestId(`asset-${logo.id}`).locator('img')).toBeVisible(); // thumbnail
  // Place a second copy of the logo.
  await page.getByTestId(`asset-${logo.id}`).getByRole('button', { name: 'Place', exact: true }).click();
  await waitRevision(page, 3);
  // Spread the three images out so each can be clicked.
  await page.evaluate(() => {
    const d = (window as any).__diagram; const sc = d.scope();
    const imgs = d.snapshot().document.pages[0].elements.filter((e: any) => e.kind === 'image');
    return d.agentApply({ documentId: sc.documentId, sessionId: sc.sessionId, baseRevision: sc.revision, transactionId: crypto.randomUUID(),
      operations: imgs.map((e: any, i: number) => ({ op: 'set', target: e.id, patch: { bounds: { x: 100 + i * 150, y: 150, width: 80, height: 80 } } })) });
  });
  await waitRevision(page, 4);
  answer(page, 'Company logo');
  await page.getByTestId(`asset-${logo.id}`).getByRole('button', { name: 'Rename', exact: true }).click();
  await expect.poll(async () => (await snap(page)).document.assets[0].name).toBe('Company logo');
  answer(page, 'brand, logo');
  await page.getByTestId(`asset-${logo.id}`).getByRole('button', { name: 'Tags', exact: true }).click();
  await expect.poll(async () => (await snap(page)).document.assets[0].tags).toEqual(['brand', 'logo']);
  await page.getByTestId(`asset-${logo.id}`).getByRole('button', { name: 'Copy ID', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(logo.id);

  // Single-image replacement changes only the selected image.
  const logoImage = (await pageElements(page)).find((e: any) => e.kind === 'image' && e.assetId === logo.id);
  const lc = await centreOf(page, logoImage.bounds);
  await page.mouse.click(lc.x, lc.y);
  expect(await selection(page)).toEqual([logoImage.id]);
  const before = await revision(page);
  await page.getByTestId(`asset-use-${photo.id}`).click();
  await waitRevision(page, before + 1);
  let imgs = (await pageElements(page)).filter((e: any) => e.kind === 'image');
  expect(imgs.filter((e: any) => e.assetId === logo.id)).toHaveLength(1); // the placed copy is untouched
  expect(imgs.find((e: any) => e.id === logoImage.id).assetId).toBe(photo.id);

  // Global replacement is explicit and changes every image of that asset.
  const copy = imgs.find((e: any) => e.assetId === logo.id);
  const cc = await centreOf(page, copy.bounds);
  await page.mouse.click(cc.x, cc.y);
  answer(page, true);
  await page.getByTestId(`asset-${photo.id}`).getByRole('button', { name: 'Replace globally', exact: true }).click();
  await waitRevision(page, before + 2);
  imgs = (await pageElements(page)).filter((e: any) => e.kind === 'image');
  expect(imgs.every((e: any) => e.assetId === photo.id)).toBe(true);

  // In-use delete rejects; unused delete succeeds.
  const r = await revision(page);
  await page.getByTestId(`asset-${photo.id}`).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('status')).toContainText('used by');
  expect(await revision(page)).toBe(r);
  await page.getByTestId(`asset-${logo.id}`).getByRole('button', { name: 'Delete', exact: true }).click();
  await waitRevision(page, r + 1);
  expect((await snap(page)).document.assets.map((a: any) => a.id)).toEqual([photo.id]);
});
