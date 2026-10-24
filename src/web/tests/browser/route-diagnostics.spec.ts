import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { openEditor, snapshot } from './support';

// R26: routing diagnostics in inspect_layout and the overlay, on the real editor.
const FIXTURES = '../../tests/fixtures/diagrams';
const EXPECTED = `${FIXTURES}/r26-route-diagnostics.expected.json`;
const ROUTE_CODES = ['CONNECTORS_CROSS', 'CONNECTOR_JOIN', 'CONNECTOR_TOUCHES_CONNECTOR', 'CONNECTORS_OVERLAP', 'CONNECTORS_TOO_CLOSE',
  'ROUTE_SHORT_SEGMENT', 'ROUTE_REDUNDANT_VERTEX', 'ROUTE_EXCESS_BENDS', 'ROUTE_TOO_CLOSE_TO_SHAPE', 'CONNECTOR_CROSSES_CONTAINER', 'CONNECTOR_CROSSES_BACKGROUND'];

/**
 * Builds a fixture page. Connectors on fixed ports go in with everything else; connectors with dynamic glue go in a second transaction,
 * because R22 refuses a transaction with fixed ports that would leave any connector unrouted, and four PSGL connectors cannot be routed.
 */
async function load(page: Page, name: string): Promise<string> {
  const ops = JSON.parse(readFileSync(`${FIXTURES}/${name}.operations.json`, 'utf8')) as any[];
  const later = (o: any) => o.op === 'createConnector' && o.from.glue !== 'static' && o.to.glue !== 'static' && (o.from.glue === 'dynamic' || o.to.glue === 'dynamic');
  for (const batch of [ops.filter(o => !later(o)), ops.filter(later)]) {
    if (!batch.length) continue;
    const r = await page.evaluate(b => (window as any).__editor.agentApply(b), batch);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
  }
  const pageId = ops[0].id as string;
  await page.evaluate(id => (window as any).__editor.setCurrentPage(id), pageId);
  return pageId;
}
const hidden = async (page: Page, pageId: string) => {
  const r = await page.evaluate(pageId => (window as any).__editor.callTool('doc.inspectLayout', { pageId }), pageId);
  return ((r.result ?? r).issues as any[]);
};
const live = (page: Page) => page.evaluate(() => (window as any).__editor.routeDiagnostics()) as Promise<any[]>;
const summary = (issues: any[]) => issues.filter(i => ROUTE_CODES.includes(i.code)).map(i => [i.code, i.severity, i.evidence.classification, i.elementIds.join(' ')].join(' | ')).sort();

for (const name of ['lego-infra', 'psgl-swimlane']) {
  test(`${name}: the recorded route diagnostics, the same from the live canvas and the hidden projection`, async ({ page }) => {
    test.setTimeout(120_000);
    await openEditor(page);
    const pageId = await load(page, name);
    const fromHidden = summary(await hidden(page, pageId));
    await expect.poll(async () => summary(await live(page))).toEqual(fromHidden);

    const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
    if (process.env.R26_RECORD) { expected[name] = fromHidden; writeFileSync(EXPECTED, JSON.stringify(expected, null, 1) + '\n'); }
    expect(fromHidden).toEqual(expected[name]);
    // the acceptance set: what the issue asks to be found on these drawings
    const found = new Set(fromHidden.map(s => s.split(' | ')[0]));
    for (const code of name === 'lego-infra' ? ['CONNECTORS_OVERLAP', 'ROUTE_SHORT_SEGMENT', 'ROUTE_TOO_CLOSE_TO_SHAPE'] : ['ROUTE_SHORT_SEGMENT', 'ROUTE_TOO_CLOSE_TO_SHAPE', 'CONNECTOR_CROSSES_CONTAINER']) expect(found).toContain(code);
  });
}

test('the overlay is off by default, draws the classified findings when turned on, and never changes the document', async ({ page }) => {
  await openEditor(page);
  const ids = { a: '00000000-0000-4000-8000-000000000d01', b: '00000000-0000-4000-8000-000000000d02', across: '00000000-0000-4000-8000-000000000d03', down: '00000000-0000-4000-8000-000000000d04', branch: '00000000-0000-4000-8000-000000000d05' };
  const made = await page.evaluate(ids => (window as any).__editor.agentApply([
    { op: 'createConnector', id: ids.across, from: { glue: 'none', point: { x: 100, y: 300 } }, to: { glue: 'none', point: { x: 600, y: 300 } }, route: 'orthogonal', hops: 'arc' },
    { op: 'createConnector', id: ids.down, from: { glue: 'none', point: { x: 300, y: 150 } }, to: { glue: 'none', point: { x: 300, y: 450 } }, route: 'orthogonal' },
    { op: 'createConnector', id: ids.branch, from: { glue: 'none', join: { connector: ids.across, position: 0.8 } }, to: { glue: 'none', point: { x: 500, y: 450 } }, route: 'orthogonal' },
  ]), ids);
  expect(made.ok, JSON.stringify(made.error)).toBe(true);

  // what an agent reads: the hop is intended, the junction is a join
  const issues = await hidden(page, (await snapshot(page)).document.pages[0]!.id);
  expect(issues).toContainEqual(expect.objectContaining({ code: 'CONNECTORS_CROSS', elementIds: [ids.across, ids.down], evidence: expect.objectContaining({ classification: 'hopped', intended: true }) }));
  expect(issues).toContainEqual(expect.objectContaining({ code: 'CONNECTOR_JOIN', elementIds: [ids.branch, ids.across], evidence: expect.objectContaining({ classification: 't_join' }) }));
  expect(issues.filter(i => i.code === 'CONNECTORS_CROSS' && i.elementIds.includes(ids.branch))).toEqual([]);

  await expect(page.getByTestId('route-diagnostics')).toHaveCount(0);
  const before = await snapshot(page);
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-route-diagnostics').click();
  await expect(page.getByTestId('route-diagnostics')).toBeVisible();
  await expect(page.getByTestId('route-diagnostic-CONNECTORS_CROSS')).toHaveAttribute('data-intended', 'true');
  await expect(page.getByTestId('route-diagnostic-CONNECTOR_JOIN')).toHaveAttribute('data-intended', 'true');
  await expect(page.getByTestId('route-diagnostics-legend')).toContainText('0 to look at, 2 on purpose');
  const after = await snapshot(page);
  expect(after.revision).toBe(before.revision);
  expect(after.document).toEqual(before.document);

  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-route-diagnostics').click();
  await expect(page.getByTestId('route-diagnostics')).toHaveCount(0);
});
