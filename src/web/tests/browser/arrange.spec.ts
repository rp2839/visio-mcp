import { test, expect, type Page } from '@playwright/test';
import { boot, centreOf, pageElements, revision, selection, snap, waitRevision } from './helpers';

const hashes = async (page: Page) => Object.fromEntries((await pageElements(page)).map((e: any) => [e.id, JSON.stringify(e)]));

async function selectAll(page: Page, ids: string[]) {
  const els = await pageElements(page);
  for (const [i, id] of ids.entries()) {
    const c = await centreOf(page, els.find((e: any) => e.id === id).bounds);
    if (i > 0) await page.keyboard.down('Shift');
    await page.mouse.click(c.x, c.y);
    if (i > 0) await page.keyboard.up('Shift');
  }
  await expect.poll(async () => (await selection(page)).sort()).toEqual([...ids].sort());
}

test('arrange and group through the GUI', async ({ page }) => {
  await boot(page);
  page.on('dialog', (d) => void d.accept('5'));
  // Four shapes at staggered positions (inspector commits; snapping is off for exact geometry).
  await page.getByTestId('grid-snap').uncheck();
  const r0 = await revision(page);
  for (const [i, [x, y]] of [[20, 20], [70, 35], [140, 28], [60, 90]].entries()) {
    await page.getByTestId('stencil-rectangle').click();
    await waitRevision(page, r0 + 1 + i * 3);
    await page.getByTestId('geo-x').fill(String(x)); await page.getByTestId('geo-x').press('Enter');
    await waitRevision(page, r0 + 2 + i * 3);
    await page.getByTestId('geo-y').fill(String(y)); await page.getByTestId('geo-y').press('Enter');
    await waitRevision(page, r0 + 3 + i * 3);
  }
  const [a, b, c, bystander] = (await pageElements(page)).map((e: any) => e.id);

  // Align top: only selected geometry changes; the bystander's exact serialisation is untouched.
  await selectAll(page, [a, b, c]);
  let before = await hashes(page);
  let r = await revision(page);
  await page.getByTestId('align-top').click();
  await waitRevision(page, r + 1);
  let els = await pageElements(page);
  const tops = [a, b, c].map((id) => els.find((e: any) => e.id === id).bounds.y);
  expect(new Set(tops).size).toBe(1);
  expect((await hashes(page))[bystander]).toBe(before[bystander]);

  // Distribute horizontally keeps the ends.
  r = await revision(page);
  const xsBefore = [a, b, c].map((id) => els.find((e: any) => e.id === id).bounds.x);
  await page.getByTestId('distribute-horizontal').click();
  await waitRevision(page, r + 1);
  els = await pageElements(page);
  const xs = [a, b, c].map((id) => els.find((e: any) => e.id === id).bounds);
  expect(xs[0].x).toBe(xsBefore[0]);
  expect(xs[2].x).toBe(xsBefore[2]);
  expect(xs[1].x - (xs[0].x + xs[0].width)).toBeCloseTo(xs[2].x - (xs[1].x + xs[1].width), 6);

  // Gap (prompt answered with 5 mm) keeps the first.
  r = await revision(page);
  await page.getByTestId('gap-horizontal').click();
  await waitRevision(page, r + 1);
  els = await pageElements(page);
  const g = [a, b, c].map((id) => els.find((e: any) => e.id === id).bounds);
  expect(g[0].x).toBe(xs[0].x);
  expect(g[1].x - (g[0].x + g[0].width)).toBeCloseTo(5 * 72 / 25.4, 6);

  // Z-order: send the first to front, then back.
  await selectAll(page, [a]);
  r = await revision(page);
  await page.getByTestId('z-front').click();
  await waitRevision(page, r + 1);
  expect((await pageElements(page)).at(-1).id).toBe(a);
  await page.getByTestId('z-back').click();
  await waitRevision(page, r + 2);
  expect((await pageElements(page))[0].id).toBe(a);

  // Group then ungroup; one Undo restores the grouped state exactly.
  await selectAll(page, [b, c]);
  before = await hashes(page);
  r = await revision(page);
  await page.getByTestId('group').click();
  await waitRevision(page, r + 1);
  const s = await snap(page);
  const group = s.document.pages[0].elements.find((e: any) => e.kind === 'group');
  expect(group.childIds.sort()).toEqual([b, c].sort());
  expect(group.rotationDeg).toBe(0);
  const grouped = await hashes(page);
  await page.evaluate(() => 0);
  const gc = await centreOf(page, group.bounds);
  await page.mouse.click(gc.x, gc.y);
  await expect.poll(() => selection(page)).toEqual([group.id]);
  await page.getByTestId('ungroup').click();
  await waitRevision(page, r + 2);
  expect((await pageElements(page)).some((e: any) => e.kind === 'group')).toBe(false);
  expect(await hashes(page)).toEqual(before);
  await page.getByTestId('undo').click();
  await waitRevision(page, r + 3);
  expect(await hashes(page)).toEqual(grouped);
});
