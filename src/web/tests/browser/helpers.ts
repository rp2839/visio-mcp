import { expect, type Page } from '@playwright/test';

export type Box = { x: number; y: number; width: number; height: number };
export const snap = (page: Page) => page.evaluate(() => (window as any).__diagram.snapshot());
export const elements = async (page: Page) => (await snap(page)).document.pages.find((p: any) => p.id === (undefined)) ?? (await snap(page)).document.pages[0].elements;
export async function pageElements(page: Page): Promise<any[]> {
  return page.evaluate(() => { const d = (window as any).__diagram; const s = d.snapshot(); return s.document.pages.find((p: any) => p.id === d.pageId()).elements; });
}
export const revision = async (page: Page) => (await snap(page)).revision as number;
export const selection = (page: Page) => page.evaluate(() => (window as any).__diagram.selection() as string[]);
export const toClient = (page: Page, p: { x: number; y: number }) => page.evaluate((q) => (window as any).__diagram.toClient(q), p) as Promise<{ x: number; y: number }>;

export async function centreOf(page: Page, b: Box) {
  return toClient(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
}

export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { steps?: number; midway?: () => Promise<void> } = {}) {
  const steps = opts.steps ?? 10;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    if (i === steps - 1 && opts.midway) await opts.midway();
  }
  await page.mouse.up();
}

export async function waitRevision(page: Page, r: number) {
  await expect.poll(() => revision(page)).toBe(r);
}

export async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__diagram && document.querySelector('[data-testid=canvas] svg'));
}

export async function commit(page: Page, testid: string, value: string) {
  const input = page.getByTestId(testid);
  await input.fill(value);
  await input.press('Enter');
}

/** 2×2 24-bit BMP. */
export function bmp(): Buffer {
  const b = Buffer.alloc(54 + 16);
  b.write('BM', 0); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(2, 18); b.writeInt32LE(2, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(16, 34);
  for (let i = 54; i < b.length; i++) b[i] = (i * 37) & 0xff;
  return b;
}
