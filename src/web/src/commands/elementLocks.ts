import type { DiagramDocument, Element } from '../contracts/generated';
import type { DiffBody } from './diff';

/** What a person's gesture protects while it is in progress. Everything it does not name stays open to an agent's edits. */
export interface ElementLock {
  readonly token: number;
  readonly kind: string;
  readonly ids: readonly string[];
}

const TEXT_KINDS: ReadonlySet<string> = new Set(['text']);
const GEOMETRY_KINDS: ReadonlySet<string> = new Set(['move', 'resize', 'rotate', 'bend']);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function everyElement(doc: DiagramDocument): Map<string, Element> {
  const out = new Map<string, Element>();
  for (const page of doc.pages) for (const e of page.elements) out.set(e.id, e);
  return out;
}

/** Position, size, rotation and shape outline; for a connector, its ends and route. */
function geometryChanged(before: Element, after: Element): boolean {
  const b = before as unknown as Record<string, unknown>, a = after as unknown as Record<string, unknown>;
  return ['bounds', 'rotationDeg', 'geometry', 'ports', 'attachment', 'from', 'to', 'route', 'waypoints', 'routing'].some(k => !same(b[k], a[k]));
}

/** The words: a shape's or text box's text, a connector's label. */
function textChanged(before: Element, after: Element): boolean {
  const b = before as unknown as Record<string, unknown>, a = after as unknown as Record<string, unknown>;
  return ['text', 'label'].some(k => !same(b[k], a[k]));
}

/**
 * The ids an agent edit would change that a person's gesture currently protects. An edit-text gesture protects that element's text
 * and nothing else; a move, resize, rotate or bend protects the element's size and position, the group members that go with it, and
 * the connectors attached to it (their ends and route follow it). Deleting a protected element always conflicts. Created elements never do.
 */
export function lockedChanges(locks: Iterable<ElementLock>, before: DiagramDocument, forward: DiffBody): string[] {
  const held = [...locks];
  if (!held.length) return [];
  const elements = everyElement(before);
  const textIds = new Set<string>(), geometryIds = new Set<string>();
  const addGeometry = (id: string) => {
    if (geometryIds.has(id)) return;
    geometryIds.add(id);
    const e = elements.get(id);
    if (e?.kind === 'group') for (const child of e.childIds) addGeometry(child);
  };
  for (const lock of held) {
    for (const id of lock.ids) {
      if (TEXT_KINDS.has(lock.kind)) textIds.add(id);
      else if (GEOMETRY_KINDS.has(lock.kind)) addGeometry(id);
    }
  }
  if (geometryIds.size) {
    for (const e of elements.values()) {
      if (e.kind !== 'connector') continue;
      if ((e.from.elementId && geometryIds.has(e.from.elementId)) || (e.to.elementId && geometryIds.has(e.to.elementId))) geometryIds.add(e.id);
    }
  }
  const protectedIds = new Set([...textIds, ...geometryIds]);
  const hit = new Set<string>();
  for (const id of forward.deletes.elementIds) if (protectedIds.has(id)) hit.add(id);
  for (const { element } of forward.upserts.elements) {
    const old = elements.get(element.id);
    if (!old) continue;
    if ((geometryIds.has(element.id) && geometryChanged(old, element)) || (textIds.has(element.id) && textChanged(old, element))) hit.add(element.id);
  }
  return [...hit].sort();
}
