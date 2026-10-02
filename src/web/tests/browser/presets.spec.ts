import { expect, test } from '@playwright/test';
import { boot, pageElements, waitRevision } from './helpers';
import { PRESETS } from '../../src/canvas/presets';

/**
 * Every stencil must draw its own outline on the live canvas, not maxGraph's rectangle fallback
 * (maxGraph has no callout/document/parallelogram shapes, and server/application/user had none).
 */
test('every stencil draws its own outline on the canvas', async ({ page }) => {
  await boot(page);
  let rev = 0;
  for (const p of PRESETS) {
    await page.getByTestId(`stencil-${p.label.toLowerCase().replace(/\W+/g, '-')}`).first().click();
    await waitRevision(page, ++rev);
  }
  const els = await pageElements(page);
  const markup = async (id: string) => (await page.evaluate((i) => (window as any).__diagram.cellMarkup(i), id)) as string;
  const pathD = (html: string) => [...html.matchAll(/<path[^>]* d="([^"]+)"/g)].map((m) => m[1]).join(' ');
  for (const preset of ['parallelogram', 'callout', 'document', 'server', 'application', 'user']) {
    const el = els.find((e: any) => e.geometry?.preset === preset);
    expect(el, preset).toBeTruthy();
    const html = await markup(el.id);
    const d = pathD(html);
    expect(d, `${preset} should be drawn as a path, got ${html.slice(0, 120)}`).not.toBe('');
    const moves = (d.match(/M/g) ?? []).length;
    if (preset === 'server') expect(moves).toBeGreaterThanOrEqual(3); // outline plus two divider lines
    if (preset === 'application') expect(moves).toBeGreaterThanOrEqual(2); // outline plus title bar
    if (preset === 'document') expect(d).toMatch(/C/); // curved bottom edge
    if (preset === 'user') expect((d.match(/C/g) ?? []).length).toBeGreaterThanOrEqual(5); // whole head (4 quarter arcs) + shoulders
    if (preset === 'callout' || preset === 'parallelogram') expect(d.match(/L/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  }
  // Built-in shapes still use maxGraph's own renderers.
  const ellipse = els.find((e: any) => e.geometry?.preset === 'ellipse');
  expect(await markup(ellipse.id)).toMatch(/<ellipse/);
});
