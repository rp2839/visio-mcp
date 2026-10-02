import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const evidence = join(import.meta.dirname, '..', '..', '..', 'docs', 'm0', 'evidence', 'G2');

type Box = { x: number; y: number; width: number; height: number };
const state = (page: Page) => page.evaluate(() => (window as any).probe.readProbeState());
const bounds = (page: Page, id: string): Promise<Box> => page.evaluate((i) => (window as any).probe.cellBounds(i), id);
const log = (page: Page) => page.evaluate(() => (window as any).probe.gestureLog());
const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).probe);
});

test('move_resize_rotate_glue_and_picture', async ({ page }) => {
  const before = await state(page);

  // Move: one gesture is one revision; glue identity and untouched objects survive.
  const rect = await bounds(page, 'rect');
  await drag(page, centre(rect), { x: centre(rect).x + 40, y: centre(rect).y + 100 });
  await expect.poll(async () => (await state(page)).revision).toBe(before.revision + 1);
  const after = await state(page);
  expect(after.revision).toBe(before.revision + 1);
  expect(after.connector.from.elementId).toBe(before.connector.from.elementId);
  expect(after.connector.to.elementId).toBe(before.connector.to.elementId);
  expect(after.ellipse).toEqual(before.ellipse);
  expect(after.picture).toEqual(before.picture);
  expect(after.rect.x).toBeCloseTo(before.rect.x + 40, 0);
  expect(after.rect.y).toBeCloseTo(before.rect.y + 100, 0);

  // Connector route follows the moved shape (derived geometry, not store data).
  const edge = await bounds(page, 'connector');
  const moved = await bounds(page, 'rect');
  expect(edge.y + edge.height).toBeGreaterThanOrEqual(moved.y);

  // Resize via the bottom-right handle of the selected rectangle.
  await page.evaluate(() => (window as any).probe.select('rect'));
  const r2 = await bounds(page, 'rect');
  await drag(page, { x: r2.x + r2.width, y: r2.y + r2.height }, { x: r2.x + r2.width + 60, y: r2.y + r2.height + 30 });
  await expect.poll(async () => (await state(page)).revision).toBe(before.revision + 2);
  const resized = await state(page);
  expect(resized.rect.width).toBeCloseTo(after.rect.width + 60, 0);
  expect(resized.rect.height).toBeCloseTo(after.rect.height + 30, 0);
  expect(resized.ellipse).toEqual(before.ellipse);

  // Rotate via the rotation handle (above the top-right corner in maxGraph).
  await page.evaluate(() => (window as any).probe.select('rect'));
  const handle = page.locator('#canvas svg g > g > image, #canvas svg [style*="cursor: crosshair"]').last();
  const hb = (await handle.boundingBox())!;
  const r3 = await bounds(page, 'rect');
  await drag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: r3.x + r3.width + 120, y: r3.y + r3.height / 2 + 40 });
  await expect.poll(async () => (await state(page)).revision).toBe(before.revision + 3);
  const rotated = await state(page);
  expect(rotated.rect.rotation).not.toBe(0);
  expect(rotated.connector.from.elementId).toBe('rect');

  // Connect: re-glue the connector's target end from the ellipse onto the picture.
  await page.evaluate(() => (window as any).probe.select('connector'));
  const ends = await page.evaluate(() => (window as any).probe.edgeEnds('connector'));
  const pic = await bounds(page, 'picture');
  await drag(page, ends.end, centre(pic));
  await expect.poll(async () => (await state(page)).revision).toBe(before.revision + 4);
  const reglued = await state(page);
  expect(reglued.connector.from.elementId).toBe('rect');
  expect(reglued.connector.to.elementId).toBe('picture');
  expect(reglued.ellipse).toEqual(before.ellipse);

  // Picture is an independent image cell and the offscreen render embeds it without taint.
  const t0 = Date.now();
  const png = Uint8Array.from(await page.evaluate(() => (window as any).probe.renderProbe()));
  const renderMs = Date.now() - t0;
  expect(Array.from(png.subarray(0, 8))).toEqual(pngMagic);
  expect(png.length).toBeGreaterThan(1000);

  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'render.png'), png);
  writeFileSync(join(evidence, 'probe-state.json'), JSON.stringify({ before, after: reglued, gestures: await log(page) }, null, 2));
  writeFileSync(join(evidence, 'timing.json'), JSON.stringify({
    renderMs, commits: await page.evaluate(() => (window as any).probe.timings()),
  }, null, 2));
});

