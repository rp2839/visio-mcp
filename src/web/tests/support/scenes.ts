import { createTestEngine, ids, uuid } from './engine';
import type { Operation } from '../../src/model/types';

/** Engine with a two-page document, a connector, a nested group and a second-page alias clash. */
export async function richScene() {
  const t = createTestEngine();
  const page2 = uuid(3);
  const ops: Operation[] = [
    { op: 'addPage', page: { id: page2, name: 'Second' } },
    { op: 'create', pageId: page2, element: { kind: 'shape', id: uuid(0x300), alias: 's0', bounds: { x: 10, y: 10, width: 50, height: 50 } } },
    { op: 'create', pageId: ids.page, element: { kind: 'connector', id: uuid(0x200), alias: 'c01', from: { target: ids.shapes[0] }, to: { target: ids.shapes[1] } } },
    { op: 'group', targets: [ids.shapes[5], ids.shapes[6]], id: uuid(0x201), alias: 'inner' },
    { op: 'group', targets: [uuid(0x201), ids.shapes[7]], id: uuid(0x202), alias: 'outer' },
  ];
  const r = await t.engine.execute(t.request(ops, { pageId: ids.page }), 'gui');
  if (!r.ok) throw new Error(r.error.message);
  return { ...t, page2, connector: uuid(0x200), inner: uuid(0x201), outer: uuid(0x202) };
}
