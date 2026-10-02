import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { bmp, boot, centreOf, commit, drag, waitRevision } from './helpers';

/**
 * Spec §23 demonstration, steps 1–9 (and the inputs for 10/14), driven through the same request
 * router MCP uses plus real GUI gestures for the human steps. Evidence (snapshots, transaction
 * results, previews) goes to tools/demo/out/ and is checked by tools/demo/verify-demo.mjs.
 * This is NOT a real LLM: the agent's decisions are scripted; steps 11–13 need Visio/Word.
 */
const OUT = '../../tools/demo/out';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function call(page: Page, method: string, params: Record<string, unknown>) {
  return page.evaluate(async ({ method, params }) => {
    const d = (window as any).__diagram; const s = d.scope();
    return d.request({ protocolVersion: 1, kind: 'request', requestId: crypto.randomUUID(), method, documentId: s.documentId, sessionId: s.sessionId, params });
  }, { method, params });
}

test('§23 demo steps 1–9 with semantic evidence', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  const evidence: any = { generatedAt: new Date().toISOString(), environment: 'Linux, headless Chromium, browser build (no WPF host); agent decisions scripted', steps: [] };
  const snapshot = () => page.evaluate(() => (window as any).__diagram.snapshot());
  const record = async (step: number, title: string, extra: Record<string, unknown> = {}) => evidence.steps.push({ step, title, snapshot: await snapshot(), ...extra });

  // 1. Human opens a blank A4 landscape page.
  await boot(page);
  await record(1, 'blank A4 landscape page');

  // Approved assets (host-prepared in the real app; the dev build prepares them in memory).
  const corona = bmp();
  const esgOld = bmp(); for (let i = 54; i < esgOld.length; i++) esgOld[i] = (esgOld[i] * 3) & 0xff;
  const esgNew = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><rect width="60" height="30" fill="#2CA02C"/><text x="6" y="20" font-size="12" fill="#fff">ESG</text></svg>');
  const asset = (id: string, name: string, mime: string, b: Buffer, w: number, h: number) => ({ id, name, mimeType: mime, sha256: sha(b), widthPx: w, heightPx: h, tags: ['logo'], provenance: 'approved demo library' });
  const assets = {
    corona: asset('asset:corona-energy', 'Corona Energy logo', 'image/bmp', corona, 2, 2),
    esg: asset('asset:esg-global-old', 'ESG Global logo (2019)', 'image/bmp', esgOld, 2, 2),
    esgNew: asset('asset:esg-global', 'ESG Global logo', 'image/svg+xml', esgNew, 60, 30),
  };
  await page.evaluate((list) => { for (const [s, url] of list) (window as any).__diagram.putAsset(s, url); },
    [[assets.corona.sha256, `data:image/bmp;base64,${corona.toString('base64')}`], [assets.esg.sha256, `data:image/bmp;base64,${esgOld.toString('base64')}`], [assets.esgNew.sha256, `data:image/svg+xml;base64,${esgNew.toString('base64')}`]]);
  const ref = (a: any) => ({ preparationId: `prep-${a.id}`, asset: a, expiresAt: '2099-01-01T00:00:00Z' });

  // 2–3. Agent creates the diagram in one transaction; the UI updates.
  const script = readFileSync('../../tools/demo/scenario.drawscript', 'utf8');
  const s2 = await page.evaluate(() => (window as any).__diagram.scope());
  const created = await call(page, 'doc.executeScript', { transactionId: crypto.randomUUID(), baseRevision: s2.revision, pageId: await page.evaluate(() => (window as any).__diagram.pageId()), script, preparedAssetRefs: { corona: ref(assets.corona), esg: ref(assets.esg) } });
  expect(created.error).toBeUndefined();
  await waitRevision(page, 1);
  await expect(page.locator('[data-testid=canvas] svg g')).not.toHaveCount(0);
  await record(2, 'agent creates blocks, connectors, note and logos (execute_script)', { result: created.result });

  // 4. Agent previews and inspects; notices the misaligned block from geometry in the summary.
  const pid = await page.evaluate(() => (window as any).__diagram.pageId());
  const preview = await call(page, 'doc.render', { pageId: pid, format: 'png', maxWidth: 1600, maxHeight: 1200 });
  expect(preview.error).toBeUndefined();
  writeFileSync(`${OUT}/preview-step4.png`, Buffer.from(preview.result.data, 'base64'));
  const layout = await call(page, 'doc.inspectLayout', { pageId: pid });
  const summary = await call(page, 'doc.summary', { includeGeometry: true });
  const tops = Object.fromEntries(summary.result.elements.filter((e: any) => ['crm', 'billing', 'dwh'].includes(e.alias)).map((e: any) => [e.alias, e.bounds.y]));
  await record(4, 'agent renders a PNG preview and inspects layout', { preview: { revision: preview.result.revision, widthPx: preview.result.widthPx, heightPx: preview.result.heightPx, file: 'preview-step4.png' }, layoutIssues: layout.result.issues, topsPt: tops });

  // 5. Agent aligns only the affected elements.
  const s5 = await page.evaluate(() => (window as any).__diagram.scope());
  const aligned = await call(page, 'doc.executeScript', { transactionId: crypto.randomUUID(), baseRevision: s5.revision, pageId: pid, script: 'align top crm billing dwh' });
  expect(aligned.error).toBeUndefined();
  await waitRevision(page, 2);
  await record(5, 'agent aligns the three top blocks', { result: aligned.result });
  const agentRevision = aligned.result.result?.revision ?? aligned.result.revision;

  // 6. Human drags one element and changes one fill colour (real GUI gestures).
  const els = (await snapshot()).document.pages[0].elements;
  const dwh = els.find((e: any) => e.alias === 'dwh'), esgBlock = els.find((e: any) => e.alias === 'esgblock');
  const c = await centreOf(page, dwh.bounds);
  await drag(page, c, { x: c.x + 40, y: c.y + 120 });
  await waitRevision(page, 3);
  const ec = await centreOf(page, esgBlock.bounds);
  await page.mouse.click(ec.x, ec.y);
  await commit(page, 'style-fill', '#FFE0B2');
  await waitRevision(page, 4);
  await record(6, 'human moves the data warehouse block and recolours the ESG block (GUI)');

  // 7. Agent's stale edit is refused; it reads changes since its revision and preserves the human edit.
  const stale = await call(page, 'doc.apply', { transactionId: crypto.randomUUID(), baseRevision: agentRevision, operations: [{ op: 'set', target: dwh.id, patch: { text: { value: 'Data warehouse (Snowflake)' } } }] });
  const changes = await call(page, 'doc.getChanges', { sinceRevision: agentRevision });
  const s7 = await page.evaluate(() => (window as any).__diagram.scope());
  const retry = await call(page, 'doc.apply', { transactionId: crypto.randomUUID(), baseRevision: s7.revision, operations: [{ op: 'set', target: dwh.id, patch: { text: { value: 'Data warehouse (Snowflake)' } } }] });
  expect(retry.error).toBeUndefined();
  await waitRevision(page, 5);
  await record(7, 'agent hits revision_conflict, reads changes, retries a text-only patch', { staleError: stale.error, changes: changes.result, result: retry.result });

  // 8–9. Human asks for the ESG logo swap; agent picks the approved asset by ID; only that image changes.
  const before = await snapshot();
  const logo = before.document.pages[0].elements.find((e: any) => e.alias === 'logo_esg');
  const s8 = await page.evaluate(() => (window as any).__diagram.scope());
  const swap = await call(page, 'doc.apply', { transactionId: crypto.randomUUID(), baseRevision: s8.revision, operations: [{ op: 'registerAsset', asset: assets.esgNew }, { op: 'set', target: logo.id, patch: { assetId: 'asset:esg-global' } }] });
  expect(swap.error).toBeUndefined();
  await waitRevision(page, 6);
  const finalPreview = await call(page, 'doc.render', { pageId: pid, format: 'png', maxWidth: 1600, maxHeight: 1200 });
  writeFileSync(`${OUT}/preview-final.png`, Buffer.from(finalPreview.result.data, 'base64'));
  await record(9, 'agent replaces one logo by approved asset ID', { result: swap.result, imageId: logo.id });

  const final = await snapshot();
  writeFileSync(`${OUT}/demo-final.json`, JSON.stringify(final, null, 2));
  writeFileSync(`${OUT}/demo-assets.json`, JSON.stringify({ [assets.corona.sha256]: corona.toString('base64'), [assets.esg.sha256]: esgOld.toString('base64'), [assets.esgNew.sha256]: esgNew.toString('base64') }));
  writeFileSync(`${OUT}/demo-evidence.json`, JSON.stringify(evidence, null, 2));
});