test('gesture_lifecycle_observable_and_cancellable', async ({ page }) => {
  const before = await state(page);

  // Selection and zoom do not activate the gesture hook.
  const rect = await bounds(page, 'rect');
  await page.mouse.click(centre(rect).x, centre(rect).y);
  await page.evaluate(() => (window as any).probe.zoomIn());
  await page.evaluate(() => (window as any).probe.zoomIn());
  expect(await log(page)).toEqual([]);
  expect((await state(page)).revision).toBe(before.revision);

  // Move: begin → cancel (Escape) restores the snapshot and commits nothing.
  const r = await bounds(page, 'rect');
  await page.mouse.move(centre(r).x, centre(r).y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(centre(r).x + i * 10, centre(r).y + i * 5);
  expect(await page.evaluate(() => (window as any).probe.isGestureActive())).toBe(true);
  await page.evaluate(() => (window as any).probe.cancelGesture());
  await page.mouse.up();
  expect(await state(page)).toEqual(before);
  expect(await bounds(page, 'rect')).toEqual(r);

  // Move commit.
  const r1 = await bounds(page, 'rect');
  await drag(page, centre(r1), { x: centre(r1).x + 30, y: centre(r1).y });
  await expect.poll(async () => (await state(page)).revision).toBe(before.revision + 1);

  // Resize begin/commit.
  await page.evaluate(() => (window as any).probe.select('ellipse'));
  const e = await bounds(page, 'ellipse');
  await drag(page, { x: e.x + e.width, y: e.y + e.height }, { x: e.x + e.width + 20, y: e.y + e.height + 20 });
  await expect.poll(async () => (await state(page)).revision).toBe(before.revision + 2);

  // Bend: drag the connector's virtual/segment handle.
  await page.evaluate(() => (window as any).probe.select('connector'));
  const c = await bounds(page, 'connector');
  const mid = centre(c);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(mid.x, mid.y + i * 8);
  const bendActive = await page.evaluate(() => (window as any).probe.isGestureActive());
  await page.evaluate(() => (window as any).probe.cancelGesture());
  await page.mouse.up();

  // In-place text edit: begin → cancel, then begin → commit.
  await page.evaluate(() => (window as any).probe.startTextEdit('rect'));
  expect(await page.evaluate(() => (window as any).probe.isGestureActive())).toBe(true);
  await page.evaluate(() => (window as any).probe.stopTextEdit(true));
  const midState = await state(page);
  expect(midState.rect.text).toBe('Probe');
  await page.evaluate(() => (window as any).probe.startTextEdit('rect'));
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Edited');
  await page.evaluate(() => (window as any).probe.stopTextEdit(false));
  await expect.poll(async () => (await state(page)).rect.text).toBe('Edited');
  expect((await state(page)).revision).toBe(midState.revision + 1);

  const phases = (await log(page)).map((g: any) => `${g.kind}:${g.phase}`);
  expect(phases).toEqual([
    'move:begin', 'move:cancel',
    'move:begin', 'move:commit',
    'resize:begin', 'resize:commit',
    ...(bendActive ? ['bend:begin', 'bend:cancel'] : []),
    'text:begin', 'text:cancel',
    'text:begin', 'text:commit',
  ]);
  expect(bendActive).toBe(true);
});

test('svg_vector_asset_does_not_taint_offscreen_render', async ({ page }) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#2CA02C"/></svg>';
  const scene = await state(page);
  scene.picture.assetDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  await page.evaluate((s) => (window as any).probe.project(s), scene);
  const png = Uint8Array.from(await page.evaluate(() => (window as any).probe.renderProbe()));
  expect(Array.from(png.subarray(0, 8))).toEqual(pngMagic);
  writeFileSync(join(evidence, 'render-svg-asset.png'), png);
});
