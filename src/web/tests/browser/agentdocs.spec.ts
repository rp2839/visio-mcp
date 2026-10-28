import { test, expect, type Page } from '@playwright/test';
import { openEditor, placeShape, snapshot } from './support';

const tabs = (page: Page) => page.evaluate(() => (window as any).__editor.tabs() as Array<{ label: string; unsaved: boolean; documentId: string; active: boolean }>);
const app = (page: Page, method: string, params: object) => page.evaluate(([m, p]) => (window as any).__editor.callApp(m, p), [method, params] as const) as Promise<{ result?: any; error?: { code: string; message: string } }>;

/** A document as the agent view would hand over: the current one, under another id and title, at its revision. */
async function agentDocument(page: Page, id: string) {
  const doc = (await snapshot(page)).document;
  return { ...JSON.parse(JSON.stringify(doc)), id, title: 'Pipeline' };
}

test('adopting a background document opens it as an unsaved tab with its content, and shows it when asked', async ({ page }) => {
  const errors = await openEditor(page);
  await placeShape(page, 'shape-rectangle', { x: 200, y: 150 }, 'mine');
  const id = '00000000-0000-4000-8000-0000000000d9';
  const sourceAlias = 'mine';
  const r = await app(page, 'app.adoptDocument', { document: await agentDocument(page, id), activate: true });
  expect(r.error).toBeUndefined();
  expect(r.result.documentId).toBe(id);
  expect(r.result.sessionId).toBeTruthy();
  const t = await tabs(page);
  expect(t).toHaveLength(2);
  expect(t.map(x => x.active)).toEqual([false, true]);
  expect(t[1]!.unsaved).toBe(true); // it was never saved anywhere
  expect((await snapshot(page)).document.pages[0]!.elements.map(e => e.alias)).toEqual([sourceAlias]);
  await page.getByTestId('tab').nth(0).click();
  expect((await snapshot(page)).document.pages[0]!.elements.map(e => e.alias)).toEqual(['mine']); // the person's own tab is untouched
  expect(errors).toEqual([]);
});

test('a background document can come in without taking over the view', async ({ page }) => {
  await openEditor(page);
  await app(page, 'app.adoptDocument', { document: await agentDocument(page, '00000000-0000-4000-8000-0000000000d8'), activate: false });
  expect((await tabs(page)).map(x => x.active)).toEqual([true, false]);
});

test('it is refused while the person is mid-gesture, and an invalid document is refused outright', async ({ page }) => {
  await openEditor(page);
  const a = await placeShape(page, 'shape-rectangle', { x: 200, y: 150 }, 'mine');
  const centre = await page.evaluate(id => (window as any).__editor.centre(id), a.id);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 30, centre.y + 20, { steps: 3 });
  expect(await page.evaluate(() => (window as any).__editor.gestureActive())).toBe(true);
  const busy = await app(page, 'app.adoptDocument', { document: await agentDocument(page, '00000000-0000-4000-8000-0000000000d7'), activate: true });
  expect(busy.error?.code).toBe('busy_user_editing');
  const alreadyShowing = await app(page, 'app.activateDocument', { documentId: (await tabs(page))[0]!.documentId });
  expect(alreadyShowing.error).toBeUndefined(); // the tab is already in front, so there is nothing to switch and nothing to refuse
  await page.mouse.up();
  expect(await tabs(page)).toHaveLength(1); // nothing was opened
  const bad = await app(page, 'app.adoptDocument', { document: { nonsense: true }, activate: true });
  expect(bad.error?.code).toBe('invalid_request');
});

test('showing a tab that is already open switches to it, and an unknown id is refused', async ({ page }) => {
  await openEditor(page);
  await page.getByTestId('tab-new').click();
  const first = (await tabs(page))[0]!;
  const r = await app(page, 'app.activateDocument', { documentId: first.documentId });
  expect(r.result.activated).toBe(first.documentId);
  expect((await tabs(page)).map(x => x.active)).toEqual([true, false]);
  const missing = await app(page, 'app.activateDocument', { documentId: '00000000-0000-4000-8000-00000000ffff' });
  expect(missing.error?.code).toBe('document_mismatch');
});

test('background documents appear as tabs of their own; clicking one asks the host to bring it here, closing asks twice when it has work', async ({ page }) => {
  await openEditor(page);
  const id = '00000000-0000-4000-8000-0000000000d6';
  const list = [{ documentId: id, sessionId: 's', title: 'Network plan', revision: 2, unsaved: true, pages: 1 }];
  await page.evaluate(([documentId, docs]) => {
    const calls: string[] = [];
    (window as any).__calls = calls;
    (window as any).__editor.setHost({
      documentShow: async (d: string) => { calls.push('show:' + d); return { ok: true, value: { documentId: d, shown: true } }; },
      documentDiscard: async (d: string) => { calls.push('discard:' + d); return { ok: true, value: { discarded: d } }; },
      agentDocuments: async () => ({ ok: true, value: { documents: (window as any).__stillThere ? docs : [] } }),
    });
    (window as any).__stillThere = true;
    void documentId;
  }, [id, list] as const);
  expect((await app(page, 'app.agentDocuments', { documents: list })).result.received).toBe(true);
  await expect(page.getByTestId('agent-tab')).toHaveCount(1);
  await expect(page.getByTestId('agent-tab-name')).toHaveText('Network plan');
  expect(await tabs(page)).toHaveLength(1); // it is not one of the window's own tabs
  await page.getByTestId('agent-tab').click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls)).toEqual([`show:${id}`]);
  await page.getByTestId('agent-tab-close').click();
  await expect(page.getByTestId('agent-tab-close')).toHaveText('Discard?'); // it has work: the first press only asks
  expect(await page.evaluate(() => (window as any).__calls)).toEqual([`show:${id}`]);
  await page.getByTestId('agent-tab-close').click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls)).toEqual([`show:${id}`, `discard:${id}`]);
  await page.evaluate(() => { (window as any).__stillThere = false; });
  await app(page, 'app.agentDocuments', { documents: [] });
  await expect(page.getByTestId('agent-tab')).toHaveCount(0);
});
