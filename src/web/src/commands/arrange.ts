import type { AlignOp, Bounds, DistributeOp, Page, SetGapOp, ZOrderOp } from '../model/types';
import { fail } from '../model/result';
import { assertNoAncestorConflicts } from './groups';
import { frameOf, translate } from './geometry';
import type { Draft } from './draft';

type Item = { id: string; b: Bounds; order: number };

function items(d: Draft, targets: string[], min: number): Item[] {
  const ids = d.resolveAll(targets);
  if (ids.length < min) fail('invalid_request', `needs at least ${min} targets`);
  d.samePage(ids);
  assertNoAncestorConflicts(d, ids);
  return ids.map((id, order) => ({ id, b: frameOf(d, id), order }));
}

/** Align selected objects to the selection's axis-aligned visual extent. Only selected geometry changes. */
export function planAlign(d: Draft, op: AlignOp) {
  const xs = items(d, op.targets, 2);
  const left = Math.min(...xs.map((i) => i.b.x)), right = Math.max(...xs.map((i) => i.b.x + i.b.width));
  const top = Math.min(...xs.map((i) => i.b.y)), bottom = Math.max(...xs.map((i) => i.b.y + i.b.height));
  for (const { id, b } of xs) {
    let dx = 0, dy = 0;
    switch (op.edge) {
      case 'left': dx = left - b.x; break;
      case 'right': dx = right - (b.x + b.width); break;
      case 'center': dx = (left + right) / 2 - (b.x + b.width / 2); break;
      case 'top': dy = top - b.y; break;
      case 'bottom': dy = bottom - (b.y + b.height); break;
      case 'middle': dy = (top + bottom) / 2 - (b.y + b.height / 2); break;
    }
    translate(d, id, dx, dy);
  }
}

const sortAlong = (xs: Item[], horizontal: boolean) =>
  [...xs].sort((a, b) => (horizontal ? a.b.x - b.b.x : a.b.y - b.b.y) || a.order - b.order);

/** Keeps the first and last objects; divides the edge-to-edge space equally. */
export function planDistribute(d: Draft, op: DistributeOp) {
  const h = op.axis === 'horizontal';
  const xs = sortAlong(items(d, op.targets, 3), h);
  const pos = (i: Item) => (h ? i.b.x : i.b.y), size = (i: Item) => (h ? i.b.width : i.b.height);
  const first = xs[0], last = xs[xs.length - 1];
  const inner = xs.slice(1, -1).reduce((s, i) => s + size(i), 0);
  const gap = (pos(last) - (pos(first) + size(first)) - inner) / (xs.length - 1);
  let cursor = pos(first) + size(first) + gap;
  for (const i of xs.slice(1, -1)) {
    const delta = cursor - pos(i);
    translate(d, i.id, h ? delta : 0, h ? 0 : delta);
    cursor += size(i) + gap;
  }
}

/** Keeps the first object; places following objects with the requested edge-to-edge gap. */
export function planSetGap(d: Draft, op: SetGapOp) {
  const h = op.axis === 'horizontal';
  const xs = sortAlong(items(d, op.targets, 2), h);
  const pos = (i: Item) => (h ? i.b.x : i.b.y), size = (i: Item) => (h ? i.b.width : i.b.height);
  let cursor = pos(xs[0]) + size(xs[0]) + op.gapPt;
  for (const i of xs.slice(1)) {
    const delta = cursor - pos(i);
    translate(d, i.id, h ? delta : 0, h ? 0 : delta);
    cursor += size(i) + op.gapPt;
  }
}

/**
 * Re-stacks targets and reassigns the page's existing zIndex values to the new order, so
 * only elements whose rank changed (targets and intervening objects) change.
 */
export function planZOrder(d: Draft, op: ZOrderOp) {
  const ids = d.resolveAll(op.targets);
  const page: Page = d.samePage(ids);
  d.assertUnlocked(ids);
  const order = [...page.elements].sort((a, b) => a.zIndex - b.zIndex);
  const values = order.map((e) => e.zIndex);
  const sel = new Set(ids);
  let next = order.map((e) => e.id);
  if (op.action === 'front') next = [...next.filter((x) => !sel.has(x)), ...next.filter((x) => sel.has(x))];
  else if (op.action === 'back') next = [...next.filter((x) => sel.has(x)), ...next.filter((x) => !sel.has(x))];
  else if (op.action === 'forward') {
    for (let i = next.length - 2; i >= 0; i--) if (sel.has(next[i]) && !sel.has(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]];
  } else {
    for (let i = 1; i < next.length; i++) if (sel.has(next[i]) && !sel.has(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]];
  }
  next.forEach((id, rank) => {
    const e = d.get(id);
    if (e.zIndex !== values[rank]) d.replaceElement({ ...e, zIndex: values[rank] });
  });
}
