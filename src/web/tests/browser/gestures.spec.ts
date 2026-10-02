import { test, expect } from '@playwright/test';
import { boot, centreOf, pageElements, revision, waitRevision } from './helpers';

const agent = (page: any, operations: unknown[], baseRevision?: number) => page.evaluate(async ([ops, base]: any) => {
  const d = (window as any).__diagram; const s = d.scope();
  return d.agentApply({ documentId: s.documentId, sessionId: s.sessionId, transactionId: crypto.randomUUID(), baseRevision: base ?? s.revision, atomic: true, operations: ops });
}, [operations, baseRevision]);

test('long_text_edit_and_drag_stale_backstop', async ({ page }) => {
  await boot(page);
  await page.getByTestId('stencil-rectangle').click();
  await waitRevision(page, 1);
  const shape = (await pageElements(page))[0];
  const c = await centreOf(page, shape.bounds);

  // Drag in progress; an already-admitted agent edit lands; the stale gesture is discarded.
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + i * 10, c.y);
  expect(await page.evaluate(() => (window as any).__diagram.gestureActive())).toBe(true);
  const r = await agent(page, [{ op: 'set', target: shape.id, patch: { style: { fill: '#00AA00' } } }]);
  expect(r.ok).toBe(true);
  await page.mouse.up();
  await expect(page.getByTestId('status')).toContainText('discarded');
  let el = (await pageElements(page))[0];
  expect(el.style.fill).toBe('#00AA00');      // agent change kept
  expect(el.bounds.x).toBe(shape.bounds.x);   // stale human preview not applied
  expect(await revision(page)).toBe(2);

  // A completed human edit makes an older agent mutation stale (no automatic rebase).
  const agentBase = await revision(page);
  await page.mouse.click(c.x, c.y);
  await expect.poll(() => page.evaluate(() => (window as any).__diagram.selection())).toEqual([shape.id]);
  await page.getByTestId('style-fill').fill('#FF0000');
  await page.getByTestId('style-fill').press('Enter');
  await waitRevision(page, 3);
  const stale = await agent(page, [{ op: 'set', target: shape.id, patch: { style: { fill: '#0000FF' } } }], agentBase);
  expect(stale.ok).toBe(false);
  expect(stale.error.code).toBe('revision_conflict');
  expect((await pageElements(page))[0].style.fill).toBe('#FF0000');

  // Long in-place text edit: cancel restores, commit is one revision.
  el = (await pageElements(page))[0];
  const ec = await centreOf(page, el.bounds);
  await page.mouse.dblclick(ec.x, ec.y);
  expect(await page.evaluate(() => (window as any).__diagram.gestureActive())).toBe(true);
  await page.keyboard.type('Draft that will be cancelled');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).__diagram.gestureActive())).toBe(false);
  expect(await revision(page)).toBe(3);
  await page.mouse.dblclick(ec.x, ec.y);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Committed text');
  const away = await page.evaluate(() => (window as any).__diagram.toClient({ x: 700, y: 500 }));
  await page.mouse.click(away.x, away.y); // click elsewhere on the page ends the edit session
  await waitRevision(page, 4);
  expect((await pageElements(page))[0].text.value).toBe('Committed text');

  // Lifecycle replacement cancels an active preview without committing it.
  await page.mouse.dblclick(ec.x, ec.y);
  await page.keyboard.type(' more');
  const replaced = await page.evaluate(() => (window as any).__diagram.lifecycleReplace());
  expect(replaced.ok).toBe(true);
  expect(await page.evaluate(() => (window as any).__diagram.gestureActive())).toBe(false);
  expect((await pageElements(page))[0].text.value).toBe('Committed text');
});
