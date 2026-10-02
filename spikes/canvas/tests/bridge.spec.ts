import { test, expect, type Page } from '@playwright/test';

// Emulates window.chrome.webview so the real bridge.ts runs; the host side is the test.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__posted = [];
    w.__listeners = [];
    w.chrome = { webview: {
      postMessage: (m: unknown) => w.__posted.push(JSON.parse(JSON.stringify(m))),
      addEventListener: (_t: string, fn: (e: { data: unknown }) => void) => w.__listeners.push(fn),
    } };
    w.__deliver = (m: unknown) => w.__listeners.forEach((fn: any) => fn({ data: m }));
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).probe);
});

const posted = (page: Page) => page.evaluate(() => (window as any).__posted as any[]);
async function call(page: Page, msg: Record<string, unknown>) {
  const before = (await posted(page)).length;
  await page.evaluate((m) => (window as any).__deliver(m), msg);
  await expect.poll(async () => (await posted(page)).length).toBe(before + 1);
  return (await posted(page))[before];
}
const ready = async (page: Page) => (await posted(page)).find((m) => m.method === 'editor.ready');
const apply = (scope: any, requestId: string, transactionId: string, baseRevision: number, dx = 40) => ({
  protocolVersion: 1, kind: 'request', requestId, method: 'doc.apply', documentId: scope.documentId, sessionId: scope.sessionId,
  params: { transactionId, baseRevision, atomic: true, operations: [{ op: 'move', target: 'rect', dx, dy: 0 }] },
});

test('ReadyBeforeApply', async ({ page }) => {
  const first = (await posted(page))[0];
  expect(first.method).toBe('editor.ready');
  expect(first.revision).toBe(0);
});

test('apply_changes_visible_canvas_and_matches_revision', async ({ page }) => {
  const scope = await ready(page);
  const x0 = (await page.evaluate(() => (window as any).probe.cellBounds('rect'))).x;
  const r = await call(page, apply(scope, 'h1', 'aaaaaaaa-0000-4000-8000-000000000001', 0));
  expect(r.result.revision).toBe(1);
  expect(r.result.changed).toEqual(['rect']);
  expect((await page.evaluate(() => (window as any).probe.readProbeState())).revision).toBe(1);
  expect((await page.evaluate(() => (window as any).probe.cellBounds('rect'))).x).toBe(x0 + 40);
});

test('MismatchedSessionRejected', async ({ page }) => {
  const scope = await ready(page);
  const stale = await call(page, apply({ ...scope, sessionId: '00000000-0000-4000-8000-000000000000' }, 'h1', 'aaaaaaaa-0000-4000-8000-000000000002', 0));
  expect(stale.error.code).toBe('session_mismatch');
  expect((await page.evaluate(() => (window as any).probe.readProbeState())).revision).toBe(0);
});

test('DuplicateTransactionChangesOnce', async ({ page }) => {
  const scope = await ready(page);
  const tx = 'aaaaaaaa-0000-4000-8000-000000000003';
  const response = await call(page, apply(scope, 'h1', tx, 0));
  const duplicate = await call(page, apply(scope, 'h2', tx, 0)); // stale baseRevision, but cache wins
  expect(response.result.revision).toBe(1);
  expect(duplicate.result.revision).toBe(1);
  expect(duplicate.requestId).toBe('h2');
  const conflict = await call(page, apply(scope, 'h3', tx, 0, 99));
  expect(conflict.error.code).toBe('transaction_id_conflict');
  const stale = await call(page, apply(scope, 'h4', 'aaaaaaaa-0000-4000-8000-000000000004', 0));
  expect(stale.error.code).toBe('revision_conflict');
  expect((await page.evaluate(() => (window as any).probe.readProbeState())).revision).toBe(1);
});
