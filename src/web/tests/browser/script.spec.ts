import { test, expect } from '@playwright/test';
import { boot, pageElements, revision, waitRevision } from './helpers';

test('script drawer validates, runs one transaction and shows the transaction log', async ({ page }) => {
  await boot(page);
  await page.getByTestId('drawer-toggle').click();
  const src = page.getByTestId('script-source');
  await src.fill('add shape id=a type=roundedRect x=20mm y=20mm w=40mm h=15mm text="A"\nadd shape id=b x=80mm y=20mm w=40mm h=15mm\nconnect id=ab from=a.east to=b.west');
  await page.getByTestId('script-validate').click();
  await expect(page.getByTestId('script-report')).toContainText('would create 3');
  expect(await revision(page)).toBe(0); // validate never commits

  await src.fill('add shape id=a x=20mm y=20mm w=40mm h=15mm\nset a nonsense=1');
  await page.getByTestId('script-validate').click();
  await expect(page.getByTestId('script-report')).toContainText('line 2');

  await src.fill('add shape id=a type=roundedRect x=20mm y=20mm w=40mm h=15mm text="A"\nadd shape id=b x=80mm y=20mm w=40mm h=15mm\nconnect id=ab from=a.east to=b.west');
  await page.getByTestId('script-run').click();
  await waitRevision(page, 1);
  await expect(page.getByTestId('script-report')).toContainText('Created 3');
  await expect(page.getByTestId('last-result')).toContainText('revision 0 → 1');
  await expect(page.getByTestId('tx-1')).toContainText('script');
  const els = await pageElements(page);
  expect(els.map((e: any) => e.alias)).toEqual(['a', 'b', 'ab']);

  // A later human edit: the earlier script transaction can no longer be undone selectively.
  await page.locator('[data-testid=canvas]').click({ position: { x: 5, y: 5 } });
  await page.getByTestId('stencil-rectangle').click();
  await waitRevision(page, 2);
  await expect(page.getByTestId('tx-undo-1')).toBeDisabled();
  await expect(page.getByTestId('tx-undo-2')).toBeEnabled();
  await page.getByTestId('tx-undo-2').click();
  await waitRevision(page, 3);
  await expect(page.getByTestId('tx-undo-1')).toBeEnabled();
});
