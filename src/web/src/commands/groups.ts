import type { GroupElement, GroupOp, UngroupOp } from '../model/types';
import { fail } from '../model/result';
import { ancestors } from '../model/geometry';
import type { Draft } from './draft';

/** Rejects a selection containing both an element and one of its ancestors. */
export function assertNoAncestorConflicts(d: Draft, ids: string[]) {
  const set = new Set(ids);
  for (const id of ids) {
    const page = d.loc(id).page;
    for (const a of ancestors(d.pageIndex(page), id))
      if (set.has(a)) fail('invalid_request', `selection contains both group ${a} and its descendant ${id}`, { reason: 'ancestor_descendant_conflict' });
  }
}

export function planGroup(d: Draft, op: GroupOp): string {
  const ids = d.resolveAll(op.targets);
  const page = d.samePage(ids);
  assertNoAncestorConflicts(d, ids);
  d.assertUnlocked(ids);
  const parents = new Set(ids.map((id) => d.parentOf(id)));
  if (parents.size > 1) fail('invalid_request', 'grouped elements must share the same parent group');
  const parent = [...parents][0];
  const id = op.id ?? d.newUuid();
  // Children keep page order; the group sits above them for hit-testing.
  const ordered = page.elements.filter((e) => ids.includes(e.id)).map((e) => e.id);
  const group: GroupElement = {
    id, kind: 'group', childIds: ordered, layerIds: [], zIndex: d.nextZ(page), locked: false, hidden: false,
    bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
    ...(op.alias ? { alias: op.alias } : {}), ...(op.name ? { name: op.name } : {}),
  };
  if (op.alias && page.elements.some((e) => e.alias === op.alias)) fail('invalid_request', `alias "${op.alias}" already exists on page`);
  d.insertElement(page, group);
  if (op.alias) d.createdAliases[op.alias] = id;
  if (parent) {
    const p = d.get(parent) as GroupElement;
    const kept = p.childIds.filter((c) => !ids.includes(c));
    d.replaceElement({ ...p, childIds: [...kept, id] });
  }
  d.normaliseGroups();
  return id;
}

export function planUngroup(d: Draft, op: UngroupOp): string[] {
  const id = d.resolve(op.target);
  const g = d.get(id);
  if (g.kind !== 'group') fail('invalid_request', `${id} is not a group`);
  d.assertUnlocked([id]);
  const parent = d.parentOf(id);
  if (parent) {
    const p = d.get(parent) as GroupElement;
    d.replaceElement({ ...p, childIds: p.childIds.flatMap((c) => (c === id ? g.childIds : [c])) });
  }
  d.removeElement(id);
  d.normaliseGroups();
  return g.childIds;
}
