import { expect, test } from '@playwright/test';
import { boot, waitRevision } from './helpers';

const apply = (page: import('@playwright/test').Page, operations: unknown[]) => page.evaluate(async (ops) => {
  const d = (window as any).__diagram; const s = d.scope();
  const r = await d.agentApply({ documentId: s.documentId, sessionId: s.sessionId, pageId: d.pageId(), baseRevision: s.revision, transactionId: crypto.randomUUID(), operations: ops });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}, operations);

test('incremental canvas projection equals a full re-projection; connectors follow moved shapes', async ({ page }) => {
  await boot(page);
  const r = await apply(page, [
    { op: 'create', element: { kind: 'shape', alias: 'a', bounds: { x: 50, y: 50, width: 100, height: 60 }, text: { value: 'A' } } },
    { op: 'create', element: { kind: 'shape', alias: 'b', bounds: { x: 400, y: 50, width: 100, height: 60 } } },
    { op: 'create', element: { kind: 'shape', alias: 'c', bounds: { x: 400, y: 300, width: 100, height: 60 } } },
    { op: 'create', element: { kind: 'connector', alias: 'ab', from: { target: 'a' }, to: { target: 'b' } } },
    { op: 'create', element: { kind: 'connector', alias: 'free', from: { point: { x: 50, y: 400 } }, to: { point: { x: 200, y: 450 } } } },
  ]);
  await waitRevision(page, 1);
  const [a, b, c, ab, free] = r.created;
  // A mix of incremental-path edits.
  await apply(page, [{ op: 'move', target: a, delta: { xPt: 30, yPt: 120 } }]);
  await apply(page, [{ op: 'set', target: b, patch: { text: { value: 'B!' }, style: { fill: '#FFCC00' } } }]);
  await apply(page, [{ op: 'set', target: ab, patch: { to: { target: c, glue: 'dynamic' }, style: { endArrow: 'diamond' } } }]);
  await apply(page, [{ op: 'set', target: free, patch: { waypoints: [{ x: 120, y: 500 }] } }]);
  await apply(page, [{ op: 'set', target: c, patch: { hidden: true } }]);
  await apply(page, [{ op: 'set', target: c, patch: { hidden: false } }]); // re-shown: out-of-order insert → full fallback
  await apply(page, [{ op: 'resize', target: c, widthPt: 140, heightPt: 80 }]);
  await apply(page, [{ op: 'create', element: { kind: 'text', bounds: { x: 600, y: 500, width: 80, height: 20 }, text: { value: 'note' } } }]);
  await apply(page, [{ op: 'delete', target: b }]);
  await waitRevision(page, 10);

  const incremental = await page.evaluate(() => (window as any).__diagram.cellStates());
  // The connector's rendered end follows the moved/resized target c.
  const end = incremental[ab].points.at(-1);
  const cs = incremental[c];
  expect(end.x).toBeGreaterThanOrEqual(cs.x - 1); expect(end.x).toBeLessThanOrEqual(cs.x + cs.width + 1);
  expect(end.y).toBeGreaterThanOrEqual(cs.y - 1); expect(end.y).toBeLessThanOrEqual(cs.y + cs.height + 1);
  expect(incremental[b]).toBeUndefined();
  expect(incremental[a].value).toBe('A');

  await page.evaluate(() => (window as any).__diagram.reprojectAll());
  const full = await page.evaluate(() => (window as any).__diagram.cellStates());
  expect(Object.keys(incremental).sort()).toEqual(Object.keys(full).sort());
  for (const id of Object.keys(full)) expect({ id, ...incremental[id] }).toEqual({ id, ...full[id] });
});
